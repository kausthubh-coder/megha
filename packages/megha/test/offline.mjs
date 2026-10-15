// Offline checks (no network; every fetch is mocked). Runs in `bun run test`.
//   node test/offline.mjs
// Env is pointed at throwaway folders first: the data dir, fake CLI logins, and no T3 MCP endpoint.
// The suites are imported afterwards because lib/util.mjs reads MEGHA_DATA_DIR at import time.
// suite-secrecy.mjs runs last: it scans everything the earlier suites printed, sent and wrote.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "megha-offline-"));
process.env.MEGHA_DATA_DIR = join(root, "data");
process.env.CODEX_HOME = join(root, "logins", "codex");
process.env.CLAUDE_CONFIG_DIR = join(root, "logins", "claude");
process.env.CLAUDE_CODE_ORGANIZATION_UUID = "00000000-0000-4000-8000-000000000000";
process.env.T3CODE_HOME = join(root, "t3");
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.T3_ACP_MCP_ENDPOINT;
delete process.env.T3_ACP_MCP_AUTHORIZATION;
delete process.env.CODEX_CLOUD_TASKS_BASE_URL;
delete process.env.CLAUDE_CLOUD_BASE_URL;

const { writeFakeLogins, failed, teeStdio, instrument } = await import("./harness.mjs");
teeStdio();
instrument();
const logins = writeFakeLogins(join(root, "logins"));
const realFetch = globalThis.fetch;
// `node test/offline.mjs suite-round2.mjs` runs only the named suites (while working on one).
const ALL = ["suite-core.mjs", "suite-prompt.mjs", "suite-agent.mjs", "suite-codex.mjs", "suite-claude.mjs", "suite-hardening.mjs", "suite-round2.mjs", "suite-round3.mjs", "suite-round4.mjs", "suite-round5.mjs", "suite-secrecy.mjs"];
const only = process.argv.slice(2);
try {
  for (const suite of only.length ? ALL.filter((s) => only.includes(s)) : ALL) {
    console.log(`\n# ${suite}`);
    await (await import(`./${suite}`)).run({ root, logins });
    globalThis.fetch = realFetch;
  }
} finally {
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
}
const n = failed();
console.log(n ? `\n${n} FAILED` : "\nall offline checks passed");
process.exit(n ? 1 : 0);
