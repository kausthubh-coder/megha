// The agent's turn lifecycle with a fake backend: fast cancel, steering after cancel, commands,
// command advertisement, and taking over a cloud task after T3 replaces the session (rollback).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MeghaAgent, CANCEL_GRACE_MS } from "../lib/agent.mjs";
import { test, tmp, fakeConn } from "./harness.mjs";

const { fixtures } = JSON.parse(readFileSync(new URL("./fixtures/t3-prompts.json", import.meta.url), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeBackend {
  name = "codex"; label = "Fake Cloud"; title = "Megha · Fake";
  commands = [{ name: "pr", description: "Open a PR" }];
  prompts = []; commandsRun = []; seenCloudIds = [];
  windDownMs = 3000; // how long the cloud takes to acknowledge a cancel
  checkAuth() {}
  async prepare(s) { s.config ??= {}; }
  configOptions() { return []; }
  setConfig() {}
  async prompt(s, input, io) {
    this.prompts.push(input.text);
    this.seenCloudIds.push(s.cloudId ?? null);
    s.cloudId ??= "task_fake_1";
    io.text("working ");
    if (input.text.startsWith("slow")) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 30_000);
        io.signal.addEventListener("abort", () => { clearTimeout(t); setTimeout(resolve, this.windDownMs); }, { once: true });
      });
      io.text("late output after cancel");
      return io.signal.aborted ? "cancelled" : "end_turn";
    }
    io.text("done");
    return "end_turn";
  }
  async command(s, cmd, io) { this.commandsRun.push(cmd); io.text(`ran /${cmd.name}`); }
}

const texts = (conn, sessionId) => conn.notes.filter((n) => n.sessionId === sessionId && n.update.sessionUpdate === "agent_message_chunk").map((n) => n.update.content.text).join("");

export async function run() {
  const cwd = tmp("agent");

  await test("initialize: megha name/title and image prompts advertised", async () => {
    const a = new MeghaAgent(fakeConn(), new FakeBackend(), { version: "9.9.9", env: {} });
    const init = await a.initialize();
    assert.equal(init.agentInfo.name, "megha-codex");
    assert.equal(init.agentInfo.title, "Megha · Fake");
    assert.equal(init.agentCapabilities.promptCapabilities.image, true);
  });

  await test("session/new advertises megha's slash commands after responding", async () => {
    const conn = fakeConn();
    const a = new MeghaAgent(conn, new FakeBackend(), { env: {} });
    const s = await a.newSession({ cwd, mcpServers: [] });
    await sleep(20);
    const u = conn.notes.find((n) => n.sessionId === s.sessionId && n.update.sessionUpdate === "available_commands_update");
    assert.deepEqual(u.update.availableCommands.map((c) => c.name), ["pr"]);
  });

  await test("cancel answers within the grace period; a steer right after is accepted and waits for the wind-down", async () => {
    const conn = fakeConn(); const be = new FakeBackend();
    const a = new MeghaAgent(conn, be, { env: {} });
    const { sessionId } = await a.newSession({ cwd, mcpServers: [] });
    const t0 = Date.now();
    const p = a.prompt({ sessionId, prompt: [{ type: "text", text: "slow task" }] });
    await sleep(200);
    await a.cancel({ sessionId });
    const res = await p;
    const answeredMs = Date.now() - t0 - 200;
    assert.equal(res.stopReason, "cancelled");
    assert.ok(answeredMs < CANCEL_GRACE_MS + 500, `answered after ${answeredMs} ms`);
    assert.ok(answeredMs < 2000, "well inside T3's 10 s interrupt timeout");
    // The steer: a new prompt on the same session, immediately.
    const t1 = Date.now();
    const steer = await a.prompt({ sessionId, prompt: [{ type: "text", text: "actually, only fix the test" }] });
    assert.equal(steer.stopReason, "end_turn");
    assert.ok(Date.now() - t1 >= be.windDownMs - CANCEL_GRACE_MS - 300, "the steer waited for the cancelled cloud turn");
    assert.deepEqual(be.prompts, ["slow task", "actually, only fix the test"]);
    assert.ok(!texts(conn, sessionId).includes("late output after cancel"), "output of a cancelled turn is muted after T3 got its answer");
  });

  await test("a second prompt while one is running is refused", async () => {
    const be = new FakeBackend(); be.windDownMs = 10;
    const a = new MeghaAgent(fakeConn(), be, { env: {} });
    const { sessionId } = await a.newSession({ cwd, mcpServers: [] });
    const p = a.prompt({ sessionId, prompt: [{ type: "text", text: "slow" }] });
    await sleep(50);
    await assert.rejects(a.prompt({ sessionId, prompt: [{ type: "text", text: "again" }] }), /already running/);
    await a.cancel({ sessionId });
    assert.equal((await p).stopReason, "cancelled");
  });

  await test("T3 wrappers are stripped before the backend sees the prompt; /pr runs locally", async () => {
    const conn = fakeConn(); const be = new FakeBackend();
    const a = new MeghaAgent(conn, be, { env: {} });
    const { sessionId } = await a.newSession({ cwd, mcpServers: [] });
    await a.prompt({ sessionId, prompt: fixtures.firstTurn });
    assert.equal(be.prompts[0], "Fix the flaky login test in src/auth.test.ts");
    const r = await a.prompt({ sessionId, prompt: fixtures.slashCommand });
    assert.equal(r.stopReason, "end_turn");
    assert.deepEqual(be.commandsRun, [{ name: "pr", args: "" }]);
    assert.equal(be.prompts.length, 1, "/pr is not sent to the cloud");
  });

  await test("rollback: a new session for the same thread continues the same cloud task", async () => {
    const env = { T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:1/mcp", T3_ACP_MCP_AUTHORIZATION: "Bearer thread-A" };
    const be1 = new FakeBackend();
    const a1 = new MeghaAgent(fakeConn(), be1, { env });
    const s1 = await a1.newSession({ cwd, mcpServers: [] });
    await a1.prompt({ sessionId: s1.sessionId, prompt: [{ type: "text", text: "first" }] });
    // T3 rolls back: a new process, session/new, and the next prompt carries the context handoff.
    const conn2 = fakeConn(); const be2 = new FakeBackend();
    const a2 = new MeghaAgent(conn2, be2, { env });
    const s2 = await a2.newSession({ cwd, mcpServers: [] });
    await a2.prompt({ sessionId: s2.sessionId, prompt: fixtures.handoffFirstTurn });
    assert.equal(be2.seenCloudIds[0], "task_fake_1", "took over the thread's cloud task");
    assert.match(be2.prompts[0], /^T3 Code started a new session for this conversation/);
    assert.match(texts(conn2, s2.sessionId), /Continuing the same cloud task/);
    // A different thread (different credential) with a handoff starts fresh and says so.
    const conn3 = fakeConn(); const be3 = new FakeBackend();
    const a3 = new MeghaAgent(conn3, be3, { env: { ...env, T3_ACP_MCP_AUTHORIZATION: "Bearer thread-B" } });
    const s3 = await a3.newSession({ cwd, mcpServers: [] });
    await a3.prompt({ sessionId: s3.sessionId, prompt: fixtures.handoffFirstTurn });
    assert.equal(be3.seenCloudIds[0], null);
    assert.match(texts(conn3, s3.sessionId), /Starting a new cloud task/);
  });
}
