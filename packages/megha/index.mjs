#!/usr/bin/env node
// megha: an ACP agent (stdio, newline-delimited JSON-RPC) that runs T3 Code threads on
// Codex Cloud (--backend codex) or Claude Code on the web (--backend claude).
// In agent mode stdout is the protocol; all logging goes to stderr.

import { Readable, Writable } from "node:stream";
import { VERSION } from "./lib/version.mjs";

const HELP = `megha ${VERSION}: run T3 Code (or any ACP client) threads on Codex Cloud or Claude Code on the web.

Usage:
  megha --backend codex           ACP agent for Codex Cloud (uses your \`codex login\`)
  megha --backend claude          ACP agent for Claude Code on the web (uses your \`claude\` /login)
  megha --backend <b> --login     say whether that CLI login is there and how to sign in
                                  (the ACP sign-in method; never runs a login or touches tokens)
  megha doctor                    check Node, git and both logins (prints no tokens)
  megha --version | --help

Starting values for new threads (add after --backend; each thread can still change them):
  --default-mode <mode>           claude: default, acceptEdits, plan, bypassPermissions (megha's default: acceptEdits)
                                  codex: code, ask, plan (megha's default: code)
  --default-model <id>            a model id from the Model option, e.g. claude-opus-5-5 or gpt-5.6-sol
  --default-environment <id|name> a cloud environment, by id or by its name
  --default-apply on|off          apply the cloud diff to this checkout (megha's default: off)
A value the account doesn't have (a model, an environment) is ignored with one line on stderr.

In T3 Code: Settings > Providers > Add provider > Local ACP command, with the command
\`node <path>/megha/index.mjs --backend codex\` (one provider per backend), or edit
~/.t3/userdata/settings.json, for example:
  "commandArgs": ["<path>/megha/index.mjs", "--backend", "claude",
                  "--default-mode", "bypassPermissions", "--default-model", "claude-opus-5-5"]
`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(HELP); process.exit(0); }
if (argv.includes("--version") || argv.includes("-v")) { process.stdout.write(`${VERSION}\n`); process.exit(0); }
if (argv[0] === "doctor") {
  const { runDoctor } = await import("./lib/doctor.mjs");
  process.exit(runDoctor() ? 0 : 1);
}

const i = argv.indexOf("--backend");
const backendName = i >= 0 ? argv[i + 1] : process.env.MEGHA_BACKEND ?? process.env.CLOUD_ACP_BACKEND;
if (!["codex", "claude"].includes(backendName ?? "")) {
  process.stderr.write(`megha: pass --backend codex or --backend claude\n\n${HELP}`);
  process.exit(2);
}

// The ACP terminal sign-in method (lib/login.mjs): a plain terminal program, not the ACP agent.
if (argv.includes("--login")) {
  const { runLogin } = await import("./lib/login.mjs");
  process.exit(await runLogin({ backend: backendName }));
}

const acp = await import("@agentclientprotocol/sdk");
const { log, setLogPrefix, migrateLegacyStore, describeError } = await import("./lib/util.mjs");
const { MeghaAgent } = await import("./lib/agent.mjs");
const { parseDefaults, describeDefaults } = await import("./lib/defaults.mjs");

setLogPrefix(`megha:${backendName}`);
const defaults = parseDefaults(argv);
const backend = backendName === "codex" ? new (await import("./lib/codex.mjs")).CodexBackend({ defaults }) : new (await import("./lib/claude.mjs")).ClaudeBackend({ defaults });
try { migrateLegacyStore(); } catch (e) { log(`session migration failed: ${describeError(e)}`); }
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const conn = new acp.AgentSideConnection((c) => new MeghaAgent(c, backend, { version: VERSION }), stream);
conn.closed?.then?.(() => process.exit(0));
log(`ready (v${VERSION}, cwd ${process.cwd()}, defaults: ${describeDefaults(defaults)})`);
