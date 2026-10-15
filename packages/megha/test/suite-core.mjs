// Diff helpers, local apply, ACP schema shapes, the data store, small utilities, the T3 MCP client,
// the stdout-is-protocol rule, and the no-secrets-in-fixtures rule.

import { writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { zSessionNotification, zInitializeResponse, zNewSessionResponse, zListSessionsResponse } from "../node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { git, migrateLegacyStore, saveHint, loadHint, hintKey, setupCommandsFor, localChanges, localPatch, repoInfo, findPullRequestUrl, DATA_DIR, loadSessionRecord } from "../lib/util.mjs";
import { diffFiles, codexChangesToPatch, diffToolCall, applyLocally } from "../lib/diff.mjs";
import { imageSize } from "../lib/image.mjs";
import { callT3Tool, linkPullRequest, t3McpFrom } from "../lib/t3mcp.mjs";
import { test, tmp, makeRepo, mockFetch, json, sse, PNG_1x1 } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export async function run({ root, logins }) {
  const dir = await makeRepo({ origin: null, files: { "a.txt": "one\ntwo\nthree\n" } });
  const readText = (f) => readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n");
  let applied = null;

  const patch = codexChangesToPatch([
    { path: "a.txt", kind: { type: "update", move_path: null }, diff: "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n" },
    { path: "b.txt", kind: { type: "add" }, diff: "hello\nworld\n" },
  ]);
  await test("codexChangesToPatch + diffFiles", () => {
    assert.deepEqual(diffFiles(patch).map((f) => [f.path, f.added, f.removed]), [["a.txt", 1, 1], ["b.txt", 2, 0]]);
  });
  const call = diffToolCall({ toolCallId: "diff:1", diff: patch, cwd: dir });
  await test("diffToolCall renders the whole patch as an edit", () => {
    assert.equal(call.kind, "edit"); assert.equal(call.rawOutput, patch);
    assert.equal(call.title, "Cloud diff: 2 files (+3 -1)");
  });
  await test("applyLocally: clean apply leaves the index alone", async () => {
    applied = await applyLocally({ cwd: dir, diff: patch, name: "t1" });
    assert.ok(applied.ok, applied.message);
    assert.equal(readText("a.txt"), "one\nTWO\nthree\n");
    assert.equal(readText("b.txt"), "hello\nworld\n");
    assert.equal((await git(dir, ["diff", "--cached", "--name-only"])).stdout.trim(), "");
  });
  await test("applyLocally: a newer cumulative diff replaces the applied one", async () => {
    const patch2 = codexChangesToPatch([{ path: "a.txt", kind: { type: "update" }, diff: "@@ -1,3 +1,3 @@\n one\n-two\n+Two!\n three\n" }]);
    const r = await applyLocally({ cwd: dir, diff: patch2, name: "t2", previousFile: applied.patchFile });
    assert.ok(r.ok, r.message);
    assert.equal(readText("a.txt"), "one\nTwo!\nthree\n");
    assert.equal((await git(dir, ["status", "--porcelain", "--", "b.txt"])).stdout.trim(), "");
  });
  await test("applyLocally: refuses on conflict and changes nothing", async () => {
    writeFileSync(join(dir, "a.txt"), "local edit\n");
    const p3 = codexChangesToPatch([{ path: "a.txt", kind: { type: "update" }, diff: "@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n" }]);
    const r = await applyLocally({ cwd: dir, diff: p3, name: "t3" });
    assert.equal(r.ok, false);
    assert.equal(readText("a.txt"), "local edit\n");
  });

  await test("session/update shapes are valid ACP v1 (incl. commands + config updates)", () => {
    const updates = [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "prompt" } },
      { sessionUpdate: "tool_call", toolCallId: "x", title: "ls", kind: "execute", status: "in_progress", rawInput: { command: "ls" } },
      { sessionUpdate: "tool_call_update", toolCallId: "x", status: "completed", rawOutput: { output: "a\nb", exitCode: 0 } },
      { sessionUpdate: "tool_call", toolCallId: "e", title: "Edit a", kind: "edit", status: "in_progress", locations: [{ path: "C:\\x\\a" }], content: [{ type: "diff", path: "C:\\x\\a", oldText: "a", newText: "b" }], rawInput: {} },
      call,
      { sessionUpdate: "plan", entries: [{ content: "step", priority: "medium", status: "in_progress" }] },
      { sessionUpdate: "usage_update", used: 12310, size: 353400 },
      { sessionUpdate: "usage_update", used: 5, size: 0, cost: { amount: 0.1, currency: "USD" } },
      { sessionUpdate: "session_info_update", title: "t", updatedAt: new Date().toISOString() },
      { sessionUpdate: "available_commands_update", availableCommands: [{ name: "pr", description: "Open a PR", input: { hint: "draft" } }, { name: "open", description: "Open" }] },
      { sessionUpdate: "config_option_update", configOptions: [{ id: "environment", name: "Environment", type: "select", currentValue: "e1", options: [{ value: "e1", name: "widget" }] }] },
    ];
    for (const u of updates) {
      const res = zSessionNotification.safeParse({ sessionId: "s", update: u });
      assert.ok(res.success, `${u.sessionUpdate}: ${res.error?.message}`);
    }
    const opt = (id, cat) => ({ id, name: id, ...(cat ? { category: cat } : {}), type: "select", currentValue: "a", options: [{ value: "a", name: "A", description: "d" }] });
    assert.ok(zNewSessionResponse.safeParse({ sessionId: "s", configOptions: [opt("environment"), opt("mode", "mode"), opt("model", "model")] }).success);
    assert.ok(zListSessionsResponse.safeParse({ sessions: [{ sessionId: "task_e_1", cwd: "C:\\x", title: "t", updatedAt: new Date().toISOString(), _meta: { status: "completed" } }], nextCursor: "c" }).success);
    assert.ok(zInitializeResponse.safeParse({ protocolVersion: 1, agentInfo: { name: "megha-codex", title: "Megha · Codex Cloud", version: "1" },
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, mcpCapabilities: { http: false, sse: false }, sessionCapabilities: { list: {}, resume: {} } }, authMethods: [] }).success);
  });

  await test("imageSize: PNG, GIF, JPEG headers", () => {
    assert.deepEqual(imageSize(Buffer.from(PNG_1x1, "base64")), { width: 1, height: 1 });
    const gif = Buffer.alloc(32); gif.write("GIF89a"); gif.writeUInt16LE(640, 6); gif.writeUInt16LE(480, 8);
    assert.deepEqual(imageSize(gif), { width: 640, height: 480 });
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(imageSize(jpg), { width: 640, height: 480 });
  });

  await test("data dir is the test folder, and a cloud-acp store migrates once", () => {
    assert.ok(DATA_DIR.startsWith(root), DATA_DIR);
    const legacyDir = join(root, "legacy"); mkdirSync(legacyDir, { recursive: true });
    const legacy = join(legacyDir, "sessions.json");
    writeFileSync(legacy, JSON.stringify({ sessions: { ca_1: { id: "ca_1", backend: "codex", cloudId: "task_e_old" } } }));
    assert.equal(migrateLegacyStore({ from: legacy }), true);
    assert.equal(loadSessionRecord("ca_1").cloudId, "task_e_old");
    assert.equal(migrateLegacyStore({ from: legacy }), false, "second run is a no-op");
  });

  await test("thread hints are keyed by a hash, never the credential", () => {
    const key = hintKey("C:\\Repo", "Bearer secret-token-123");
    assert.match(key, /^[0-9a-f]{32}$/);
    saveHint(key, { backend: "codex", sessionId: "mg_1", cloudId: "task_e_1" });
    assert.equal(loadHint(key).cloudId, "task_e_1");
    assert.equal(hintKey("c:\\repo", "Bearer secret-token-123"), key, "cwd case does not matter on Windows");
    assert.ok(!readFileSync(join(DATA_DIR, "sessions.json"), "utf8").includes("secret-token-123"));
  });

  await test("setupCommandsFor picks the install command from the lockfile", () => {
    const has = (names) => (p) => names.some((n) => p.endsWith(n));
    assert.deepEqual(setupCommandsFor("/r", has(["bun.lock"])), ["bun install"]);
    assert.deepEqual(setupCommandsFor("/r", has(["pnpm-lock.yaml"])), ["pnpm i"]);
    assert.deepEqual(setupCommandsFor("/r", has(["package-lock.json"])), ["npm ci"]);
    assert.deepEqual(setupCommandsFor("/r", has(["yarn.lock"])), ["yarn"]);
    assert.deepEqual(setupCommandsFor("/r", has([])), []);
  });

  await test("localChanges + localPatch: unpushed commit and uncommitted edit, against the merge-base", async () => {
    const r = await makeRepo({ files: { "a.txt": "one\n", "b.txt": "b\n" } });
    let info = await localChanges(r, await repoInfo(r));
    assert.equal(info.any, false, "clean and pushed");
    writeFileSync(join(r, "c.txt"), "c\n"); await git(r, ["add", "c.txt"]); await git(r, ["commit", "-qm", "local"]);
    writeFileSync(join(r, "a.txt"), "ONE\n");
    writeFileSync(join(r, "untracked.txt"), "never sent\n");
    info = await localChanges(r, await repoInfo(r));
    assert.equal(info.unpushed, 1); assert.deepEqual(info.dirty, ["a.txt"]); assert.equal(info.any, true);
    const p = await localPatch(r, info);
    assert.deepEqual(diffFiles(p).map((f) => f.path).sort(), ["a.txt", "c.txt"]);
    const b = await makeRepo(); await git(b, ["checkout", "-qb", "feature"]);
    assert.equal((await localChanges(b, await repoInfo(b))).any, true, "branch not on origin defaults to sending local changes");
  });

  await test("findPullRequestUrl finds a PR link in nested API JSON", () => {
    assert.equal(findPullRequestUrl({ a: [{ b: { url: "https://github.com/o/r/pull/12" } }] }), "https://github.com/o/r/pull/12");
    assert.equal(findPullRequestUrl({ url: "https://github.com/o/r/compare/x" }), null);
  });

  await test("T3 MCP: link_pull_request goes through initialize -> tools/call with the thread credential", async () => {
    const seen = [];
    mockFetch([["POST", /^127\.0\.0\.1:4321\/mcp$/, (req) => {
      seen.push({ method: req.body.method, auth: req.headers.authorization, session: req.headers["mcp-session-id"] });
      if (req.body.method === "initialize") return json({ jsonrpc: "2.0", id: req.body.id, result: { protocolVersion: "2025-06-18" } }, 200, { "mcp-session-id": "mcp-s1" });
      if (req.body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return sse([{ jsonrpc: "2.0", id: req.body.id, result: { content: [{ type: "text", text: "{}" }] } }]);
    }]]);
    const t3 = t3McpFrom([{ name: "t3-code", command: "t3", args: [], env: [{ name: "T3_ACP_MCP_ENDPOINT", value: "http://127.0.0.1:4321/mcp" }, { name: "T3_ACP_MCP_AUTHORIZATION", value: "Bearer abc" }] }], {});
    assert.equal(await linkPullRequest(t3, "https://github.com/o/r/pull/3"), "Linked the pull request to this thread in T3 Code.");
    assert.deepEqual(seen.map((s) => s.method), ["initialize", "notifications/initialized", "tools/call"]);
    assert.ok(seen.every((s) => s.auth === "Bearer abc"));
    assert.equal(seen[2].session, "mcp-s1");
    assert.equal(t3McpFrom([], {}), null);
    await assert.rejects(callT3Tool(null, "x", {}), /not available/);
  });

  await test("stdout carries only JSON-RPC (initialize through the real entry point)", async () => {
    const child = spawn(process.execPath, [join(here, "..", "index.mjs"), "--backend", "codex"], { env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }) + "\n");
    const deadline = Date.now() + 10_000;
    while (!out.includes("\n") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    child.stdin.end();
    await new Promise((r) => { child.once("exit", r); setTimeout(() => { child.kill(); r(); }, 3000).unref(); });
    const lines = out.split("\n").filter(Boolean);
    assert.ok(lines.length >= 1, `no response; stderr: ${err.slice(0, 300)}`);
    for (const l of lines) JSON.parse(l);
    const init = JSON.parse(lines[0]).result;
    assert.equal(init.agentInfo.title, "Megha · Codex Cloud");
    assert.equal(init.agentCapabilities.promptCapabilities.image, true);
    assert.match(err, /\[megha:codex\] ready/);
  });

  await test("megha --version / --help / doctor print without tokens", async () => {
    const runCli = (args) => new Promise((resolve) => {
      const c = spawn(process.execPath, [join(here, "..", "index.mjs"), ...args], { env: { ...process.env }, windowsHide: true });
      let o = ""; c.stdout.on("data", (d) => { o += d; }); c.on("exit", (code) => resolve({ code, o }));
    });
    const v = await runCli(["--version"]);
    assert.match(v.o.trim(), /^\d+\.\d+\.\d+$/);
    assert.match((await runCli(["--help"])).o, /megha doctor/);
    const d = await runCli(["doctor"]);
    assert.equal(d.code, 0, d.o);
    assert.match(d.o, /ok\s+codex login/); assert.match(d.o, /ok\s+claude login/);
    assert.ok(!d.o.includes(logins.codexToken) && !d.o.includes(logins.claudeToken), "doctor must not print tokens");
  });

  await test("fixtures and recorded streams hold no tokens or secrets", () => {
    const files = [...readdirSync(join(here, "fixtures")).filter((f) => f.endsWith(".json")).map((f) => join(here, "fixtures", f)),
      ...readdirSync(here).filter((f) => f.endsWith(".jsonl")).map((f) => join(here, f))];
    assert.ok(files.length >= 1);
    const bad = [/sk-ant-[a-z]{2,4}\d{2}-/, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, /"(?:access|refresh|id)_token"/, /"env_vars"\s*:\s*\{\s*"/, /"secrets"\s*:\s*\{\s*"/, /gh[pousr]_[A-Za-z0-9]{20,}/];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const re of bad) assert.ok(!re.test(text), `${f} matches ${re}`);
    }
    if (existsSync(join(DATA_DIR, "sessions.json"))) {
      const store = readFileSync(join(DATA_DIR, "sessions.json"), "utf8");
      assert.ok(!store.includes(logins.codexToken) && !store.includes(logins.claudeToken));
    }
  });
}
