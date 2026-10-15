// Runs LAST. Drives both backends through success and failure paths with secret canaries planted in
// the fake logins, API error bodies, environment JSON and startup errors, then checks that no canary
// reached stdout, stderr, any ACP notification or error from the whole offline run, or any file megha
// wrote to its data dir.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MeghaAgent } from "../lib/agent.mjs";
import { CodexBackend } from "../lib/codex.mjs";
import { ClaudeBackend } from "../lib/claude.mjs";
import { DATA_DIR } from "../lib/util.mjs";
import { test, makeRepo, mockFetch, json, sse, fakeConn, captureAcp, acpCaptured, stdio, CANARY } from "./harness.mjs";

const CX = "chatgpt\\.com/backend-api";
const AN = "api\\.anthropic\\.com";
const text = (t) => [{ type: "text", text: t }];
const swallow = (p) => p.then((r) => r, (e) => captureAcp(e));

function filesUnder(dir) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...filesUnder(p)); else out.push(p);
  }
  return out;
}

export async function run({ logins }) {
  const secretEnv = { id: "env_sec", label: "sec", repo_map: { r: { repository_full_name: "acme/sec" } },
    env_vars: { API_KEY: CANARY.envSecret }, secrets: { TOKEN: CANARY.envSecret }, secrets_with_domains: [{ name: "X", value: CANARY.envSecret }] };
  const thread = (method, params = {}) => ({ item_type: "thread_event", event: { method, params } });

  await test("secrecy: Codex success and failure paths, with secrets in env JSON and error bodies", async () => {
    const repo = await makeRepo({ origin: "https://github.com/acme/sec.git" });
    let fail = false;
    mockFetch([
      ["GET", new RegExp(`^${CX}/wham/models$`), () => json({ models: [{ slug: "gpt-5.6-sol", display_name: "Sol", visibility: "list" }] })],
      ["GET", new RegExp(`^${CX}/wham/environments/by-repo/github/`), () => json([secretEnv])],
      ["POST", new RegExp(`^${CX}/wham/tasks$`), () => (fail ? json({ error: { message: CANARY.serverBody, code: CANARY.serverBody } }, 400)
        : json({ task: { id: "task_e_sec" }, turn: { id: "task_e_sec~assttrn_e_1" } }))],
      ["GET", new RegExp(`^${CX}/wham/tasks/task_e_sec/turns/[^/]+/stream$`), () => sse([thread("turn/started"), thread("item/agentMessage/delta", { itemId: "m", delta: "ok" }), thread("turn/completed", { turn: { status: "completed" } })])],
      ["GET", new RegExp(`^${CX}/wham/tasks/task_e_sec$`), () => (fail ? json({ detail: `${CANARY.serverBody} ${CANARY.envSecret}` }, 503)
        : json({ task: { id: "task_e_sec", title: "t" }, current_assistant_turn: { id: "task_e_sec~assttrn_e_1", turn_status: "completed", environment_id: "env_sec", environment: secretEnv, output_items: [] } }))],
    ]);
    const a = new MeghaAgent(fakeConn(), new CodexBackend(), { env: {} });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    assert.equal((await a.prompt({ sessionId, prompt: text("hello") })).stopReason, "end_turn");
    await swallow(a.prompt({ sessionId, prompt: text("/status") }));
    fail = true;
    await swallow(a.prompt({ sessionId, prompt: text("/status") }));
    await swallow(a.prompt({ sessionId, prompt: text("another") }));
    const s2 = await a.newSession({ cwd: repo, mcpServers: [] });
    await swallow(a.prompt({ sessionId: s2.sessionId, prompt: text("new task") }));
    await swallow(a.loadSession({ sessionId: "task_e_sec", cwd: repo, mcpServers: [] }));
  });

  await test("secrecy: Claude success and failure paths, with secrets in error bodies and startup errors", async () => {
    const repo = await makeRepo({ origin: null });
    let fail = false;
    mockFetch([
      ["GET", new RegExp(`^${AN}/v1/environment_providers$`), () => json({ environments: [{ environment_id: "env_cloud", name: "Default", kind: "anthropic_cloud" }] })],
      ["GET", new RegExp(`^${AN}/v1/models$`), () => json({ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] })],
      ["POST", new RegExp(`^${AN}/v1/files$`), () => (fail ? new Response(CANARY.serverBody, { status: 500 }) : json({ id: "file_sec" }))],
      ["POST", new RegExp(`^${AN}/v1/sessions$`), () => json({ id: "session_sec", title: "t" })],
      ["POST", new RegExp(`^${AN}/v1/code/sessions/cse_sec/events$`), () => (fail ? json({ error: { type: "invalid_request_error", message: CANARY.serverBody } }, 400) : json({ results: [{ sequence_num: "2" }] }))],
      ["GET", new RegExp(`^${AN}/v1/code/sessions/cse_sec/events/stream$`), (req) => sse([{ event: "client_event", id: "9", data: { sequence_num: "9", source: "worker", payload: { type: "result", subtype: "success", is_error: false } } }])],
      ["GET", new RegExp(`^${AN}/v1/code/sessions/cse_sec$`), () => (fail ? json({ error: { message: CANARY.serverBody } }, 502)
        : json({ session: { id: "cse_sec", worker_status: "idle", title: "t", external_metadata: { last_init_error: CANARY.initError } } }))],
    ]);
    const a = new MeghaAgent(fakeConn(), new ClaudeBackend({ statusPollMs: 50 }), { env: {} });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    await swallow(a.prompt({ sessionId, prompt: text("hello") }));
    await swallow(a.prompt({ sessionId, prompt: text("/status") }));
    fail = true;
    await swallow(a.prompt({ sessionId, prompt: text("/status") }));
    await swallow(a.prompt({ sessionId, prompt: text("again") }));
    const s2 = await a.newSession({ cwd: repo, mcpServers: [] });
    await swallow(a.prompt({ sessionId: s2.sessionId, prompt: text("new") }));
  });

  await test("secrecy: failed cloud turns (SSE error events, failed turn/completed, polled failures, Claude results) with canary diagnostics", async () => {
    const diag = `${CANARY.serverBody} env_vars={"API_KEY":"${CANARY.envSecret}"}`;
    // Codex: a turn that fails on the stream, then one that fails as seen by the poller.
    const repo = await makeRepo({ origin: "https://github.com/acme/sec.git" });
    let gets = 0, posts = 0;
    const failedTurn = (id) => ({ task: { id: "task_e_fail", title: "t", current_turn_id: id },
      current_assistant_turn: { id, turn_status: "failed", environment_id: "env_sec", environment: secretEnv, error: { code: CANARY.serverBody, message: diag },
        output_items: [{ type: "message", content: [{ content_type: "text", text: "partial" }] }] } });
    mockFetch([
      ["GET", new RegExp(`^${CX}/wham/models$`), () => json({ models: [{ slug: "gpt-5.6-sol", display_name: "Sol", visibility: "list" }] })],
      ["GET", new RegExp(`^${CX}/wham/environments/by-repo/github/`), () => json([secretEnv])],
      ["POST", new RegExp(`^${CX}/wham/tasks$`), () => json({ turn: { id: `task_e_fail~assttrn_e_${++posts + 1}` } })],
      ["GET", new RegExp(`^${CX}/wham/tasks/task_e_fail/turns/task_e_fail~assttrn_e_2/stream$`), () => sse([thread("turn/started"),
        thread("error", { error: { message: diag, codexErrorInfo: { httpConnectionFailed: { body: diag } } }, willRetry: false }),
        thread("turn/completed", { turn: { status: "failed", error: { message: diag, additionalDetails: diag } } })])],
      ["GET", new RegExp(`^${CX}/wham/tasks/task_e_fail/turns/[^/]+/stream$`), (req) => new Response(new ReadableStream({ start(c) { req.signal?.addEventListener("abort", () => { try { c.error(new DOMException("aborted", "AbortError")); } catch {} }); } }))],
      ["GET", new RegExp(`^${CX}/wham/tasks/task_e_fail$`), () => json(++gets === 1 ? failedTurn("task_e_fail~assttrn_e_1") : failedTurn(`task_e_fail~assttrn_e_${posts + 1}`))],
    ]);
    const a = new MeghaAgent(fakeConn(), new CodexBackend({ pollMs: 50 }), { env: {} });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    a.sessions.get(sessionId).cloudId = "task_e_fail";
    await swallow(a.prompt({ sessionId, prompt: text("fails on the stream") }));
    await swallow(a.prompt({ sessionId, prompt: text("fails on the poll") }));
    await swallow(a.loadSession({ sessionId: "task_e_fail", cwd: repo, mcpServers: [] }));

    // Claude: failed results with the cloud's text in result.result, error subtypes megha doesn't know.
    const crepo = await makeRepo({ origin: null });
    let seq = 10;
    const results = [{ subtype: "error_during_execution", is_error: true, result: diag }, { subtype: `error_${CANARY.serverBody}`, is_error: true, result: diag }, { subtype: "success", is_error: true, result: diag }];
    mockFetch([
      ["GET", new RegExp(`^${AN}/v1/environment_providers$`), () => json({ environments: [{ environment_id: "env_cloud", name: "Default", kind: "anthropic_cloud" }] })],
      ["GET", new RegExp(`^${AN}/v1/models$`), () => json({ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] })],
      ["POST", new RegExp(`^${AN}/v1/code/sessions/cse_fail/events$`), () => json({ results: [{ sequence_num: String(seq += 10) }] })],
      ["GET", new RegExp(`^${AN}/v1/code/sessions/cse_fail/events/stream$`), () => sse([{ event: "client_event", id: String(seq + 1), data: { sequence_num: String(seq + 1), source: "worker", payload: { type: "result", ...results.shift() } } }])],
      ["GET", new RegExp(`^${AN}/v1/code/sessions/cse_fail$`), () => json({ session: { id: "cse_fail", worker_status: "idle", title: "t", external_metadata: { last_init_error: diag } } })],
    ]);
    const c = new MeghaAgent(fakeConn(), new ClaudeBackend({ statusPollMs: 60_000 }), { env: {} });
    const cs = await c.newSession({ cwd: crepo, mcpServers: [] });
    const sess = c.sessions.get(cs.sessionId);
    Object.assign(sess, { cloudId: "cse_fail", bundle: true, repoChecked: true, sentMode: sess.config.mode, sentModel: sess.config.model });
    for (let i = 0; i < 3; i++) await swallow(c.prompt({ sessionId: cs.sessionId, prompt: text(`fails ${i}`) }));
  });

  await test("secrecy: no canary in stdout, stderr, ACP traffic or persisted files of the whole run", () => {
    const canaries = [...Object.values(CANARY), logins.codexToken, logins.claudeToken];
    const sources = [
      ["stdout", stdio.out.join("")],
      ["stderr", stdio.err.join("")],
      ["ACP notifications and errors", JSON.stringify(acpCaptured)],
      ...filesUnder(DATA_DIR).map((f) => [f, readFileSync(f, "utf8")]),
    ];
    assert.ok(acpCaptured.length > 0 && stdio.err.length > 0, "something was captured");
    const leaks = [];
    for (const [where, content] of sources) {
      canaries.forEach((c, i) => { if (content.includes(c)) leaks.push(`canary #${i} in ${where}`); });
      for (const re of [/"(?:access|refresh|id)_token"/, /"(?:access|refresh)Token"/, /"env_vars"\s*:\s*\{\s*"/, /"secrets"\s*:\s*\{\s*"/]) if (re.test(content)) leaks.push(`${re} in ${where}`);
    }
    // Never print the canary itself: the message names only where it was found.
    assert.deepEqual(leaks, []);
  });
}
