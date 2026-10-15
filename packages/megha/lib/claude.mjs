// Claude Code on the web backend (api.anthropic.com /v1/sessions + /v1/code/sessions).
// See cloud-threads-research/claude/FINDINGS.md. Auth: ~/.claude/.credentials.json claudeAiOauth,
// read fresh per request and never refreshed here (refresh tokens rotate).

import { readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import { log, sleep, sseFrames, tail, git, repoInfo, UserError, saveSessionRecord, allSessionRecords, cleanTerminal } from "./util.mjs";
import { diffToolCall, applyLocally, diffFiles } from "./diff.mjs";

const BASE = (process.env.CLAUDE_CLOUD_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
const CC_VERSION = "2.1.288";
const BETA_CCR = "ccr-byoc-2025-07-29";
const AUTH_HELP = "Run `claude auth status` (or any `claude` command) so Claude Code refreshes its login, then retry. cloud-acp never refreshes tokens itself.";
const MODES = [
  { value: "default", name: "Ask for permission" },
  { value: "acceptEdits", name: "Accept edits" },
  { value: "plan", name: "Plan" },
  { value: "bypassPermissions", name: "Bypass permissions" },
];

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

function readToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const file = join(claudeDir(), ".credentials.json");
  let j;
  try { j = JSON.parse(readFileSync(file, "utf8")); } catch (e) {
    throw new UserError(`Claude cloud: cannot read ${file} (${e.code ?? "parse error"}). Log in with \`claude auth login\` (claude.ai account).`);
  }
  const o = j.claudeAiOauth;
  if (!o?.accessToken) throw new UserError("Claude cloud sessions need a claude.ai login (`claude auth login`); API keys are not accepted.");
  if (o.expiresAt && o.expiresAt < Date.now() + 60_000) throw new UserError(`Claude cloud: your claude.ai token has expired. ${AUTH_HELP}`);
  if (o.scopes && !o.scopes.includes("user:sessions:claude_code")) throw new UserError("Claude cloud: this login lacks the user:sessions:claude_code scope. Log in again with `claude auth login`.");
  return o.accessToken;
}

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

class ApiError extends Error { constructor(msg, status, body) { super(msg); this.status = status; this.body = body; } }

async function api(method, path, { body, query, beta, noOrg, signal } = {}) {
  const token = readToken();
  const org = noOrg ? undefined : await getOrg();
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetch(url, { method, headers: headers(token, { org, beta }), body: body === undefined ? undefined : JSON.stringify(body), signal });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch {}
  if (res.status === 401) throw new UserError(`Claude cloud rejected the claude.ai token (401). ${AUTH_HELP}`);
  if (!res.ok) {
    const err = json?.error;
    throw new ApiError(`Claude cloud ${method} ${path.replace(/\/(cse|session)_[A-Za-z0-9]+/, "/<id>")} failed: HTTP ${res.status} ${err?.reason ?? err?.type ?? ""} ${String(err?.message ?? text).slice(0, 300)}`.trim(), res.status, json);
  }
  return json ?? {};
}

async function uploadFile(data, filename) {
  const token = readToken();
  const boundary = `----cloudacp${crypto.randomUUID()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nuser_data\r\n--${boundary}--\r\n`),
  ]);
  const res = await fetch(`${BASE}/v1/files`, { method: "POST", body,
    headers: { ...headers(token, { json: false, beta: "files-api-2025-04-14,oauth-2025-04-20" }), "Content-Type": `multipart/form-data; boundary=${boundary}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Claude cloud bundle upload failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text).id;
}

const unwrap = (j) => j?.response_shape ?? j?.session ?? j;
const toCodeId = (id) => (id?.startsWith("session_") ? `cse_${id.slice("session_".length)}` : id);
const enc = encodeURIComponent;

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

export class ClaudeBackend {
  name = "claude";
  label = "Claude Code on the web";
  #cache = new Map();

  checkAuth() { readToken(); }
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
  #recentSessions() {
    return this.#cached("sessions", 60_000, async () => (await api("GET", "/v1/code/sessions", { query: { limit: 50 } })).data ?? []);
  }

  async prepare(session) {
    session.repo = await repoInfo(session.cwd);
    let envs = [], recent = [];
    try { envs = (await this.#envs()).filter((e) => e.kind !== "bridge"); } catch (e) { if (e instanceof UserError) throw e; log(`environment list failed: ${e.message}`); }
    try { recent = await this.#recentSessions(); } catch (e) { if (e instanceof UserError) throw e; log(`session list failed: ${e.message}`); }
    session.envs = envs;
    // Models this account has actually used in cloud sessions (no public model list endpoint).
    session.models = [...new Set(recent.flatMap((s) => [s.config?.model, s.external_metadata?.last_served_model]).filter((m) => typeof m === "string" && m))];
    const cfg = session.config ?? (session.config = {});
    if (!cfg.environment || !envs.some((e) => e.id === cfg.environment)) cfg.environment = pickDefaultEnv(envs)?.id ?? "none";
    cfg.model ??= "default";
    cfg.mode ??= "acceptEdits";
    cfg.apply ??= "off";
  }

  configOptions(session) {
    const cfg = session.config;
    const envOptions = (session.envs ?? []).map((e) => ({ value: e.id, name: e.name, description: e.kind }));
    if (!envOptions.some((o) => o.value === cfg.environment)) envOptions.unshift({ value: cfg.environment, name: cfg.environment === "none" ? "No environment (open claude.ai/code once)" : cfg.environment });
    const models = [{ value: "default", name: "Default", description: "The cloud's default model" },
      ...[...new Set([...(session.models ?? []), ...(cfg.model !== "default" ? [cfg.model] : [])])].map((m) => ({ value: m, name: m }))];
    return [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: cfg.model, options: models },
      { id: "environment", name: "Environment", description: "Claude Code cloud environment.", type: "select", currentValue: cfg.environment, options: envOptions },
      { id: "mode", name: "Permission mode", category: "mode", type: "select", currentValue: cfg.mode, options: MODES },
      { id: "apply", name: "Apply diff locally", description: "When the session pushes a branch, fetch it and apply its diff here (git apply, never forced).", type: "select", currentValue: cfg.apply,
        options: [{ value: "off", name: "Off" }, { value: "on", name: "On" }] },
    ];
  }

  setConfig(session, id, value) {
    if (id === "mode" && !MODES.some((m) => m.value === value)) throw new UserError(`Invalid permission mode ${value}`);
    if (id === "apply" && !["off", "on"].includes(value)) throw new UserError(`Invalid value ${value}`);
    if (!["model", "environment", "mode", "apply"].includes(id)) throw new UserError(`Unknown config option ${id}`);
    session.config[id] = value;
  }

  // ---------- prompt ----------
  async prompt(session, text, io) {
    let fromSeq = 0, userSeq = 0;
    if (!session.cloudId) {
      await this.#create(session, text, io);
    } else {
      const events = [];
      if (session.sentMode !== session.config.mode) events.push({ payload: { type: "control_request", request_id: `set-mode-${crypto.randomUUID()}`, request: { subtype: "set_permission_mode", mode: session.config.mode }, uuid: crypto.randomUUID() } });
      if (session.config.model !== "default" && session.sentModel !== session.config.model) events.push({ payload: { type: "control_request", request_id: `set-model-${crypto.randomUUID()}`, request: { subtype: "set_model", model: session.config.model }, uuid: crypto.randomUUID() } });
      events.push({ payload: { uuid: crypto.randomUUID(), session_id: session.cloudId, type: "user", parent_tool_use_id: null, message: { role: "user", content: text } } });
      const r = await api("POST", `/v1/code/sessions/${enc(session.cloudId)}/events`, { body: { events } });
      userSeq = Number(r.results?.at(-1)?.sequence_num ?? 0);
      fromSeq = session.lastSeq ?? 0;
      session.sentMode = session.config.mode;
      session.sentModel = session.config.model;
    }
    const result = await this.#streamTurn(session, io, fromSeq, userSeq);
    saveSessionRecord(session);
    if (result.status === "completed") await this.#finishDiff(session, io);
    io.text(`\n\n[Open in Claude Code on the web](${session.webUrl})`);
    if (session.title) io.update({ sessionUpdate: "session_info_update", title: session.title, updatedAt: new Date().toISOString() });
    saveSessionRecord(session);
    if (result.status === "cancelled" || io.signal.aborted) return "cancelled";
    if (result.status === "max_turns") return "max_turn_requests";
    if (result.status === "failed") throw new Error(`Claude cloud turn failed: ${result.error ?? "unknown error"} (${session.webUrl})`);
    return "end_turn";
  }

  async #create(session, text, io) {
    const cfg = session.config;
    if (!cfg.environment || cfg.environment === "none") throw new UserError("No Claude Code cloud environment found. Open https://claude.ai/code once to create the default environment, then retry.");
    const repo = session.repo ?? (session.repo = await repoInfo(session.cwd));
    const title = text.split("\n")[0].slice(0, 75) || "cloud-acp task";
    const events = [
      { type: "event", data: { type: "control_request", request_id: `set-mode-${crypto.randomUUID()}`, request: { subtype: "set_permission_mode", mode: cfg.mode } } },
      { type: "event", data: { uuid: crypto.randomUUID(), session_id: "", type: "user", parent_tool_use_id: null, message: { role: "user", content: text } } },
    ];
    const base = { title, events, environment_id: cfg.environment };
    const model = cfg.model !== "default" ? { model: cfg.model } : {};
    let created = null;

    if (repo.github) {
      let revision = repo.branch;
      if (!revision || !repo.branchSha) {
        revision = repo.defaultBranch;
        io.text(`Note: ${repo.branch ? `branch \`${repo.branch}\` is not on origin` : "no current branch"}, so the session starts from \`${revision}\`. Push your branch to run on it.\n\n`);
      }
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
      const outcomeBranch = `claude/${slug}-${crypto.randomBytes(3).toString("hex")}`;
      const full = `${repo.github.owner}/${repo.github.name}`;
      try {
        created = await api("POST", "/v1/sessions", { beta: BETA_CCR, body: { ...base, session_context: {
          sources: [{ type: "git_repository", url: `https://github.com/${full}`, revision }],
          outcomes: [{ type: "git_repository", git_info: { type: "github", repo: full, branches: [outcomeBranch] } }], ...model } } });
        session.bundle = false;
        session.outcomeBranch = outcomeBranch;
        session.baseSha = revision === repo.branch ? repo.branchSha : repo.defaultSha;
      } catch (e) {
        const reason = e.body?.error?.reason ?? "";
        if (!(e instanceof ApiError) || e.status !== 400 || !/github|repo_access/i.test(reason + e.message)) throw e;
        log(`GitHub source refused (${reason || e.status}); falling back to a git bundle`);
      }
    }
    if (!created) {
      if (!repo.isRepo) throw new UserError(`${session.cwd} is not a git repository, so there is nothing to send to the cloud.`);
      const file = join(tmpdir(), `cloud-acp-${crypto.randomBytes(4).toString("hex")}.bundle`);
      const refs = ["HEAD", ...(repo.branch ? [repo.branch] : [])];
      const b = await git(session.cwd, ["bundle", "create", file, ...refs]);
      if (b.code !== 0) throw new Error(`git bundle create failed: ${b.stderr.trim().slice(0, 300)}`);
      const data = readFileSync(file); rmSync(file, { force: true });
      if (data.length > 100 * 1024 * 1024) throw new UserError("The repo bundle is over 100 MB, which Claude cloud sessions do not accept.");
      const fileId = await uploadFile(data, "_source_seed.bundle");
      created = await api("POST", "/v1/sessions", { beta: BETA_CCR, body: { ...base, session_context: { sources: [], outcomes: [], seed_bundle_file_id: fileId, ...model } } });
      session.bundle = true;
      io.text(`Claude's GitHub app can't reach ${repo.github ? `${repo.github.owner}/${repo.github.name}` : "this repo"}, so the session was seeded from a git bundle of your committed work (${(data.length / 1024).toFixed(0)} KB; uncommitted changes are not included). In this mode the session can't push a branch, so its changes stay in the cloud.\n\n`);
    }
    session.cloudId = toCodeId(created.id);
    session.title = created.title ?? title;
    session.webUrl = this.webUrl(session.cloudId);
    session.sentMode = cfg.mode;
    session.sentModel = cfg.model;
    saveSessionRecord(session);
    log(`created session ${session.cloudId}${session.bundle ? " (bundle)" : ""}`);
  }

  async #streamTurn(session, io, fromSeq, userSeq) {
    const st = new ClaudeTurn(session, io);
    const ac = new AbortController();
    let finished = null;
    const finish = (r) => { if (!finished) { finished = r; ac.abort(); } };
    let interruptSent = false;
    const onAbort = async () => {
      if (interruptSent) return; interruptSent = true;
      try {
        await api("POST", `/v1/code/sessions/${enc(session.cloudId)}/events`, { body: { events: [{ payload: { type: "control_request", request_id: crypto.randomUUID(), request: { subtype: "interrupt", cancel_queued: true }, uuid: crypto.randomUUID() } }] } });
        log("interrupt sent");
      } catch (e) { log(`interrupt failed: ${e.message}`); }
      setTimeout(() => finish({ status: "cancelled" }), 30_000).unref();
    };
    io.signal.addEventListener("abort", onAbort, { once: true });
    if (io.signal.aborted) onAbort();

    st.onPermission = async (row) => {
      const req = row.payload.request ?? {};
      const toolCallId = req.tool_use_id ?? `perm:${row.payload.request_id}`;
      let allow = false;
      try {
        const r = await io.requestPermission({
          sessionId: session.id,
          toolCall: { toolCallId, title: `${req.tool_name ?? "Tool"}${req.input?.command ? `: ${req.input.command}` : ""}`, kind: toolKind(req.tool_name), status: "pending", rawInput: req.input ?? {} },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Deny", kind: "reject_once" }],
        });
        allow = r.outcome?.outcome === "selected" && r.outcome.optionId === "allow";
      } catch (e) { log(`permission request failed: ${e.message}`); }
      const response = allow ? { behavior: "allow", updatedInput: req.input ?? {} } : { behavior: "deny", message: "The user denied this in T3 Code." };
      await api("POST", `/v1/code/sessions/${enc(session.cloudId)}/events`, { body: { events: [{ payload: { type: "control_response", response: { subtype: "success", request_id: row.payload.request_id, response } } }] } })
        .catch((e) => log(`control_response failed: ${e.message}`));
    };

    let lastSeq = fromSeq;
    const deadline = Date.now() + 3 * 3600_000;
    while (!finished && Date.now() < deadline) {
      try {
        const token = readToken();
        const url = `${BASE}/v1/code/sessions/${enc(session.cloudId)}/events/stream?from_sequence_num=${lastSeq}`;
        const res = await fetch(url, { headers: { ...headers(token, { json: false, accept: "text/event-stream" }), ...(lastSeq ? { "Last-Event-ID": String(lastSeq) } : {}) }, signal: ac.signal });
        if (res.status === 401) throw new UserError(`Claude cloud rejected the claude.ai token (401). ${AUTH_HELP}`);
        if (!res.ok) throw new Error(`stream HTTP ${res.status}`);
        for await (const frame of sseFrames(res)) {
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
        if (e instanceof UserError) { finish({ status: "failed", error: e.message }); break; }
        log(`stream error (${e.message}); reconnecting`);
      }
      if (!finished) await sleep(1500, ac.signal);
    }
    io.signal.removeEventListener("abort", onAbort);
    st.closeSetup();
    try {
      const s = unwrap(await api("GET", `/v1/code/sessions/${enc(session.cloudId)}`));
      session.title = s.title ?? session.title;
    } catch {}
    const status = io.signal.aborted && finished?.status !== "completed" ? "cancelled" : finished?.status ?? "failed";
    log(`turn ${status}`);
    return { status, error: finished?.error };
  }

  // Only GitHub-sourced sessions push an outcome branch; bundle-seeded ones have no way back.
  async #finishDiff(session, io) {
    if (session.bundle || !session.outcomeBranch || !session.baseSha) return;
    const ls = await git(session.cwd, ["ls-remote", "origin", `refs/heads/${session.outcomeBranch}`]);
    if (ls.code !== 0 || !ls.stdout.trim()) return;
    const f = await git(session.cwd, ["fetch", "--no-tags", "origin", `${session.outcomeBranch}:refs/remotes/origin/${session.outcomeBranch}`]);
    if (f.code !== 0) { io.text(`\n\nCould not fetch ${session.outcomeBranch}: ${f.stderr.trim().slice(0, 200)}`); return; }
    const d = await git(session.cwd, ["diff", "--no-color", session.baseSha, `refs/remotes/origin/${session.outcomeBranch}`]);
    const diff = d.stdout;
    if (d.code !== 0 || !diff.trim()) return;
    io.update(diffToolCall({ toolCallId: `diff:${session.cloudId}:${session.lastSeq}`, diff, cwd: session.cwd, title: `Branch ${session.outcomeBranch}: ${diffFiles(diff).length} files` }));
    if (session.config.apply === "on") {
      const r = await applyLocally({ cwd: session.cwd, diff, name: `${session.cloudId}-${session.lastSeq}`, previousFile: session.appliedPatchFile });
      if (r.ok && !r.unchanged) session.appliedPatchFile = r.patchFile;
      io.text(`\n\n${r.message}`);
    } else {
      io.text(`\n\nThe session pushed \`${session.outcomeBranch}\` (fetched as origin/${session.outcomeBranch}). Turn on "Apply diff locally" to apply it here.`);
    }
  }

  async cancel() { /* handled through the prompt's abort signal */ }

  // ---------- list / load ----------
  async list(cwd, cursor) {
    const repo = await repoInfo(cwd);
    const full = repo.github ? `${repo.github.owner}/${repo.github.name}`.toLowerCase() : null;
    const mine = new Set(allSessionRecords("claude").filter((r) => r.cwd?.toLowerCase() === cwd.toLowerCase()).map((r) => r.cloudId));
    const j = await api("GET", "/v1/code/sessions", { query: { limit: 50, cursor } });
    const sessions = (j.data ?? [])
      .filter((s) => s.status !== "archived" && s.environment_kind !== "bridge")
      .filter((s) => mine.has(s.id) || (full && sourceRepo(s) === full))
      .map((s) => ({ sessionId: s.id, cwd, title: s.title ?? null, updatedAt: s.last_event_at ?? s.updated_at ?? s.created_at ?? null,
        _meta: { status: s.worker_status ?? s.status ?? null } }));
    return { sessions, ...(j.next_cursor ? { nextCursor: j.next_cursor } : {}) };
  }

  async replay(session, io) {
    const s = unwrap(await api("GET", `/v1/code/sessions/${enc(session.cloudId)}`));
    session.title = s.title ?? session.title;
    session.webUrl = this.webUrl(session.cloudId);
    const outcome = (s.config?.outcomes ?? []).find((o) => o.type === "git_repository");
    session.outcomeBranch ??= outcome?.git_info?.branches?.[0];
    session.bundle ??= !(s.config?.sources ?? []).length;
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
        return { status: "failed", error: p.result || p.subtype || "error" };
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
