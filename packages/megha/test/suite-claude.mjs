// Claude backend against a mocked api.anthropic.com: models, the bundle path (no GitHub remote, local
// changes via refs/seed/stash), images, follow-up model switch, no-git error, cancel interrupt, /pr.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeBackend, modelsFromResponse, userContent, compareUrl } from "../lib/claude.mjs";
import { cleanPrompt } from "../lib/prompt.mjs";
import { git } from "../lib/util.mjs";
import { test, tmp, makeRepo, mockFetch, json, sse, recorder, PNG_1x1 } from "./harness.mjs";

const API = "api.anthropic.com";
const input = (text, extra = []) => cleanPrompt([{ type: "text", text }, ...extra]);
const row = (seq, payload) => ({ event: "client_event", id: String(seq), data: { sequence_num: String(seq), source: "worker", payload } });

function fakeClaude({ stream } = {}) {
  const state = { seq: 0, uploads: [] };
  const routes = [
    ["GET", new RegExp(`^${API}/v1/environment_providers$`), () => json({ environments: [{ environment_id: "env_cloud", name: "Default", kind: "anthropic_cloud" }, { environment_id: "env_bridge", name: "Laptop", kind: "bridge" }] })],
    ["GET", new RegExp(`^${API}/v1/models$`), () => json({ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }, { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }] })],
    ["POST", new RegExp(`^${API}/v1/files$`), (req) => { state.uploads.push(Buffer.from(req.rawBody)); return json({ id: "file_bundle1" }); }],
    ["POST", new RegExp(`^${API}/v1/sessions$`), (req) => { state.create = req.body; return json({ id: "session_abc", title: "t" }); }],
    ["POST", new RegExp(`^${API}/v1/code/sessions/cse_abc/events$`), (req) => { (state.posted ??= []).push(req.body); state.seq += 1; return json({ results: [{ sequence_num: String(100 + state.seq) }] }); }],
    // Rows continue after the requested sequence number, like the live stream.
    ["GET", new RegExp(`^${API}/v1/code/sessions/cse_abc/events/stream$`), (req) => {
      if (stream) return stream(req, state);
      const from = Math.max(Number(req.url.searchParams.get("from_sequence_num") ?? 0), 200);
      return sse([row(from + 1, { type: "assistant", message: { content: [{ type: "text", text: "Claude says hi" }] } }),
        row(from + 2, { type: "result", subtype: "success", is_error: false })]);
    }],
    ["GET", new RegExp(`^${API}/v1/code/sessions/cse_abc$`), () => json({ session: { id: "cse_abc", title: "t", worker_status: "idle", config: { model: "claude-haiku-5-5" } } })],
  ];
  return { state, routes };
}

// The multipart body of POST /v1/files -> the bundle bytes.
function bundleFromMultipart(buf) {
  const start = buf.indexOf("\r\n\r\n") + 4;
  const end = buf.indexOf(Buffer.from("\r\n--", "latin1"), start);
  return buf.subarray(start, end);
}

export async function run() {
  await test("models: labels drop the \"Claude \" prefix", () => {
    assert.deepEqual(modelsFromResponse({ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] }), [{ id: "claude-opus-5-5", name: "Opus 5.5" }]);
  });

  await test("user content: images become base64 image blocks before the text", () => {
    assert.equal(userContent("hi"), "hi");
    assert.deepEqual(userContent("hi", [{ data: "AAA", mimeType: "image/png" }]),
      [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }, { type: "text", text: "hi" }]);
  });

  await test("compare URL for a pushed claude/ branch", () => {
    assert.equal(compareUrl("acme/widget", "main", "claude/fix-1"), "https://github.com/acme/widget/compare/main...claude%2Ffix-1?expand=1");
  });

  const be = new ClaudeBackend();

  await test("no GitHub remote + local changes: bundle carries refs/seed/stash; model goes in session_context", async () => {
    const repo = await makeRepo({ origin: null, files: { "a.txt": "one\n" } });
    writeFileSync(join(repo, "a.txt"), "uncommitted edit\n");
    const fake = fakeClaude();
    const calls = mockFetch(fake.routes);
    const s = { id: "mg_claude_1", backend: "claude", cwd: repo, config: {} };
    await be.prepare(s);
    const opts = be.configOptions(s);
    assert.equal(opts.find((o) => o.id === "model").currentValue, "claude-opus-5-5");
    assert.deepEqual(opts.find((o) => o.id === "model").options.map((o) => o.name), ["Opus 5.5", "Haiku 5.5"]);
    assert.equal(opts.find((o) => o.id === "environment").currentValue, "env_cloud", "bridge environments are skipped");
    assert.equal(s.config.localChanges, "on");
    const rec = recorder();
    assert.equal(await be.prompt(s, input("What changed?"), rec.io), "end_turn");
    assert.equal(fake.state.create.session_context.model, "claude-opus-5-5");
    assert.equal(fake.state.create.session_context.seed_bundle_file_id, "file_bundle1");
    assert.deepEqual(fake.state.create.session_context.sources, []);
    const bundleFile = join(tmp("bundle"), "b.bundle");
    writeFileSync(bundleFile, bundleFromMultipart(fake.state.uploads[0]));
    const heads = (await git(repo, ["bundle", "list-heads", bundleFile])).stdout;
    assert.match(heads, /refs\/seed\/stash/);
    assert.equal((await git(repo, ["rev-parse", "--verify", "--quiet", "refs/seed/stash"])).code, 1, "temporary ref removed again");
    assert.match(rec.text(), /"Send local changes" is on[\s\S]*including uncommitted tracked changes/);
    assert.match(rec.text(), /Claude says hi/);
    assert.ok(calls.every((c) => !String(c.headers?.Authorization ?? "").includes("undefined")));
  });

  const s = { id: "mg_claude_2", backend: "claude", cwd: await makeRepo({ origin: null }), config: {} };
  await test("follow-up: model switch control_request, image blocks in the user message", async () => {
    const fake = fakeClaude();
    mockFetch(fake.routes);
    await be.prepare(s);
    await be.prompt(s, input("first"), recorder().io);
    be.setConfig(s, "model", "claude-haiku-5-5");
    await be.prompt(s, input("look", [{ type: "image", data: PNG_1x1, mimeType: "image/png" }]), recorder().io);
    const events = fake.state.posted.at(-1).events.map((e) => e.payload);
    assert.deepEqual(events.find((p) => p.type === "control_request").request, { subtype: "set_model", model: "claude-haiku-5-5" });
    const user = events.find((p) => p.type === "user");
    assert.equal(user.message.content[0].type, "image");
    assert.deepEqual(user.message.content.at(-1), { type: "text", text: "look" });
  });

  await test("cancel sends the interrupt control_request", async () => {
    // A live stream that stays open until the worker reports the interrupt.
    const fake = fakeClaude({ stream: (req, state) => new Response(new ReadableStream({
      start(controller) {
        const t = setInterval(() => {
          if (!state.interrupted) return;
          clearInterval(t);
          controller.enqueue(new TextEncoder().encode(`event: client_event\nid: 301\ndata: ${JSON.stringify(row(301, { type: "result", subtype: "error_during_execution", terminal_reason: "interrupted" }).data)}\n\n`));
        }, 50);
        req.signal?.addEventListener("abort", () => { clearInterval(t); try { controller.error(new DOMException("aborted", "AbortError")); } catch {} }, { once: true });
      },
    }), { headers: { "content-type": "text/event-stream" } }) });
    fake.routes.unshift(["POST", new RegExp(`^${API}/v1/code/sessions/cse_abc/events$`), (req) => {
      if (req.body.events.some((e) => e.payload.request?.subtype === "interrupt")) fake.state.interrupted = true;
      return json({ results: [{ sequence_num: "300" }] });
    }]);
    mockFetch(fake.routes);
    const ac = new AbortController();
    const p = be.prompt(s, input("long"), recorder({ signal: ac.signal }).io);
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    assert.equal(await p, "cancelled");
    assert.equal(fake.state.interrupted, true);
  });

  await test("no git at all: a clear error before anything is uploaded", async () => {
    const fake = fakeClaude();
    const calls = mockFetch(fake.routes);
    const plain = { id: "mg_claude_3", backend: "claude", cwd: tmp("nogit-claude"), config: {} };
    await be.prepare(plain);
    await assert.rejects(be.prompt(plain, input("hi"), recorder().io), /is not a git repository[\s\S]*git init/);
    assert.ok(!calls.some((c) => c.method === "POST"));
  });

  await test("/pr on a bundle session explains why there is no branch", async () => {
    const rec = recorder();
    await be.command({ ...s, bundle: true }, { name: "pr", args: "" }, rec.io);
    assert.match(rec.text(), /seeded from a git bundle/);
  });
}
