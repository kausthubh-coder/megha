// Offline checks (no network): diff helpers + local apply on a throwaway git repo, and every
// update shape we emit validated against the SDK's ACP v1 zod schema.
//   node test/offline.mjs

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { zSessionNotification, zInitializeResponse, zNewSessionResponse, zListSessionsResponse } from "../node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { git } from "../lib/util.mjs";
import { diffFiles, codexChangesToPatch, diffToolCall, applyLocally } from "../lib/diff.mjs";

const dir = mkdtempSync(join(tmpdir(), "cloud-acp-test-"));
const ok = (m) => console.log(`ok  ${m}`);
// core.autocrlf may turn LF into CRLF on apply, exactly as on a checkout.
const readText = (f) => readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n");
try {
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@example.com"]); await git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  await git(dir, ["add", "."]); await git(dir, ["commit", "-qm", "init"]);

  // Codex fileChange item -> patch
  const patch = codexChangesToPatch([
    { path: "a.txt", kind: { type: "update", move_path: null }, diff: "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n" },
    { path: "b.txt", kind: { type: "add" }, diff: "hello\nworld\n" },
  ]);
  const files = diffFiles(patch);
  assert.deepEqual(files.map((f) => [f.path, f.added, f.removed]), [["a.txt", 1, 1], ["b.txt", 2, 0]]);
  ok("codexChangesToPatch + diffFiles");

  const call = diffToolCall({ toolCallId: "diff:1", diff: patch, cwd: dir });
  assert.equal(call.kind, "edit"); assert.equal(call.rawOutput, patch);
  assert.equal(call.title, "Cloud diff: 2 files (+3 -1)");
  ok("diffToolCall");

  let r = await applyLocally({ cwd: dir, diff: patch, name: "t1" });
  assert.ok(r.ok, r.message);
  assert.equal(readText("a.txt"), "one\nTWO\nthree\n");
  assert.equal(readText("b.txt"), "hello\nworld\n");
  assert.equal((await git(dir, ["diff", "--cached", "--name-only"])).stdout.trim(), "", "index must stay untouched");
  ok(`applyLocally clean apply: ${r.message}`);

  // A newer cumulative diff replaces the applied one.
  const patch2 = codexChangesToPatch([
    { path: "a.txt", kind: { type: "update" }, diff: "@@ -1,3 +1,3 @@\n one\n-two\n+Two!\n three\n" },
  ]);
  r = await applyLocally({ cwd: dir, diff: patch2, name: "t2", previousFile: r.patchFile });
  assert.ok(r.ok, r.message);
  assert.equal(readText("a.txt"), "one\nTwo!\nthree\n");
  assert.equal((await git(dir, ["status", "--porcelain", "--", "b.txt"])).stdout.trim(), "", "b.txt from the old diff is gone");
  ok(`applyLocally swap: ${r.message}`);

  // Conflict with local edits: nothing changes.
  writeFileSync(join(dir, "a.txt"), "local edit\n");
  const patch3 = codexChangesToPatch([{ path: "a.txt", kind: { type: "update" }, diff: "@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n" }]);
  r = await applyLocally({ cwd: dir, diff: patch3, name: "t3" });
  assert.equal(r.ok, false);
  assert.equal(readText("a.txt"), "local edit\n");
  ok(`applyLocally refuses on conflict: ${r.message.slice(0, 90)}...`);

  // Schema validation of representative updates (shapes copied from what the backends emit).
  const updates = [
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "prompt" } },
    { sessionUpdate: "tool_call", toolCallId: "x", title: "ls", kind: "execute", status: "in_progress", rawInput: { command: "ls" } },
    { sessionUpdate: "tool_call_update", toolCallId: "x", status: "completed", rawOutput: { output: "a\nb", exitCode: 0 } },
    { sessionUpdate: "tool_call", toolCallId: "e", title: "Edit a", kind: "edit", status: "in_progress", locations: [{ path: "C:\\x\\a" }], content: [{ type: "diff", path: "C:\\x\\a", oldText: "a", newText: "b" }], rawInput: {} },
    { sessionUpdate: "tool_call", toolCallId: "w", title: "Write", kind: "edit", status: "in_progress", content: [{ type: "diff", path: "C:\\x\\n", oldText: null, newText: "new" }] },
    call,
    { sessionUpdate: "plan", entries: [{ content: "step", priority: "medium", status: "in_progress" }] },
    { sessionUpdate: "usage_update", used: 12310, size: 353400 },
    { sessionUpdate: "usage_update", used: 5, size: 0, cost: { amount: 0.1, currency: "USD" } },
    { sessionUpdate: "session_info_update", title: "t", updatedAt: new Date().toISOString() },
  ];
  for (const u of updates) {
    const res = zSessionNotification.safeParse({ sessionId: "s", update: u });
    assert.ok(res.success, `${u.sessionUpdate}: ${res.error?.message}`);
  }
  ok(`${updates.length} session/update shapes valid against ACP v1 schema`);

  const opt = (id, cat) => ({ id, name: id, ...(cat ? { category: cat } : {}), type: "select", currentValue: "a", options: [{ value: "a", name: "A", description: "d" }] });
  assert.ok(zNewSessionResponse.safeParse({ sessionId: "s", configOptions: [opt("environment"), opt("mode", "mode"), opt("model", "model")] }).success);
  assert.ok(zListSessionsResponse.safeParse({ sessions: [{ sessionId: "task_e_1", cwd: "C:\\x", title: "t", updatedAt: new Date().toISOString(), _meta: { status: "completed" } }], nextCursor: "c" }).success);
  assert.ok(zInitializeResponse.safeParse({ protocolVersion: 1, agentInfo: { name: "n", title: "t", version: "1" },
    agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true }, mcpCapabilities: { http: false, sse: false }, sessionCapabilities: { list: {}, resume: {} } }, authMethods: [] }).success);
  ok("initialize / session/new / session/list responses valid");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
