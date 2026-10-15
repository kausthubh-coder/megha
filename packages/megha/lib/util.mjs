// Shared helpers: stderr logging, the session store, caches, git, SSE parsing.
// stdout belongs to the ACP protocol, so nothing here may write to it.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let logPrefix = "megha";
export const setLogPrefix = (p) => { logPrefix = p; };
// Logs go to stderr. Callers pass short descriptions only, never tokens or task/env JSON.
export function log(...parts) {
  process.stderr.write(`[${logPrefix}] ${parts.map((p) => (typeof p === "string" ? p : String(p))).join(" ")}\n`);
}

export const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

export class UserError extends Error {}

// ---------- data dir: %LOCALAPPDATA%\megha (ids, settings and caches only, no secrets) ----------
const appData = () => process.env.LOCALAPPDATA || join(homedir(), ".local", "share");
// MEGHA_DATA_DIR lets tests use a throwaway folder.
export const DATA_DIR = process.env.MEGHA_DATA_DIR || join(appData(), "megha");
const storeFile = join(DATA_DIR, "sessions.json");
const LEGACY_STORE = join(appData(), "cloud-acp", "sessions.json");

// megha was called cloud-acp; carry its session map over once so imported threads keep working.
export function migrateLegacyStore({ from = LEGACY_STORE } = {}) {
  if (existsSync(storeFile) || !existsSync(from)) return false;
  mkdirSync(DATA_DIR, { recursive: true });
  copyFileSync(from, storeFile);
  log(`migrated sessions from ${from}`);
  return true;
}

function readStore() {
  try {
    const s = JSON.parse(readFileSync(storeFile, "utf8"));
    return { sessions: s.sessions ?? {}, hints: s.hints ?? {} };
  } catch { return { sessions: {}, hints: {} }; }
}
function writeStore(store) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${storeFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, storeFile);
}
export function loadSessionRecord(id) {
  return readStore().sessions[id] ?? null;
}
export function findSessionByCloudId(backend, cloudId) {
  return Object.values(readStore().sessions).find((s) => s.backend === backend && s.cloudId === cloudId) ?? null;
}
export function allSessionRecords(backend) {
  return Object.values(readStore().sessions).filter((s) => s.backend === backend);
}
const PERSISTED_KEYS = ["id", "backend", "cwd", "cloudId", "turnId", "doneTurnId", "lastSeq", "title", "webUrl", "config", "bundle",
  "outcomeBranch", "baseBranch", "baseSha", "appliedPatchFile", "sentMode", "sentModel", "prUrl", "createdAt", "updatedAt"];
export function saveSessionRecord(session) {
  const store = readStore();
  const rec = {};
  for (const k of PERSISTED_KEYS) if (session[k] !== undefined) rec[k] = session[k];
  rec.updatedAt = new Date().toISOString();
  store.sessions[session.id] = rec;
  // Keep the file small: drop the oldest records past 500.
  const entries = Object.entries(store.sessions).sort((a, b) => (b[1].updatedAt ?? "").localeCompare(a[1].updatedAt ?? ""));
  store.sessions = Object.fromEntries(entries.slice(0, 500));
  writeStore(store);
}

// Thread hints: T3 replaces the ACP session on rollback (provider-acp adapter rollbackThread) and gives
// megha no thread id. Its per-thread MCP credential is stable for the thread, so a hash of it (never
// the credential) maps a fresh session back to the cloud task the thread was using.
export const hintKey = (cwd, secret) => crypto.createHash("sha256").update(`${String(cwd).toLowerCase()}\n${secret}`).digest("hex").slice(0, 32);
export function saveHint(key, value) {
  const store = readStore();
  store.hints[key] = { ...value, at: new Date().toISOString() };
  const entries = Object.entries(store.hints).sort((a, b) => (b[1].at ?? "").localeCompare(a[1].at ?? ""));
  store.hints = Object.fromEntries(entries.slice(0, 200));
  writeStore(store);
}
export function loadHint(key, maxAgeMs = 7 * 24 * 3600_000) {
  const h = readStore().hints[key];
  if (!h || Date.now() - Date.parse(h.at ?? 0) > maxAgeMs) return null;
  return h;
}

// ---------- small JSON cache in the data dir (model and environment lists; never secrets) ----------
export function readCache(name, ttlMs) {
  try {
    const j = JSON.parse(readFileSync(join(DATA_DIR, "cache", `${name}.json`), "utf8"));
    return { value: j.value, fresh: Date.now() - j.at < ttlMs };
  } catch { return null; }
}
export function writeCache(name, value) {
  try {
    const dir = join(DATA_DIR, "cache");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.json`);
    writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify({ at: Date.now(), value }));
    renameSync(`${file}.${process.pid}.tmp`, file);
  } catch (e) { log(`cache write failed: ${e.message}`); }
}
// Fresh cache -> it; else fetch (bounded) -> cache; fetch failure -> stale cache -> fallback.
export async function cachedList(name, ttlMs, fetcher, fallback) {
  const hit = readCache(name, ttlMs);
  if (hit?.fresh && Array.isArray(hit.value) && hit.value.length) return hit.value;
  try {
    const value = await fetcher();
    if (Array.isArray(value) && value.length) { writeCache(name, value); return value; }
  } catch (e) {
    if (e instanceof UserError) throw e;
    log(`${name} fetch failed: ${e.message}`);
  }
  return Array.isArray(hit?.value) && hit.value.length ? hit.value : fallback;
}

// ---------- git ----------
export function git(cwd, args, { input, allowFail = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out = []; const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => (allowFail ? resolve({ code: -1, stdout: "", stderr: e.message }) : reject(e)));
    child.on("close", (code) => {
      const r = { code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
      if (code !== 0 && !allowFail) reject(new Error(`git ${args[0]} failed: ${r.stderr.trim().slice(0, 300)}`));
      else resolve(r);
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

export function parseGitHubRemote(url) {
  if (!url) return null;
  const m = url.match(/^(?:git@|ssh:\/\/git@)([^:/]+)[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/) || url.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  return m ? { host: m[1].toLowerCase(), owner: m[2], name: m[3] } : null;
}

// What we know about the thread's repo without touching the network.
export async function repoInfo(cwd) {
  // One round of independent git calls: each spawn costs ~0.2 s on Windows (more on OneDrive).
  const [top, origin, cur, head, refs] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel"]),
    git(cwd, ["remote", "get-url", "origin"]),
    git(cwd, ["branch", "--show-current"]),
    git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
    git(cwd, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes/origin/"]),
  ]);
  if (top.code !== 0) return { isRepo: false, cwd };
  const originUrl = origin.stdout.trim() || null;
  const remote = parseGitHubRemote(originUrl);
  const branch = cur.stdout.trim() || null;
  const remoteRefs = new Map(refs.stdout.split("\n").filter(Boolean).map((l) => { const [sha, ref] = l.split(" "); return [ref.replace(/^refs\/remotes\/origin\//, ""), sha]; }));
  let defaultBranch = head.stdout.trim().replace(/^origin\//, "") || null;
  if (!defaultBranch) defaultBranch = ["main", "master"].find((b) => remoteRefs.has(b)) ?? null;
  const remoteSha = (b) => (b ? remoteRefs.get(b) ?? null : null);
  return {
    isRepo: true,
    root: top.stdout.trim(),
    originUrl,
    github: remote && remote.host === "github.com" ? { owner: remote.owner, name: remote.name } : null,
    remote,
    branch,
    defaultBranch: defaultBranch ?? "main",
    branchSha: remoteSha(branch),
    defaultSha: remoteSha(defaultBranch ?? "main"),
  };
}

// Work the cloud can't see because it clones from origin: commits not on origin and uncommitted
// changes to tracked files. Untracked files never travel (same as the codex and claude CLIs).
export async function localChanges(cwd, repo) {
  if (!repo?.isRepo) return { any: false, base: null };
  const baseRef = repo.branchSha ? `origin/${repo.branch}` : repo.defaultSha ? `origin/${repo.defaultBranch}` : null;
  const [d, mb, count] = await Promise.all([
    git(cwd, ["diff", "--name-only", "HEAD"]),
    baseRef ? git(cwd, ["merge-base", "HEAD", baseRef]) : null,
    baseRef ? git(cwd, ["rev-list", "--count", `${baseRef}..HEAD`]) : null,
  ]);
  const dirty = d.stdout.split("\n").filter(Boolean);
  if (!baseRef) return { any: dirty.length > 0, base: null, baseRef: null, unpushed: 0, dirty, branchOnOrigin: false };
  const base = mb.code === 0 ? mb.stdout.trim() : null;
  // Commits reachable from HEAD but not from origin = commits since the merge-base.
  const ahead = base && count.code === 0 ? Number(count.stdout.trim() || 0) : 0;
  return { any: ahead > 0 || dirty.length > 0 || !repo.branchSha, base, baseRef, unpushed: ahead, dirty, branchOnOrigin: !!repo.branchSha };
}

// Patch of local work against the merge-base with origin, so applying it on origin's branch head adds
// only what is local (a plain `git diff origin/x` would also revert newer upstream commits).
export async function localPatch(cwd, info) {
  if (!info?.base) return "";
  const d = await git(cwd, ["diff", "--no-color", "--binary", info.base]);
  return d.code === 0 ? d.stdout : "";
}

// Detect the install command a cloud setup script should run, from the lockfile in the repo root.
export function setupCommandsFor(root, exists = existsSync) {
  if (!root) return [];
  if (exists(join(root, "bun.lock")) || exists(join(root, "bun.lockb"))) return ["bun install"];
  if (exists(join(root, "pnpm-lock.yaml"))) return ["pnpm i"];
  if (exists(join(root, "package-lock.json"))) return ["npm ci"];
  if (exists(join(root, "yarn.lock"))) return ["yarn"];
  return [];
}

// ---------- SSE ----------
// Yields {event, id, data} frames from a fetch Response body.
export async function* sseFrames(res) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let k;
    while ((k = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, k); buf = buf.slice(k + 2);
      let event = "message", id, data = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith(":")) continue;
        const i = line.indexOf(":");
        const field = i < 0 ? line : line.slice(0, i);
        let value = i < 0 ? "" : line.slice(i + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "id") id = value;
        else if (field === "data") data.push(value);
      }
      if (data.length) yield { event, id, data: data.join("\n") };
    }
  }
}

// Keep the end of long tool output: that is the useful part, and T3 bounds it anyway.
export function tail(text, max = 8000) {
  if (typeof text !== "string") return text;
  return text.length <= max ? text : `[earlier output truncated]\n${text.slice(text.length - max)}`;
}

export const isoFromEpochSeconds = (s) => (typeof s === "number" ? new Date(s * 1000).toISOString() : null);

// Turn raw terminal output (ANSI colours, cursor moves, \r-redrawn spinners) into plain lines.
export function cleanTerminal(text) {
  return String(text ?? "")
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .split("\n")
    .map((line) => line.split("\r").filter((part) => part.trim() !== "").pop() ?? "")
    .map((line) => line.replace(/[⠀-⣿]/g, "").replace(/\s+$/, ""))
    .filter((line) => line !== "")
    .join("\n");
}

// First GitHub pull request URL anywhere in an API response (walks a bounded part of the JSON, so
// nothing of the response itself is ever logged).
export function findPullRequestUrl(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (typeof value === "string") return value.match(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/)?.[0] ?? null;
  if (Array.isArray(value)) { for (const v of value.slice(0, 50)) { const u = findPullRequestUrl(v, depth + 1); if (u) return u; } return null; }
  if (typeof value === "object") { for (const v of Object.values(value).slice(0, 100)) { const u = findPullRequestUrl(v, depth + 1); if (u) return u; } }
  return null;
}
