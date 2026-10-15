// Shared helpers: stderr logging, the session store, caches, git, SSE parsing.
// stdout belongs to the ACP protocol, so nothing here may write to it.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

// Same folder? Windows paths are case-insensitive.
export const samePath = (a, b) => !!a && !!b && (process.platform === "win32" ? resolvePath(a).toLowerCase() === resolvePath(b).toLowerCase() : resolvePath(a) === resolvePath(b));

let logPrefix = "megha";
export const setLogPrefix = (p) => { logPrefix = p; };
// Logs go to stderr. Callers pass short descriptions only, never tokens or task/env JSON.
export function log(...parts) {
  process.stderr.write(`[${logPrefix}] ${parts.map((p) => (typeof p === "string" ? p : String(p))).join(" ")}\n`);
}

// Resolves after ms, or at once when signal aborts. Either way nothing is left behind: the timer is
// cleared on abort and the abort listener is removed when the timer fires (a long-lived signal would
// otherwise collect one listener per sleep).
export const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) { resolve(); return; }
  const onAbort = () => { clearTimeout(t); resolve(); };
  const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});

export class UserError extends Error {}
// Something the user must act on even when the turn was stopped (a local apply that left the checkout
// changed): the agent shows it now, or at the start of the next prompt if T3 already has its answer.
export class RecoveryNeeded extends UserError {}
export class Cancelled extends Error { constructor() { super("cancelled"); this.name = "Cancelled"; } }

// ---------- cloud API errors ----------
// A failed cloud request. The message is built only from the HTTP status, a fixed operation label and
// an allowlisted error code, never from the response body: error bodies can echo env vars, tokens or
// account ids, and this message goes to stderr and into the ACP error T3 shows.
export class CloudError extends Error {
  constructor({ label, operation, status = null, code = null, guidance = null }) {
    super(`${label} ${operation} failed${status ? `: HTTP ${status}` : ""}${code ? ` (${code})` : ""}. ${guidance ?? statusGuidance(status)}`.trim());
    this.status = status;
    this.code = code;
  }
}
function statusGuidance(status) {
  if (status === 403) return "Access was denied for this account.";
  if (status === 404) return "It was not found (deleted, or not visible to this account).";
  if (status === 409) return "The cloud reported a conflict; retry in a moment.";
  if (status === 413) return "The upload is too large.";
  if (status === 429) return "Rate limited; wait a moment and retry.";
  if (status >= 500) return "The cloud had a server error; retry in a moment.";
  if (status >= 400) return "The cloud rejected the request.";
  return "";
}
// "GET /wham/tasks/task_e_1?x=y" -> "GET /wham/tasks/<id>": ids and query strings stay out of messages.
const isIdSegment = (p) => !/^v\d+$/.test(p) && (/[\d~%]/.test(p) || /^(?:task|cse|session|file|env|assttrn|usertrn)_/.test(p) || p.length > 40);
export function operationLabel(method, path) {
  const segs = String(path).split("?")[0].split("/").map((p) => (p && isIdSegment(p) ? "<id>" : p));
  return `${method} ${segs.join("/")}`;
}
// A cloud turn that ended in failure. Like a failed request, only an allowlisted code and fixed guidance
// travel: the cloud's own error text (Codex turn.error.message and stream `error` events, Claude
// result.result) can quote env vars, tokens or tool output.
export function turnFailed(label, { code = null, guidance = null, url = null } = {}) {
  return new CloudError({ label, operation: "turn", code, guidance: guidance ?? `Open it in the cloud to see why${url ? `: ${url}` : "."}` });
}

// The one way megha turns any caught error into text for stderr or for the ACP error T3 shows. Only
// megha-made messages pass through as they are: UserError, CloudError and Cancelled (fixed text), and
// plain `Error`s that megha throws with fixed text. Everything else is named by kind, never by message:
// a SyntaxError quotes the response it failed on, and library errors can carry server text.
export function describeError(e) {
  if (e instanceof UserError || e instanceof CloudError || e instanceof Cancelled) return e.message;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return "the request timed out or was stopped";
  const code = (x) => (typeof x === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(x) ? x : null);
  if (e instanceof TypeError && e.cause) return `network error${code(e.cause.code) ? ` (${e.cause.code})` : ""}`;
  if (code(e?.code)) return `system error (${e.code})`;
  if (e instanceof Error && Object.getPrototypeOf(e) === Error.prototype) return e.message;
  return `unexpected ${e instanceof Error ? e.name : "error"}`;
}

// Parse a JSON response body without letting the body reach an error message (SyntaxError messages
// quote the input).
export function parseJsonBody(text, label, operation) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new CloudError({ label, operation, guidance: "The cloud sent a response megha could not read." }); }
}

// ---------- cancellation and request bounds ----------
// Call before every cloud or local mutation: a cancelled turn must not start new work.
export function throwIfCancelled(signal) { if (signal?.aborted) throw new Cancelled(); }
// The caller's signal (cancel, or the turn finished) plus a per-request timeout, so no request can
// hang a turn.
export function boundedSignal(signal, timeoutMs) {
  const t = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, t]) : t;
}

// ---------- data dir: %LOCALAPPDATA%\megha (ids, settings and caches only, no secrets) ----------
const appData = () => process.env.LOCALAPPDATA || join(homedir(), ".local", "share");
// MEGHA_DATA_DIR lets tests use a throwaway folder.
export const DATA_DIR = process.env.MEGHA_DATA_DIR || join(appData(), "megha");
// Session records and thread hints live one file each (sessions/<id>.json, hints/<key>.json). T3 runs
// one megha process per thread, and a single shared file lost updates when two processes read, changed
// and replaced it at the same time. One file per record has one writer and needs no lock.
const SESSIONS_DIR = join(DATA_DIR, "sessions");
const HINTS_DIR = join(DATA_DIR, "hints");
const OLD_STORE = join(DATA_DIR, "sessions.json"); // megha 0.1.0
const LEGACY_STORE = join(appData(), "cloud-acp", "sessions.json"); // megha was called cloud-acp
const MAX_SESSIONS = 500;
const MAX_HINTS = 200;

// Ids come from the client (session/load can name any cloud id), so map them to safe file names.
function fileFor(dir, id) {
  const s = String(id);
  return join(dir, `${/^[A-Za-z0-9_-]{1,128}$/.test(s) ? s : `h_${crypto.createHash("sha256").update(s).digest("hex").slice(0, 40)}`}.json`);
}

// Write via a temp file + rename so readers never see half a record. Windows refuses a rename onto a
// file another process is renaming or reading at that instant (EPERM/EBUSY): retry briefly.
function writeJsonAtomic(dir, file, value) {
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); return; } catch (e) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(e.code) || i >= 50) { rmSync(tmp, { force: true }); throw e; }
      const until = Date.now() + 5 + i * 2;
      while (Date.now() < until) { /* these races clear within milliseconds */ }
    }
  }
}
// null when missing. A record that can't be read is skipped and logged; it never turns into "no
// records", so nothing else is lost because of it.
const reportedUnreadable = new Set();
function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) {
    if (e.code !== "ENOENT" && !reportedUnreadable.has(file)) { reportedUnreadable.add(file); log(`skipping an unreadable record (${e.code ?? "parse error"})`); }
    return null;
  }
}
function jsonFiles(dir) {
  try { return readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return []; }
}
const readAll = (dir) => jsonFiles(dir).map((n) => readJson(join(dir, n))).filter(Boolean);
// Keep the folder small: drop the oldest files past the cap (by modification time).
function prune(dir, max) {
  const names = jsonFiles(dir);
  if (names.length <= max + 20) return;
  const aged = names.map((n) => { try { return [n, statSync(join(dir, n)).mtimeMs]; } catch { return [n, 0]; } }).sort((a, b) => b[1] - a[1]);
  for (const [n] of aged.slice(max)) rmSync(join(dir, n), { force: true });
}

// Import the records of a single-file store (megha 0.1.0, or cloud-acp) once, without overwriting
// anything already stored. A marker file makes later runs a no-op.
export function migrateLegacyStore({ from } = {}) {
  let imported = false;
  for (const file of from ? [from] : [OLD_STORE, LEGACY_STORE]) {
    const marker = join(SESSIONS_DIR, `.imported-${crypto.createHash("sha256").update(file.toLowerCase()).digest("hex").slice(0, 16)}`);
    if (existsSync(marker) || !existsSync(file)) continue;
    const old = readJson(file);
    if (!old) continue;
    for (const rec of Object.values(old.sessions ?? {})) {
      if (rec?.id && !existsSync(fileFor(SESSIONS_DIR, rec.id))) writeJsonAtomic(SESSIONS_DIR, fileFor(SESSIONS_DIR, rec.id), rec);
    }
    for (const [key, h] of Object.entries(old.hints ?? {})) {
      if (!existsSync(fileFor(HINTS_DIR, key))) writeJsonAtomic(HINTS_DIR, fileFor(HINTS_DIR, key), { ...h, key });
    }
    mkdirSync(SESSIONS_DIR, { recursive: true });
    writeFileSync(marker, new Date().toISOString());
    log(`migrated sessions from ${file}`);
    imported = true;
  }
  return imported;
}

export function loadSessionRecord(id) {
  const rec = readJson(fileFor(SESSIONS_DIR, id));
  return rec && rec.id === id ? rec : null;
}
export function findSessionByCloudId(backend, cloudId) {
  return readAll(SESSIONS_DIR).find((s) => s.backend === backend && s.cloudId === cloudId) ?? null;
}
export function allSessionRecords(backend) {
  return readAll(SESSIONS_DIR).filter((s) => s.backend === backend);
}
const PERSISTED_KEYS = ["id", "backend", "cwd", "cloudId", "cloudState", "turnId", "doneTurnId", "lastSeq", "title", "webUrl", "config", "bundle",
  "outcomeBranch", "baseBranch", "baseSha", "appliedPatchFile", "sentMode", "sentModel", "prUrl", "createdAt", "updatedAt"];

// ---------- the session's cloud turn state ----------
// What megha knows about the cloud task's (Codex) or session's (Claude) current turn:
//   idle            a terminal status was seen from the cloud (stream end event, or a GET)
//   running         megha started a turn and has not seen it end
//   stop_requested  megha asked the cloud to stop it (Stop, or the turn's time limit) and has not
//                   seen it end; an accepted cancel request is not an ended turn
//   unknown         megha can't tell: a turn-starting request whose answer never came (it may have
//                   been taken), or a session megha never watched (bound from a cloud id, or a
//                   record from before this field)
// Only an observed terminal status moves it to idle. It is saved with the session record at every
// change, so a restarted megha sees it. Every mutation (prompt, follow-up, apply, PR) checks the cloud
// first unless the state is idle (each backend's #reconcile).
export const CLOUD_STATES = ["idle", "running", "stop_requested", "unknown"];
export function cloudStateOf(session) {
  if (CLOUD_STATES.includes(session.cloudState)) return session.cloudState;
  return session.cloudId ? "unknown" : "idle";
}
export function setCloudState(session, state) {
  if (!CLOUD_STATES.includes(state)) throw new Error(`unknown cloud state ${state}`);
  if (session.cloudState === state) return;
  session.cloudState = state;
  if (session.cloudId) {
    try { saveSessionRecord(session); } catch (e) { log(`session save failed: ${describeError(e)}`); }
  }
}
// The text a refused mutation shows.
export const stillRunningText = (label, url, again) =>
  `The previous ${label} turn is still running; wait or use /status.${again === undefined ? "" : ` megha ${again ? "asked" : "tried to ask"} ${label} to stop it again.`}${url ? ` Open it at ${url}.` : ""}`;
// A turn-starting request failed: did the cloud surely not take it? Only an HTTP error answer (or a
// refused login) says so; a timeout, a dropped connection or an unreadable answer may hide a turn
// that started.
export const surelyRejected = (e) => e instanceof UserError || (e instanceof CloudError && e.status >= 400 && e.status < 500);
// Send a request that starts a cloud turn (create, follow-up, user event). While it is in flight the
// state is "unknown", saved first, so even a crash mid-request leaves a record that is checked before
// the next mutation. The cloud's answer makes it "running"; a sure refusal puts back what it was.
export async function startCloudTurn(session, send) {
  const before = cloudStateOf(session);
  setCloudState(session, "unknown");
  try {
    const r = await send();
    setCloudState(session, "running");
    return r;
  } catch (e) {
    if (surelyRejected(e)) setCloudState(session, before);
    throw e;
  }
}
// Where megha created the session's cloud task: the folder of the session/new that sent its first
// prompt. Set once, when megha creates the cloud task, and never rewritten. A bundle-seeded Claude
// session names no repo in the cloud, so this is the only evidence of which checkout it belongs to;
// `cwd` is just the folder the session is bound to now (a resume can rebind it). Always written, as
// null when megha didn't create the task, so a record from before this field is recognizable.
export function provenanceOf(rec) {
  if (!rec) return null;
  // A record from megha 0.1.0 has no createdIn: its cwd is the best evidence there is.
  return Object.hasOwn(rec, "createdIn") ? rec.createdIn ?? null : rec.cwd ?? null;
}
// The part of a live session that is saved: ids, settings and cloud state, none of the runtime state
// (repo info, environment lists, the running turn, checks already passed).
export function sessionRecordOf(session) {
  const rec = {};
  for (const k of PERSISTED_KEYS) if (session[k] !== undefined) rec[k] = structuredClone(session[k]);
  rec.createdIn = session.createdIn ?? null;
  return rec;
}
export function saveSessionRecord(session) {
  const rec = sessionRecordOf(session);
  rec.updatedAt = new Date().toISOString();
  writeJsonAtomic(SESSIONS_DIR, fileFor(SESSIONS_DIR, session.id), rec);
  prune(SESSIONS_DIR, MAX_SESSIONS);
}

// Thread hints: T3 replaces the ACP session on rollback (provider-acp adapter rollbackThread) and gives
// megha no thread id. Its per-thread MCP credential is stable for the thread, so a hash of it (never
// the credential) maps a fresh session back to the cloud task the thread was using.
export const hintKey = (cwd, secret) => crypto.createHash("sha256").update(`${String(cwd).toLowerCase()}\n${secret}`).digest("hex").slice(0, 32);
export function saveHint(key, value) {
  writeJsonAtomic(HINTS_DIR, fileFor(HINTS_DIR, key), { ...value, key, at: new Date().toISOString() });
  prune(HINTS_DIR, MAX_HINTS);
}
export function loadHint(key, maxAgeMs = 7 * 24 * 3600_000) {
  const h = readJson(fileFor(HINTS_DIR, key));
  if (!h || h.key !== key || Date.now() - Date.parse(h.at ?? 0) > maxAgeMs) return null;
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
  } catch (e) { log(`cache write failed: ${describeError(e)}`); }
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
    log(`${name} fetch failed: ${describeError(e)}`);
  }
  return Array.isArray(hit?.value) && hit.value.length ? hit.value : fallback;
}

// ---------- git ----------
// Every git call is bounded. `timeoutMs` ends one that stalls (a hung ls-remote, fetch or credential
// helper) with { code: -1, timedOut: true }; `signal` (the turn's Stop) ends it with Cancelled. Either
// way megha ends git's whole process tree (git starts remote helpers such as git-remote-https, which
// hold the connection; on Windows git.exe is itself a launcher for another git.exe), and the call
// settles only once git has exited and its pipes have closed, so nothing it started outlives it (see
// killTree). Pass a signal only to commands that are safe to kill: reads, fetches, bundle creation. A
// command that changes the checkout or a ref gets none; check the signal before starting it instead,
// and verify the result if its timeout fires (lib/diff.mjs). git's stderr can quote the remote
// ("remote: ..." lines), so it is returned to the caller but never put in an error message.
export const GIT_TIMEOUT_MS = 120_000;
export const GIT_NETWORK_TIMEOUT_MS = 60_000;
// How long a killed tree may take to exit before megha gives up waiting and says so.
const TREE_EXIT_WAIT_MS = 10_000;
const WINDOWS = process.platform === "win32";
export function git(cwd, args, { input, allowFail = true, signal, timeoutMs = GIT_TIMEOUT_MS, network = false } = {}) {
  if (signal?.aborted) return Promise.reject(new Cancelled());
  return new Promise((resolve, reject) => {
    // A network call never waits on a terminal prompt nobody can see.
    const env = network ? { ...process.env, GIT_TERMINAL_PROMPT: "0" } : process.env;
    // POSIX: git leads its own process group, so one kill reaches every process it started.
    const child = spawn("git", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: !WINDOWS });
    const closed = new Promise((r) => child.once("close", r));
    const out = []; const err = [];
    let done = false, killing = false;
    const end = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    // Stop or the timeout: end the tree, then answer once it is gone.
    const killThen = (fn) => {
      if (done || killing) return;
      killing = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      killTree(child, closed, args[0]).then(() => end(fn));
    };
    const onAbort = () => killThen(() => reject(new Cancelled()));
    const timer = setTimeout(() => killThen(() => {
      log(`git ${args[0]} gave no answer in ${Math.round(timeoutMs / 1000)} s; stopped it`);
      if (allowFail) resolve({ code: -1, stdout: "", stderr: "", timedOut: true });
      else reject(new Error(`git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)} s`));
    }), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.stdin.on("error", () => {}); // EPIPE when git exits (or is killed) before reading its input
    child.on("error", (e) => { if (!killing) end(() => (allowFail ? resolve({ code: -1, stdout: "", stderr: e.message }) : reject(e))); });
    child.on("close", (code) => { if (!killing) end(() => {
      const r = { code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
      if (code !== 0 && !allowFail) reject(new Error(`git ${args[0]} failed (exit ${code})`));
      else resolve(r);
    }); });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

// End the process tree rooted at a git megha spawned, and resolve once git has exited and its pipes
// have closed. The pipes are inherited by the processes git started, so "closed" means none of them
// is still running with them. Only that pid's tree is touched:
//   Windows: taskkill /T /F /PID walks the tree by parent pid, so it runs while git (the root) is
//            still alive; killing git first would orphan its children out of reach.
//   POSIX:   git was spawned detached (its own process group); kill(-pid) signals the whole group.
// If the tree hasn't gone after TREE_EXIT_WAIT_MS, megha stops waiting and logs it.
function killTree(child, closed, what) {
  if (child.pid === undefined) return Promise.resolve();
  let killer = Promise.resolve();
  if (WINDOWS) {
    killer = new Promise((done) => {
      const tk = spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
      tk.once("error", () => { try { child.kill(); } catch {} done(); });
      tk.once("exit", () => done());
    });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
  let bound;
  const gaveUp = new Promise((r) => { bound = setTimeout(() => r(true), TREE_EXIT_WAIT_MS); });
  return Promise.all([killer, Promise.race([closed.then(() => false), gaveUp])]).then(([, late]) => {
    clearTimeout(bound);
    if (late) {
      log(`git ${what} was stopped but its processes had not exited after ${TREE_EXIT_WAIT_MS / 1000} s`);
      child.stdout.destroy(); child.stderr.destroy();
    }
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
    // The configured URL names the repo; `remote get-url` would apply url.*.insteadOf rewrites.
    git(cwd, ["config", "--get", "remote.origin.url"]),
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
// Yields {event, id, data} frames from a fetch Response body, by the event-stream rules: lines end in
// LF, CRLF or a lone CR, and a blank line ends a frame. A CRLF can be split across network chunks, so a
// CR at the very end of the buffer waits for the next chunk before it counts as a line end.
// onActivity fires for every chunk (keepalive comments included) so callers can spot a dead connection.
export async function* sseFrames(res, { onActivity } = {}) {
  const dec = new TextDecoder();
  let buf = "";
  let started = false;
  let event = "", id, data = [];
  // Complete lines in buf; `final` means no more bytes are coming.
  function* lines(final) {
    for (;;) {
      const i = buf.search(/[\r\n]/);
      if (i < 0) return;
      if (buf[i] === "\r" && i === buf.length - 1 && !final) return;
      const line = buf.slice(0, i);
      buf = buf.slice(buf[i] === "\r" && buf[i + 1] === "\n" ? i + 2 : i + 1);
      yield line;
    }
  }
  // One line -> null, or a finished frame when it is the blank line that ends one.
  function take(line) {
    if (line === "") {
      const frame = data.length ? { event: event || "message", id, data: data.join("\n") } : null;
      event = ""; id = undefined; data = [];
      return frame;
    }
    if (line.startsWith(":")) return null;
    const c = line.indexOf(":");
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? "" : line.slice(c + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0")) id = value;
    else if (field === "data") data.push(value);
    return null;
  }
  for await (const chunk of res.body) {
    onActivity?.();
    buf += dec.decode(chunk, { stream: true });
    if (!started && buf) { started = true; if (buf.charCodeAt(0) === 0xfeff) buf = buf.slice(1); }
    for (const line of lines(false)) { const f = take(line); if (f) yield f; }
  }
  buf += dec.decode();
  // A frame still missing its blank line when the stream ends is incomplete and dropped (per the spec).
  for (const line of lines(true)) { const f = take(line); if (f) yield f; }
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
