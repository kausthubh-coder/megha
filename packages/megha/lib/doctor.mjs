// `megha doctor`: is this machine ready to run cloud threads? Checks the CLI logins (token present and
// not expired; the token itself is never printed), Node and git. Runs only local checks.

import { spawnSync } from "node:child_process";
import { readAuth } from "./codex.mjs";
import { readCredentials } from "./claude.mjs";
import { DATA_DIR } from "./util.mjs";

const hours = (ms) => (ms > 48 * 3600_000 ? `${Math.round(ms / 86_400_000)} days` : `${Math.max(0, Math.round(ms / 3600_000))} h`);

// One backend's CLI login, read only (also `megha --login` and ACP authenticate, lib/login.mjs).
export function loginCheck(backend) {
  try {
    if (backend === "codex") {
      const a = readAuth();
      return { ok: true, name: "codex login", detail: `ChatGPT sign-in found${a.expiresAt ? `, token valid for ${hours(a.expiresAt - Date.now())}` : ""}` };
    }
    const c = readCredentials();
    return { ok: true, name: "claude login", detail: `claude.ai login found${c.expiresAt ? `, token valid for ${hours(c.expiresAt - Date.now())}` : ""}` };
  } catch (e) { return { ok: false, name: `${backend} login`, detail: e.message }; }
}

export function loginChecks() {
  return [loginCheck("codex"), loginCheck("claude")];
}

export function toolChecks() {
  const out = [];
  const major = Number(process.versions.node.split(".")[0]);
  out.push({ ok: major >= 22, name: "node", detail: `${process.versions.node}${major >= 22 ? "" : " (megha needs Node 22 or newer)"}` });
  const g = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  out.push({ ok: g.status === 0, name: "git", detail: g.status === 0 ? g.stdout.trim() : "git not found on PATH (both clouds need a git repo)" });
  return out;
}

export function printChecks(checks, write = (s) => process.stdout.write(s)) {
  for (const c of checks) write(`${c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(13)} ${c.detail}\n`);
  return checks.every((c) => c.ok);
}

export function runDoctor(write) {
  const checks = [...toolChecks(), ...loginChecks()];
  const ok = printChecks(checks, write);
  (write ?? ((s) => process.stdout.write(s)))(`\ndata dir: ${DATA_DIR}\n${ok ? "Ready." : "Fix the FAIL lines above. A failed login only blocks that backend."}\n`);
  return ok;
}
