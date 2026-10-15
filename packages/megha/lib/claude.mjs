// Claude Code on the web backend (api.anthropic.com /v1/sessions + /v1/code/sessions).
// Endpoint and body shapes: docs/research-claude.md. Auth: ~/.claude/.credentials.json claudeAiOauth
// (macOS: the "Claude Code-credentials" Keychain item), read fresh per request and never refreshed
// or written here (refresh tokens rotate).

import { readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import crypto from "node:crypto";
import {
  log, sleep, sseFrames, tail, git, repoInfo, UserError, saveSessionRecord, allSessionRecords, cleanTerminal, cachedList, localChanges,
  CloudError, operationLabel, parseJsonBody, throwIfCancelled, boundedSignal, Cancelled, describeError, turnFailed, provenanceOf,
  GIT_NETWORK_TIMEOUT_MS,
} from "./util.mjs";
import { diffToolCall, applyLocally, diffFiles } from "./diff.mjs";

const BASE = (process.env.CLAUDE_CLOUD_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
const CC_VERSION = "2.1.288";
const BETA_CCR = "ccr-byoc-2025-07-29";
const AUTH_HELP = "Start `claude` once (it renews an expired login) or sign in again with `claude` then /login, then retry. megha never refreshes tokens itself.";
const MODES = [
  { value: "default", name: "Ask for permission" },
  { value: "acceptEdits", name: "Accept edits" },
  { value: "plan", name: "Plan" },
  { value: "bypassPermissions", name: "Bypass permissions" },
];
export const DEFAULT_MODEL = "claude-opus-5-5";
// Used when GET /v1/models can't be reached (ids from the live list, 2026-10-14).
export const FALLBACK_MODELS = [
  { id: "claude-opus-5-5", name: "Opus 5.5" }, { id: "claude-sonnet-5-5", name: "Sonnet 5.5" }, { id: "claude-haiku-5-5", name: "Haiku 5.5" },
  { id: "claude-fable-5-1", name: "Fable 5.1" }, { id: "claude-opus-5", name: "Opus 5" },
];

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

// The Keychain item Claude Code stores its login in on macOS (Claude Code 2.1.288 oee()): "Claude
// Code-credentials", plus "-<first 8 hex of sha256(config dir)>" when CLAUDE_CONFIG_DIR (or
// CLAUDE_SECURESTORAGE_CONFIG_DIR) moves the config away from ~/.claude.
export function keychainService(env = process.env) {
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const isDefault = secure !== undefined ? !secure : !env.CLAUDE_CONFIG_DIR;
  if (isDefault) return "Claude Code-credentials";
  const dir = (secure !== undefined ? secure : env.CLAUDE_CONFIG_DIR).normalize("NFC");
  return `Claude Code-credentials-${crypto.createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
}
const runSecurity = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
let keychainCache = null; // {service, at, value}: the default lookup is cached briefly, in memory only
// Read-only: `security find-generic-password -w` prints the stored JSON; nothing is ever written back.
function readKeychain(env, exec) {
  const service = keychainService(env);
  const cacheable = exec === runSecurity;
  if (cacheable && keychainCache?.service === service && Date.now() - keychainCache.at < 30_000) return keychainCache.value;
  let value = null;
  try { value = JSON.parse(String(exec("security", ["find-generic-password", "-s", service, "-w"])).trim()); } catch { value = null; }
  if (cacheable) keychainCache = { service, at: Date.now(), value };
  return value;
}

export function readCredentials({ env = process.env, platform = process.platform, exec = runSecurity } = {}) {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { token: env.CLAUDE_CODE_OAUTH_TOKEN, expiresAt: null, scopes: null };
  const file = join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json");
  let j = platform === "darwin" ? readKeychain(env, exec) : null;
  if (!j?.claudeAiOauth) {
    try { j = JSON.parse(readFileSync(file, "utf8")); } catch (e) {
      throw new UserError(platform === "darwin"
        ? `Claude cloud: no claude.ai login found in the macOS Keychain ("${keychainService(env)}") or ${file}. Log in with \`claude auth login\` (claude.ai account).`
        : `Claude cloud: cannot read ${file} (${e.code ?? "parse error"}). Log in with \`claude auth login\` (claude.ai account).`);
    }
  }
  const o = j.claudeAiOauth;
  if (!o?.accessToken) throw new UserError("Claude cloud sessions need a claude.ai login (`claude auth login`); API keys are not accepted.");
  if (o.expiresAt && o.expiresAt < Date.now() + 60_000) throw new UserError(`Claude cloud: your claude.ai token has expired. ${AUTH_HELP}`);
  if (o.scopes && !o.scopes.includes("user:sessions:claude_code")) throw new UserError("Claude cloud: this login lacks the user:sessions:claude_code scope. Log in again with `claude auth login`.");
  return { token: o.accessToken, expiresAt: o.expiresAt ?? null, scopes: o.scopes ?? null };
}
const readToken = () => readCredentials().token;

let orgUuid = null;
async function getOrg() {
  if (orgUuid) return orgUuid;
  if (process.env.CLAUDE_CODE_ORGANIZATION_UUID) return (orgUuid = process.env.CLAUDE_CODE_ORGANIZATION_UUID);
  const cfg = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json");
  try { orgUuid = JSON.parse(readFileSync(cfg, "utf8")).oauthAccount?.organizationUuid ?? null; } catch {}
  if (!orgUuid) orgUuid = (await api("GET", "/api/oauth/profile", { noOrg: true })).organization?.uuid ?? null;
  if (!orgUuid) throw new UserError("Claude cloud: could not determine your organization.");
  return orgUuid;
}

function headers(token, { org, beta, json = true, accept } = {}) {
  const h = { "User-Agent": `claude-code/${CC_VERSION}`, Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-client-platform": "claude_code_cli" };
  if (json) h["Content-Type"] = "application/json";
  if (accept) h.Accept = accept;
  if (org) h["x-organization-uuid"] = org;
  if (beta) h["anthropic-beta"] = beta;
  return h;
}

const LABEL = "Claude cloud";
const REQUEST_TIMEOUT_MS = 30_000;
// Error types and reasons worth naming (research-claude.md §3, §8), with fixed guidance. Anything
// else, and every error message and body, is left out: bodies can echo secrets.
const KNOWN_ERRORS = {
  github_repo_access_denied: "Claude's GitHub app can't reach this repo.",
  environment_not_found: "That environment no longer exists; pick another in the Environment option.",
  model_not_available_for_org: "That model is not available for your organization; pick another in the Model option.",
  feature_disabled: "Claude Code on the web is turned off for this account or organization.",
  bound_unattested: "This session is bound to another device and can't be driven from here.",
  untrusted_device: "This session is bound to another device and can't be driven from here.",
  rate_limit_error: "Rate limited; wait a moment and retry.",
  overloaded_error: "Claude is overloaded; retry in a moment.",
  not_found_error: "It was not found (deleted, or not visible to this account).",
  permission_error: "This account is not allowed to do that.",
};
function knownError(json) {
  for (const c of [json?.error?.reason, json?.error?.type]) {
    if (typeof c === "string" && Object.hasOwn(KNOWN_ERRORS, c)) return { code: c, guidance: KNOWN_ERRORS[c] };
  }
  return {};
}
// A failed request as a CloudError. The raw reason is only tested (GitHub refusal -> bundle fallback),
// never kept.
function cloudError(operation, status, json) {
  const err = new CloudError({ label: LABEL, operation, status, ...knownError(json) });
  err.githubRefused = /github|repo_access/i.test(`${json?.error?.reason ?? ""} ${json?.error?.type ?? ""}`);
  return err;
}

// signal: cancel / turn-finished signal for reads. Mutations pass none (see prompt()).
async function api(method, path, { body, query, beta, noOrg, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const token = readToken();
  const org = noOrg ? undefined : await getOrg();
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const operation = operationLabel(method, path);
  const res = await fetch(url, { method, headers: headers(token, { org, beta }), body: body === undefined ? undefined : JSON.stringify(body), signal: boundedSignal(signal, timeoutMs) });
  const text = await res.text();
  if (res.status === 401) throw new UserError(`Claude cloud rejected the claude.ai token (401). ${AUTH_HELP}`);
  if (!res.ok) { let json; try { json = JSON.parse(text); } catch {} throw cloudError(operation, res.status, json); }
  return parseJsonBody(text, LABEL, operation);
}

async function uploadFile(data, filename, signal) {
  const token = readToken();
  const boundary = `----megha${crypto.randomUUID()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nuser_data\r\n--${boundary}--\r\n`),
  ]);
  const res = await fetch(`${BASE}/v1/files`, { method: "POST", body, signal: boundedSignal(signal, 5 * 60_000),
    headers: { ...headers(token, { json: false, beta: "files-api-2025-04-14,oauth-2025-04-20" }), "Content-Type": `multipart/form-data; boundary=${boundary}` } });
  const text = await res.text();
  if (res.status === 401) throw new UserError(`Claude cloud rejected the claude.ai token (401). ${AUTH_HELP}`);
  if (!res.ok) { let json; try { json = JSON.parse(text); } catch {} throw cloudError("bundle upload", res.status, json); }
  const id = parseJsonBody(text, LABEL, "bundle upload").id;
  if (!id) throw new CloudError({ label: LABEL, operation: "bundle upload", guidance: "The cloud returned no file id." });
  return id;
}

// Claude Code's own bundle upload keeps uncommitted tracked changes under a ref private to that one
// upload, refs/seed/<ms>-<16 hex>/stash, and renames it to refs/seed/stash inside the bundle header,
// the name the cloud reads (Claude Code 2.1.288 z7t()/V7t, bundle@11013564). megha does the same, so
// concurrent uploads from worktrees of one repo (which share refs) never see each other's ref, and a
// refs/seed/stash of the user's is never touched. Bundle header: signature line, optional @capability
// lines (v3), "-<sha> ..." prerequisites and "<sha> <ref>" lines, a blank line, then the pack.
export function relabelBundle(buf, labels) {
  let pos = 0;
  const line = () => {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) throw new Error("git bundle header is not terminated");
    const s = buf.toString("latin1", pos, nl); pos = nl + 1; return s;
  };
  const out = [line()];
  if (out[0] !== "# v2 git bundle" && out[0] !== "# v3 git bundle") throw new Error("not a v2 or v3 git bundle");
  const applied = new Set();
  for (let l = line(); l !== ""; l = line()) {
    const sp = l.indexOf(" ");
    const name = sp > 0 && !l.startsWith("-") && !l.startsWith("@") ? l.slice(sp + 1) : null;
    if (name !== null && Object.hasOwn(labels, name)) { out.push(`${l.slice(0, sp)} ${labels[name]}`); applied.add(name); } else out.push(l);
  }
  if (applied.size !== Object.keys(labels).length) throw new Error("git bundle header is missing a ref to relabel");
  return Buffer.concat([Buffer.from(`${out.join("\n")}\n\n`, "latin1"), buf.subarray(pos)]);
}

const unwrap = (j) => j?.response_shape ?? j?.session ?? j;
const toCodeId = (id) => (id?.startsWith("session_") ? `cse_${id.slice("session_".length)}` : id);
const enc = encodeURIComponent;

// GET /v1/models -> [{id, name}] with "Claude " dropped from the display name.
export function modelsFromResponse(j) {
  return (j?.data ?? []).filter((m) => typeof m?.id === "string" && m.id.startsWith("claude-"))
    .map((m) => ({ id: m.id, name: String(m.display_name || m.id).replace(/^Claude\s+/, "") }));
}

// User message content: plain text, or Messages API blocks when images are attached.
export function userContent(text, images = []) {
  if (!images.length) return text;
  return [...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.data } })), ...(text ? [{ type: "text", text }] : [])];
}

function pickDefaultEnv(envs) {
  let configured;
  try { configured = JSON.parse(readFileSync(join(claudeDir(), "settings.json"), "utf8")).remote?.defaultEnvironmentId; } catch {}
  return envs.find((e) => e.id === configured) ?? envs.find((e) => e.kind === "anthropic_cloud") ?? envs.find((e) => e.kind !== "bridge") ?? envs[0] ?? null;
}

function sourceRepo(s) {
  const src = (s.config?.sources ?? s.session_context?.sources ?? []).find((x) => x.type === "git_repository");
  const m = src?.url?.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}
// The GitHub repo a session works on: its source, else its outcome. null for bundle-seeded sessions,
// which carry no repo identity in the cloud.
function sessionRepo(s) {
  const out = (s.config?.outcomes ?? s.session_context?.outcomes ?? []).find((o) => o.type === "git_repository")?.git_info?.repo;
  return sourceRepo(s) ?? (typeof out === "string" ? out.toLowerCase() : null);
}
const fullName = (repo) => (repo?.github ? `${repo.github.owner}/${repo.github.name}`.toLowerCase() : null);
const samePath = (a, b) => !!a && !!b && (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
// Shown when the container never comes up. last_init_error itself is server text and is never shown.
const STARTUP_FAILED = "Claude could not start the cloud session's container; open the session on claude.ai to see why.";
// Claude Code SDK result subtypes named in megha's failure message. result.result is the cloud's own
// text (it can quote tool output or env vars) and is never shown.
const RESULT_ERRORS = {
  error_during_execution: null,
  error_max_budget_usd: "The session reached its spending limit.",
  error_max_structured_output_retries: null,
};
const resultCode = (p) => (typeof p.subtype === "string" && Object.hasOwn(RESULT_ERRORS, p.subtype) ? p.subtype : null);

export const compareUrl = (full, base, branch) => `https://github.com/${full}/compare/${enc(base)}...${enc(branch)}?expand=1`;

export class ClaudeBackend {
  name = "claude";
  label = "Claude Code on the web";
  title = "Megha · Claude Cloud";
  commands = [
    { name: "pr", description: "Link to open a pull request for the branch this session pushed" },
    { name: "apply", description: "Apply the session's pushed branch to this checkout" },
    { name: "open", description: "Link to this session on claude.ai" },
    { name: "status", description: "Show the cloud session's status" },
  ];
  #cache = new Map();

  // statusPollMs: how often a running turn checks the session for startup failures; turnTimeoutMs:
  // the hard limit for one turn; idleMs: reconnect a stream that sends no bytes (not even keepalives)
  // for this long. Tests shorten them.
  // stopWaitMs: how long a stopped turn (Stop or the limit) is watched for its result after megha
  // sends the interrupt.
  constructor({ statusPollMs = 15_000, turnTimeoutMs = 3 * 3600_000, idleMs = 120_000, stopWaitMs = 30_000 } = {}) {
    Object.assign(this, { statusPollMs, turnTimeoutMs, idleMs, stopWaitMs });
  }

  checkAuth() { readCredentials(); }
  webUrl(id) { return `https://claude.ai/code/${id}`; }

  async #cached(key, ttl, fn) {
    const hit = this.#cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = await fn();
    this.#cache.set(key, { at: Date.now(), value });
    return value;
  }
  #envs() {
    return this.#cached("envs", 10 * 60_000, async () => {
      const j = await api("GET", "/v1/environment_providers", { query: { limit: 100 } });
      return (j.environments ?? []).map((e) => ({ id: e.environment_id, name: e.name ?? e.environment_id, kind: e.kind }));
    });
  }
  #models() {
    return cachedList("models-claude", 10 * 60_000, async () =>
      modelsFromResponse(await api("GET", "/v1/models", { query: { limit: 1000 }, noOrg: true, timeoutMs: 5000 })), FALLBACK_MODELS);
  }

  async prepare(session) {
    // Run the env list, model list and git checks side by side; T3 waits on this for every probe.
    const settle = (p) => p.then((v) => ({ v }), (e) => ({ e }));
    const [envsR, modelsR, repoR] = await Promise.all([settle(this.#envs()), settle(this.#models()), settle(repoInfo(session.cwd))]);
    for (const r of [envsR, modelsR, repoR]) if (r.e instanceof UserError) throw r.e;
    if (repoR.e) throw repoR.e;
    session.repo = repoR.v;
    if (envsR.e) log(`environment list failed: ${describeError(envsR.e)}`);
    const envs = (envsR.v ?? []).filter((e) => e.kind !== "bridge");
    session.envs = envs;
    session.models = modelsR.v ?? FALLBACK_MODELS;
    const cfg = session.config ?? (session.config = {});
    if (!cfg.environment || !envs.some((e) => e.id === cfg.environment)) cfg.environment = pickDefaultEnv(envs)?.id ?? "none";
    // Records from before megha may hold "default"; T3 never sends that, so use a real id.
    if (!cfg.model || cfg.model === "default") cfg.model = session.models.some((m) => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : session.models[0]?.id ?? DEFAULT_MODEL;
    cfg.mode ??= "acceptEdits";
    cfg.apply ??= "off";
    if (!cfg.localChanges) cfg.localChanges = (await localChanges(session.cwd, session.repo)).any ? "on" : "off";
  }

  configOptions(session) {
    const cfg = session.config;
    const envOptions = (session.envs ?? []).map((e) => ({ value: e.id, name: e.name, description: e.kind }));
    if (!envOptions.some((o) => o.value === cfg.environment)) envOptions.unshift({ value: cfg.environment, name: cfg.environment === "none" ? "No environment (open claude.ai/code once)" : cfg.environment });
    const models = (session.models ?? FALLBACK_MODELS).map((m) => ({ value: m.id, name: m.name }));
    if (!models.some((m) => m.value === cfg.model)) models.unshift({ value: cfg.model, name: cfg.model });
    return [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: cfg.model, options: models },
      { id: "environment", name: "Environment", description: "Claude Code cloud environment.", type: "select", currentValue: cfg.environment, options: envOptions },
      { id: "mode", name: "Permission mode", category: "mode", type: "select", currentValue: cfg.mode, options: MODES },
      { id: "apply", name: "Apply diff locally", description: "When the session pushes a branch, fetch it and apply its diff here (git apply, never forced).", type: "select", currentValue: cfg.apply,
        options: [{ value: "off", name: "Off" }, { value: "on", name: "On" }] },
      { id: "localChanges", name: "Send local changes", description: "Upload this checkout as a git bundle, with commits not on origin and uncommitted tracked changes. Such sessions can't push a branch back.", type: "select", currentValue: cfg.localChanges,
        options: [{ value: "off", name: "Off" }, { value: "on", name: "On" }] },
    ];
  }

  setConfig(session, id, value) {
    if (id === "mode" && !MODES.some((m) => m.value === value)) throw new UserError(`Invalid permission mode ${value}`);
    if ((id === "apply" || id === "localChanges") && !["off", "on"].includes(value)) throw new UserError(`Invalid value ${value}`);
    if (id === "model" && !/^[\w.:-]+$/.test(value)) throw new UserError(`Invalid model ${value}`);
    if (!["model", "environment", "mode", "apply", "localChanges"].includes(id)) throw new UserError(`Unknown config option ${id}`);
    if (id === "environment") this.#checkEnvironment(session, value);
    session.config[id] = value;
  }

  // Only environments this account listed (bridge environments excluded) can be picked.
  #checkEnvironment(session, value) {
    if (value === "none" || (session.envs ?? []).some((e) => e.id === value)) return;
    throw new UserError(`Unknown Claude cloud environment ${String(value).slice(0, 80)}. Pick one from the Environment option.`);
  }

  // Throws unless the session (GET /v1/code/sessions/{id}) works on this folder's repo. A GitHub
  // session names its repo; a bundle-seeded one names none, so it must be one megha created in this
  // folder. That evidence is the record's createdIn, written once at creation: binding, settings and
  // failed prompts rewrite `cwd`, never createdIn.
  #checkSession(session, s) {
    const full = fullName(session.repo);
    const theirs = sessionRepo(s);
    if (theirs) {
      if (theirs !== full) throw new UserError(`This Claude cloud session belongs to ${theirs}, not ${full ?? "this folder's repo"}, so megha won't open or continue it here.`);
    } else if (!samePath(session.createdIn, session.cwd)
      && !allSessionRecords("claude").some((r) => r.cloudId === session.cloudId && samePath(provenanceOf(r), session.cwd))) {
      throw new UserError("megha can't tell which repository this Claude cloud session came from (it was seeded from a git bundle, not made by megha in this folder), so it won't open or continue it here.");
    }
    session.repoChecked = true;
  }

  // Before any network check (session/load and session/resume): a bundle session megha created in
  // another folder is refused from its local record alone, so a check that can't run never lets it bind.
  checkRecord(session) {
    if (session.cloudId && session.bundle === true && session.createdIn && !samePath(session.createdIn, session.cwd)) {
      throw new UserError("This Claude cloud session was seeded from a git bundle of another folder's repo, so megha won't open or continue it here.");
    }
  }

  // session/load and session/resume of a cloud id, and the first follow-up of a session megha did not
  // create in this process: confirm the repo, fill in what megha needs to know about the session, and
  // note its current startup error so only a new one fails the next turn.
  async checkRepo(session, signal) {
    session.repo ??= await repoInfo(session.cwd);
    const s = unwrap(await api("GET", `/v1/code/sessions/${enc(session.cloudId)}`, { signal }));
    this.#checkSession(session, s);
    this.#hydrate(session, s);
    session.lastInitError = s.external_metadata?.last_init_error ?? null;
    return s;
  }

  // What load and resume both need from the cloud's session object, without replaying history: its
  // title and link, whether it was bundle-seeded, the branch it pushes, and where that branch started.
  #hydrate(session, s) {
    session.title = s.title ?? session.title;
    session.webUrl ??= this.webUrl(session.cloudId);
    const sources = s.config?.sources ?? s.session_context?.sources ?? [];
    const outcome = (s.config?.outcomes ?? s.session_context?.outcomes ?? []).find((o) => o.type === "git_repository");
    session.outcomeBranch ??= outcome?.git_info?.branches?.[0];
    session.bundle ??= !sources.length;
    // Where an imported GitHub session started: its source revision (a commit, or a branch), else the
    // repo's default branch (web-created sources carry no revision). #branchDiff resolves the commit.
    if (!session.bundle && !session.baseSha) {
      const rev = sources.find((x) => x.type === "git_repository")?.revision;
      if (typeof rev === "string" && /^[0-9a-f]{40}$/i.test(rev)) session.baseSha = rev.toLowerCase();
      else session.baseBranch ??= (typeof rev === "string" && rev) || session.repo?.defaultBranch || null;
    }
  }

  // true when the cloud accepted the interrupt. Never throws.
  async #interruptQuietly(session) {
    try { await this.#interrupt(session); log("interrupt sent"); return true; }
    catch (e) { log(`interrupt failed: ${describeError(e)}`); return false; }
  }
  async #interruptNow(session) {
    if (!(await this.#interruptQuietly(session))) session.stopUnconfirmed = true;
  }

  // A turn megha stopped without confirmation (the interrupt failed and no result came in time) may
  // still be running, and a new prompt would queue behind it. Before one is sent: if the session is
  // still working, interrupt again and refuse; once it is idle, carry on.
  async #ensureStopped(session, signal) {
    const s = unwrap(await api("GET", `/v1/code/sessions/${enc(session.cloudId)}`, { signal }));
    if (s.worker_status !== "running" && s.worker_status !== "requires_action") { session.stopUnconfirmed = false; return; }
    const ok = await this.#interruptQuietly(session);
    throw new UserError(`The previous Claude cloud turn hasn't confirmed it stopped; megha ${ok ? "asked" : "tried to ask"} it to stop again. Try again in a moment, or stop it at ${session.webUrl ?? this.webUrl(session.cloudId)}.`);
  }

  // ---------- prompt ----------
  // Cancellation: every await before a create or follow-up POST takes io.signal, and the signal is
  // checked right before each mutation (git refs, bundle upload, POSTs). A POST already sent is
  // awaited, then its session is interrupted in the cloud.
  async prompt(session, input, io) {
    const { signal } = io;
    let fromSeq = 0, userSeq = 0;
    session.repo ??= await repoInfo(session.cwd);
    if (input.isContinue && session.cloudId) {
      const r = await this.#continueTurn(session, io);
      if (r) return r;
    }
    if (!session.cloudId) {
      await this.#create(session, input, io);
      if (signal.aborted) { await this.#interruptNow(session); return "cancelled"; }
    } else {
      if (!session.repoChecked) await this.checkRepo(session, signal);
      if (session.stopUnconfirmed) await this.#ensureStopped(session, signal);
      const events = [];
      if (session.sentMode !== session.config.mode) events.push({ payload: { type: "control_request", request_id: `set-mode-${crypto.randomUUID()}`, request: { subtype: "set_permission_mode", mode: session.config.mode }, uuid: crypto.randomUUID() } });
      if (session.sentModel !== session.config.model) events.push({ payload: { type: "control_request", request_id: `set-model-${crypto.randomUUID()}`, request: { subtype: "set_model", model: session.config.model }, uuid: crypto.randomUUID() } });
      events.push({ payload: { uuid: crypto.randomUUID(), session_id: session.cloudId, type: "user", parent_tool_use_id: null, message: { role: "user", content: userContent(input.text, input.images) } } });
      throwIfCancelled(signal);
      const r = await api("POST", `/v1/code/sessions/${enc(session.cloudId)}/events`, { body: { events }, timeoutMs: 60_000 });
      userSeq = Number(r.results?.at(-1)?.sequence_num ?? 0);
      fromSeq = session.lastSeq ?? 0;
      session.sentMode = session.config.mode;
      session.sentModel = session.config.model;
      if (signal.aborted) { await this.#interruptNow(session); return "cancelled"; }
    }
    if (input.images.length) io.text(`Sent ${input.images.length} image${input.images.length === 1 ? "" : "s"} with the prompt.\n\n`);
    const result = await this.#streamTurn(session, io, fromSeq, userSeq);
    return this.#afterTurn(session, result, io);
  }

  // result: {status, error?: an Error megha made, code?: an allowlisted result subtype}.
  async #afterTurn(session, result, io) {
    session.webUrl ??= this.webUrl(session.cloudId);
    saveSessionRecord(session);
    // After Stop nothing more happens locally: no branch fetch, no automatic apply.
    if (result.status === "completed" && !io.signal.aborted) {
      try { await this.#finishDiff(session, io); } catch (e) { if (!(e instanceof Cancelled)) throw e; }
    }
    io.text(`\n\n[Open in Claude Code on the web](${session.webUrl})`);
    if (session.title) io.update({ sessionUpdate: "session_info_update", title: session.title, updatedAt: new Date().toISOString() });
    saveSessionRecord(session);
    if (result.status === "cancelled" || io.signal.aborted) return "cancelled";
    if (result.status === "max_turns") return "max_turn_requests";
    if (result.status === "failed") {
      const known = result.code && RESULT_ERRORS[result.code];
      throw result.error ?? turnFailed(LABEL, { code: result.code, url: session.webUrl, guidance: known ? `${known} (${session.webUrl})` : null });
    }
    return "end_turn";
  }

  // T3's automatic "Continue where you left off." after a restart: follow a turn that is still running,
  // or show the end of one that finished while megha wasn't attached. Otherwise a normal follow-up.
  async #continueTurn(session, io) {
    const s = unwrap(await api("GET", `/v1/code/sessions/${enc(session.cloudId)}`, { signal: io.signal }));
    this.#checkSession(session, s);
    session.webUrl ??= this.webUrl(session.cloudId);
    let pending = s.worker_status === "running" || s.worker_status === "requires_action";
    if (!pending) {
      const j = await api("GET", `/v1/code/sessions/${enc(session.cloudId)}/events`, { query: { sort_order: "asc", cursor: session.lastSeq ?? 0, limit: 500 }, signal: io.signal });
      pending = (j.data ?? []).some((row) => row.payload?.type === "result" && !row.payload.parent_tool_use_id && Number(row.sequence_num) > (session.lastSeq ?? 0));
      if (pending) io.text("The cloud turn finished while T3 Code was away. Its result:\n\n");
    }
    if (!pending) return null;
    log(`reattaching from sequence ${session.lastSeq ?? 0}`);
    return this.#afterTurn(session, await this.#streamTurn(session, io, session.lastSeq ?? 0, 0), io);
  }

  // A git bundle of HEAD (+ the current branch); with local changes, also the `git stash create`
  // commit, under a ref private to this upload that the bundle header then names refs/seed/stash (see
  // relabelBundle). The private ref is created only if absent and deleted only while it still points
  // at this upload's stash.
  async #bundle(session, repo, withLocal, signal) {
    const file = join(tmpdir(), `megha-${crypto.randomBytes(4).toString("hex")}.bundle`);
    const refs = ["HEAD", ...(repo.branch ? [repo.branch] : [])];
    let ownRef = null, stashSha = null;
    if (withLocal) {
      // `stash create` only writes objects (no ref, no checkout change), so Stop may kill it.
      stashSha = (await git(session.cwd, ["stash", "create"], { signal })).stdout.trim();
      if (stashSha) {
        throwIfCancelled(signal);
        const ref = `refs/seed/${Date.now()}-${crypto.randomBytes(8).toString("hex")}/stash`;
        if ((await git(session.cwd, ["update-ref", ref, stashSha, ""])).code === 0) { ownRef = ref; refs.push(ref); }
      }
    }
    let b;
    // Stop may kill the bundle write (a temp file); the private ref is deleted either way, unkillably.
    try { b = await git(session.cwd, ["bundle", "create", file, ...refs], { signal, timeoutMs: 10 * 60_000 }); }
    catch (e) { rmSync(file, { force: true }); throw e; }
    finally { if (ownRef) await git(session.cwd, ["update-ref", "-d", ownRef, stashSha]); }
    if (b.code !== 0) { rmSync(file, { force: true }); throw new Error(`git bundle create failed (exit ${b.code})`); }
    let data = readFileSync(file); rmSync(file, { force: true });
    if (ownRef) data = relabelBundle(data, { [ownRef]: "refs/seed/stash" });
    if (data.length > 100 * 1024 * 1024) throw new UserError("The repo bundle is over 100 MB, which Claude cloud sessions do not accept.");
    throwIfCancelled(signal);
    return { fileId: await uploadFile(data, "_source_seed.bundle", signal), kb: (data.length / 1024).toFixed(0), stashed: !!ownRef };
  }

  async #create(session, input, io) {
    const { signal } = io;
    const cfg = session.config;
    if (!cfg.environment || cfg.environment === "none") throw new UserError("No Claude Code cloud environment found. Open https://claude.ai/code once to create the default environment, then retry.");
    this.#checkEnvironment(session, cfg.environment);
    const repo = session.repo ?? (session.repo = await repoInfo(session.cwd));
    if (!repo.isRepo) throw new UserError(`${session.cwd} is not a git repository, so there is nothing to send to Claude's cloud. Run \`git init\` and commit your files, then retry.`);
    const title = input.userText.split("\n")[0].slice(0, 75) || "megha task";
    const events = [
      { type: "event", data: { type: "control_request", request_id: `set-mode-${crypto.randomUUID()}`, request: { subtype: "set_permission_mode", mode: cfg.mode } } },
      { type: "event", data: { uuid: crypto.randomUUID(), session_id: "", type: "user", parent_tool_use_id: null, message: { role: "user", content: userContent(input.text, input.images) } } },
    ];
    const base = { title, events, environment_id: cfg.environment };
    const model = { model: cfg.model };
    const local = cfg.localChanges === "on" ? await localChanges(session.cwd, repo) : null;
    const sendLocal = !!(local && (local.unpushed > 0 || local.dirty.length > 0));
    let created = null, refused = false;

    if (repo.github && !sendLocal) {
      let revision = repo.branch;
      if (!revision || !repo.branchSha) {
        revision = repo.defaultBranch;
        io.text(`Note: ${repo.branch ? `branch \`${repo.branch}\` is not on origin` : "no current branch"}, so the session starts from \`${revision}\`. Push your branch, or turn on "Send local changes", to run on it.\n\n`);
      }
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
      const outcomeBranch = `claude/${slug}-${crypto.randomBytes(3).toString("hex")}`;
      const full = `${repo.github.owner}/${repo.github.name}`;
      try {
        throwIfCancelled(signal);
        created = await api("POST", "/v1/sessions", { beta: BETA_CCR, timeoutMs: 60_000, body: { ...base, session_context: {
          sources: [{ type: "git_repository", url: `https://github.com/${full}`, revision }],
          outcomes: [{ type: "git_repository", git_info: { type: "github", repo: full, branches: [outcomeBranch] } }], ...model } } });
        session.bundle = false;
        session.outcomeBranch = outcomeBranch;
        session.baseBranch = revision;
        session.baseSha = revision === repo.branch ? repo.branchSha : repo.defaultSha;
      } catch (e) {
        if (!(e instanceof CloudError) || e.status !== 400 || !e.githubRefused) throw e;
        log(`GitHub source refused (${e.code ?? e.status}); falling back to a git bundle`);
        refused = true;
      }
    }
    if (!created) {
      throwIfCancelled(signal);
      const b = await this.#bundle(session, repo, sendLocal, signal);
      throwIfCancelled(signal);
      created = await api("POST", "/v1/sessions", { beta: BETA_CCR, timeoutMs: 60_000, body: { ...base, session_context: { sources: [], outcomes: [], seed_bundle_file_id: b.fileId, ...model } } });
      session.bundle = true;
      const what = b.stashed ? "your local repo including uncommitted tracked changes" : "your committed work";
      const why = sendLocal ? "\"Send local changes\" is on, so the session was seeded from"
        : refused ? `Claude's GitHub app can't reach ${repo.github.owner}/${repo.github.name}, so the session was seeded from`
        : "This repo has no GitHub remote, so the session was seeded from";
      io.text(`${why} a git bundle of ${what} (${b.kb} KB; untracked files are not included). A bundle-seeded session can't push a branch, so its changes stay in the cloud session.\n\n`);
    }
    session.cloudId = toCodeId(created.id);
    session.title = created.title ?? title;
    session.webUrl = this.webUrl(session.cloudId);
    session.sentMode = cfg.mode;
    session.sentModel = cfg.model;
    session.repoChecked = true; // made here, from this folder's repo
    session.createdIn = session.cwd; // the evidence #checkSession needs for a bundle session; set only here
    session.lastInitError = null; // a new session: any startup error is this turn's
    saveSessionRecord(session);
    log(`created session ${session.cloudId}${session.bundle ? " (bundle)" : ""} (model ${cfg.model})`);
  }

  async #interrupt(session) {
    await api("POST", `/v1/code/sessions/${enc(session.cloudId)}/events`, { body: { events: [{ payload: { type: "control_request", request_id: crypto.randomUUID(), request: { subtype: "interrupt", cancel_queued: true }, uuid: crypto.randomUUID() } }] } });
  }

  async #streamTurn(session, io, fromSeq, userSeq) {
    const st = new ClaudeTurn(session, io);
    const ac = new AbortController(); // aborts once the turn has an outcome: ends the stream and the poller
    let finished = null;
    const finish = (r) => { if (!finished) { finished = r; ac.abort(); } };
    const timers = [];
    // Stop and the turn's time limit end a turn the same way: interrupt the cloud session, then keep
    // reading for its result for at most stopWaitMs. The interrupt request belongs to the turn
    // (io.turn.track): the next prompt waits for its answer, even if the result arrives first.
    let stopping = null, interruptRequest = null;
    const stop = (reason) => {
      if (stopping || finished) return;
      stopping = reason;
      log(reason === "timeout" ? "turn time limit reached; interrupting the cloud session" : "stopping the cloud turn");
      interruptRequest = io.turn.track(this.#interruptQuietly(session), "interrupt");
      timers.push(setTimeout(() => finish({ status: "cancelled", unconfirmed: true }), this.stopWaitMs));
    };
    const onAbort = () => stop("cancel");
    io.signal.addEventListener("abort", onAbort, { once: true });
    if (io.signal.aborted) onAbort();
    // The limit fires on its own timer: a stream busy with keepalives can't postpone it.
    timers.push(setTimeout(() => stop("timeout"), this.turnTimeoutMs));
    // A container that fails to start shows up only in the session's status (external_metadata
    // .last_init_error, or status "failed"; research-claude.md §8), never as a stream event.
    const statusPoller = (async () => {
      while (!finished) {
        await sleep(this.statusPollMs, ac.signal);
        if (finished) return;
        try {
          const s = unwrap(await api("GET", `/v1/code/sessions/${enc(session.cloudId)}`, { signal: ac.signal }));
          const initError = s.external_metadata?.last_init_error || null;
          if (session.lastInitError === undefined) { session.lastInitError = initError; continue; } // no baseline yet
          if (s.status === "failed" || (initError && initError !== session.lastInitError)) {
            session.lastInitError = initError;
            log("the cloud session failed to start");
            finish({ status: "failed", error: turnFailed(LABEL, { guidance: STARTUP_FAILED }) });
            return;
          }
        } catch (e) {
          if (finished) return;
          if (e instanceof UserError) { finish({ status: "failed", error: e }); return; }
          log(`status check failed: ${describeError(e)}`);
        }
      }
    })();

    // Permission prompts belong to the turn: tracked, and answered only while the turn is live.
    st.onPermission = (row) => { io.turn.track(this.#answerPermission(session, row, io), "permission"); };

    let lastSeq = fromSeq;
    while (!finished) {
      // Per connection: bounded until headers arrive, then aborted if no bytes (not even a keepalive)
      // come for idleMs, so a dead connection reconnects instead of hanging.
      const conn = new AbortController();
      let idle = null;
      const bump = () => { clearTimeout(idle); idle = setTimeout(() => conn.abort(), this.idleMs); };
      try {
        const token = readToken();
        const url = `${BASE}/v1/code/sessions/${enc(session.cloudId)}/events/stream?from_sequence_num=${lastSeq}`;
        bump();
        const res = await fetch(url, { headers: { ...headers(token, { json: false, accept: "text/event-stream" }), ...(lastSeq ? { "Last-Event-ID": String(lastSeq) } : {}) },
          signal: AbortSignal.any([ac.signal, conn.signal]) });
        if (res.status === 401) throw new UserError(`Claude cloud rejected the claude.ai token (401). ${AUTH_HELP}`);
        if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new CloudError({ label: LABEL, operation: "stream", status: res.status }); }
        for await (const frame of sseFrames(res, { onActivity: bump })) {
          if (frame.event !== "client_event") continue;
          let row; try { row = JSON.parse(frame.data); } catch { continue; }
          const seq = Number(row.sequence_num ?? frame.id ?? 0);
          if (seq && seq <= lastSeq) continue;
          if (seq) { lastSeq = seq; session.lastSeq = seq; }
          const r = st.handle(row, { live: true });
          if (r && seq > userSeq) { finish(r); break; }
        }
      } catch (e) {
        if (finished || ac.signal.aborted) break;
        if (e instanceof UserError) { finish({ status: "failed", error: e }); break; }
        log(`stream error (${conn.signal.aborted ? "no data" : describeError(e)}); reconnecting`);
      } finally { clearTimeout(idle); }
      if (!finished) await sleep(1500, ac.signal);
    }
    await statusPoller;
    for (const t of timers) clearTimeout(t);
    io.signal.removeEventListener("abort", onAbort);
    st.closeSetup();
    // Stopped, no result came in time and the interrupt failed: the turn may still run, so the next
    // prompt checks the session first (#ensureStopped).
    if (interruptRequest) io.turn.track(interruptRequest.then((ok) => { session.stopUnconfirmed = !ok && !!finished?.unconfirmed; }), "interrupt");
    try {
      const s = unwrap(await api("GET", `/v1/code/sessions/${enc(session.cloudId)}`, { signal: io.signal }));
      session.title = s.title ?? session.title;
    } catch {}
    if (stopping === "timeout" && finished?.status !== "completed") {
      log("turn timed out");
      return { status: "failed", error: turnFailed(LABEL, { guidance: `It timed out after ${Math.round(this.turnTimeoutMs / 60_000)} min, so megha interrupted the session (${session.webUrl ?? this.webUrl(session.cloudId)}).` }) };
    }
    const status = io.signal.aborted && finished?.status !== "completed" ? "cancelled" : finished?.status ?? "failed";
    log(`turn ${status}${finished?.unconfirmed ? " (stop not confirmed)" : ""}`);
    return { status, error: finished?.error, code: finished?.code };
  }

  // Ask T3 about a can_use_tool request and send the answer, unless the turn stopped or finished in
  // the meantime: then nothing is sent (the interrupt or the turn's end already settled the request),
  // so an old prompt approved late can never allow a tool.
  async #answerPermission(session, row, io) {
    const req = row.payload.request ?? {};
    const toolCallId = req.tool_use_id ?? `perm:${row.payload.request_id}`;
    if (!io.turn.live) return;
    const asked = io.requestPermission({
      sessionId: session.id,
      toolCall: { toolCallId, title: `${req.tool_name ?? "Tool"}${req.input?.command ? `: ${req.input.command}` : ""}`, kind: toolKind(req.tool_name), status: "pending", rawInput: req.input ?? {} },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Deny", kind: "reject_once" }],
    }).catch((e) => { log(`permission request failed: ${describeError(e)}`); return null; });
    const r = await Promise.race([asked, io.turn.ended.then(() => null)]);
    if (!io.turn.live) { log("permission answered after the turn stopped; not sent"); return; }
    const allow = r?.outcome?.outcome === "selected" && r.outcome.optionId === "allow";
    const response = allow ? { behavior: "allow", updatedInput: req.input ?? {} } : { behavior: "deny", message: "The user denied this in T3 Code." };
    await api("POST", `/v1/code/sessions/${enc(session.cloudId)}/events`, { body: { events: [{ payload: { type: "control_response", response: { subtype: "success", request_id: row.payload.request_id, response } } }] } });
  }

  // The session's pushed outcome branch, fetched as origin/<branch>, and its diff from the base.
  // A session megha created knows its base commit. An imported one (made on claude.ai, or its local
  // record is gone) doesn't: its base is where the outcome branch left the branch it started from.
  // Every git call here takes the turn's signal (Stop kills it) and is bounded, so a stalled remote
  // or credential helper can't hold a stopped turn open. Fetches only update refs/remotes/origin/*.
  async #branchDiff(session, signal) {
    if (session.bundle || !session.outcomeBranch) return { reason: session.bundle ? "bundle" : "none" };
    const cwd = session.cwd;
    const outcome = `refs/remotes/origin/${session.outcomeBranch}`;
    const net = { signal, network: true, timeoutMs: GIT_NETWORK_TIMEOUT_MS };
    const ls = await git(cwd, ["ls-remote", "origin", `refs/heads/${session.outcomeBranch}`], net);
    if (ls.timedOut) return { reason: "fetch" };
    if (ls.code !== 0 || !ls.stdout.trim()) return { reason: "not-pushed" };
    const f = await git(cwd, ["fetch", "--no-tags", "origin", `${session.outcomeBranch}:${outcome}`], { ...net, timeoutMs: 5 * 60_000 });
    if (f.code !== 0) return { reason: "fetch" };
    let base = session.baseSha;
    if (base && (await git(cwd, ["cat-file", "-e", `${base}^{commit}`], { signal })).code !== 0) base = null;
    if (!base) {
      const from = session.baseBranch ?? session.repo?.defaultBranch;
      if (!from) return { reason: "no-base" };
      const fb = await git(cwd, ["fetch", "--no-tags", "origin", `+${from}:refs/remotes/origin/${from}`], { ...net, timeoutMs: 5 * 60_000 });
      const mb = fb.code === 0 ? await git(cwd, ["merge-base", `refs/remotes/origin/${from}`, outcome], { signal }) : null;
      if (!mb || mb.code !== 0 || !/^[0-9a-f]{40}$/.test(mb.stdout.trim())) return { reason: "no-base", from };
      base = mb.stdout.trim();
      session.baseSha = base;
      session.baseBranch ??= from;
      log(`recovered the session's base from origin/${from}`);
    }
    const d = await git(cwd, ["diff", "--no-color", base, outcome], { signal });
    return { diff: d.code === 0 ? d.stdout : "" };
  }
  // git's own output is not shown: its "remote:" lines are the server's text.
  #fetchFailedText(session) {
    return `Could not fetch \`${session.outcomeBranch}\` from origin (git fetch failed or timed out). Check that \`git fetch origin\` works in this folder, then try /apply again.`;
  }
  #notPushedText(session, then = "") {
    return session.outcomeBranch
      ? `The session hasn't pushed \`${session.outcomeBranch}\` yet.${then}`
      : "This session has no branch to apply: it wasn't set up to push one. Open it on claude.ai to see its changes.";
  }
  #noBaseText(session, r) {
    return `The session pushed \`${session.outcomeBranch}\`, but megha could not work out which commit it started from${r.from ? ` (\`${session.outcomeBranch}\` shares no history with origin/${r.from})` : ""}, so it can't build the diff. Compare the branch on GitHub instead.`;
  }

  #compare(session) {
    const g = session.repo?.github;
    return g && session.outcomeBranch ? compareUrl(`${g.owner}/${g.name}`, session.baseBranch ?? session.repo.defaultBranch, session.outcomeBranch) : null;
  }

  // Only GitHub-sourced sessions push an outcome branch; bundle-seeded ones have no way back.
  async #finishDiff(session, io) {
    const r = await this.#branchDiff(session, io.signal);
    if (r.reason === "fetch") { io.text(`\n\n${this.#fetchFailedText(session)}`); return; }
    if (r.reason === "no-base") { io.text(`\n\n${this.#noBaseText(session, r)}`); return; }
    const diff = r.diff;
    if (!diff?.trim() || io.signal.aborted) return;
    io.update(diffToolCall({ toolCallId: `diff:${session.cloudId}:${session.lastSeq}`, diff, cwd: session.cwd, title: `Branch ${session.outcomeBranch}: ${diffFiles(diff).length} files` }));
    const compare = this.#compare(session);
    if (session.config.apply === "on") {
      throwIfCancelled(io.signal);
      const a = await applyLocally({ cwd: session.cwd, diff, name: `${session.cloudId}-${session.lastSeq}`, previousFile: session.appliedPatchFile, signal: io.signal });
      if (a.ok && !a.unchanged) session.appliedPatchFile = a.patchFile;
      io.text(`\n\n${a.message}`);
    } else {
      io.text(`\n\nThe session pushed \`${session.outcomeBranch}\` (fetched as origin/${session.outcomeBranch}). Type /apply to apply it here.`);
    }
    if (compare) io.text(`\n\n[Open a pull request](${compare})`);
  }

  // ---------- megha's slash commands ----------
  async command(session, { name }, io) {
    if (name === "open") { io.text(session.webUrl ? `[Open in Claude Code on the web](${session.webUrl})` : "No cloud session yet: send a prompt first."); return; }
    if (!session.cloudId) { io.text("No cloud session yet: send a prompt first."); return; }
    session.repo ??= await repoInfo(session.cwd);
    switch (name) {
      case "status": {
        const s = unwrap(await api("GET", `/v1/code/sessions/${enc(session.cloudId)}`, { signal: io.signal }));
        this.#checkSession(session, s);
        io.text([`**${s.title ?? session.title ?? "Cloud session"}**`, `Status: ${s.worker_status ?? s.status ?? "unknown"}`,
          `Model: ${s.config?.model ?? session.config.model}`, `Permission mode: ${s.config?.permission_mode ?? session.config.mode}`,
          session.bundle ? "Source: git bundle (can't push a branch)" : `Branch: ${session.outcomeBranch ?? "?"}`,
          `[Open in Claude Code on the web](${session.webUrl})`].join("\n"));
        return;
      }
      case "apply": {
        if (!session.repoChecked) await this.checkRepo(session, io.signal);
        const r = await this.#branchDiff(session, io.signal);
        if (r.reason === "bundle") { io.text("This session was seeded from a git bundle, so it can't push a branch to apply. Open it on claude.ai to see its changes."); return; }
        if (r.reason === "no-base") { io.text(this.#noBaseText(session, r)); return; }
        if (!r.diff?.trim()) { io.text(r.reason === "fetch" ? this.#fetchFailedText(session) : this.#notPushedText(session)); return; }
        throwIfCancelled(io.signal);
        const a = await applyLocally({ cwd: session.cwd, diff: r.diff, name: `${session.cloudId}-${session.lastSeq}`, previousFile: session.appliedPatchFile, signal: io.signal });
        if (a.ok && !a.unchanged) session.appliedPatchFile = a.patchFile;
        saveSessionRecord(session);
        io.text(a.message);
        return;
      }
      case "pr": {
        if (session.bundle) { io.text("This session was seeded from a git bundle, so it can't push a branch for a pull request."); return; }
        if (!session.repoChecked) await this.checkRepo(session, io.signal);
        const ls = session.outcomeBranch ? await git(session.cwd, ["ls-remote", "origin", `refs/heads/${session.outcomeBranch}`], { signal: io.signal, network: true, timeoutMs: GIT_NETWORK_TIMEOUT_MS }) : null;
        if (!ls?.stdout.trim()) { io.text(this.#notPushedText(session, " Ask it to commit and push, then try /pr again.")); return; }
        io.text(`[Open a pull request for \`${session.outcomeBranch}\`](${this.#compare(session)})`);
        return;
      }
      default: io.text(`Unknown command /${name}`);
    }
  }

  // ---------- list / load ----------
  async list(cwd, cursor) {
    const repo = await repoInfo(cwd);
    const full = repo.github ? `${repo.github.owner}/${repo.github.name}`.toLowerCase() : null;
    // Bundle sessions megha created in this folder (createdIn, not the folder a record was last bound to).
    const mine = new Set(allSessionRecords("claude").filter((r) => samePath(provenanceOf(r), cwd)).map((r) => r.cloudId));
    const j = await api("GET", "/v1/code/sessions", { query: { limit: 50, cursor } });
    // A session that names a repo must name this one; one that names none (bundle-seeded) must be
    // one megha made in this folder.
    const sessions = (j.data ?? [])
      .filter((s) => s.status !== "archived" && s.environment_kind !== "bridge")
      .filter((s) => { const theirs = sessionRepo(s); return theirs ? !!full && theirs === full : mine.has(s.id); })
      .map((s) => ({ sessionId: s.id, cwd, title: s.title ?? null, updatedAt: s.last_event_at ?? s.updated_at ?? s.created_at ?? null,
        _meta: { status: s.worker_status ?? s.status ?? null } }));
    return { sessions, ...(j.next_cursor ? { nextCursor: j.next_cursor } : {}) };
  }

  async replay(session, io) {
    await this.checkRepo(session, io.signal); // also fills in the session's metadata (#hydrate)
    const rows = [];
    let cursor;
    for (let i = 0; i < 100; i++) {
      const j = await api("GET", `/v1/code/sessions/${enc(session.cloudId)}/events`, { query: { sort_order: "asc", cursor, limit: 500 } });
      rows.push(...(j.data ?? []));
      cursor = j.next_cursor;
      if (!cursor || !(j.data ?? []).length) break;
    }
    const updates = [];
    const st = new ClaudeTurn(session, { update: (u) => updates.push(u) }, { replay: true });
    for (const row of rows) {
      st.handle(row, { live: false });
      const seq = Number(row.sequence_num ?? 0);
      if (seq > (session.lastSeq ?? 0)) session.lastSeq = seq;
    }
    if (session.title) updates.push({ sessionUpdate: "session_info_update", title: session.title });
    for (const u of updates) io.update(u);
    saveSessionRecord(session);
  }
}

function toolKind(name) {
  switch (name) {
    case "Bash": case "BashOutput": return "execute";
    case "Read": case "NotebookRead": return "read";
    case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": return "edit";
    case "Glob": case "Grep": case "LS": return "search";
    case "WebFetch": case "WebSearch": return "fetch";
    case "Task": case "Agent": return "think";
    default: return "other";
  }
}

// Maps Claude Code SDK stream-json payloads (session event rows) to ACP updates.
class ClaudeTurn {
  constructor(session, io, { replay = false } = {}) {
    this.session = session; this.io = io; this.replay = replay;
    this.tools = new Map(); // tool_use id -> {kind, name}
    this.remoteCwd = "/home/user/repo";
    this.contextWindow = 0;
    this.setup = null;
  }
  update(u) { this.io.update(u); }
  local(p) {
    if (typeof p !== "string") return p;
    const rc = this.remoteCwd;
    if (p === rc) return this.session.cwd;
    if (p.startsWith(rc + "/")) return join(this.session.cwd, ...p.slice(rc.length + 1).split("/"));
    return p;
  }
  setupLog(line) {
    if (this.replay || !line) return;
    if (!this.setup) {
      this.setup = { id: `setup:${this.session.cloudId}:${Date.now()}`, lines: [] };
      this.update({ sessionUpdate: "tool_call", toolCallId: this.setup.id, title: "Preparing the cloud environment", kind: "execute", status: "in_progress", rawInput: { command: "Claude cloud setup" } });
    }
    const clean = cleanTerminal(line); if (!clean) return;
    this.setup.lines.push(clean);
    this.update({ sessionUpdate: "tool_call_update", toolCallId: this.setup.id, rawOutput: { output: tail(this.setup.lines.join("\n")) } });
  }
  closeSetup() {
    if (!this.setup || this.setup.closed) return;
    this.setup.closed = true;
    this.update({ sessionUpdate: "tool_call_update", toolCallId: this.setup.id, status: "completed", rawOutput: { output: tail(this.setup.lines.join("\n")) } });
  }

  // Returns {status, error} on a `result` payload.
  handle(row, { live }) {
    const p = row.payload ?? {};
    if (p.parent_tool_use_id) return null; // subagent internals: the Agent tool call shows the outcome
    switch (p.type) {
      case "env_manager_log": this.setupLog(p.data?.content); return null;
      case "autocompact_state": this.contextWindow = p.value?.effective_window ?? this.contextWindow; return null;
      case "system":
        if (p.subtype === "init") { this.closeSetup(); if (typeof p.cwd === "string") this.remoteCwd = p.cwd; }
        return null;
      case "control_request":
        if (live && row.source === "worker" && p.request?.subtype === "can_use_tool") this.onPermission?.(row);
        return null;
      case "assistant": this.closeSetup(); if (p.message?.usage) this.lastUsage = p.message.usage; this.assistant(p.message?.content ?? []); return null;
      case "user": this.user(row, p); return null;
      case "result": {
        this.closeSetup();
        // Context use = the last model call's prompt + output (result.usage sums every call in the turn).
        const u = this.lastUsage ?? p.usage;
        if (u && !this.replay) {
          const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
          this.update({ sessionUpdate: "usage_update", used, size: this.contextWindow || 0, ...(typeof p.total_cost_usd === "number" ? { cost: { amount: p.total_cost_usd, currency: "USD" } } : {}) });
        }
        if (p.subtype === "success" && !p.is_error) return { status: "completed" };
        if (p.subtype === "error_max_turns") return { status: "max_turns" };
        if (p.subtype === "error_during_execution" && p.terminal_reason === "interrupted") return { status: "cancelled" };
        return { status: "failed", code: resultCode(p) }; // p.result is the cloud's text: never kept
      }
      default: return null;
    }
  }

  assistant(blocks) {
    for (const b of blocks) {
      if (b.type === "text" && b.text) this.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: b.text } });
      else if (b.type === "thinking" && b.thinking) this.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: b.thinking } });
      else if (b.type === "tool_use") this.toolUse(b);
    }
  }

  toolUse(b) {
    const input = b.input ?? {};
    const kind = toolKind(b.name);
    this.tools.set(b.id, { kind, name: b.name });
    if (b.name === "TodoWrite" && Array.isArray(input.todos)) {
      this.update({ sessionUpdate: "plan", entries: input.todos.map((t) => ({ content: t.content ?? "", priority: "medium", status: t.status === "in_progress" ? "in_progress" : t.status === "completed" ? "completed" : "pending" })) });
      return;
    }
    const call = { sessionUpdate: "tool_call", toolCallId: b.id, kind, status: "in_progress", title: b.name, rawInput: input };
    const path = this.local(input.file_path ?? input.notebook_path ?? input.path);
    if (path && typeof path === "string") call.locations = [{ path }];
    switch (b.name) {
      case "Bash": call.title = input.description || String(input.command ?? "").split("\n")[0].slice(0, 200) || "Bash"; call.rawInput = { command: input.command }; break;
      case "Read": call.title = `Read ${path}`; call.rawInput = { path }; break;
      case "Write": call.title = `Write ${path}`; call.content = [{ type: "diff", path, oldText: null, newText: String(input.content ?? "") }]; break;
      case "Edit": call.title = `Edit ${path}`; call.content = [{ type: "diff", path, oldText: String(input.old_string ?? ""), newText: String(input.new_string ?? "") }]; break;
      case "MultiEdit": call.title = `Edit ${path}`; call.content = (input.edits ?? []).map((e) => ({ type: "diff", path, oldText: String(e.old_string ?? ""), newText: String(e.new_string ?? "") })); break;
      case "Glob": call.title = `Glob ${input.pattern}`; break;
      case "Grep": call.title = `Grep ${input.pattern}`; break;
      case "WebFetch": call.title = `Fetch ${input.url}`; break;
      case "WebSearch": call.title = `Web search: ${input.query}`; break;
      case "Task": case "Agent": call.title = `Agent: ${input.description ?? input.subagent_type ?? ""}`.trim(); break;
      default: break;
    }
    this.update(call);
  }

  user(row, p) {
    const content = p.message?.content;
    const blocks = Array.isArray(content) ? content : null;
    const results = blocks?.filter((b) => b.type === "tool_result") ?? [];
    if (results.length) {
      for (const r of results) {
        const t = this.tools.get(r.tool_use_id);
        if (!t || t.name === "TodoWrite") continue;
        const text = typeof r.content === "string" ? r.content : (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
        const upd = { sessionUpdate: "tool_call_update", toolCallId: r.tool_use_id, status: r.is_error ? "failed" : "completed" };
        if (t.kind !== "edit") {
          upd.rawOutput = t.kind === "execute" ? { output: tail(text) } : tail(text);
        } else if (r.is_error) {
          upd.rawOutput = tail(text);
        }
        this.update(upd);
      }
      return;
    }
    // A prompt (ours, or one typed on claude.ai): only replayed, never echoed live.
    if (!this.replay || p.isMeta || p.isSynthetic) return;
    const text = typeof content === "string" ? content : (blocks ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (text) this.update({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
  }
}
