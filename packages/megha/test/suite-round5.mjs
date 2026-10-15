// Regression tests for GPT-6-Astra's round-5 release check at ed64282: blockers 1-3. Each test replays
// Astra's scenario through the real agent and backends (mocked HTTP, temp git repos) and asserts what
// reaches the client over ACP.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MeghaAgent } from "../lib/agent.mjs";
import { CodexBackend } from "../lib/codex.mjs";
import { saveSessionRecord, loadSessionRecord } from "../lib/util.mjs";
import { CONTINUE_PROMPT } from "../lib/prompt.mjs";
import { test, makeRepo, mockFetch, json, wait, fakeConn } from "./harness.mjs";
import { codexEnv, codexBase, details, doneStream } from "./suite-hardening.mjs";
import { cancelledPartialApply, PARTLY } from "./suite-round4.mjs";

const { fixtures } = JSON.parse(readFileSync(new URL("./fixtures/t3-prompts.json", import.meta.url), "utf8"));
const text = (t) => [{ type: "text", text: t }];
const hung = (p, ms = 5000) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), wait(ms).then(() => "hung")]);
const shown = (conn, sessionId, from = 0) => conn.notes.slice(from).filter((n) => n.sessionId === sessionId && n.update.sessionUpdate === "agent_message_chunk").map((n) => n.update.content.text).join("");

export async function run() {
  // ============ 1. a replacement session that adopts the cloud task also takes its notices ============
  await test("R5-1 codex: Stop during /apply leaves a warning; the T3 replacement session that adopts the task shows it before continuing", async () => {
    const thread = { T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:1/mcp", T3_ACP_MCP_AUTHORIZATION: "Bearer thread-r51" };
    const { sessionId: oldId, repo } = await cancelledPartialApply("r51", { agentEnv: thread });
    assert.match((loadSessionRecord(oldId).notices ?? []).join(""), PARTLY, "(the warning is saved with the old session)");
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
    assert.match((loadSessionRecord(sessionId).notices ?? []).join(""), PARTLY, "kept: the client never got it");
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
}
