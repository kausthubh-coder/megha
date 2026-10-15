// Shared helpers: stderr logging, the session store, git, SSE parsing.
// stdout belongs to the ACP protocol, so nothing here may write to it.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let logPrefix = "cloud-acp";
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

// ---------- session store: %LOCALAPPDATA%\cloud-acp\sessions.json (ids and settings only, no secrets) ----------
const dataDir = join(process.env.LOCALAPPDATA || join(homedir(), ".local", "share"), "cloud-acp");
const storeFile = join(dataDir, "sessions.json");
export const DATA_DIR = dataDir;

function readStore() {
  try { return JSON.parse(readFileSync(storeFile, "utf8")); } catch { return { sessions: {} }; }
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
const PERSISTED_KEYS = ["id", "backend", "cwd", "cloudId", "turnId", "lastSeq", "title", "webUrl", "config", "bundle",
  "outcomeBranch", "baseSha", "appliedPatchFile", "sentMode", "sentModel", "createdAt", "updatedAt"];
export function saveSessionRecord(session) {
  mkdirSync(dataDir, { recursive: true });
  const store = readStore();
  const rec = {};
  for (const k of PERSISTED_KEYS) if (session[k] !== undefined) rec[k] = session[k];
  rec.updatedAt = new Date().toISOString();
  store.sessions[session.id] = rec;
  // Keep the file small: drop the oldest records past 500.
  const entries = Object.entries(store.sessions).sort((a, b) => (b[1].updatedAt ?? "").localeCompare(a[1].updatedAt ?? ""));
  store.sessions = Object.fromEntries(entries.slice(0, 500));
  const tmp = `${storeFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, storeFile);
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
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { isRepo: false, cwd };
  const originUrl = (await git(cwd, ["remote", "get-url", "origin"])).stdout.trim() || null;
  const remote = parseGitHubRemote(originUrl);
  const branch = (await git(cwd, ["branch", "--show-current"])).stdout.trim() || null;
  let defaultBranch = (await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).stdout.trim().replace(/^origin\//, "") || null;
  if (!defaultBranch) {
    for (const b of ["main", "master"]) {
      if ((await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`])).code === 0) { defaultBranch = b; break; }
    }
  }
  const remoteSha = async (b) => (b ? (await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`])).stdout.trim() || null : null);
  return {
    isRepo: true,
    root: top.stdout.trim(),
    originUrl,
    github: remote && remote.host === "github.com" ? { owner: remote.owner, name: remote.name } : null,
    remote,
    branch,
    defaultBranch: defaultBranch ?? "main",
    branchSha: await remoteSha(branch),
    defaultSha: await remoteSha(defaultBranch ?? "main"),
  };
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
    .map((line) => line.replace(/[\u2800-\u28ff]/g, "").replace(/\s+$/, ""))
    .filter((line) => line !== "")
    .join("\n");
}
