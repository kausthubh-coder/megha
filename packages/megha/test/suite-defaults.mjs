// --default-mode/-model/-environment/-apply: parsing, the starting values a new session gets, and the
// fallback (megha's usual default plus one stderr line) for values the account or backend doesn't have.

import assert from "node:assert/strict";
import { MeghaAgent } from "../lib/agent.mjs";
import { CodexBackend } from "../lib/codex.mjs";
import { ClaudeBackend } from "../lib/claude.mjs";
import { parseDefaults } from "../lib/defaults.mjs";
import { test, makeRepo, mockFetch, fakeConn, stdio } from "./harness.mjs";
import { codexEnv, codexBase, claudeBase } from "./suite-hardening.mjs";

const stderrSince = (i) => stdio.err.slice(i).join("");
const current = (configOptions) => Object.fromEntries(configOptions.map((o) => [o.id, o.currentValue]));

export async function run() {
  await test("defaults: parseDefaults reads both flag forms and leaves other arguments alone", () => {
    const warnings = [];
    const argv = ["index.mjs", "--backend", "claude", "--default-mode", "bypassPermissions", "--default-model=claude-opus-5-5",
      "--default-environment", "My Env", "--default-apply", "on"];
    assert.deepEqual(parseDefaults(argv, (l) => warnings.push(l)), { mode: "bypassPermissions", model: "claude-opus-5-5", environment: "My Env", apply: "on" });
    assert.deepEqual(warnings, []);
    assert.deepEqual(parseDefaults(["--backend", "codex"]), {});
  });

  await test("defaults: a flag without a value is dropped with one line, and doesn't eat the next flag", () => {
    const warnings = [];
    assert.deepEqual(parseDefaults(["--default-model", "--default-mode", "ask", "--default-apply=", "--default-environment"], (l) => warnings.push(l)), { mode: "ask" });
    assert.deepEqual(warnings, ["--default-model needs a value; ignoring it", "--default-apply needs a value; ignoring it", "--default-environment needs a value; ignoring it"]);
  });

  await test("defaults: claude new sessions start from the defaults, and each thread can still change them", async () => {
    const repo = await makeRepo({ origin: "https://github.com/acme/defaults-claude.git" });
    mockFetch(claudeBase());
    const i = stdio.err.length;
    const backend = new ClaudeBackend({ defaults: { mode: "bypassPermissions", model: "claude-haiku-5-5", environment: "default", apply: "on" } });
    const a = new MeghaAgent(fakeConn(), backend, { env: {} });
    const { sessionId, configOptions } = await a.newSession({ cwd: repo, mcpServers: [] });
    // "default" matches the environment named "Default" without case.
    assert.deepEqual(current(configOptions), { model: "claude-haiku-5-5", environment: "env_cloud", mode: "bypassPermissions", apply: "on", localChanges: "off" });
    assert.doesNotMatch(stderrSince(i), /--default-/);
    const changed = await a.setSessionConfigOption({ sessionId, configId: "mode", value: "plan" });
    assert.equal(current(changed.configOptions).mode, "plan");
    const model = await a.setSessionConfigOption({ sessionId, configId: "model", value: "claude-opus-5-5" });
    assert.equal(current(model.configOptions).model, "claude-opus-5-5");
  });

  await test("defaults: claude option names match too (\"Bypass permissions\", \"haiku 5.5\")", async () => {
    const repo = await makeRepo({ origin: "https://github.com/acme/defaults-names.git" });
    mockFetch(claudeBase());
    const i = stdio.err.length;
    const a = new MeghaAgent(fakeConn(), new ClaudeBackend({ defaults: { mode: "Bypass permissions", model: "haiku 5.5" } }), { env: {} });
    const { configOptions } = await a.newSession({ cwd: repo, mcpServers: [] });
    assert.equal(current(configOptions).mode, "bypassPermissions");
    assert.equal(current(configOptions).model, "claude-haiku-5-5");
    assert.doesNotMatch(stderrSince(i), /--default-/);
  });

  await test("defaults: claude values the account doesn't have fall back to today's defaults, one stderr line each, once", async () => {
    const repo = await makeRepo({ origin: "https://github.com/acme/defaults-bad.git" });
    mockFetch(claudeBase());
    const i = stdio.err.length;
    const backend = new ClaudeBackend({ defaults: { mode: "yolo", model: "claude-nope-9", environment: "env_gone", apply: "maybe" } });
    const a = new MeghaAgent(fakeConn(), backend, { env: {} });
    const first = await a.newSession({ cwd: repo, mcpServers: [] });
    const second = await a.newSession({ cwd: repo, mcpServers: [] });
    for (const { configOptions } of [first, second]) {
      assert.deepEqual(current(configOptions), { model: "claude-opus-5-5", environment: "env_cloud", mode: "acceptEdits", apply: "off", localChanges: "off" });
    }
    const err = stderrSince(i);
    for (const flag of ["mode", "model", "environment", "apply"]) {
      assert.equal(err.split(`--default-${flag} `).length - 1, 1, `--default-${flag}: exactly one line across two sessions`);
    }
    assert.match(err, /--default-mode "yolo" isn't available on Claude Code on the web \(one of: default, acceptEdits, plan, bypassPermissions\); using megha's usual default/);
    assert.match(err, /--default-model "claude-nope-9" isn't available/);
  });

  await test("defaults: a session that already has values (a loaded record) keeps them", async () => {
    const repo = await makeRepo({ origin: "https://github.com/acme/defaults-keep.git" });
    mockFetch(claudeBase());
    const backend = new ClaudeBackend({ defaults: { mode: "bypassPermissions", model: "claude-haiku-5-5", apply: "on" } });
    const session = { cwd: repo, config: { mode: "plan", model: "claude-opus-5-5", apply: "off" } };
    await backend.prepare(session);
    assert.equal(session.config.mode, "plan");
    assert.equal(session.config.model, "claude-opus-5-5");
    assert.equal(session.config.apply, "off");
  });

  await test("defaults: codex new sessions start from the defaults; environment by name", async () => {
    const repo = await makeRepo({ origin: "https://github.com/acme/defaults-codex.git" });
    const envs = [codexEnv("env_a", "First", "acme/defaults-codex"), codexEnv("env_b", "Second", "acme/defaults-codex")];
    mockFetch(codexBase(envs));
    const a = new MeghaAgent(fakeConn(), new CodexBackend({ defaults: { mode: "ask", model: "gpt-b", environment: "second", apply: "on" } }), { env: {} });
    const { sessionId, configOptions } = await a.newSession({ cwd: repo, mcpServers: [] });
    assert.deepEqual(current(configOptions), { model: "gpt-b", environment: "env_b", mode: "ask", apply: "on", localChanges: "off" });
    const changed = await a.setSessionConfigOption({ sessionId, configId: "mode", value: "code" });
    assert.equal(current(changed.configOptions).mode, "code");
  });

  await test("defaults: codex unknown values (another repo's environment, a claude mode) fall back with a line each", async () => {
    const repo = await makeRepo({ origin: "https://github.com/acme/defaults-codex-bad.git" });
    const envs = [codexEnv("env_c", "Only", "acme/defaults-codex-bad")];
    mockFetch(codexBase(envs));
    const i = stdio.err.length;
    const a = new MeghaAgent(fakeConn(), new CodexBackend({ defaults: { mode: "bypassPermissions", model: "gpt-zzz", environment: "env_other_repo" } }), { env: {} });
    const { configOptions } = await a.newSession({ cwd: repo, mcpServers: [] });
    assert.deepEqual(current(configOptions), { model: "gpt-5.6-sol", environment: "env_c", mode: "code", apply: "off", localChanges: "off" });
    const err = stderrSince(i);
    assert.match(err, /--default-mode "bypassPermissions" isn't available on Codex Cloud \(one of: code, ask, plan\)/);
    assert.match(err, /--default-model "gpt-zzz" isn't available on Codex Cloud/);
    assert.match(err, /--default-environment "env_other_repo" isn't available on Codex Cloud/);
  });
}
