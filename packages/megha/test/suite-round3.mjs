// Regression tests for GPT-6-Astra's round-3 audit at d2fadd0: findings 1-5 and the two retention
// issues. Each test replays Astra's probe: the real agent and backends, mocked HTTP, temp git repos,
// and for 3 a real git process tree against a local TCP server that stays open.

import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MeghaAgent } from "../lib/agent.mjs";
import { CodexBackend } from "../lib/codex.mjs";
import { ClaudeBackend } from "../lib/claude.mjs";
import { applyLocally } from "../lib/diff.mjs";
import { git, sleep, Cancelled } from "../lib/util.mjs";
import { test, tmp, makeRepo, mockFetch, json, sse, hangingSse, pushSse, deferred, wait, fakeConn, stdio } from "./harness.mjs";
import { until, codexEnv, codexBase, details, thread, doneStream, claudeBase, crow, keepaliveSse, readA } from "./suite-hardening.mjs";

const text = (t) => [{ type: "text", text: t }];
const errOf = (p) => p.then(() => null, (e) => e);
const stderrSince = (i) => stdio.err.slice(i).join("");
const hung = (p, ms = 5000) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), wait(ms).then(() => "hung")]);
const claudeEventKind = (req) => {
  const p = req.body?.events?.at(-1)?.payload ?? {};
  if (p.type === "control_request") return p.request?.subtype;
  if (p.type === "control_response") return `control_response:${p.response?.response?.behavior}`;
  return p.type;
};
const diffOf = (from, to, file = "a.txt") => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
const STILL_RUNNING = /previous .* turn is still running; wait or use \/status/;
// A prompt megha must refuse. Bounded: a prompt that overlaps a running cloud turn can stream forever.
const refusal = async (p) => {
  const r = await hung(p, 5000);
  assert.ok(r !== "hung" && r.e, `refused (got ${r === "hung" ? "a prompt that is still running" : JSON.stringify(r.v)})`);
  return r.e;
};

// ---------- process tree inspection (by PID ancestry, never by name) ----------
// Every process on the machine as [pid, ppid], plus the pid of the process that listed them.
function processTable() {
  const win = process.platform === "win32";
  const [cmd, args] = win
    ? ["powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"]]
    : ["ps", ["-A", "-o", "pid=", "-o", "ppid="]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", reject);
    child.on("close", () => resolve({ lister: child.pid, rows: out.split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number)).filter((r) => r.length === 2 && r.every(Number.isInteger)) }));
  });
}
// Descendants of `root`, not descending into `skip` (the lister's own subtree).
function descendants({ rows, lister }, root = process.pid) {
  const kids = new Map();
  for (const [pid, ppid] of rows) { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid); }
  const out = new Set();
  const stack = [root];
  while (stack.length) for (const c of kids.get(stack.pop()) ?? []) if (c !== lister && c !== root && !out.has(c)) { out.add(c); stack.push(c); }
  return out;
}
// Which of these pids still run. POSIX: a killed process can stay a zombie until its new parent reaps
// it, and kill(pid, 0) still finds a zombie, so ps decides (state Z = exited).
async function stillRunning(pids) {
  if (process.platform === "win32") return pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } });
  const out = await new Promise((resolve, reject) => {
    const child = spawn("ps", ["-A", "-o", "pid=", "-o", "stat="], { stdio: ["ignore", "pipe", "ignore"] });
    let text = "";
    child.stdout.on("data", (d) => { text += d; });
    child.on("error", reject);
    child.on("close", () => resolve(text));
  });
  const running = new Set(out.split("\n").map((l) => l.trim().split(/\s+/)).filter(([pid, stat]) => pid && stat && !stat.startsWith("Z")).map(([pid]) => Number(pid)));
  return pids.filter((pid) => running.has(pid));
}

export async function run() {
  // ======================= 1. no overlap with cloud work that hasn't stopped =======================
  await test("R3-1 codex: an acknowledged cancel with the cloud still running doesn't let a retry send another follow-up", async () => {
    const repo = await makeRepo({ origin: "https://github.com/acme/r31.git" });
    const env = codexEnv("env_r31", "r31", "acme/r31");
    let cur = { turn: "task_e_r31~assttrn_e_1", status: "completed" };
    let cancels = 0, followUps = 0;
    mockFetch(codexBase([env], [
      ["GET", /task_e_r31$/, () => json(details("task_e_r31", env, cur))],
      ["POST", /\/wham\/tasks$/, () => { followUps++; const id = `task_e_r31~assttrn_e_${followUps + 1}`; cur = { turn: id, status: "in_progress" }; return json({ turn: { id } }); }],
      ["POST", /task_e_r31\/cancel$/, () => { cancels++; return json({}); }], // acknowledged, but the turn keeps running
      ["GET", /task_e_r31\/turns\/[^/]+\/stream$/, (req) => (followUps === 1 ? hangingSse(req.signal) : doneStream("done"))],
    ]));
    const a = new MeghaAgent(fakeConn(), new CodexBackend({ pollMs: 50, stopWaitMs: 300 }), { env: {}, drainWaitMs: 5000 });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    a.sessions.get(sessionId).cloudId = "task_e_r31";
    const p = a.prompt({ sessionId, prompt: text("long") });
    await until(() => followUps === 1);
    await wait(100);
    await a.cancel({ sessionId });
    assert.equal((await p).stopReason, "cancelled");
    await until(() => cancels >= 1);
    const retry = await refusal(a.prompt({ sessionId, prompt: text("retry") }));
    assert.ok(retry, "the retry is refused while the cancelled turn still runs");
    assert.match(retry.message, STILL_RUNNING);
    assert.equal(followUps, 1, "no follow-up over the running turn");
    cur = { ...cur, status: "cancelled" };
    assert.equal((await a.prompt({ sessionId, prompt: text("retry again") })).stopReason, "end_turn");
    assert.equal(followUps, 2);
  });

  await test("R3-1 claude: an acknowledged interrupt with the session still running doesn't let a retry send another prompt", async () => {
    const repo = await makeRepo({ origin: null });
    let running = true, started = false; // the worker runs once the first prompt is in
    const kinds = [];
    mockFetch(claudeBase([
      ["POST", /cse_r31\/events$/, (req) => { const k = claudeEventKind(req); kinds.push(k); if (k === "user") started = true; return json({ results: [{ sequence_num: String(10 * kinds.length) }] }); }],
      ["GET", /cse_r31\/events\/stream$/, (req) => (running ? keepaliveSse(req.signal) : sse([crow(500, { type: "result", subtype: "success", is_error: false })]))],
      ["GET", /cse_r31$/, () => json({ session: { id: "cse_r31", worker_status: running && started ? "running" : "idle" } })],
    ]));
    const a = new MeghaAgent(fakeConn(), new ClaudeBackend({ statusPollMs: 60_000, stopWaitMs: 300 }), { env: {}, drainWaitMs: 5000 });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    const s = a.sessions.get(sessionId);
    Object.assign(s, { cloudId: "cse_r31", bundle: true, repoChecked: true, cloudState: "idle", sentMode: s.config.mode, sentModel: s.config.model });
    const p = a.prompt({ sessionId, prompt: text("long") });
    await until(() => kinds.includes("user"));
    await wait(100);
    await a.cancel({ sessionId });
    assert.equal((await p).stopReason, "cancelled");
    await until(() => kinds.includes("interrupt"));
    const users = () => kinds.filter((k) => k === "user").length;
    const retry = await refusal(a.prompt({ sessionId, prompt: text("retry") }));
    assert.ok(retry, "the retry is refused while the interrupted turn still runs");
    assert.match(retry.message, STILL_RUNNING);
    assert.equal(users(), 1, "no new prompt over the running turn");
    running = false;
    assert.equal((await a.prompt({ sessionId, prompt: text("retry again") })).stopReason, "end_turn");
    assert.equal(users(), 2);
  });

  await test("R3-1 codex: after a failed cancel, a restart still knows the turn may run and checks before prompting", async () => {
    const repo = await makeRepo({ origin: "https://github.com/acme/r31r.git" });
    const env = codexEnv("env_r31r", "r31r", "acme/r31r");
    let cur = { turn: "task_e_r31r~assttrn_e_1", status: "completed" };
    let followUps = 0;
    mockFetch(codexBase([env], [
      ["GET", /task_e_r31r$/, () => json(details("task_e_r31r", env, cur))],
      ["POST", /\/wham\/tasks$/, () => { followUps++; const id = `task_e_r31r~assttrn_e_${followUps + 1}`; cur = { turn: id, status: "in_progress" }; return json({ turn: { id } }); }],
      ["POST", /task_e_r31r\/cancel$/, () => json({ error: { code: "x" } }, 503)],
      ["GET", /task_e_r31r\/turns\/[^/]+\/stream$/, (req) => (followUps === 1 ? hangingSse(req.signal) : doneStream("done"))],
    ]));
    const a1 = new MeghaAgent(fakeConn(), new CodexBackend({ pollMs: 50, stopWaitMs: 300 }), { env: {}, drainWaitMs: 5000 });
    const { sessionId } = await a1.newSession({ cwd: repo, mcpServers: [] });
    a1.sessions.get(sessionId).cloudId = "task_e_r31r";
    const p = a1.prompt({ sessionId, prompt: text("long") });
    await until(() => followUps === 1);
    await wait(100);
    await a1.cancel({ sessionId });
    assert.equal((await p).stopReason, "cancelled");
    await a1.sessions.get(sessionId).turn.settled;
    // T3 restarts megha: a new process resumes the session and sends an ordinary prompt.
    const a2 = new MeghaAgent(fakeConn(), new CodexBackend({ pollMs: 50, stopWaitMs: 300 }), { env: {}, drainWaitMs: 5000 });
    await a2.resumeSession({ sessionId, cwd: repo, mcpServers: [] });
    const after = await refusal(a2.prompt({ sessionId, prompt: text("hello again") }));
    assert.ok(after, "the prompt after restart is refused while the turn still runs");
    assert.match(after.message, STILL_RUNNING);
    assert.equal(followUps, 1, "no follow-up over the running turn after restart");
    cur = { ...cur, status: "cancelled" };
    assert.equal((await a2.prompt({ sessionId, prompt: text("hello") })).stopReason, "end_turn");
    assert.equal(followUps, 2);
  });

  await test("R3-1 codex: a follow-up accepted but whose answer timed out is reconciled before the next one", async () => {
    const repo = await makeRepo({ origin: "https://github.com/acme/r31t.git" });
    const env = codexEnv("env_r31t", "r31t", "acme/r31t");
    let cur = { turn: "task_e_r31t~assttrn_e_1", status: "completed" };
    let followUps = 0;
    mockFetch(codexBase([env], [
      ["GET", /task_e_r31t$/, () => json(details("task_e_r31t", env, cur))],
      ["POST", /\/wham\/tasks$/, () => {
        followUps++;
        const id = `task_e_r31t~assttrn_e_${followUps + 1}`;
        cur = { turn: id, status: "in_progress" };
        // The cloud took it, but its answer never arrived in time.
        if (followUps === 1) return Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        return json({ turn: { id } });
      }],
      ["GET", /task_e_r31t\/turns\/[^/]+\/stream$/, () => doneStream("done")],
    ]));
    const a = new MeghaAgent(fakeConn(), new CodexBackend({ pollMs: 60_000 }), { env: {} });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    a.sessions.get(sessionId).cloudId = "task_e_r31t";
    assert.ok(await errOf(a.prompt({ sessionId, prompt: text("first") })), "the timed-out follow-up is reported");
    const next = await refusal(a.prompt({ sessionId, prompt: text("second") }));
    assert.ok(next, "the next prompt is refused while the accepted follow-up runs");
    assert.match(next.message, STILL_RUNNING);
    assert.equal(followUps, 1, "no second follow-up over the first");
    cur = { ...cur, status: "completed" };
    assert.equal((await a.prompt({ sessionId, prompt: text("third") })).stopReason, "end_turn");
    assert.equal(followUps, 2);
  });

  await test("R3-1 claude: a prompt accepted but whose answer timed out is reconciled before the next one", async () => {
    const repo = await makeRepo({ origin: null });
    let running = false, users = 0;
    mockFetch(claudeBase([
      ["POST", /cse_r31t\/events$/, (req) => {
        if (claudeEventKind(req) !== "user") return json({ results: [] });
        users++; running = true;
        if (users === 1) return Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        return json({ results: [{ sequence_num: "50" }] });
      }],
      ["GET", /cse_r31t\/events\/stream$/, () => sse([crow(60, { type: "result", subtype: "success", is_error: false })])],
      ["GET", /cse_r31t$/, () => json({ session: { id: "cse_r31t", worker_status: running ? "running" : "idle" } })],
    ]));
    const a = new MeghaAgent(fakeConn(), new ClaudeBackend({ statusPollMs: 60_000 }), { env: {} });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    const s = a.sessions.get(sessionId);
    Object.assign(s, { cloudId: "cse_r31t", bundle: true, repoChecked: true, cloudState: "idle", sentMode: s.config.mode, sentModel: s.config.model });
    assert.ok(await errOf(a.prompt({ sessionId, prompt: text("first") })));
    const next = await refusal(a.prompt({ sessionId, prompt: text("second") }));
    assert.ok(next, "the next prompt is refused while the accepted one runs");
    assert.match(next.message, STILL_RUNNING);
    assert.equal(users, 1);
    running = false;
    assert.equal((await a.prompt({ sessionId, prompt: text("third") })).stopReason, "end_turn");
    assert.equal(users, 2);
  });

  // ======================= 2. permissions die when the cloud turn starts ending =======================
  await test("R3-2 claude: a permission answered after the turn deadline sent its interrupt sends no allow", async () => {
    const repo = await makeRepo({ origin: null });
    const permission = deferred();
    const kinds = [];
    let live = null, asked = 0;
    mockFetch(claudeBase([
      ["POST", /cse_r32a\/events$/, (req) => { kinds.push(claudeEventKind(req)); return json({ results: [{ sequence_num: "10" }] }); }],
      ["GET", /cse_r32a\/events\/stream$/, (req) => { live = pushSse(req.signal); return live.response; }],
      ["GET", /cse_r32a$/, () => json({ session: { id: "cse_r32a", worker_status: "idle" } })],
    ]));
    const conn = fakeConn();
    conn.requestPermission = () => { asked++; return permission.promise; };
    const a = new MeghaAgent(conn, new ClaudeBackend({ statusPollMs: 60_000, turnTimeoutMs: 400, stopWaitMs: 5000 }), { env: {} });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    const s = a.sessions.get(sessionId);
    Object.assign(s, { cloudId: "cse_r32a", bundle: true, repoChecked: true, cloudState: "idle", sentMode: s.config.mode, sentModel: s.config.model });
    const p = errOf(a.prompt({ sessionId, prompt: text("clean the build") })); // fails (timed out) once the result arrives
    await until(() => live);
    live.push(crow(11, { type: "control_request", request_id: "req_r32a", request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "tu_r32a", input: { command: "rm -rf build" } } }));
    await until(() => asked === 1);
    await until(() => kinds.includes("interrupt")); // the deadline fired
    permission.resolve({ outcome: { outcome: "selected", optionId: "allow" } });
    await wait(300);
    assert.deepEqual(kinds.filter((k) => k.startsWith("control_response")), [], "no answer after the deadline began stopping the turn");
    live.push(crow(12, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "interrupted" }));
    await p;
  });

  await test("R3-2 claude: a permission answered after the terminal result (metadata GET still held) sends no allow", async () => {
    const repo = await makeRepo({ origin: null });
    const permission = deferred();
    const metaGate = deferred();
    const kinds = [];
    let live = null, asked = 0, resultSent = false;
    mockFetch(claudeBase([
      ["POST", /cse_r32b\/events$/, (req) => { kinds.push(claudeEventKind(req)); return json({ results: [{ sequence_num: "10" }] }); }],
      ["GET", /cse_r32b\/events\/stream$/, (req) => { live = pushSse(req.signal); return live.response; }],
      ["GET", /cse_r32b$/, () => (resultSent ? metaGate.promise : Promise.resolve()).then(() => json({ session: { id: "cse_r32b", worker_status: "idle" } }))],
    ]));
    const conn = fakeConn();
    conn.requestPermission = () => { asked++; return permission.promise; };
    const a = new MeghaAgent(conn, new ClaudeBackend({ statusPollMs: 60_000 }), { env: {} });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    const s = a.sessions.get(sessionId);
    Object.assign(s, { cloudId: "cse_r32b", bundle: true, repoChecked: true, cloudState: "idle", sentMode: s.config.mode, sentModel: s.config.model });
    const p = a.prompt({ sessionId, prompt: text("go") });
    await until(() => live);
    live.push(crow(11, { type: "control_request", request_id: "req_r32b", request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "tu_r32b", input: { command: "rm -rf build" } } }));
    await until(() => asked === 1);
    resultSent = true;
    live.push(crow(12, { type: "result", subtype: "success", is_error: false }));
    await wait(200); // the turn has its result; the metadata GET is held, so the run is still going
    permission.resolve({ outcome: { outcome: "selected", optionId: "allow" } });
    await wait(300);
    assert.deepEqual(kinds.filter((k) => k.startsWith("control_response")), [], "no answer after the cloud turn ended");
    metaGate.resolve();
    assert.equal((await p).stopReason, "end_turn");
  });

  // ======================= 3. cancelling git ends its whole process tree =======================
  const sockets = new Set();
  // Accepts and never answers. resume() reads (and drops) what git sends: a socket nobody reads never
  // sees the peer's FIN, so on Linux/macOS the server side sat in CLOSE_WAIT after git died and the
  // "connection closed" check failed even though git's whole tree was gone.
  const server = net.createServer((sock) => { sockets.add(sock); sock.resume(); sock.on("error", () => {}); sock.on("close", () => sockets.delete(sock)); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const hangUrl = `http://127.0.0.1:${server.address().port}/acme/tree.git`;
  // Start a stalled ls-remote, wait for its HTTP connection, record git's process tree, end it with
  // `end` (or let its timeout end it), then check every process of that tree is gone and the
  // connection closed.
  const probeTree = async (label, start, end = () => {}) => {
    const before = descendants(await processTable());
    const opened = sockets.size;
    const outcome = start();
    outcome.catch(() => {});
    await until(() => sockets.size > opened, 8000);
    const during = [...descendants(await processTable())].filter((pid) => !before.has(pid));
    assert.ok(during.length >= 2, `${label}: git started a process tree (${during.length} processes)`);
    end();
    const r = await hung(outcome, 10_000);
    assert.notEqual(r, "hung", `${label}: the git call settled`);
    const survivors = await stillRunning(during);
    assert.deepEqual(survivors, [], `${label}: no process of git's tree survives once the call settled`);
    await until(() => sockets.size === opened, 2000).catch(() => {});
    assert.equal(sockets.size, opened, `${label}: the HTTP connection was closed`);
    return r;
  };
  try {
    await test("R3-3 git: Stop during a stalled ls-remote kills git's whole process tree", async () => {
      const ac = new AbortController();
      const r = await probeTree("stop", () => git(tmp("tree"), ["ls-remote", hangUrl], { signal: ac.signal, network: true }), () => ac.abort());
      assert.ok(r.e instanceof Cancelled, `rejects with Cancelled, got ${JSON.stringify(r)}`);
    });

    await test("R3-3 git: the git timeout kills git's whole process tree", async () => {
      // Long enough for the process listing above to finish first.
      const r = await probeTree("timeout", () => git(tmp("tree"), ["ls-remote", hangUrl], { timeoutMs: 6000, network: true }));
      assert.equal(r.v?.timedOut, true);
    });
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }

  // ======================= 4. a failed rollback is never reported as success =======================
  await test("R3-4 apply: Stop after the previous diff was reversed, and putting it back fails, says so and how to recover", async () => {
    const repo = await makeRepo({ files: { "a.txt": "one\n" } });
    const prev = join(tmp("prev"), "prev.patch");
    writeFileSync(prev, diffOf("one", "two"));
    await git(repo, ["apply", prev]);
    const gate = deferred();
    const ac = new AbortController();
    const ran = [];
    const slowGit = async (cwd, args, o) => {
      ran.push(args.join(" "));
      if (args[0] === "apply" && args[1] === "--check") await gate.promise;
      return git(cwd, args, o);
    };
    const i = stdio.err.length;
    const p = errOf(applyLocally({ cwd: repo, diff: diffOf("one", "three"), name: "r34a", previousFile: prev, signal: ac.signal, run: slowGit }));
    await until(() => ran.some((c) => c.startsWith("apply --check")));
    writeFileSync(join(repo, "a.txt"), "edited meanwhile\n"); // the previous diff can no longer go back on
    ac.abort();
    gate.resolve();
    const e = await p;
    assert.ok(e, "the apply fails");
    assert.doesNotMatch(stderrSince(i), /as it was/, "never claims the checkout is as it was");
    assert.match(e.message, /could not put back/i);
    assert.match(e.message, /r34a-previous\.patch/, "names the saved previous patch");
    assert.match(e.message, /git -C .* apply /, "gives the exact recovery command");
    assert.equal(readA(repo), "edited meanwhile\n");
  });

  await test("R3-4 apply: a new diff that doesn't apply, then a failed restore, is reported as a failure with recovery steps", async () => {
    const repo = await makeRepo({ files: { "a.txt": "one\n" } });
    const prev = join(tmp("prev"), "prev.patch");
    writeFileSync(prev, diffOf("one", "two"));
    await git(repo, ["apply", prev]);
    const slowGit = async (cwd, args, o) => {
      // While megha looks at local edits (after reversing the previous diff), the file changes.
      if (args[0] === "status") writeFileSync(join(repo, "a.txt"), "edited meanwhile\n");
      return git(cwd, args, o);
    };
    const r = await applyLocally({ cwd: repo, diff: diffOf("zzz", "three"), name: "r34b", previousFile: prev, run: slowGit });
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.message, /Nothing was changed/);
    assert.match(r.message, /could not put back/i);
    assert.match(r.message, /r34b-previous\.patch/);
    assert.match(r.message, /r34b\.patch/);
    assert.match(r.message, /git -C .* apply /);
  });

  await test("R3-4 apply: a git apply killed by the timeout is checked, never assumed", async () => {
    const twoFiles = `${diffOf("one", "two", "a.txt")}${diffOf("bee", "bop", "b.txt")}`;
    const timedOut = { code: -1, stdout: "", stderr: "", timedOut: true };
    // Killed before it wrote anything: the checkout is untouched and megha says so.
    {
      const repo = await makeRepo({ files: { "a.txt": "one\n", "b.txt": "bee\n" } });
      const run = async (cwd, args, o) => (args[0] === "apply" && !args.includes("--check") ? timedOut : git(cwd, args, o));
      const r = await applyLocally({ cwd: repo, diff: twoFiles, name: "r34c1", run });
      assert.equal(r.ok, false);
      assert.match(r.message, /Nothing was changed/);
      assert.equal(readA(repo), "one\n");
    }
    // Killed after it wrote everything: megha sees the diff is in and reports it applied.
    {
      const repo = await makeRepo({ files: { "a.txt": "one\n", "b.txt": "bee\n" } });
      const run = async (cwd, args, o) => { const r = await git(cwd, args, o); return args[0] === "apply" && !args.includes("--check") ? timedOut : r; };
      const r = await applyLocally({ cwd: repo, diff: twoFiles, name: "r34c2", run });
      assert.equal(r.ok, true, r.message);
      assert.equal(readA(repo), "two\n");
    }
    // Killed halfway (one file of two written): megha can't call it applied or untouched.
    {
      const repo = await makeRepo({ files: { "a.txt": "one\n", "b.txt": "bee\n" } });
      const run = async (cwd, args, o) => {
        if (args[0] === "apply" && !args.includes("--check")) { await git(cwd, ["apply", "--include=a.txt", args.at(-1)]); return timedOut; }
        return git(cwd, args, o);
      };
      const r = await applyLocally({ cwd: repo, diff: twoFiles, name: "r34c3", run });
      assert.equal(r.ok, false);
      assert.doesNotMatch(r.message, /Nothing was changed/);
      assert.match(r.message, /partly/);
      assert.match(r.message, /r34c3\.patch/);
      assert.match(r.message, /git -C /);
    }
  });

  // ======================= 5. a bound session can't be moved to another repo =======================
  await test("R3-5 codex: resuming a session bound in repo A with repo B's folder is refused; nothing goes to A's task", async () => {
    const repoA = await makeRepo({ origin: "https://github.com/acme/a5.git" });
    const repoB = await makeRepo({ origin: "https://github.com/acme/b5.git" });
    const envA = codexEnv("env_a5", "a5", "acme/a5");
    const envB = codexEnv("env_b5", "b5", "acme/b5");
    let followUps = 0;
    const calls = mockFetch([
      ["GET", /environments\/by-repo\/github\/acme\/b5$/, () => json([envB])],
      ...codexBase([envA], [
        ["GET", /task_e_a5$/, () => json(details("task_e_a5", envA))],
        ["GET", /task_e_a5\/turns$/, () => json({ turn_mapping: {}, current_turn_id: null })],
        ["POST", /\/wham\/tasks$/, () => { followUps++; return json({ turn: { id: `task_e_a5~assttrn_e_${followUps + 1}` } }); }],
        ["GET", /task_e_a5\/turns\/[^/]+\/stream$/, () => doneStream("ok")],
      ]),
    ]);
    const a = new MeghaAgent(fakeConn(), new CodexBackend({ pollMs: 60_000 }), { env: {} });
    await a.resumeSession({ sessionId: "task_e_a5", cwd: repoA, mcpServers: [] });
    assert.equal((await a.prompt({ sessionId: "task_e_a5", prompt: text("in A") })).stopReason, "end_turn");
    assert.equal(followUps, 1);
    const resumed = await errOf(a.resumeSession({ sessionId: "task_e_a5", cwd: repoB, mcpServers: [] }));
    assert.ok(resumed, "resume with repo B's folder is refused");
    assert.match(resumed.message, /belongs to acme\/a5, not acme\/b5/);
    const turnsBefore = calls.filter((c) => c.path.endsWith("/turns")).length;
    const loaded = await errOf(a.loadSession({ sessionId: "task_e_a5", cwd: repoB, mcpServers: [] }));
    assert.ok(loaded, "load with repo B's folder is refused");
    assert.equal(calls.filter((c) => c.path.endsWith("/turns")).length, turnsBefore, "refused before replay");
    assert.equal(a.sessions.get("task_e_a5").cwd, repoA, "the binding still points at repo A");
    assert.equal(followUps, 1, "nothing was posted");
  });

  await test("R3-5 claude: resuming a bundle session bound in folder A with folder B is refused", async () => {
    const repoA = await makeRepo({ origin: null });
    const repoB = await makeRepo({ origin: null });
    mockFetch(claudeBase([
      ["POST", /\/v1\/files$/, () => json({ id: "file_r35" })],
      ["POST", /\/v1\/sessions$/, () => json({ id: "session_r35", title: "t" })],
      ["POST", /cse_r35\/events$/, () => json({ results: [] })],
      ["GET", /cse_r35\/events\/stream$/, () => sse([crow(5, { type: "result", subtype: "success", is_error: false })])],
      ["GET", /cse_r35$/, () => json({ session: { id: "cse_r35", worker_status: "idle", config: { sources: [] } } })],
    ]));
    const a = new MeghaAgent(fakeConn(), new ClaudeBackend({ statusPollMs: 60_000 }), { env: {} });
    const { sessionId } = await a.newSession({ cwd: repoA, mcpServers: [] });
    assert.equal((await a.prompt({ sessionId, prompt: text("task in A") })).stopReason, "end_turn");
    const resumed = await errOf(a.resumeSession({ sessionId, cwd: repoB, mcpServers: [] }));
    assert.ok(resumed, "resume with folder B is refused");
    assert.equal(a.sessions.get(sessionId).cwd, repoA);
  });

  // ======================= lower priority: retention =======================
  await test("R3-L sleep: a sleep that ran out leaves no abort listener behind", async () => {
    const ac = new AbortController();
    for (let i = 0; i < 15; i++) await sleep(1, ac.signal);
    assert.equal(getEventListeners(ac.signal, "abort").length, 0);
  });

  await test("R3-L agent: the drain timeout is cleared when the previous turn settles first", async () => {
    const repo = await makeRepo({ origin: null });
    mockFetch(claudeBase());
    const DRAIN = 987_654;
    const a = new MeghaAgent(fakeConn(), new ClaudeBackend({ statusPollMs: 60_000 }), { env: {}, drainWaitMs: DRAIN });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    const s = a.sessions.get(sessionId);
    const gate = deferred();
    s.turn = { isSettled: false, settled: gate.promise }; // a previous turn still settling
    const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
    const drainTimers = new Set();
    globalThis.setTimeout = (fn, ms, ...rest) => { const t = realSet(fn, ms, ...rest); if (ms === DRAIN) drainTimers.add(t); return t; };
    globalThis.clearTimeout = (t) => { drainTimers.delete(t); return realClear(t); };
    try {
      const p = a.prompt({ sessionId, prompt: text("/open") });
      await until(() => drainTimers.size === 1);
      gate.resolve();
      assert.equal((await p).stopReason, "end_turn");
      assert.equal(drainTimers.size, 0, "the losing drain timeout was cleared");
    } finally {
      globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear;
      for (const t of drainTimers) realClear(t);
    }
  });
}
