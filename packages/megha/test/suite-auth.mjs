// Sign-in (lib/login.mjs): the terminal auth method the ACP Registry requires, how T3 and the registry's
// CI see it, `authenticate`, auth_required for a missing CLI login, and `megha --login`. None of it may
// run a login, refresh a token or write a credential file.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { zInitializeResponse } from "../node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { MeghaAgent } from "../lib/agent.mjs";
import { UserError } from "../lib/util.mjs";
import { runLogin } from "../lib/login.mjs";
import { test, tmp, fakeConn } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "index.mjs");

// What each client sends in initialize.clientCapabilities.
const T3_SIGN_IN = { auth: { terminal: true }, elicitation: { url: {} }, fs: { readTextFile: false, writeTextFile: false }, terminal: false }; // T3 probe/auth discovery with a PTY
const T3_CHAT = { fs: { readTextFile: false, writeTextFile: false }, terminal: false }; // T3 chat sessions
const REGISTRY_CI = { terminal: true, fs: { readTextFile: true, writeTextFile: true }, _meta: { terminal_output: true, "terminal-auth": true } }; // .github/workflows/client.py

class FakeBackend {
  constructor(name = "codex", { loggedIn = true } = {}) { this.name = name; this.loggedIn = loggedIn; }
  label = "Fake Cloud"; title = "Megha · Fake"; commands = [];
  checkAuth() { if (!this.loggedIn) throw new UserError("Codex Cloud: cannot read /nowhere/auth.json (ENOENT). Sign in with `codex login` (ChatGPT account)."); }
  async prepare(s) { s.config ??= {}; }
  configOptions() { return []; }
}

// The registry CI's acceptance rule (client.py parse_auth_methods + validate_auth_methods).
const registryType = (m) => m.type || (m._meta?.["terminal-auth"] ? "terminal" : "agent");
const registryAccepts = (methods) => (methods ?? []).some((m) => ["agent", "terminal"].includes(registryType(m)));

// Spawns the real entry point, sends one initialize, returns the parsed response line.
async function initializeOverStdio(args, clientCapabilities, env = process.env) {
  const child = spawn(process.execPath, [ENTRY, ...args], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "test", version: "1" }, clientCapabilities } }) + "\n");
  const deadline = Date.now() + 10_000;
  while (!out.includes("\n") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.stdin.end();
  await new Promise((r) => { child.once("exit", r); setTimeout(() => { child.kill(); r(); }, 3000).unref(); });
  assert.ok(out.includes("\n"), `no initialize response; stderr: ${err.slice(0, 300)}`);
  return JSON.parse(out.split("\n")[0]);
}

const runCli = (args, env = process.env) => new Promise((resolve) => {
  const c = spawn(process.execPath, [ENTRY, ...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let o = ""; c.stdout.on("data", (d) => { o += d; }); c.stderr.on("data", (d) => { o += d; });
  c.on("exit", (code) => resolve({ code, o }));
});

const snapshot = (files) => files.map((f) => { const st = statSync(f); return `${f}:${st.size}:${st.mtimeMs}:${readFileSync(f, "utf8")}`; });

export async function run({ logins }) {
  const credentialFiles = [join(logins.codexHome, "auth.json"), join(logins.claudeHome, ".credentials.json")];
  const before = snapshot(credentialFiles);

  await test("auth: initialize offers one terminal method per backend to a client that can run it", async () => {
    for (const [name, id] of [["codex", "codex-login"], ["claude", "claude-login"]]) {
      for (const caps of [T3_SIGN_IN, REGISTRY_CI]) {
        const init = await new MeghaAgent(fakeConn(), new FakeBackend(name), { env: {} }).initialize({ protocolVersion: 1, clientCapabilities: caps });
        assert.deepEqual(init.authMethods.map((m) => [m.id, m.type, m.args]), [[id, "terminal", ["--backend", name, "--login"]]]);
        assert.match(init.authMethods[0].description, name === "codex" ? /`codex login`/ : /`claude`, type \/login/);
        assert.ok(zInitializeResponse.safeParse(init).success, "valid ACP initialize response");
        assert.ok(registryAccepts(init.authMethods), "registry CI accepts it");
      }
    }
  });

  await test("auth: no terminal method for a client that can't run one (ACP rule; T3 chat sessions)", async () => {
    const a = new MeghaAgent(fakeConn(), new FakeBackend(), { env: {} });
    assert.deepEqual((await a.initialize({ protocolVersion: 1, clientCapabilities: T3_CHAT })).authMethods, []);
    assert.deepEqual((await a.initialize()).authMethods, []);
  });

  await test("auth: the real entry point answers the registry CI's initialize with a terminal method", async () => {
    for (const name of ["codex", "claude"]) {
      const res = await initializeOverStdio(["--backend", name], REGISTRY_CI);
      assert.equal(res.error, undefined);
      assert.equal(res.result.authMethods[0].type, "terminal");
      assert.deepEqual(res.result.authMethods[0].args, ["--backend", name, "--login"]);
    }
    // The registry CI runs with HOME set to an empty sandbox: no CLI login. initialize must still answer.
    const empty = tmp("auth-nohome");
    const res = await initializeOverStdio(["--backend", "codex"], REGISTRY_CI, { ...process.env, HOME: empty, USERPROFILE: empty, CODEX_HOME: join(empty, ".codex") });
    assert.equal(res.result.authMethods[0].id, "codex-login");
  });

  await test("auth: a logged-in user is never asked to sign in (session/new, authenticate succeed)", async () => {
    const a = new MeghaAgent(fakeConn(), new FakeBackend(), { env: {} });
    await a.initialize({ protocolVersion: 1, clientCapabilities: T3_SIGN_IN });
    const s = await a.newSession({ cwd: tmp("auth-ok"), mcpServers: [] });
    assert.match(s.sessionId, /^mg_/);
    assert.deepEqual(await a.authenticate({ methodId: "codex-login" }), {});
  });

  await test("auth: a missing CLI login is auth_required (-32000) with how to sign in, on every session call", async () => {
    const a = new MeghaAgent(fakeConn(), new FakeBackend("codex", { loggedIn: false }), { env: {} });
    const cwd = tmp("auth-missing");
    for (const call of [() => a.newSession({ cwd, mcpServers: [] }), () => a.loadSession({ sessionId: "mg_x", cwd, mcpServers: [] }),
      () => a.resumeSession({ sessionId: "mg_x", cwd, mcpServers: [] }), () => a.listSessions({ cwd }), () => a.authenticate({ methodId: "codex-login" })]) {
      await assert.rejects(call(), (e) => e.code === -32000 && /codex login/.test(e.message));
    }
  });

  await test("auth: authenticate refuses a method megha doesn't offer", async () => {
    const a = new MeghaAgent(fakeConn(), new FakeBackend("claude"), { env: {} });
    await assert.rejects(a.authenticate({ methodId: "codex-login" }), (e) => e.code === -32602 && /claude-login/.test(e.message));
    await assert.rejects(a.authenticate({}), (e) => e.code === -32602);
  });

  await test("auth: --login exits 0 with the login present, for T3's appended args and the registry's replaced args", async () => {
    for (const args of [["--backend", "codex", "--backend", "codex", "--login"], ["--backend", "codex", "--login"], ["--backend", "claude", "--login"]]) {
      const r = await runCli(args);
      assert.equal(r.code, 0, r.o);
      assert.match(r.o, /is ready\. (ChatGPT sign-in|claude\.ai login) found/);
      assert.ok(!r.o.includes(logins.codexToken) && !r.o.includes(logins.claudeToken), "no tokens printed");
    }
  });

  await test("auth: --login without a login explains how to sign in and exits 1 (no terminal: no wait)", async () => {
    const empty = tmp("auth-nologin");
    const codex = await runCli(["--backend", "codex", "--login"], { ...process.env, CODEX_HOME: empty });
    assert.equal(codex.code, 1);
    assert.match(codex.o, /Not signed in yet/); assert.match(codex.o, /run: codex login/);
    const claude = await runCli(["--backend", "claude", "--login"], { ...process.env, CLAUDE_CONFIG_DIR: empty });
    assert.equal(claude.code, 1);
    assert.match(claude.o, /run: claude\n/); assert.match(claude.o, /Type \/login/);
  });

  await test("auth: in a terminal, --login re-checks on Enter and stops on q", async () => {
    const tty = () => Object.assign(new PassThrough(), { isTTY: true });
    let ok = false, out = "";
    const input = tty();
    const done = runLogin({ backend: "codex", input, write: (s) => { out += s; }, check: () => (ok ? { ok: true, detail: "ChatGPT sign-in found" } : { ok: false, detail: "no login" }) });
    await new Promise((r) => setTimeout(r, 20));
    input.write("\n");
    await new Promise((r) => setTimeout(r, 20));
    assert.match(out, /Still not signed in: no login/);
    ok = true; input.write("\n");
    assert.equal(await done, 0);
    assert.match(out, /Codex Cloud is ready/);

    const quit = tty();
    const stopped = runLogin({ backend: "claude", input: quit, write: () => {}, check: () => ({ ok: false, detail: "no login" }) });
    quit.write("q\n");
    assert.equal(await stopped, 1);
    const closed = tty();
    const ended = runLogin({ backend: "claude", input: closed, write: () => {}, check: () => ({ ok: false, detail: "no login" }) });
    closed.end();
    assert.equal(await ended, 1, "terminal closed counts as stopped");
  });

  await test("auth: sign-in paths never write the CLI credential files", () => {
    assert.deepEqual(snapshot(credentialFiles), before);
  });
}
