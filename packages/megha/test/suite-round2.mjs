// Regression tests for GPT-6-Astra's round-2 audit at fd42db3: the seven partly fixed findings (2, 3,
// 4, 6, 7, 10, 12) and the three new ones (A, B, C). Each test replays Astra's probe: the real agent
// and backends, mocked HTTP, temp git repos, and a local TCP server that never answers for C.

import assert from "node:assert/strict";
import net from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MeghaAgent } from "../lib/agent.mjs";
import { CodexBackend, TurnState } from "../lib/codex.mjs";
import { ClaudeBackend } from "../lib/claude.mjs";
import { applyLocally } from "../lib/diff.mjs";
import { git, Cancelled } from "../lib/util.mjs";
import { test, tmp, makeRepo, mockFetch, json, sse, hangingSse, pushSse, recorder, deferred, wait, fakeConn, acpCaptured, stdio, CANARY, PNG_1x1 } from "./harness.mjs";
import { until, codexEnv, codexBase, details, thread, doneStream, claudeBase, crow, keepaliveSse, githubLikeRepo, pushOutcomeBranch, readA } from "./suite-hardening.mjs";

const text = (t) => [{ type: "text", text: t }];
const errOf = (p) => p.then(() => null, (e) => e);
const stderrSince = (i) => stdio.err.slice(i).join("");
const notesText = (conn, sessionId) => conn.notes.filter((n) => n.sessionId === sessionId && n.update.sessionUpdate === "agent_message_chunk").map((n) => n.update.content.text).join("");
const hung = (p, ms = 5000) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), wait(ms).then(() => "hung")]);
const leaked = (s) => [CANARY.serverBody, CANARY.envSecret].some((c) => String(s).includes(c));
// A Claude user/control event POST body -> "user" | "interrupt" | "control_response:<behavior>".
const claudeEventKind = (req) => {
  const p = req.body?.events?.at(-1)?.payload ?? {};
  if (p.type === "control_request") return p.request?.subtype;
  if (p.type === "control_response") return `control_response:${p.response?.response?.behavior}`;
  return p.type;
};
const diffOf = (from, to) => `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-${from}\n+${to}\n`;

export async function run() {
  // ======================= 2. turn and stream failures carry no server text =======================
  await test("R2-2 codex: a failed turn's error message and a stream error event never reach stderr or ACP", async () => {
    const repo = await makeRepo({ origin: "https://github.com/acme/r2a.git" });
    const env = codexEnv("env_r2a", "r2a", "acme/r2a");
    const diag = `${CANARY.serverBody} env_vars={"K":"${CANARY.envSecret}"}`;
    mockFetch(codexBase([env], [
      ["GET", /task_e_r2a$/, () => json(details("task_e_r2a", env))],
      ["POST", /\/wham\/tasks$/, () => json({ turn: { id: "task_e_r2a~assttrn_e_2" } })],
      ["GET", /task_e_r2a\/turns\/[^/]+\/stream$/, () => sse([thread("turn/started"), thread("error", { error: { message: diag }, willRetry: false }),
        thread("turn/completed", { turn: { status: "failed", error: { message: diag, codexErrorInfo: "usageLimitExceeded" } } })])],
    ]));
    const a = new MeghaAgent(fakeConn(), new CodexBackend({ pollMs: 60_000 }), { env: {} });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    a.sessions.get(sessionId).cloudId = "task_e_r2a";
    const i = stdio.err.length;
    const e = await errOf(a.prompt({ sessionId, prompt: text("go") }));
    assert.ok(e, "the failed turn is reported");
    assert.ok(!leaked(e.message), "ACP error is clean");
    assert.ok(!leaked(stderrSince(i)), "stderr is clean");
    assert.match(e.message, /Codex Cloud turn failed \(usageLimitExceeded\)/);
  });

  await test("R2-2 codex: a failed turn seen by the poller (stream silent) carries no server text", async () => {
    const repo = await makeRepo({ origin: "https://github.com/acme/r2b.git" });
    const env = codexEnv("env_r2b", "r2b", "acme/r2b");
    let gets = 0;
    mockFetch(codexBase([env], [
      ["GET", /task_e_r2b$/, () => json(++gets === 1 ? details("task_e_r2b", env)
        : { ...details("task_e_r2b", env, { turn: "task_e_r2b~assttrn_e_2", status: "failed" }),
          current_assistant_turn: { ...details("task_e_r2b", env, { turn: "task_e_r2b~assttrn_e_2", status: "failed" }).current_assistant_turn, error: { code: CANARY.serverBody, message: `${CANARY.serverBody} ${CANARY.envSecret}` } } })],
      ["POST", /\/wham\/tasks$/, () => json({ turn: { id: "task_e_r2b~assttrn_e_2" } })],
      ["GET", /task_e_r2b\/turns\/[^/]+\/stream$/, (req) => hangingSse(req.signal)],
    ]));
    const a = new MeghaAgent(fakeConn(), new CodexBackend({ pollMs: 50 }), { env: {} });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    a.sessions.get(sessionId).cloudId = "task_e_r2b";
    const i = stdio.err.length;
    const e = await errOf(a.prompt({ sessionId, prompt: text("go") }));
    assert.ok(e, "the failed turn is reported");
    assert.ok(!leaked(e.message) && !leaked(stderrSince(i)));
    assert.match(e.message, /Codex Cloud turn failed\./);
  });

  await test("R2-2 claude: a failed result's text (result.result) never reaches stderr or ACP", async () => {
    const repo = await makeRepo({ origin: null });
    let subtype = "error_during_execution", seq = 10;
    mockFetch(claudeBase([
      ["POST", /cse_r2c\/events$/, () => json({ results: [{ sequence_num: String(seq += 10) }] })],
      ["GET", /cse_r2c\/events\/stream$/, () => sse([crow(seq + 1, { type: "result", subtype, is_error: true, result: `${CANARY.serverBody} ${CANARY.envSecret}` })])],
      ["GET", /cse_r2c$/, () => json({ session: { id: "cse_r2c" } })],
    ]));
    const a = new MeghaAgent(fakeConn(), new ClaudeBackend({ statusPollMs: 60_000 }), { env: {} });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    const s = a.sessions.get(sessionId);
    Object.assign(s, { cloudId: "cse_r2c", bundle: true, repoChecked: true, sentMode: s.config.mode, sentModel: s.config.model });
    for (subtype of ["error_during_execution", "success"]) {
      const i = stdio.err.length;
      const e = await errOf(a.prompt({ sessionId, prompt: text("go") }));
      assert.ok(e, `${subtype}: the failed turn is reported`);
      assert.ok(!leaked(e.message) && !leaked(stderrSince(i)), `${subtype}: clean`);
      assert.match(e.message, /Claude cloud turn failed/);
      if (subtype !== "success") assert.match(e.message, /error_during_execution/);
    }
  });

  // ======================= 3. resume can't manufacture bundle ownership =======================
  await test("R2-3 claude: resuming a bundle session from another repo, unchecked, can't make it that repo's", async () => {
    const repoA = await makeRepo({ origin: null });
    const repoB = await makeRepo({ origin: null });
    let getOk = true;
    const bundleSession = (id) => ({ session: { id, title: "t", config: { sources: [] } } });
    mockFetch(claudeBase([
      ["POST", /\/v1\/files$/, () => json({ id: "file_r3" })],
      ["POST", /\/v1\/sessions$/, () => json({ id: "session_r3", title: "t" })],
      ["POST", /cse_r3\/events$/, () => json({ results: [] })],
      ["GET", /cse_[a-z0-9]+\/events\/stream$/, () => sse([crow(5, { type: "result", subtype: "success", is_error: false })])],
      ["GET", /cse_[a-z0-9]+\/events$/, () => json({ data: [] })],
      ["GET", /cse_(r3|other)$/, (req) => (getOk ? json(bundleSession(req.path.split("/").pop())) : json({ error: { type: "api_error" } }, 503))],
    ]));
    // Repo A creates a bundle-seeded session the normal way.
    const a1 = new MeghaAgent(fakeConn(), new ClaudeBackend({ statusPollMs: 60_000 }), { env: {} });
    const { sessionId: mgId } = await a1.newSession({ cwd: repoA, mcpServers: [] });
    assert.equal((await a1.prompt({ sessionId: mgId, prompt: text("task in A") })).stopReason, "end_turn");
    assert.equal(a1.sessions.get(mgId).cloudId, "cse_r3");
    // Repo B resumes it while the verification GET fails, then changes a setting (which saves).
    getOk = false;
    const a2 = new MeghaAgent(fakeConn(), new ClaudeBackend({ statusPollMs: 60_000 }), { env: {} });
    const resumed = await errOf(a2.resumeSession({ sessionId: mgId, cwd: repoB, mcpServers: [] }));
    if (!resumed) await a2.setSessionConfigOption({ sessionId: mgId, configId: "mode", value: "plan" });
    const byCloudId = await errOf(a2.resumeSession({ sessionId: "cse_r3", cwd: repoB, mcpServers: [] }));
    if (!byCloudId) await a2.setSessionConfigOption({ sessionId: "cse_r3", configId: "mode", value: "plan" });
    // A bundle session megha never saw, resumed unchecked from B and saved by a setting change.
    assert.equal(await errOf(a2.resumeSession({ sessionId: "cse_other", cwd: repoB, mcpServers: [] })), null, "a cloud id with no record binds unchecked");
    await a2.setSessionConfigOption({ sessionId: "cse_other", configId: "mode", value: "plan" });
    // Later, with the network back, B loads them: neither may count as B's.
    getOk = true;
    const a3 = new MeghaAgent(fakeConn(), new ClaudeBackend({ statusPollMs: 60_000 }), { env: {} });
    const foreign = await errOf(a3.loadSession({ sessionId: "cse_r3", cwd: repoB, mcpServers: [] }));
    const other = await errOf(a3.loadSession({ sessionId: "cse_other", cwd: repoB, mcpServers: [] }));
    assert.ok(foreign, "foreignBundleAccepted=false: repo B can't load repo A's bundle session");
    assert.ok(other, "an unchecked resume created no ownership evidence");
    assert.ok(resumed && byCloudId, "the folder mismatch is refused locally, before the network fallback");
    assert.match(resumed.message, /another folder/);
    // Repo A still can.
    const a4 = new MeghaAgent(fakeConn(), new ClaudeBackend({ statusPollMs: 60_000 }), { env: {} });
    assert.equal(await errOf(a4.loadSession({ sessionId: "cse_r3", cwd: repoA, mcpServers: [] })), null);
  });

  // ======================= 4. no local or cloud mutation after Stop =======================
  await test("R2-4 apply: Stop while git preflight is paused means no git apply runs afterwards", async () => {
    const repo = await makeRepo({ files: { "a.txt": "one\n" } });
    const gate = deferred();
    const ran = [];
    // A git that can't be interrupted while paused, like a slow rev-parse on OneDrive.
    const slowGit = async (cwd, args) => { ran.push(args.join(" ")); if (args[0] === "rev-parse") await gate.promise; return git(cwd, args); };
    const ac = new AbortController();
    const p = errOf(applyLocally({ cwd: repo, diff: diffOf("one", "two"), name: "r4a", signal: ac.signal, run: slowGit }));
    await until(() => ran.length > 0);
    ac.abort();
    gate.resolve();
    const e = await p;
    assert.ok(e instanceof Cancelled, `cancelled, got ${e}`);
    assert.deepEqual(ran.filter((c) => c.startsWith("apply")), [], "no git apply after Stop");
    assert.equal(readA(repo), "one\n");
  });

  await test("R2-4 apply: Stop after the previous diff was reversed puts it back", async () => {
    const repo = await makeRepo({ files: { "a.txt": "one\n" } });
    const prev = join(tmp("prev"), "prev.patch");
    writeFileSync(prev, diffOf("one", "two"));
    await git(repo, ["apply", prev]);
    assert.equal(readA(repo), "two\n");
    const gate = deferred();
    const ac = new AbortController();
    const ran = [];
    const slowGit = async (cwd, args) => {
      ran.push(args.join(" "));
      // Pause the check of the new diff, after the previous one was reversed.
      if (args[0] === "apply" && args[1] === "--check") await gate.promise;
      return git(cwd, args);
    };
    const p = errOf(applyLocally({ cwd: repo, diff: diffOf("one", "three"), name: "r4b", previousFile: prev, signal: ac.signal, run: slowGit }));
    await until(() => ran.some((c) => c.startsWith("apply --check")));
    assert.equal(readA(repo), "one\n", "the previous diff was reversed");
    ac.abort();
    gate.resolve();
    assert.ok((await p) instanceof Cancelled);
    assert.equal(readA(repo), "two\n", "the previous diff is restored, the new one not applied");
  });

  await test("R2-4 codex: Stop during an image upload sends no finalize POST and no follow-up", async () => {
    const repo = await makeRepo({ origin: "https://github.com/acme/r4c.git" });
    const env = codexEnv("env_r4c", "r4c", "acme/r4c");
    const gate = deferred();
    const calls = mockFetch(codexBase([env], [
      ["GET", /task_e_r4c$/, () => json(details("task_e_r4c", env))],
      ["POST", /chatgpt\.com\/backend-api\/files$/, () => json({ file_id: "file_r4c", upload_url: "https://blob.example.com/up/r4c?sig=x" })],
      ["PUT", /blob\.example\.com/, () => gate.promise.then(() => new Response("", { status: 201 }))],
      ["POST", /files\/file_r4c\/uploaded$/, () => json({})],
      ["POST", /\/wham\/tasks$/, () => json({ turn: { id: "task_e_r4c~assttrn_e_2" } })],
    ]));
    const a = new MeghaAgent(fakeConn(), new CodexBackend({ pollMs: 60_000 }), { env: {} });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    a.sessions.get(sessionId).cloudId = "task_e_r4c";
    const p = a.prompt({ sessionId, prompt: [...text("what is this?"), { type: "image", data: PNG_1x1, mimeType: "image/png" }] });
    await until(() => calls.some((c) => c.method === "PUT"));
    await a.cancel({ sessionId });
    assert.equal((await p).stopReason, "cancelled");
    gate.resolve();
    await wait(300);
    assert.ok(!calls.some((c) => c.path.endsWith("/uploaded")), "no finalize POST after Stop");
    assert.ok(!calls.some((c) => c.method === "POST" && c.path.endsWith("/wham/tasks")), "no follow-up");
  });

  // ======================= 6. a deadline stops the cloud turn, and a retry waits for it =======================
  await test("R2-6 claude: the turn deadline interrupts the cloud session; a retry is refused until it stops", async () => {
    const repo = await makeRepo({ origin: null });
    let running = true;
    const kinds = [];
    mockFetch(claudeBase([
      ["POST", /cse_r6\/events$/, (req) => {
        const k = claudeEventKind(req); kinds.push(k);
        if (k === "interrupt") return running ? json({ error: { type: "api_error" } }, 503) : json({ results: [] });
        return json({ results: [{ sequence_num: String(10 * kinds.length) }] });
      }],
      ["GET", /cse_r6\/events\/stream$/, (req) => (running ? keepaliveSse(req.signal) : sse([crow(500, { type: "result", subtype: "success", is_error: false })]))],
      ["GET", /cse_r6$/, () => json({ session: { id: "cse_r6", worker_status: running ? "running" : "idle" } })],
    ]));
    const a = new MeghaAgent(fakeConn(), new ClaudeBackend({ statusPollMs: 60_000, turnTimeoutMs: 300, stopWaitMs: 300 }), { env: {}, drainWaitMs: 5000 });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    const s = a.sessions.get(sessionId);
    Object.assign(s, { cloudId: "cse_r6", bundle: true, repoChecked: true, sentMode: s.config.mode, sentModel: s.config.model });
    const first = await hung(a.prompt({ sessionId, prompt: text("long") }));
    assert.notEqual(first, "hung");
    assert.match(first.e?.message ?? "", /timed out/);
    assert.ok(kinds.includes("interrupt"), "the deadline sent an interrupt to the cloud");
    const users = () => kinds.filter((k) => k === "user").length;
    const retry = await errOf(a.prompt({ sessionId, prompt: text("retry") }));
    assert.ok(retry, "the retry is refused while the timed-out turn may still run");
    assert.match(retry.message, /hasn't confirmed it stopped/);
    assert.equal(users(), 1, "no new prompt sent over the timed-out turn");
    assert.ok(kinds.filter((k) => k === "interrupt").length >= 2, "asked the cloud to stop again");
    running = false;
    assert.equal((await a.prompt({ sessionId, prompt: text("retry again") })).stopReason, "end_turn");
    assert.equal(users(), 2);
  });

  await test("R2-6 codex: the turn deadline cancels the cloud task; a retry is refused until it stops", async () => {
    const repo = await makeRepo({ origin: "https://github.com/acme/r6.git" });
    const env = codexEnv("env_r6", "r6", "acme/r6");
    let cur = { turn: "task_e_r6~assttrn_e_1", status: "completed" };
    let cancels = 0, followUps = 0;
    mockFetch(codexBase([env], [
      ["GET", /task_e_r6$/, () => json(details("task_e_r6", env, cur))],
      ["POST", /\/wham\/tasks$/, () => { followUps++; const id = `task_e_r6~assttrn_e_${followUps + 1}`; cur = { turn: id, status: "in_progress" }; return json({ turn: { id } }); }],
      ["POST", /task_e_r6\/cancel$/, () => { cancels++; return json({ error: { code: "x" } }, 503); }],
      ["GET", /task_e_r6\/turns\/[^/]+\/stream$/, (req) => (followUps === 1 ? hangingSse(req.signal) : doneStream("done"))],
    ]));
    const a = new MeghaAgent(fakeConn(), new CodexBackend({ pollMs: 50, turnTimeoutMs: 300, stopWaitMs: 300 }), { env: {}, drainWaitMs: 5000 });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    a.sessions.get(sessionId).cloudId = "task_e_r6";
    const first = await hung(a.prompt({ sessionId, prompt: text("long") }));
    assert.notEqual(first, "hung");
    assert.match(first.e?.message ?? "", /timed out/);
    assert.ok(cancels >= 1, "the deadline sent a cloud cancel");
    const retry = await errOf(a.prompt({ sessionId, prompt: text("retry") }));
    assert.ok(retry, "the retry is refused while the timed-out turn still runs");
    assert.match(retry.message, /hasn't confirmed it stopped/);
    assert.equal(followUps, 1, "no follow-up over the running turn");
    assert.ok(cancels >= 2, "asked the cloud to cancel again");
    cur = { ...cur, status: "cancelled" };
    assert.equal((await a.prompt({ sessionId, prompt: text("retry again") })).stopReason, "end_turn");
    assert.equal(followUps, 2);
  });

  // ======================= 7. completed commentary does not hide the final answer =======================
  await test("R2-7 codex: a completed commentary message doesn't stop output_items from finishing the final answer", () => {
    for (const outputs of [["Hello world. Complete answer."], ["Working. ", "Hello world. Complete answer."]]) {
      const rec = recorder();
      const st = new TurnState({ cwd: "C:\\x" }, rec.io, "t7");
      st.handle("item/agentMessage/delta", { itemId: "c1", delta: "Working. " });
      st.handle("item/completed", { item: { id: "c1", type: "agentMessage", text: "Working. " } });
      st.handle("item/agentMessage/delta", { itemId: "m2", delta: "Hello " });
      st.catchUp([{ method: "item/completed", params: { item: { id: "c1", type: "agentMessage", text: "Working. " } } }]);
      st.fallbackMessages(outputs);
      assert.equal(rec.text(), "Working. Hello world. Complete answer.", `output_items ${JSON.stringify(outputs)}`);
    }
  });

  // ======================= 10. resume hydrates the same metadata as load =======================
  await test("R2-10 claude: an imported GitHub session opened with session/resume can /apply its pushed branch", async () => {
    const { work } = await githubLikeRepo("acme/imp2");
    await pushOutcomeBranch(work, "claude/fix-2", "two\n");
    const github = { sources: [{ type: "git_repository", url: "https://github.com/acme/imp2" }] };
    const calls = mockFetch(claudeBase([
      ["GET", /cse_imp2$/, () => json({ session: { id: "cse_imp2", title: "Imported", status: "active",
        config: { ...github, outcomes: [{ type: "git_repository", git_info: { type: "github", repo: "acme/imp2", branches: ["claude/fix-2"] } }] } } })],
      ["GET", /cse_noout$/, () => json({ session: { id: "cse_noout", title: "No outcome", status: "active", config: github } })],
    ]));
    const conn = fakeConn();
    const a = new MeghaAgent(conn, new ClaudeBackend(), { env: {} });
    await a.resumeSession({ sessionId: "cse_imp2", cwd: work, mcpServers: [] });
    await a.prompt({ sessionId: "cse_imp2", prompt: text("/apply") });
    assert.match(notesText(conn, "cse_imp2"), /Applied the cloud diff/);
    assert.equal(readA(work), "two\n");
    assert.ok(!calls.some((c) => c.path.endsWith("/events")), "resume does not replay history");
    await a.resumeSession({ sessionId: "cse_noout", cwd: work, mcpServers: [] });
    await a.prompt({ sessionId: "cse_noout", prompt: text("/apply") });
    const said = notesText(conn, "cse_noout");
    assert.ok(!said.includes("`a branch`"), said);
    assert.match(said, /no branch/);
  });

  // ======================= 12. every test path is captured =======================
  await test("R2-12 harness: errors and backend output from any test path reach the secrecy capture", async () => {
    const marker = `capture-marker-${Date.now().toString(36)}`;
    const be = new CodexBackend();
    const s = { id: "mg_r12", cwd: tmp("r12"), config: {}, envs: [], repo: { isRepo: true, github: { owner: "acme", name: "r12" } } };
    // A test that asserts on an error and never hands it to captureAcp.
    assert.throws(() => be.setConfig(s, "environment", `env_${marker}_a`));
    await assert.rejects(be.command({ ...s, cloudId: null, config: { environment: `env_${marker}_b` } }, { name: "nope" }, { ...recorder().io, text: () => { throw new Error(`${marker}_b`); } }));
    // A backend driven with recorder() instead of a fake connection.
    recorder().io.text(`${marker}_c`);
    const seen = JSON.stringify(acpCaptured);
    for (const tag of ["_a", "_b", "_c"]) assert.ok(seen.includes(`${marker}${tag}`), `${tag} captured`);
  });

  // ======================= A. a steer can't overtake an outstanding cloud cancel =======================
  await test("A codex: a steer waits for the cloud cancel even when the stream ends first", async () => {
    const repo = await makeRepo({ origin: "https://github.com/acme/ra.git" });
    const env = codexEnv("env_ra", "ra", "acme/ra");
    const cancelGate = deferred();
    let live = null, streams = 0, followUps = 0;
    const calls = mockFetch(codexBase([env], [
      ["GET", /task_e_ra$/, () => json(details("task_e_ra", env))],
      ["POST", /\/wham\/tasks$/, () => { followUps++; return json({ turn: { id: `task_e_ra~assttrn_e_${followUps + 1}` } }); }],
      ["POST", /task_e_ra\/cancel$/, () => cancelGate.promise.then(() => json({}))],
      ["GET", /task_e_ra\/turns\/[^/]+\/stream$/, (req) => { if (++streams === 1) { live = pushSse(req.signal); return live.response; } return doneStream("steered"); }],
    ]));
    const a = new MeghaAgent(fakeConn(), new CodexBackend({ pollMs: 60_000 }), { env: {}, drainWaitMs: 5000 });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    a.sessions.get(sessionId).cloudId = "task_e_ra";
    const p = a.prompt({ sessionId, prompt: text("long job") });
    await until(() => live);
    await a.cancel({ sessionId });
    await until(() => calls.some((c) => c.path.endsWith("/task_e_ra/cancel")));
    live.push(thread("turn/completed", { turn: { status: "interrupted" } }));
    assert.equal((await p).stopReason, "cancelled");
    const steer = a.prompt({ sessionId, prompt: text("steer") });
    await wait(400);
    assert.equal(followUps, 1, "no follow-up while the cancel request is unanswered");
    cancelGate.resolve();
    assert.equal((await steer).stopReason, "end_turn");
    assert.equal(followUps, 2);
  });

  await test("A claude: a steer waits for the cloud interrupt even when the result arrives first", async () => {
    const repo = await makeRepo({ origin: null });
    const gate = deferred();
    const kinds = [];
    let live = null, streams = 0;
    mockFetch(claudeBase([
      ["POST", /cse_ra\/events$/, (req) => {
        const k = claudeEventKind(req); kinds.push(k);
        return k === "interrupt" ? gate.promise.then(() => json({ results: [] })) : json({ results: [{ sequence_num: String(10 * kinds.length) }] });
      }],
      ["GET", /cse_ra\/events\/stream$/, (req) => { if (++streams === 1) { live = pushSse(req.signal); return live.response; } return sse([crow(500, { type: "result", subtype: "success", is_error: false })]); }],
      ["GET", /cse_ra$/, () => json({ session: { id: "cse_ra", worker_status: "idle" } })],
    ]));
    const a = new MeghaAgent(fakeConn(), new ClaudeBackend({ statusPollMs: 60_000 }), { env: {}, drainWaitMs: 5000 });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    const s = a.sessions.get(sessionId);
    Object.assign(s, { cloudId: "cse_ra", bundle: true, repoChecked: true, sentMode: s.config.mode, sentModel: s.config.model });
    const p = a.prompt({ sessionId, prompt: text("long job") });
    await until(() => live);
    await a.cancel({ sessionId });
    await until(() => kinds.includes("interrupt"));
    live.push(crow(20, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "interrupted" }));
    assert.equal((await p).stopReason, "cancelled");
    const users = () => kinds.filter((k) => k === "user").length;
    const steer = a.prompt({ sessionId, prompt: text("steer") });
    await wait(400);
    assert.equal(users(), 1, "no new prompt while the interrupt is unanswered");
    gate.resolve();
    assert.equal((await steer).stopReason, "end_turn");
    assert.equal(users(), 2);
  });

  // ======================= B. a permission answered after Stop is never sent as allow =======================
  await test("B claude: approving an old permission prompt after Stop sends no allow", async () => {
    const repo = await makeRepo({ origin: null });
    const permission = deferred();
    const kinds = [];
    let live = null, asked = 0;
    mockFetch(claudeBase([
      ["POST", /cse_rb\/events$/, (req) => { kinds.push(claudeEventKind(req)); return json({ results: [{ sequence_num: "10" }] }); }],
      ["GET", /cse_rb\/events\/stream$/, (req) => { live = pushSse(req.signal); return live.response; }],
      ["GET", /cse_rb$/, () => json({ session: { id: "cse_rb", worker_status: "idle" } })],
    ]));
    const conn = fakeConn();
    conn.requestPermission = () => { asked++; return permission.promise; };
    const a = new MeghaAgent(conn, new ClaudeBackend({ statusPollMs: 60_000 }), { env: {} });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    const s = a.sessions.get(sessionId);
    Object.assign(s, { cloudId: "cse_rb", bundle: true, repoChecked: true, sentMode: s.config.mode, sentModel: s.config.model });
    const p = a.prompt({ sessionId, prompt: text("clean the build") });
    await until(() => live);
    live.push(crow(11, { type: "control_request", request_id: "req_rb", request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "tu_rb", input: { command: "rm -rf build" } } }));
    await until(() => asked === 1);
    await a.cancel({ sessionId });
    await until(() => kinds.includes("interrupt"));
    live.push(crow(12, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "interrupted" }));
    assert.equal((await p).stopReason, "cancelled");
    permission.resolve({ outcome: { outcome: "selected", optionId: "allow" } });
    await wait(300);
    assert.deepEqual(kinds.filter((k) => k === "control_response:allow"), [], "no late allow");
  });

  // ======================= C. git subprocesses are bounded and cancellable =======================
  const sockets = new Set();
  const server = net.createServer((sock) => { sockets.add(sock); sock.on("error", () => {}); }); // accepts, never answers
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const hangUrl = `http://127.0.0.1:${server.address().port}/acme/hang.git`;
  try {
    await test("C git: a stalled ls-remote is killed by Stop and by its timeout", async () => {
      const dir = tmp("gitc");
      const ac = new AbortController();
      const t0 = Date.now();
      setTimeout(() => ac.abort(), 300);
      const stopped = await hung(git(dir, ["ls-remote", hangUrl], { signal: ac.signal }), 4000);
      assert.notEqual(stopped, "hung", "Stop ends the git call");
      assert.ok(stopped.e instanceof Cancelled, `rejects with Cancelled, got ${JSON.stringify(stopped)}`);
      assert.ok(Date.now() - t0 < 2000);
      const timedOut = await hung(git(dir, ["ls-remote", hangUrl], { timeoutMs: 300 }), 4000);
      assert.notEqual(timedOut, "hung", "the timeout ends the git call");
      assert.equal(timedOut.v?.timedOut, true);
    });

    await test("C claude: Stop during a stalled ls-remote in /apply doesn't block the next prompt", async () => {
      const repo = await makeRepo({ origin: hangUrl });
      mockFetch(claudeBase());
      const a = new MeghaAgent(fakeConn(), new ClaudeBackend({ statusPollMs: 60_000 }), { env: {}, drainWaitMs: 4000 });
      const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
      Object.assign(a.sessions.get(sessionId), { cloudId: "cse_rc", bundle: false, outcomeBranch: "claude/rc", baseBranch: "main", repoChecked: true, webUrl: "https://claude.ai/code/cse_rc" });
      const before = sockets.size;
      const p = a.prompt({ sessionId, prompt: text("/apply") });
      await until(() => sockets.size > before, 8000);
      await a.cancel({ sessionId });
      assert.equal((await p).stopReason, "cancelled");
      const t1 = Date.now();
      const next = await hung(a.prompt({ sessionId, prompt: text("/open") }), 6000);
      assert.notEqual(next, "hung");
      assert.equal(next.v?.stopReason, "end_turn", `the next prompt ran: ${next.e?.message ?? ""}`);
      assert.ok(Date.now() - t1 < 2500, `answered in ${Date.now() - t1} ms`);
    });
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }
}
