// Is this checkout ready to work in? Checks installed deps against bun.lock, both CLI logins (token
// present and not expired; never printed), gh auth, that PORT is free, and whether HEAD is behind
// origin/main.
//   node scripts/doctor.mjs

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loginChecks, toolChecks, printChecks } from "../packages/megha/lib/doctor.mjs";
import { portIsFree } from "./setup.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [...toolChecks()];

// bun.lock is JSON with trailing commas.
function readLock() {
  return JSON.parse(readFileSync(join(root, "bun.lock"), "utf8").replace(/,(\s*[}\]])/g, "$1"));
}

function depsCheck() {
  let lock;
  try { lock = readLock(); } catch (e) { return { ok: false, name: "deps", detail: `cannot read bun.lock (${e.message})` }; }
  const problems = [];
  let n = 0;
  for (const [dir, ws] of Object.entries(lock.workspaces ?? {})) {
    for (const name of Object.keys({ ...ws.dependencies, ...ws.devDependencies })) {
      n++;
      const want = lock.packages?.[name]?.[0]?.replace(/^.+@/, "");
      const candidates = [join(root, dir, "node_modules", name, "package.json"), join(root, "node_modules", name, "package.json")];
      const file = candidates.find((f) => existsSync(f));
      if (!file) { problems.push(`${name} missing`); continue; }
      const have = JSON.parse(readFileSync(file, "utf8")).version;
      if (want && have !== want) problems.push(`${name} ${have} (lockfile ${want})`);
    }
  }
  return problems.length
    ? { ok: false, name: "deps", detail: `${problems.slice(0, 5).join(", ")}${problems.length > 5 ? ` and ${problems.length - 5} more` : ""}. Run \`bun install\`.` }
    : { ok: true, name: "deps", detail: `${n} direct dependencies match bun.lock` };
}

function ghCheck() {
  // `gh auth token` answers from the local keyring in under a second; `gh auth status` calls the
  // GitHub API and sometimes hung for 25 s. The token is only checked for presence, never printed.
  // No windowsHide: with it, gh on Windows did not return (gh 2.97, 2026-10-14).
  // Run outside the checkout: the first gh call inside this OneDrive repo stalled for 25 s.
  const r = spawnSync("gh", ["auth", "token", "--hostname", "github.com"], { cwd: tmpdir(), stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 });
  if (r.error?.code === "ETIMEDOUT") return { ok: false, name: "gh auth", detail: "`gh auth token` did not answer within 15 s" };
  if (r.error) return { ok: false, name: "gh auth", detail: "gh not found on PATH (needed to open PRs)" };
  const ok = r.status === 0 && r.stdout.length > 0;
  return { ok, name: "gh auth", detail: ok ? "signed in to github.com" : "not signed in: run `gh auth login`" };
}

function behindCheck() {
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 20_000 });
  if (git(["remote", "get-url", "origin"]).status !== 0) return { ok: true, name: "origin/main", detail: "no origin remote yet (skipped)" };
  const f = git(["fetch", "--quiet", "origin", "main"]);
  if (f.status !== 0) return { ok: true, name: "origin/main", detail: "could not fetch origin main (offline?); skipped" };
  const behind = Number(git(["rev-list", "--count", "HEAD..origin/main"]).stdout.trim() || 0);
  return { ok: behind === 0, name: "origin/main", detail: behind ? `HEAD is ${behind} commit${behind === 1 ? "" : "s"} behind origin/main: rebase or merge first` : "up to date" };
}

checks.push(depsCheck(), ...loginChecks(), ghCheck());
const port = Number(process.env.PORT) || 3000;
checks.push({ ok: await portIsFree(port), name: "port", detail: `PORT ${port} ${(await portIsFree(port)) ? "is free" : "is in use: run `bun run setup` to pick a free one"}` });
checks.push(behindCheck());
process.exit(printChecks(checks) ? 0 : 1);
