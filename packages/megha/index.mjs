#!/usr/bin/env node
// megha: an ACP agent (stdio, newline-delimited JSON-RPC) that runs T3 Code threads on
// Codex Cloud (--backend codex) or Claude Code on the web (--backend claude).
// In agent mode stdout is the protocol; all logging goes to stderr.

import { Readable, Writable } from "node:stream";
import { VERSION } from "./lib/version.mjs";

const HELP = `megha ${VERSION}: run T3 Code (or any ACP client) threads on Codex Cloud or Claude Code on the web.

Usage:
  megha --backend codex     ACP agent for Codex Cloud (uses your \`codex login\`)
  megha --backend claude    ACP agent for Claude Code on the web (uses your \`claude auth login\`)
  megha doctor              check Node, git and both logins (prints no tokens)
  megha --version | --help

In T3 Code: Settings > Providers > Add provider > Local ACP command, with the command
\`node <path>/megha/index.mjs --backend codex\` (one provider per backend).
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

const acp = await import("@agentclientprotocol/sdk");
const { log, setLogPrefix, migrateLegacyStore } = await import("./lib/util.mjs");
const { MeghaAgent } = await import("./lib/agent.mjs");
const backend = backendName === "codex" ? new (await import("./lib/codex.mjs")).CodexBackend() : new (await import("./lib/claude.mjs")).ClaudeBackend();

setLogPrefix(`megha:${backendName}`);
try { migrateLegacyStore(); } catch (e) { log(`session migration failed: ${e.message}`); }
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const conn = new acp.AgentSideConnection((c) => new MeghaAgent(c, backend, { version: VERSION }), stream);
conn.closed?.then?.(() => process.exit(0));
log(`ready (v${VERSION}, cwd ${process.cwd()})`);
