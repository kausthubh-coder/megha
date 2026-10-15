// Makes a cloud session (Claude Code on the web, Codex Cloud) ready by itself. A cloud VM starts from a
// bare Linux clone: no global skills, no deps, no .claude/skills link, no codex or claude login.
//
//   Claude: the SessionStart hook in .claude/settings.json runs `node scripts/cloud.mjs`
//   Codex:  the environment's setup script is `CLOUD=1 node scripts/cloud.mjs`
//
// Local sessions don't set CLAUDE_CODE_REMOTE, CODEX_CI or CLOUD, so it exits at once there.
// stdout becomes the session's context, so only Kausthubh's rules and the last line go there; setup's
// and the doctor's output go to stderr.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isCloud } from "./setup.mjs";
import { findBrowser } from "./browser.mjs";

if (!isCloud) process.exit(0);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const run = (command, stdout) => spawnSync(command, { cwd: root, shell: true, stdio: ["ignore", stdout, "inherit"] }).status === 0;

// 1. Kausthubh's global skills and rules. Its stdout (the rules) passes through to the session.
if (!run("curl -fsSL https://raw.githubusercontent.com/kausthubh-coder/skills/main/cloud/session.sh | bash", "inherit"))
  problems.push("the global skills and rules didn't load");

// 2. bun, at the version package.json pins, when the VM has none (Codex Cloud images may not).
if (!run("bun --version", "ignore")) {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager.replace(/^bun@/, "");
  if (!run(`npm install -g bun@${version}`, process.stderr)) problems.push("bun is missing and `npm install -g bun` failed");
}

// 3. Setup (deps from bun.lock, .claude/skills link, port), then the doctor. Output goes to stderr.
if (!run("node scripts/setup.mjs", process.stderr)) problems.push("setup failed (run bun run setup)");
else if (!run("node scripts/doctor.mjs", process.stderr)) problems.push("the doctor has FAIL lines (run bun run doctor)");

// 4. A browser for verify-megha's site-check. The doctor above already reports when there's none.
if (!findBrowser() && !run("npx -y playwright@latest install chromium", process.stderr))
  problems.push("no browser for site-check, and installing Playwright's Chromium failed");

console.log(problems.length
  ? `cloud: megha NOT ready: ${problems.join("; ")}.`
  : "cloud: megha ready (deps, skills link, port, browser; no CLI logins, by design). See ## Cloud sessions in AGENTS.md.");
