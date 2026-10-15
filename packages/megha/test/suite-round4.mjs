// Regression tests for GPT-6-Astra's round-4 release check at 7a417b5: blockers 1-3. Each test replays
// Astra's scenario through the real agent and backends (mocked HTTP, temp git repos) and asserts what
// reaches the client over ACP.

import assert from "node:assert/strict";
import { MeghaAgent } from "../lib/agent.mjs";
import { CodexBackend } from "../lib/codex.mjs";
import { ClaudeBackend } from "../lib/claude.mjs";
import { git, saveSessionRecord, loadSessionRecord } from "../lib/util.mjs";
import { test, makeRepo, mockFetch, json, sse, deferred, wait, fakeConn, CANARY } from "./harness.mjs";
import { until, codexEnv, codexBase, details, doneStream, claudeBase, crow, keepaliveSse, readA } from "./suite-hardening.mjs";

const text = (t) => [{ type: "text", text: t }];
const hung = (p, ms = 5000) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), wait(ms).then(() => "hung")]);
const claudeEventKind = (req) => {
  const p = req.body?.events?.at(-1)?.payload ?? {};
  return p.type === "control_request" ? p.request?.subtype : p.type;
};
const diffOf = (from, to, file = "a.txt") => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
const STILL_RUNNING = /previous .* turn is still running; wait or use \/status/;
const NOT_SEEN = /hasn't seen the last turn end/;
// Agent message text sent to the client for this session, from note `from` on.
const shown = (conn, sessionId, from = 0) => conn.notes.slice(from).filter((n) => n.sessionId === sessionId && n.update.sessionUpdate === "agent_message_chunk").map((n) => n.update.content.text).join("");
const refusal = async (p) => {
  const r = await hung(p, 5000);
  assert.ok(r !== "hung" && r.e, `refused (got ${r === "hung" ? "a prompt that is still running" : JSON.stringify(r.v)})`);
  return r.e;
};

export async function run() {
  // ============ 1. a fresh cloud response beats the saved state, in both directions ============
  await test("R4-1 codex: a saved idle task the cloud reports running (continued on the web) is reconciled on resume; no follow-up is sent", async () => {
    const repo = await makeRepo({ origin: "https://github.com/acme/r41.git" });
    const env = codexEnv("env_r41", "r41", "acme/r41");
    let cur = { turn: "task_e_r41~assttrn_e_1", status: "completed" };
    let followUps = 0;
    mockFetch(codexBase([env], [
      ["GET", /task_e_r41$/, () => json(details("task_e_r41", env, cur))],
      ["POST", /\/wham\/tasks$/, () => { followUps++; const id = `task_e_r41~assttrn_e_${followUps + 2}`; cur = { turn: id, status: "in_progress" }; return json({ turn: { id } }); }],
      ["GET", /task_e_r41\/turns\/[^/]+\/stream$/, () => doneStream("done")],
    ]));
    // A session megha saw end, saved as idle.
    const a1 = new MeghaAgent(fakeConn(), new CodexBackend({ pollMs: 60_000 }), { env: {} });
    const { sessionId } = await a1.newSession({ cwd: repo, mcpServers: [] });
    const s1 = a1.sessions.get(sessionId);
    Object.assign(s1, { cloudId: "task_e_r41", cloudState: "idle", turnId: cur.turn, doneTurnId: cur.turn, createdIn: repo });
    saveSessionRecord(s1);
    // The task is continued on chatgpt.com: a new turn is running there.
    cur = { turn: "task_e_r41~assttrn_e_2", status: "in_progress" };
    const conn = fakeConn();
    const a2 = new MeghaAgent(conn, new CodexBackend({ pollMs: 60_000 }), { env: {} });
    await a2.resumeSession({ sessionId, cwd: repo, mcpServers: [] });
    assert.equal(a2.sessions.get(sessionId).cloudState, "running", "resume takes the cloud's running over the saved idle");
    assert.equal(loadSessionRecord(sessionId).cloudState, "running", "and saves it");
    await a2.prompt({ sessionId, prompt: text("/status") });
    assert.match(shown(conn, sessionId), /Status: in_progress/);
    assert.match(shown(conn, sessionId), NOT_SEEN, "/status says new prompts wait");
    const e = await refusal(a2.prompt({ sessionId, prompt: text("hello") }));
    assert.match(e.message, STILL_RUNNING);
    assert.equal(followUps, 0, "no follow-up over the turn running on the web");
    cur = { ...cur, status: "completed" };
    assert.equal((await a2.prompt({ sessionId, prompt: text("hello again") })).stopReason, "end_turn");
    assert.equal(followUps, 1);
  });

  await test("R4-1 claude: a saved idle session the cloud reports running is reconciled on resume; no prompt is sent", async () => {
    const repo = await makeRepo({ origin: null });
    let worker = "idle", users = 0;
    mockFetch(claudeBase([
      ["POST", /cse_r41\/events$/, (req) => { if (claudeEventKind(req) === "user") { users++; worker = "running"; } return json({ results: [{ sequence_num: "50" }] }); }],
      ["GET", /cse_r41\/events\/stream$/, () => sse([crow(60, { type: "result", subtype: "success", is_error: false })])],
      ["GET", /cse_r41$/, () => json({ session: { id: "cse_r41", worker_status: worker, config: { sources: [] } } })],
    ]));
    const a1 = new MeghaAgent(fakeConn(), new ClaudeBackend({ statusPollMs: 60_000 }), { env: {} });
    const { sessionId } = await a1.newSession({ cwd: repo, mcpServers: [] });
    const s1 = a1.sessions.get(sessionId);
    Object.assign(s1, { cloudId: "cse_r41", bundle: true, createdIn: repo, cloudState: "idle", lastSeq: 40, sentMode: s1.config.mode, sentModel: s1.config.model });
    saveSessionRecord(s1);
    worker = "running"; // someone sent a prompt from claude.ai
    const conn = fakeConn();
    const a2 = new MeghaAgent(conn, new ClaudeBackend({ statusPollMs: 60_000 }), { env: {} });
    await a2.resumeSession({ sessionId, cwd: repo, mcpServers: [] });
    assert.equal(a2.sessions.get(sessionId).cloudState, "running", "resume takes the cloud's running over the saved idle");
    await a2.prompt({ sessionId, prompt: text("/status") });
    assert.match(shown(conn, sessionId), /Status: running/);
    assert.match(shown(conn, sessionId), NOT_SEEN);
    const e = await refusal(a2.prompt({ sessionId, prompt: text("hello") }));
    assert.match(e.message, STILL_RUNNING);
    assert.equal(users, 0, "no prompt over the running turn");
    worker = "idle";
    assert.equal((await a2.prompt({ sessionId, prompt: text("hello again") })).stopReason, "end_turn");
    assert.equal(users, 1);
  });

  await test("R4-1 claude: a bound session whose cached idle went stale is checked before the next prompt", async () => {
    const repo = await makeRepo({ origin: null });
    let worker = "idle", users = 0;
    mockFetch(claudeBase([
      ["POST", /cse_r41b\/events$/, (req) => { if (claudeEventKind(req) === "user") users++; return json({ results: [{ sequence_num: "50" }] }); }],
      ["GET", /cse_r41b\/events\/stream$/, () => sse([crow(60, { type: "result", subtype: "success", is_error: false })])],
      ["GET", /cse_r41b$/, () => json({ session: { id: "cse_r41b", worker_status: worker, config: { sources: [] } } })],
    ]));
    const a = new MeghaAgent(fakeConn(), new ClaudeBackend({ statusPollMs: 60_000 }), { env: {} });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    const s = a.sessions.get(sessionId);
    Object.assign(s, { cloudId: "cse_r41b", bundle: true, repoChecked: true, createdIn: repo, cloudState: "idle", sentMode: s.config.mode, sentModel: s.config.model });
    worker = "running"; // another client started a turn after megha last looked
    const e = await refusal(a.prompt({ sessionId, prompt: text("hello") }));
    assert.match(e.message, STILL_RUNNING);
    assert.equal(users, 0);
    assert.equal(s.cloudState, "running");
  });

  // ============ 2. a checkout left needing recovery is always reported, even after Stop ============
  // Astra's probe: /apply through the real agent, Stop while `git apply` runs, then git's time limit
  // kills it halfway through. The answer to T3 was already `cancelled` (muted), so the warning must
  // travel through the session's durable notices.
  const cancelledPartialApply = async (label) => {
    const repo = await makeRepo({ origin: `https://github.com/acme/${label}.git`, files: { "a.txt": "one\n", "b.txt": "bee\n" } });
    const env = codexEnv(`env_${label}`, label, `acme/${label}`);
    const diff = `${diffOf("one", "two", "a.txt")}${diffOf("bee", "bop", "b.txt")}`;
    mockFetch(codexBase([env], [
      ["GET", new RegExp(`task_e_${label}$`), () => json(details(`task_e_${label}`, env, { output_items: [{ type: "output_diff", diff }] }))],
    ]));
    const gate = deferred();
    let applying = false;
    const applyGit = async (cwd, args, o) => {
      if (args[0] === "apply" && !args.includes("--check") && !args.includes("-R")) {
        applying = true;
        await gate.promise;
        await git(cwd, ["apply", "--include=a.txt", args.at(-1)]); // one file of two written...
        return { code: -1, stdout: "", stderr: "", timedOut: true }; // ...when the time limit killed it
      }
      return git(cwd, args, o);
    };
    const conn = fakeConn();
    const a = new MeghaAgent(conn, new CodexBackend({ pollMs: 60_000, applyGit }), { env: {} });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    Object.assign(a.sessions.get(sessionId), { cloudId: `task_e_${label}`, webUrl: `https://chatgpt.com/codex/tasks/task_e_${label}`, cloudState: "idle", createdIn: repo });
    const p = a.prompt({ sessionId, prompt: text("/apply") });
    await until(() => applying);
    await a.cancel({ sessionId });
    assert.equal((await p).stopReason, "cancelled");
    gate.resolve();
    await a.sessions.get(sessionId).turn.settled;
    assert.equal(readA(repo), "two\n", "the checkout really is partly changed");
    return { a, conn, sessionId, repo };
  };
  const PARTLY = /partly changed/;

  await test("R4-2 codex: Stop during /apply, then a timeout-killed git apply: the next prompt shows the recovery warning", async () => {
    const { a, conn, sessionId } = await cancelledPartialApply("r42");
    assert.doesNotMatch(shown(conn, sessionId), PARTLY, "(muted: T3 already had its answer)");
    const from = conn.notes.length;
    assert.equal((await a.prompt({ sessionId, prompt: text("/open") })).stopReason, "end_turn");
    const next = shown(conn, sessionId, from);
    assert.match(next, PARTLY, "the warning reaches the user on the next prompt");
    assert.match(next, /task_e_r42-[^ ]*\.patch/, "with the saved patch");
    assert.match(next, /git -C .* apply /, "and the commands to recover");
    const from2 = conn.notes.length;
    await a.prompt({ sessionId, prompt: text("/open") });
    assert.doesNotMatch(shown(conn, sessionId, from2), PARTLY, "shown once");
  });

  await test("R4-2 codex: the recovery warning survives a restart and shows on the first prompt after it", async () => {
    const { sessionId, repo } = await cancelledPartialApply("r42r");
    const conn = fakeConn();
    const a2 = new MeghaAgent(conn, new CodexBackend({ pollMs: 60_000 }), { env: {} });
    await a2.resumeSession({ sessionId, cwd: repo, mcpServers: [] });
    await a2.prompt({ sessionId, prompt: text("/open") });
    assert.match(shown(conn, sessionId), PARTLY);
    assert.deepEqual(loadSessionRecord(sessionId).notices ?? [], [], "cleared once shown");
  });

  // ============ 3. one reading of the cloud's state: a failed session is ended, with a way forward ============
  await test("R4-3 claude: a session the cloud reports failed (startup) is not 'still running' after a restart", async () => {
    const repo = await makeRepo({ origin: null });
    let users = 0;
    mockFetch(claudeBase([
      ["POST", /cse_r43\/events$/, (req) => { if (claudeEventKind(req) === "user") users++; return json({ results: [{ sequence_num: "50" }] }); }],
      ["GET", /cse_r43\/events\/stream$/, (req) => keepaliveSse(req.signal)],
      ["GET", /cse_r43\/events$/, () => json({ data: [] })],
      ["GET", /cse_r43$/, () => json({ session: { id: "cse_r43", status: "failed", config: { sources: [] }, external_metadata: { last_init_error: CANARY.initError } } })],
    ]));
    const a1 = new MeghaAgent(fakeConn(), new ClaudeBackend({ statusPollMs: 60_000 }), { env: {} });
    const { sessionId } = await a1.newSession({ cwd: repo, mcpServers: [] });
    const s1 = a1.sessions.get(sessionId);
    Object.assign(s1, { cloudId: "cse_r43", bundle: true, createdIn: repo, cloudState: "unknown", sentMode: s1.config.mode, sentModel: s1.config.model });
    saveSessionRecord(s1);
    const conn = fakeConn();
    const a2 = new MeghaAgent(conn, new ClaudeBackend({ statusPollMs: 100 }), { env: {} });
    await a2.resumeSession({ sessionId, cwd: repo, mcpServers: [] });
    assert.equal(a2.sessions.get(sessionId).cloudState, "idle", "a failed session has ended");
    let from = conn.notes.length;
    await a2.prompt({ sessionId, prompt: text("/status") });
    let out = shown(conn, sessionId, from);
    assert.match(out, /Status: failed/);
    assert.doesNotMatch(out, NOT_SEEN, "no wait for a session that failed");
    assert.match(out, /send a prompt to try again/i, "says what to do");
    assert.match(out, /claude\.ai\/code\/cse_r43/);
    // T3's automatic continuation after the restart reports the failure; it doesn't wait or resend.
    from = conn.notes.length;
    const cont = await hung(a2.prompt({ sessionId, prompt: text("Continue where you left off.") }));
    assert.ok(cont !== "hung" && !cont.e, `auto-continue answers (got ${cont === "hung" ? "hung" : cont.e?.message})`);
    out = shown(conn, sessionId, from);
    assert.match(out, /could not start/i);
    assert.match(out, /send a prompt to try again/i);
    assert.equal(users, 0, "nothing sent by the automatic continuation");
    // /apply isn't refused as "still running".
    from = conn.notes.length;
    await a2.prompt({ sessionId, prompt: text("/apply") });
    assert.match(shown(conn, sessionId, from), /seeded from a git bundle/);
    // A prompt the user sends is the retry: it goes to the cloud, and its failure says what to do.
    const retry = await hung(a2.prompt({ sessionId, prompt: text("try again") }));
    assert.equal(users, 1, "the user's prompt was sent");
    assert.ok(retry !== "hung" && retry.e, "the retry into a failed session reports the failure");
    assert.doesNotMatch(retry.e.message, STILL_RUNNING);
    assert.match(retry.e.message, /could not start/i);
  });

  await test("R4-3 codex: a task whose last turn failed shows the failure and how to retry in /status", async () => {
    const repo = await makeRepo({ origin: "https://github.com/acme/r43.git" });
    const env = codexEnv("env_r43", "r43", "acme/r43");
    mockFetch(codexBase([env], [["GET", /task_e_r43$/, () => json(details("task_e_r43", env, { status: "failed" }))]]));
    const a1 = new MeghaAgent(fakeConn(), new CodexBackend({ pollMs: 60_000 }), { env: {} });
    const { sessionId } = await a1.newSession({ cwd: repo, mcpServers: [] });
    Object.assign(a1.sessions.get(sessionId), { cloudId: "task_e_r43", cloudState: "unknown", createdIn: repo });
    saveSessionRecord(a1.sessions.get(sessionId));
    const conn = fakeConn();
    const a2 = new MeghaAgent(conn, new CodexBackend({ pollMs: 60_000 }), { env: {} });
    await a2.resumeSession({ sessionId, cwd: repo, mcpServers: [] });
    assert.equal(a2.sessions.get(sessionId).cloudState, "idle");
    await a2.prompt({ sessionId, prompt: text("/status") });
    const out = shown(conn, sessionId);
    assert.match(out, /Status: failed/);
    assert.doesNotMatch(out, NOT_SEEN);
    assert.match(out, /send a prompt to try again/i);
    assert.match(out, /chatgpt\.com\/codex\/tasks\/task_e_r43/);
  });
}
