// Set up a fresh checkout: install dependencies from the lockfile, then pick a free port for the site.
//   node scripts/setup.mjs [--skip-install]
// Prints the PORT to use; `PORT=<n> bun run dev` starts the site on it.

import { spawnSync } from "node:child_process";
import { createServer, connect } from "node:net";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// A cloud session (Claude Code on the web, Codex Cloud, or CLOUD=1 by hand). scripts/cloud.mjs runs only
// there, and the doctor expects no CLI logins there.
export const isCloud = process.env.CLAUDE_CODE_REMOTE === "true" || !!process.env.CODEX_CI || process.env.CLOUD === "1";
const skipInstall = process.argv.includes("--skip-install");

// Something answers on this host/port. A listen-only probe on 127.0.0.1 misses Next, which listens on
// 0.0.0.0 and [::], so a connect probe on both loopbacks is what tells us the port is taken.
function answers(port, host) {
  return new Promise((resolve) => {
    const sock = connect({ port, host });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(300, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

function canListen(port, host) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

export async function portIsFree(port) {
  if ((await answers(port, "127.0.0.1")) || (await answers(port, "::1"))) return false;
  return canListen(port, "0.0.0.0");
}

// The main checkout starts at 3000; each worktree gets its own starting port from its path, so
// parallel worktrees don't all race for 3000.
export function startPort(dir = root) {
  const common = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: dir, encoding: "utf8" }).stdout?.trim();
  const isWorktree = common && !/^\.git\/?$/.test(common);
  if (!isWorktree) return 3000;
  let h = 0;
  for (const ch of dir) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 3100 + (h % 800);
}

export async function freePort(start = startPort(), tries = 50) {
  for (let p = start; p < start + tries; p++) if (await portIsFree(p)) return p;
  throw new Error(`no free port in ${start}-${start + tries - 1}`);
}

// .claude/skills points at .agents/skills so Claude Code and Codex read the same skills. It is not
// committed (git would store a second copy), so every checkout creates it here.
function linkSkills() {
  const link = join(root, ".claude", "skills");
  if (existsSync(link)) return;
  mkdirSync(join(root, ".claude"), { recursive: true });
  symlinkSync(join(root, ".agents", "skills"), link, process.platform === "win32" ? "junction" : "dir");
  console.log("linked .claude/skills -> .agents/skills");
}

// Run only when executed directly (doctor.mjs imports portIsFree from here).
if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/setup.mjs")) {
  if (!skipInstall) {
    console.log("bun install --frozen-lockfile");
    const r = spawnSync("bun", ["install", "--frozen-lockfile"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) { console.error("bun install failed; fix that first (is bun on PATH?)"); process.exit(1); }
  }
  linkSkills();
  const port = await freePort(Number(process.env.PORT) || startPort());
  console.log(`\nPORT=${port}`);
  console.log(`Start the site with: PORT=${port} bun run dev`);
  console.log("Check the machine with: bun run doctor");
}
