#!/usr/bin/env node
// Drive this checkout's megha agent over ACP the way T3 Code does (node.exe + index.mjs --backend <b>,
// cwd = a git repo, shell:false, stdio JSON-RPC) and keep a raw transcript as evidence.
//
//   node .agents/skills/verify-megha/scripts/acp-drive.mjs --backend codex|claude [options]
//
// Options:
//   --cwd <repo>          repo the "thread" runs in (default: the krida checkout)
//   --out <dir>           evidence folder (default: %TEMP%/megha-verify/<stamp>-acp-<backend>)
//   --load <cloudId>      replay an existing cloud task/session with session/load instead of session/new
//   --steps <file.json>   custom steps (see below) instead of the default read-only sequence
//   --prompt "<text>"     after session/new: Ask mode (Codex), apply off, then ONE session/prompt.
//                         Creates a cloud task: needs --allow-cloud-task and --cwd on krida.
//   --allow-cloud-task    permit session/prompt steps (they cost the user's quota). Not needed for a
//                         prompt that is exactly "/status" or "/open" (they only read the task).
//   --shared-data         use the real data dir (%LOCALAPPDATA%\megha) instead of a throwaway one
//   --agent <index.mjs>   agent entry to run (default: this checkout's packages/megha/index.mjs)
//   -- <agent args>       passed to the agent after --backend <b>, like T3's commandArgs
//                         (e.g. `-- --default-mode bypassPermissions --default-apply on`)
//
// Default steps (read-only, no cloud task): initialize -> session/new -> session/list.
// A steps file is a JSON array of {method, params?, notify?, async?, waitMs?, timeoutMs?, expectError?}.
//   "$sessionId", "$cwd" and "$loadId" (the --load value) inside params are replaced. async: send and move on (await at the end), for
//   cancel/steer races. waitMs: pause before sending. notify: a notification (session/cancel).
// Writes transcript.jsonl (every line both ways), stderr.log and summary.json to --out. Exit 1 on a
// failed step or non-JSON on stdout.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KRIDA = "C:\\Users\\kaust\\OneDrive\\Documents\\dev\\krida";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

// The initialize T3 sends (copied from packages/megha/test/client.mjs T3_INITIALIZE).
const T3_INITIALIZE = {
  protocolVersion: 2,
  info: { name: "t3-code", version: "0.0.46-nightly" },
  capabilities: {},
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "t3-code", version: "0.0.46-nightly" },
};

function parseArgs(argv) {
  const a = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    const name = k.slice(2);
    if (["allow-cloud-task", "shared-data"].includes(name)) a.flags.add(name);
    else a[name] = argv[++i];
  }
  return a;
}

// Everything after a bare `--` goes to the agent after `--backend <b>` (T3's commandArgs), e.g.
// `-- --default-mode bypassPermissions`.
const rawArgs = process.argv.slice(2);
const sep = rawArgs.indexOf("--");
const agentArgs = sep >= 0 ? rawArgs.slice(sep + 1) : [];
const args = parseArgs(sep >= 0 ? rawArgs.slice(0, sep) : rawArgs);
const backend = args.backend;
if (!["codex", "claude"].includes(backend)) {
  console.error("usage: acp-drive.mjs --backend codex|claude [--cwd <repo>] [--load <id>] [--steps <file>] [--prompt <text> --allow-cloud-task]");
  process.exit(2);
}
const cwd = resolve(args.cwd ?? KRIDA);
const agentPath = resolve(args.agent ?? join(repoRoot, "packages", "megha", "index.mjs"));
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const out = resolve(args.out ?? join(tmpdir(), "megha-verify", `${stamp}-acp-${backend}`));
if (!existsSync(agentPath)) { console.error(`no agent at ${agentPath}`); process.exit(2); }
if (!existsSync(join(cwd, ".git"))) { console.error(`${cwd} is not a git checkout; megha needs one`); process.exit(2); }

// ---------- steps ----------
let steps;
if (args.steps) steps = JSON.parse(readFileSync(resolve(args.steps), "utf8"));
else if (args.load) steps = [
  { method: "initialize", params: T3_INITIALIZE },
  { method: "session/load", params: { sessionId: args.load, cwd: "$cwd", mcpServers: [] }, timeoutMs: 120_000 },
];
else {
  steps = [
    { method: "initialize", params: T3_INITIALIZE },
    { method: "session/new", params: { cwd: "$cwd", mcpServers: [] } },
  ];
  if (args.prompt) steps.push(
    { method: "$readonly-config" },
    { method: "session/prompt", params: { sessionId: "$sessionId", prompt: [{ type: "text", text: args.prompt }] }, timeoutMs: 15 * 60_000 },
  );
  else steps.push({ method: "session/list", params: { cwd: "$cwd" }, waitMs: 300 });
}

// Cloud tasks cost quota: refuse before spawning anything. /status and /open only read the task, so a
// prompt that is exactly one of them passes without the flag.
const readOnlyCommand = (s) => {
  const blocks = s.params?.prompt ?? [];
  return blocks.length === 1 && blocks[0].type === "text" && /^\/(status|open)\s*$/.test(blocks[0].text);
};
if (steps.some((s) => s.method === "session/prompt" && !readOnlyCommand(s))) {
  if (!args.flags.has("allow-cloud-task")) { console.error("refusing: session/prompt creates a cloud task. Pass --allow-cloud-task (read-only prompt, krida only)."); process.exit(2); }
  if (cwd.toLowerCase() !== KRIDA.toLowerCase()) { console.error(`refusing: cloud tasks only on ${KRIDA}`); process.exit(2); }
}

mkdirSync(out, { recursive: true });
const transcript = join(out, "transcript.jsonl");
writeFileSync(transcript, "");
const t0 = Date.now();
const rec = (dir, msg) => appendFileSync(transcript, JSON.stringify({ t: Date.now() - t0, dir, msg }) + "\n");

const env = { ...process.env };
if (!args.flags.has("shared-data")) env.MEGHA_DATA_DIR = join(out, "data");
// No T3 MCP endpoint: this drive is not a T3 thread.
delete env.T3_ACP_MCP_ENDPOINT; delete env.T3_ACP_MCP_AUTHORIZATION;

const child = spawn(process.execPath, [agentPath, "--backend", backend, ...agentArgs], { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
let stderr = "";
child.stderr.on("data", (d) => { stderr += d.toString(); });
const pending = new Map();
const updates = {};
const badLines = [];
let nextId = 1;
let sessionId = null;
let lastConfig = null;

const send = (msg) => { rec("->", msg); child.stdin.write(JSON.stringify(msg) + "\n"); };
createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { badLines.push(line); rec("<-raw", line); return; }
  rec("<-", msg);
  if (msg.id !== undefined && !msg.method && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code })) : p.resolve(msg.result);
    return;
  }
  if (msg.method === "session/update") {
    const kind = msg.params?.update?.sessionUpdate ?? "?";
    updates[kind] = (updates[kind] ?? 0) + 1;
    if (kind === "config_option_update") lastConfig = msg.params.update.configOptions;
    return;
  }
  if (msg.method && msg.id !== undefined) {
    // Permission requests: allow reads and searches only, like test/e2e.mjs.
    const ok = ["read", "search", "fetch"].includes(msg.params?.toolCall?.kind);
    const result = msg.method === "session/request_permission" ? { outcome: { outcome: "selected", optionId: ok ? "allow" : "reject" } } : null;
    send({ jsonrpc: "2.0", id: msg.id, result });
  }
});

function request(method, params, timeoutMs) {
  const id = nextId++;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); res(v); }, reject: (e) => { clearTimeout(timer); rej(e); } });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const fill = (v) => JSON.parse(JSON.stringify(v ?? {})
  .replaceAll('"$sessionId"', JSON.stringify(sessionId)).replaceAll('"$cwd"', JSON.stringify(cwd)).replaceAll('"$loadId"', JSON.stringify(args.load ?? null)));
const results = [];
const asyncRuns = [];

async function setOption(configId, value) {
  const r = await request("session/set_config_option", { sessionId, configId, value }, 60_000);
  lastConfig = r.configOptions ?? lastConfig;
  return { configId, value, now: lastConfig?.find((o) => o.id === configId)?.currentValue };
}

async function runStep(step) {
  const started = Date.now();
  const row = { method: step.method };
  try {
    if (step.method === "$readonly-config") {
      // Read-only turn settings: never apply a diff locally; Codex in Ask mode on the krida environment.
      const set = [await setOption("apply", "off")];
      if (backend === "codex") {
        const envOpt = lastConfig?.find((o) => o.id === "environment");
        const krida = envOpt?.options?.find((c) => /krida/i.test(`${c.name} ${c.value}`));
        if (!krida) throw new Error(`no Codex environment labelled krida (choices: ${envOpt?.options?.map((c) => c.name).join(", ")})`);
        set.push(await setOption("environment", krida.value), await setOption("mode", "ask"));
      }
      row.result = set;
    } else if (step.notify) {
      send({ jsonrpc: "2.0", method: step.method, params: fill(step.params) });
      row.result = "notified";
    } else {
      const r = await request(step.method, fill(step.params), step.timeoutMs ?? 60_000);
      if (r?.sessionId) sessionId = r.sessionId;
      if (step.method === "session/load" || step.method === "session/resume") sessionId = fill(step.params).sessionId;
      if (r?.configOptions) lastConfig = r.configOptions;
      row.result = summarize(step.method, r);
    }
    row.ok = !step.expectError;
  } catch (e) {
    row.error = e.message; row.ok = Boolean(step.expectError);
  }
  row.ms = Date.now() - started;
  console.log(`${row.ok ? "ok  " : "FAIL"} ${row.method} (${row.ms} ms)${row.error ? `: ${row.error}` : ""}${row.result && typeof row.result !== "string" ? ` ${JSON.stringify(row.result).slice(0, 300)}` : ""}`);
  results.push(row);
}

function summarize(method, r) {
  if (method === "initialize") return { protocolVersion: r.protocolVersion, agent: r.agentInfo, caps: r.agentCapabilities, authMethods: r.authMethods };
  if (method === "session/new" || method === "session/load") return { sessionId: r.sessionId ?? sessionId, options: (r.configOptions ?? []).map((o) => `${o.id}=${o.currentValue} [${o.options?.length ?? 0} choices]`) };
  if (method === "session/list") return { sessions: r.sessions?.length, first: r.sessions?.slice(0, 5).map((s) => `${s.sessionId} ${s.title ?? ""}`) };
  if (method === "session/prompt") return { stopReason: r.stopReason };
  return r;
}

try {
  for (const step of steps) {
    if (step.waitMs) await new Promise((r) => setTimeout(r, step.waitMs));
    if (step.async) asyncRuns.push(runStep(step)); else await runStep(step);
  }
  await Promise.all(asyncRuns);
  await new Promise((r) => setTimeout(r, 300));
} finally {
  child.stdin.end();
  await new Promise((r) => { child.once("exit", r); setTimeout(() => { child.kill(); r(); }, 3000).unref(); });
}

const failed = results.some((r) => !r.ok) || badLines.length > 0;
const summary = { backend, cwd, agentPath, dataDir: env.MEGHA_DATA_DIR ?? "(shared)", steps: results, updates, nonJsonStdoutLines: badLines.length, ok: !failed };
writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
writeFileSync(join(out, "stderr.log"), stderr);
console.log(`session/update kinds: ${JSON.stringify(updates)}`);
if (badLines.length) console.log(`FAIL non-JSON on stdout: ${badLines[0].slice(0, 120)}`);
console.log(`${failed ? "FAILED" : "PASSED"}  evidence: ${out}`);
process.exit(failed ? 1 : 0);
