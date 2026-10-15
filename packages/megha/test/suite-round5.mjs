// Regression tests for GPT-6-Astra's round-5 release check at ed64282: blockers 1-3. Each test replays
// Astra's scenario through the real agent and backends (mocked HTTP, temp git repos) and asserts what
// reaches the client over ACP.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MeghaAgent } from "../lib/agent.mjs";
import { CodexBackend } from "../lib/codex.mjs";
import { git, saveSessionRecord, loadSessionRecord } from "../lib/util.mjs";
import { CONTINUE_PROMPT } from "../lib/prompt.mjs";
import { test, makeRepo, mockFetch, json, wait, deferred, fakeConn } from "./harness.mjs";
import { until, codexEnv, codexBase, details, doneStream } from "./suite-hardening.mjs";
import { cancelledPartialApply, PARTLY } from "./suite-round4.mjs";

const { fixtures } = JSON.parse(readFileSync(new URL("./fixtures/t3-prompts.json", import.meta.url), "utf8"));
const text = (t) => [{ type: "text", text: t }];
const diffOf = (from, to, file = "a.txt") => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
const hung = (p, ms = 5000) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), wait(ms).then(() => "hung")]);
const shown = (conn, sessionId, from = 0) => conn.notes.slice(from).filter((n) => n.sessionId === sessionId && n.update.sessionUpdate === "agent_message_chunk").map((n) => n.update.content.text).join("");
// The saved notices' text (a notice is { id, text }; a record from before ids holds plain strings).
const savedNotices = (id) => (loadSessionRecord(id)?.notices ?? []).map((n) => n.text ?? n).join("");
// How many times the recovery warning reached the client, over every session.
const warnings = (conn) => conn.notes.filter((n) => n.update.sessionUpdate === "agent_message_chunk" && PARTLY.test(n.update.content.text)).length;

// Astra's controlled pending ACP writes: from now on, every session/update that carries the recovery
// warning stays pending until the test settles it. The client "has" a notification (conn.notes)
// only once its write resolved. `only`: hold just this session's writes. Returns the held writes:
// { resolve, reject, sessionId }.
function holdWarnings(conn, only) {
  const held = [];
  const deliver = conn.sessionUpdate;
  conn.sessionUpdate = (n) => {
    if (n.update.sessionUpdate !== "agent_message_chunk" || !PARTLY.test(n.update.content.text)) return deliver(n);
    if (only && n.sessionId !== only) return deliver(n);
    const d = deferred();
    held.push({ ...d, sessionId: n.sessionId });
    return d.promise.then(() => deliver(n));
  };
  return held;
}

// The scenario for round 6 blocker 1: /apply on a live turn leaves the checkout partly changed (git's
// time limit killed `git apply` halfway), so the warning goes out at once, while the turn can talk.
async function livePartialApply(label, conn) {
  const repo = await makeRepo({ origin: `https://github.com/acme/${label}.git`, files: { "a.txt": "one\n", "b.txt": "bee\n" } });
  const env = codexEnv(`env_${label}`, label, `acme/${label}`);
  const diff = `${diffOf("one", "two", "a.txt")}${diffOf("bee", "bop", "b.txt")}`;
  const applyGit = async (cwd, args, o) => {
    if (args[0] === "apply" && !args.includes("--check") && !args.includes("-R")) {
      await git(cwd, ["apply", "--include=a.txt", args.at(-1)]);
      return { code: -1, stdout: "", stderr: "", timedOut: true };
    }
    return git(cwd, args, o);
  };
  const a = new MeghaAgent(conn, new CodexBackend({ pollMs: 60_000, applyGit }), { env: {} });
  const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
  Object.assign(a.sessions.get(sessionId), { cloudId: `task_e_${label}`, webUrl: `https://chatgpt.com/codex/tasks/task_e_${label}`, cloudState: "idle", createdIn: repo, turnId: `task_e_${label}~assttrn_e_1`, doneTurnId: `task_e_${label}~assttrn_e_1` });
  return { a, sessionId, repo, env, diff };
}

export async function run() {
  // ============ 1. a replacement session that adopts the cloud task also takes its notices ============
  await test("R5-1 codex: Stop during /apply leaves a warning; the T3 replacement session that adopts the task shows it before continuing", async () => {
    const thread = { T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:1/mcp", T3_ACP_MCP_AUTHORIZATION: "Bearer thread-r51" };
    const { sessionId: oldId, repo } = await cancelledPartialApply("r51", { agentEnv: thread });
    assert.match(savedNotices(oldId), PARTLY, "(the warning is saved with the old session)");
    // T3 replaces the session (rollback): session/new, then a prompt carrying the context handoff.
    const env = codexEnv("env_r51", "r51", "acme/r51");
    let cur = { turn: "task_e_r51~assttrn_e_1", status: "completed" };
    let followUps = 0, warnedBeforeFollowUp = null;
    const conn = fakeConn();
    const a2 = new MeghaAgent(conn, new CodexBackend({ pollMs: 60_000 }), { env: thread });
    const { sessionId } = await a2.newSession({ cwd: repo, mcpServers: [] });
    mockFetch(codexBase([env], [
      ["GET", /task_e_r51$/, () => json(details("task_e_r51", env, cur))],
      ["POST", /\/wham\/tasks$/, () => {
        followUps++;
        warnedBeforeFollowUp ??= PARTLY.test(shown(conn, sessionId));
        cur = { turn: "task_e_r51~assttrn_e_2", status: "in_progress" };
        return json({ turn: { id: cur.turn } });
      }],
      ["GET", /task_e_r51\/turns\/[^/]+\/stream$/, () => { cur = { ...cur, status: "completed" }; return doneStream("done"); }],
    ]));
    const r = await hung(a2.prompt({ sessionId, prompt: fixtures.handoffFirstTurn }));
    assert.ok(r !== "hung" && !r.e, `the prompt answers (got ${r === "hung" ? "hung" : r.e?.message})`);
    const out = shown(conn, sessionId);
    assert.match(out, /Continuing the same cloud task/, "(the replacement adopted the task)");
    assert.equal(followUps, 1, "(and continued it)");
    assert.match(out, PARTLY, "the recovery warning reaches the user");
    assert.match(out, /task_e_r51-[^ ]*\.patch/, "with the saved patch");
    assert.equal(warnedBeforeFollowUp, true, "before the follow-up is sent");
    assert.deepEqual(loadSessionRecord(sessionId).notices ?? [], [], "cleared from the new session once shown");
    assert.deepEqual(loadSessionRecord(oldId).notices ?? [], [], "and moved off the old session, so it isn't shown twice");
  });

  // ============ 2. a notice is removed only once its notification was written ============
  await test("R5-2 codex: a notice whose session/update is rejected (closed connection) is kept and shown after a restart", async () => {
    const { a, conn, sessionId, repo } = await cancelledPartialApply("r52");
    conn.sessionUpdate = async () => { throw new Error("ACP connection closed"); };
    await hung(a.prompt({ sessionId, prompt: text("/open") }));
    await wait(50); // let any write's rejection land
    assert.match(savedNotices(sessionId), PARTLY, "kept: the client never got it");
    const conn2 = fakeConn();
    const a2 = new MeghaAgent(conn2, new CodexBackend({ pollMs: 60_000 }), { env: {} });
    await a2.resumeSession({ sessionId, cwd: repo, mcpServers: [] });
    assert.equal((await a2.prompt({ sessionId, prompt: text("/open") })).stopReason, "end_turn");
    assert.match(shown(conn2, sessionId), PARTLY, "shown on the first prompt that can deliver it");
    assert.deepEqual(loadSessionRecord(sessionId).notices ?? [], [], "cleared once delivered");
  });

  // ============ 3. auto-continue after an observed failed turn reports it; nothing is posted ============
  await test("R5-3 codex: T3's auto-continue after a restart, on a failed turn megha already saw end, sends no follow-up", async () => {
    const repo = await makeRepo({ origin: "https://github.com/acme/r53.git" });
    const env = codexEnv("env_r53", "r53", "acme/r53");
    const failedTurn = "task_e_r53~assttrn_e_1";
    let followUps = 0;
    mockFetch(codexBase([env], [
      ["GET", /task_e_r53$/, () => json(details("task_e_r53", env, { turn: failedTurn, status: "failed" }))],
      ["POST", /\/wham\/tasks$/, () => { followUps++; return json({ turn: { id: "task_e_r53~assttrn_e_2" } }); }],
      ["GET", /task_e_r53\/turns\/[^/]+\/stream$/, () => doneStream("retried")],
    ]));
    // megha watched the turn fail and saved that (doneTurnId is set from an observed end).
    const a1 = new MeghaAgent(fakeConn(), new CodexBackend({ pollMs: 60_000 }), { env: {} });
    const { sessionId } = await a1.newSession({ cwd: repo, mcpServers: [] });
    Object.assign(a1.sessions.get(sessionId), { cloudId: "task_e_r53", cloudState: "idle", turnId: failedTurn, doneTurnId: failedTurn, createdIn: repo, webUrl: "https://chatgpt.com/codex/tasks/task_e_r53" });
    saveSessionRecord(a1.sessions.get(sessionId));
    // T3 restarts and sends its automatic continuation.
    const conn = fakeConn();
    const a2 = new MeghaAgent(conn, new CodexBackend({ pollMs: 60_000 }), { env: {} });
    await a2.resumeSession({ sessionId, cwd: repo, mcpServers: [] });
    const cont = await hung(a2.prompt({ sessionId, prompt: text(CONTINUE_PROMPT) }));
    assert.ok(cont !== "hung" && !cont.e, `auto-continue answers (got ${cont === "hung" ? "hung" : cont.e?.message})`);
    assert.equal(followUps, 0, "nothing sent by the automatic continuation");
    const out = shown(conn, sessionId);
    assert.match(out, /failed/i, "says the last turn failed");
    assert.match(out, /send a prompt to try again/i, "and what to do");
    assert.match(out, /chatgpt\.com\/codex\/tasks\/task_e_r53/);
    // A prompt the user sends is the retry.
    assert.equal((await a2.prompt({ sessionId, prompt: text("try again") })).stopReason, "end_turn");
    assert.equal(followUps, 1, "the user's own prompt is sent");
  });

  // ============ round 6 (Astra at f153103, controlled pending ACP writes) ============
  // 1. A prompt that arrives while a notice's write is still pending waits for it (bounded) before
  //    any cloud work: the warning reaches the user before the next follow-up is sent.
  await test("R5-4 codex: a prompt sent while the live recovery warning's write is pending sends its follow-up only after the warning is delivered", async () => {
    const conn = fakeConn();
    const held = holdWarnings(conn);
    const { a, sessionId, env, diff } = await livePartialApply("r54", conn);
    let cur = { turn: "task_e_r54~assttrn_e_1", status: "completed" };
    let followUps = 0, warnedBeforeFollowUp = null;
    mockFetch(codexBase([env], [
      ["GET", /task_e_r54$/, () => json(details("task_e_r54", env, { ...cur, output_items: followUps ? [] : [{ type: "output_diff", diff }] }))],
      ["POST", /\/wham\/tasks$/, () => {
        followUps++;
        warnedBeforeFollowUp ??= warnings(conn) === 1;
        cur = { turn: "task_e_r54~assttrn_e_2", status: "in_progress" };
        return json({ turn: { id: cur.turn } });
      }],
      ["GET", /task_e_r54\/turns\/[^/]+\/stream$/, () => { cur = { ...cur, status: "completed" }; return doneStream("done"); }],
    ]));
    assert.equal((await a.prompt({ sessionId, prompt: text("/apply") })).stopReason, "end_turn");
    assert.equal(held.length, 1, "(the warning was written live, and its write is pending)");
    const next = a.prompt({ sessionId, prompt: text("go on") });
    await wait(300);
    assert.equal(followUps, 0, "no follow-up while the warning is still on its way");
    held[0].resolve();
    const r = await hung(next);
    assert.ok(r !== "hung" && !r.e, `the prompt answers (got ${r === "hung" ? "hung" : r.e?.message})`);
    assert.equal(followUps, 1, "(then the follow-up is sent)");
    assert.equal(warnedBeforeFollowUp, true, "after the warning was delivered");
    assert.equal(warnings(conn), 1, "shown once");
    assert.equal(savedNotices(sessionId), "", "and cleared once written");
  });

  // 2. Notice writes are not part of the turn: Stop never waits on one, and a stalled write doesn't
  //    keep the turn unsettled (which refused every later prompt until the write settled).
  await test("R5-5 codex: Stop while a notice write is stalled settles the turn at once; the next prompt runs; the notice stays saved until written", async () => {
    const { a, conn, sessionId } = await cancelledPartialApply("r55");
    a.drainWaitMs = 1000; // a turn that won't settle refuses the next prompt after 1 s, not 60
    a.noticeWaitMs = 200;
    const held = holdWarnings(conn);
    const stalled = a.prompt({ sessionId, prompt: text("/open") });
    await until(() => held.length === 1);
    await a.cancel({ sessionId });
    const t0 = Date.now();
    assert.equal((await hung(stalled)).v?.stopReason, "cancelled");
    const stopMs = Date.now() - t0;
    const settled = await hung(a.sessions.get(sessionId).turn.settled.then(() => "settled"), 1000);
    assert.equal(settled === "hung" ? "hung" : settled.v, "settled", "the stopped turn settles while the write is still pending");
    const r = await hung(a.prompt({ sessionId, prompt: text("/open") }));
    assert.ok(r !== "hung" && !r.e, `the next prompt runs (got ${r === "hung" ? "hung" : r.e?.message})`);
    assert.equal(r.v.stopReason, "end_turn");
    assert.ok(stopMs < 500, `Stop answered without waiting out the cancel grace on the write (took ${stopMs} ms)`);
    assert.equal(warnings(conn), 0, "(the write still hasn't landed)");
    assert.match(savedNotices(sessionId), PARTLY, "the warning stays saved while its write is pending");
    held[0].resolve();
    await until(() => savedNotices(sessionId) === "");
    assert.equal(warnings(conn), 1, "delivered once, late");
    assert.equal(held.length, 1, "written once: the next prompt didn't send it again");
  });

  // 3. A replacement session adopting the task while the old session's notice is being written takes
  //    only the notices that aren't in flight; the old session keeps (and shows) the one it is writing.
  await test("R5-6 codex: a replacement session adopting the task while the old session's warning write is pending doesn't show it a second time", async () => {
    const thread = { T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:1/mcp", T3_ACP_MCP_AUTHORIZATION: "Bearer thread-r56" };
    const { a, conn, sessionId: oldId, repo } = await cancelledPartialApply("r56", { agentEnv: thread });
    a.noticeWaitMs = 200;
    const held = holdWarnings(conn, oldId);
    const env = codexEnv("env_r56", "r56", "acme/r56");
    let cur = { turn: "task_e_r56~assttrn_e_1", status: "completed" };
    let followUps = 0;
    mockFetch(codexBase([env], [
      ["GET", /task_e_r56$/, () => json(details("task_e_r56", env, cur))],
      ["POST", /\/wham\/tasks$/, () => { followUps++; cur = { turn: "task_e_r56~assttrn_e_2", status: "in_progress" }; return json({ turn: { id: cur.turn } }); }],
      ["GET", /task_e_r56\/turns\/[^/]+\/stream$/, () => { cur = { ...cur, status: "completed" }; return doneStream("done"); }],
    ]));
    // The old session starts writing the warning; the write stays pending.
    const oldPrompt = a.prompt({ sessionId: oldId, prompt: text("/open") });
    await until(() => held.length === 1);
    // T3 replaces the session (rollback) in the same megha process.
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    const r = await hung(a.prompt({ sessionId, prompt: fixtures.handoffFirstTurn }));
    assert.ok(r !== "hung" && !r.e, `the replacement's prompt answers (got ${r === "hung" ? "hung" : r.e?.message})`);
    assert.match(shown(conn, sessionId), /Continuing the same cloud task/, "(the replacement adopted the task)");
    assert.equal(followUps, 1, "(and continued it)");
    held[0].resolve();
    await hung(oldPrompt);
    await until(() => savedNotices(oldId) === "");
    assert.equal(warnings(conn), 1, "the warning reaches the user once, not on both sessions");
    assert.equal(savedNotices(sessionId), "", "nothing left saved on the replacement");
  });
}
