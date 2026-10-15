// Codex Cloud backend (chatgpt.com/backend-api/wham). See cloud-threads-research/codex/FINDINGS.md.
// Auth: ~/.codex/auth.json, read fresh per request and never refreshed here (refresh tokens rotate).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { posix } from "node:path";
import { log, sleep, sseFrames, tail, git, repoInfo, UserError, isoFromEpochSeconds, saveSessionRecord, cleanTerminal } from "./util.mjs";
import { codexChangesToPatch, diffToolCall, applyLocally, diffFiles } from "./diff.mjs";

const BASE = (process.env.CODEX_CLOUD_TASKS_BASE_URL || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
const WEB = BASE.replace(/\/backend-api$/, "");
const USER_AGENT = "cloud-acp/0.1 (T3 Code ACP bridge)";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const POLL_MS = 5000;

const AUTH_HELP = "Run `codex login status` (or any `codex` command) so the Codex CLI refreshes its login, then retry. cloud-acp never refreshes tokens itself.";

function readAuth() {
  const file = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
  let auth;
  try { auth = JSON.parse(readFileSync(file, "utf8")); } catch (e) {
    throw new UserError(`Codex Cloud: cannot read ${file} (${e.code ?? "parse error"}). Sign in with \`codex login\` (ChatGPT account).`);
  }
  const t = auth.tokens;
  if (!t?.access_token) throw new UserError("Codex Cloud needs a ChatGPT sign-in (`codex login`); API-key auth is not accepted by Codex Cloud.");
  let claims = null;
  try { claims = JSON.parse(Buffer.from(t.access_token.split(".")[1], "base64url").toString("utf8")); } catch {}
  if (claims?.exp && claims.exp * 1000 < Date.now() + 60_000) throw new UserError(`Codex Cloud: your ChatGPT token has expired. ${AUTH_HELP}`);
  return { token: t.access_token, accountId: t.account_id ?? claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? null };
}

async function api(method, path, body, { signal } = {}) {
  const auth = readAuth();
  const headers = { Authorization: `Bearer ${auth.token}`, "User-Agent": USER_AGENT, Accept: "application/json" };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "error", signal });
  const text = await res.text();
  if (res.status === 401) throw new UserError(`Codex Cloud rejected the ChatGPT token (401). ${AUTH_HELP}`);
  if (!res.ok) {
    // Error bodies are short API errors; still cap them so nothing large is echoed.
    let detail = text.slice(0, 300);
    try { const j = JSON.parse(text); detail = j.detail?.message ?? j.detail ?? j.error?.message ?? detail; } catch {}
    throw new Error(`Codex Cloud ${method} ${path.split("?")[0]} failed: HTTP ${res.status} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function openStream(path, signal) {
  const auth = readAuth();
  const headers = { Authorization: `Bearer ${auth.token}`, "User-Agent": USER_AGENT, Accept: "text/event-stream" };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
  const res = await fetch(BASE + path, { headers, signal, redirect: "error" });
  if (!res.ok) throw new Error(`Codex Cloud stream failed: HTTP ${res.status}`);
  return res;
}

const enc = encodeURIComponent;
const taskUrl = (id) => `${WEB}/codex/tasks/${id}`;

// Environments: keep only the fields we show. The API also returns env_vars/secrets; never keep those.
const slimEnv = (e) => ({ id: e.id, label: e.label ?? e.id, pinned: !!e.is_pinned, taskCount: e.task_count ?? 0,
  repos: Object.values(e.repo_map ?? {}).map((r) => r.repository_full_name).filter(Boolean) });

function pickDefaultEnv(envs, repoName) {
  if (!envs.length) return null;
  const matching = envs.filter((e) => e.matchesRepo);
  const pool = matching.length ? matching : envs;
  return pool.find((e) => repoName && e.label.toLowerCase() === repoName.toLowerCase())
    ?? (pool.length === 1 ? pool[0] : null)
    ?? pool.find((e) => e.pinned)
    ?? [...pool].sort((a, b) => b.taskCount - a.taskCount)[0];
}

// `/bin/bash -lc "..."` -> the inner command, for display.
function displayCommand(cmd) {
  if (typeof cmd !== "string") return Array.isArray(cmd) ? cmd.join(" ") : "command";
  const m = cmd.match(/^\/bin\/(?:ba)?sh -lc (["'])([\s\S]*)\1$/);
  if (!m) return cmd;
  return m[1] === '"' ? m[2].replace(/\\(["\\$`])/g, "$1") : m[2];
}

function inputText(items) {
  return (items ?? []).filter((i) => i.type === "message")
    .flatMap((i) => (i.content ?? []).filter((c) => c.content_type === "text").map((c) => c.text)).join("\n\n");
}

function turnDiff(turn) {
  for (const item of turn?.output_items ?? []) {
    if (item.type === "output_diff" && item.diff) return item.diff;
    if (item.type === "pr" && item.output_diff?.diff) return item.output_diff.diff;
  }
  return null;
}

export class CodexBackend {
  name = "codex";
  label = "Codex Cloud";
  #envCache = new Map(); // repoKey -> {at, envs}

  checkAuth() { readAuth(); }
  webUrl(id) { return taskUrl(id); }

  async #environments(repo) {
    const key = repo?.github ? `${repo.github.owner}/${repo.github.name}` : "";
    const hit = this.#envCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.envs;
    const byId = new Map();
    if (repo?.github) {
      try {
        for (const e of await api("GET", `/wham/environments/by-repo/github/${enc(repo.github.owner)}/${enc(repo.github.name)}`)) {
          byId.set(e.id, { ...slimEnv(e), matchesRepo: true });
        }
      } catch (e) { if (e instanceof UserError) throw e; log(`by-repo lookup failed: ${e.message}`); }
    }
    for (const e of await api("GET", "/wham/environments")) if (!byId.has(e.id)) byId.set(e.id, { ...slimEnv(e), matchesRepo: false });
    const envs = [...byId.values()].sort((a, b) => (b.matchesRepo - a.matchesRepo) || (b.pinned - a.pinned) || a.label.localeCompare(b.label));
    this.#envCache.set(key, { at: Date.now(), envs });
    return envs;
  }

  // session/new: no cloud task, just local defaults + option lists.
  async prepare(session) {
    session.repo = await repoInfo(session.cwd);
    let envs = [];
    try { envs = await this.#environments(session.repo); } catch (e) { if (e instanceof UserError) throw e; log(`environment list failed: ${e.message}`); }
    session.envs = envs;
    const cfg = session.config ?? (session.config = {});
    if (!cfg.environment || !envs.some((e) => e.id === cfg.environment)) cfg.environment = pickDefaultEnv(envs, session.repo.github?.name)?.id ?? "none";
    cfg.mode ??= "code";
    cfg.apply ??= "off";
    cfg.localChanges ??= "off";
  }

  configOptions(session) {
    const cfg = session.config;
    const envOptions = (session.envs ?? []).map((e) => ({
      value: e.id, name: e.label,
      description: `${e.repos.join(", ") || "no repos"}${e.matchesRepo ? " (this repo)" : ""}`,
    }));
    if (!envOptions.some((o) => o.value === cfg.environment)) {
      envOptions.unshift({ value: cfg.environment, name: cfg.environment === "none" ? "No environment (create one at chatgpt.com/codex)" : cfg.environment });
    }
    return [
      { id: "environment", name: "Environment", description: "Codex Cloud environment the task runs in.", type: "select", currentValue: cfg.environment, options: envOptions },
      { id: "mode", name: "Mode", category: "mode", description: "Code makes changes; Ask only answers.", type: "select", currentValue: cfg.mode,
        options: [{ value: "code", name: "Code" }, { value: "ask", name: "Ask" }] },
      { id: "apply", name: "Apply diff locally", description: "Apply the cloud diff to this checkout at the end of each turn (git apply, never forced).", type: "select", currentValue: cfg.apply,
        options: [{ value: "off", name: "Off" }, { value: "on", name: "On" }] },
      { id: "localChanges", name: "Send local changes", description: "Send `git diff origin/<branch>` (unpushed and uncommitted tracked changes) as the task's starting patch.", type: "select", currentValue: cfg.localChanges,
        options: [{ value: "off", name: "Off" }, { value: "on", name: "On" }] },
    ];
  }

  setConfig(session, id, value) {
    const allowed = { environment: null, mode: ["code", "ask"], apply: ["off", "on"], localChanges: ["off", "on"] };
    if (!(id in allowed)) throw new UserError(`Unknown config option ${id}`);
    if (allowed[id] && !allowed[id].includes(value)) throw new UserError(`Invalid value ${value} for ${id}`);
    session.config[id] = value;
  }

  // ---------- prompt ----------
  async prompt(session, text, io) {
    const cfg = session.config;
    let turnId;
    if (!session.cloudId) {
      if (!cfg.environment || cfg.environment === "none") {
        throw new UserError("No Codex Cloud environment is set up for this repo. Create one at https://chatgpt.com/codex/settings/environments, then pick it in the Environment option.");
      }
      const repo = session.repo ?? (session.repo = await repoInfo(session.cwd));
      let branch = repo.branch;
      if (!branch || !repo.branchSha) {
        branch = repo.defaultBranch;
        io.text(`Note: ${repo.branch ? `branch \`${repo.branch}\` is not on origin` : "no current branch"}, so the cloud task starts from \`${branch}\`. Push your branch to run on it.\n\n`);
      }
      const input_items = [{ type: "message", role: "user", content: [{ content_type: "text", text }] }];
      if (cfg.localChanges === "on" && repo.isRepo) {
        const d = await git(session.cwd, ["diff", "--no-color", `origin/${branch}`]);
        if (d.code === 0 && d.stdout.trim()) {
          input_items.push({ type: "pre_apply_patch", output_diff: { diff: d.stdout } });
          io.text(`Sending your local changes as the starting patch (${diffFiles(d.stdout).length} files vs origin/${branch}; untracked files are not included).\n\n`);
        }
      }
      const res = await api("POST", "/wham/tasks", { new_task: { environment_id: cfg.environment, branch, run_environment_in_qa_mode: cfg.mode === "ask" }, input_items });
      session.cloudId = res?.task?.id ?? res?.id;
      if (!session.cloudId) throw new Error("Codex Cloud created a task but returned no id");
      session.webUrl = taskUrl(session.cloudId);
      session.title = res?.task?.title ?? session.title;
      saveSessionRecord(session);
      log(`created task ${session.cloudId}`);
      turnId = typeof res?.turn?.id === "string" && res.turn.id.includes("assttrn") ? res.turn.id : await this.#waitForNewTurn(session.cloudId, null, io.signal);
    } else {
      const before = await api("GET", `/wham/tasks/${enc(session.cloudId)}`);
      const prev = before.task?.current_turn_id ?? session.turnId;
      const res = await api("POST", "/wham/tasks", {
        follow_up: { task_id: session.cloudId, turn_id: prev, environment_mode: cfg.mode === "ask" ? "ask" : "code" },
        input_items: [{ type: "message", role: "user", content: [{ content_type: "text", text }] }],
      });
      turnId = typeof res?.turn?.id === "string" && res.turn.id.includes("assttrn") && res.turn.id !== prev ? res.turn.id : await this.#waitForNewTurn(session.cloudId, prev, io.signal);
    }
    session.turnId = turnId;
    saveSessionRecord(session);

    const result = await this.#streamTurn(session, turnId, io);
    if (session.title) io.update({ sessionUpdate: "session_info_update", title: session.title, updatedAt: new Date().toISOString() });

    if (result.status === "completed") await this.#finishDiff(session, result.turn, io);
    io.text(`\n\n[Open in Codex Cloud](${session.webUrl})`);
    saveSessionRecord(session);
    if (result.status === "cancelled" || io.signal.aborted) return "cancelled";
    if (result.status === "failed") throw new Error(`Codex Cloud turn failed: ${result.error ?? "unknown error"} (${session.webUrl})`);
    return "end_turn";
  }

  async #waitForNewTurn(taskId, previous, signal) {
    for (let i = 0; i < 60 && !signal?.aborted; i++) {
      const d = await api("GET", `/wham/tasks/${enc(taskId)}`);
      const id = d.current_assistant_turn?.id ?? d.task?.current_turn_id;
      if (id && id !== previous && id.includes("assttrn")) return id;
      await sleep(1000, signal);
    }
    throw new Error("Codex Cloud did not start a turn within 60 s");
  }

  // Live SSE for the turn plus a 5 s GET poll (the stream can stay open and silent once a turn is done).
  async #streamTurn(session, turnId, io) {
    const st = new TurnState(session, io, turnId);
    const ac = new AbortController();
    let finished = null;
    const finish = (r) => { if (!finished) { finished = r; ac.abort(); } };
    let cancelSent = false;
    const onAbort = async () => {
      if (cancelSent) return; cancelSent = true;
      try { await api("POST", `/wham/tasks/${enc(session.cloudId)}/cancel`); log("cancel requested"); } catch (e) { log(`cancel failed: ${e.message}`); }
    };
    io.signal.addEventListener("abort", onAbort, { once: true });
    if (io.signal.aborted) onAbort();

    const streamer = (async () => {
      let gotEvents = false;
      st.setupLog("Waiting for the cloud container (clone + setup script)...");
      for (let attempt = 0; attempt < 5 && !finished; attempt++) {
        // A reconnect would replay deltas we already showed; once events have flowed, the poller's
        // catch-up from stored thread_events covers the rest of the turn instead.
        if (gotEvents) return;
        try {
          const res = await openStream(`/wham/tasks/${enc(session.cloudId)}/turns/${enc(turnId)}/stream?item_type=thread_event&item_type=log`, ac.signal);
          for await (const frame of sseFrames(res)) {
            gotEvents = true;
            let d; try { d = JSON.parse(frame.data); } catch { continue; }
            if (d.item_type === "log") { st.setupLog(d.line); continue; }
            if (d.item_type !== "thread_event" || !d.event?.method) continue;
            const r = st.handle(d.event.method, d.event.params ?? {});
            if (r) { finish({ ...r, via: "stream" }); return; }
          }
        } catch (e) {
          if (finished || ac.signal.aborted) return;
          log(`stream error (${e.message}); reconnecting`);
        }
        await sleep(2000, ac.signal);
      }
    })();

    const poller = (async () => {
      const startedAt = Date.now();
      let cancelDeadline = null;
      while (!finished) {
        await sleep(POLL_MS, ac.signal);
        if (finished) return;
        if (io.signal.aborted) cancelDeadline ??= Date.now() + 30_000;
        try {
          const d = await api("GET", `/wham/tasks/${enc(session.cloudId)}`);
          session.title = d.task?.title ?? session.title;
          const turn = d.current_assistant_turn;
          if (turn?.id === turnId && TERMINAL.has(turn.turn_status)) {
            // Give the stream a moment to deliver the tail, then fill gaps from the stored events.
            await sleep(1500);
            if (finished) return;
            st.catchUp(turn.thread_events?.events ?? []);
            if (!st.sawText) for (const m of turnMessages(turn)) st.text(m);
            finish({ status: turn.turn_status, error: turn.error?.message, via: "poll" });
            return;
          }
        } catch (e) { if (e instanceof UserError) { finish({ status: "failed", error: e.message }); return; } log(`poll failed: ${e.message}`); }
        if (cancelDeadline && Date.now() > cancelDeadline) { finish({ status: "cancelled" }); return; }
        if (Date.now() - startedAt > 3 * 3600_000) { finish({ status: "failed", error: "timed out after 3 h" }); return; }
      }
    })();

    await Promise.race([streamer, poller]);
    await Promise.allSettled([streamer, poller]);
    io.signal.removeEventListener("abort", onAbort);
    st.closeSetup();
    log(`turn ${finished?.status} via ${finished?.via ?? "?"}`);
    const status = io.signal.aborted && finished?.status !== "completed" ? "cancelled" : finished?.status ?? "failed";
    return { status, error: finished?.error, turn: null };
  }

  async #finishDiff(session, _turn, io) {
    // The diff lands in output_items once the turn is done; it can lag turn/completed a little.
    let diff = null;
    for (let i = 0; i < 4; i++) {
      const d = await api("GET", `/wham/tasks/${enc(session.cloudId)}`);
      session.title = d.task?.title ?? session.title;
      diff = turnDiff(d.current_diff_task_turn) ?? turnDiff(d.current_assistant_turn);
      const stats = d.task?.task_status_display?.latest_turn_status_display?.diff_stats;
      if (diff || !(stats?.files_modified > 0)) break;
      await sleep(2000);
    }
    if (!diff) return;
    io.update(diffToolCall({ toolCallId: `diff:${session.turnId}`, diff, cwd: session.cwd }));
    if (session.config.apply === "on") {
      const r = await applyLocally({ cwd: session.cwd, diff, name: `${session.cloudId}-${session.turnId.split("~").pop()}`, previousFile: session.appliedPatchFile });
      if (r.ok && !r.unchanged) session.appliedPatchFile = r.patchFile;
      io.text(`\n\n${r.message}`);
    } else {
      io.text(`\n\nThe cloud produced a diff (${diffFiles(diff).length} files). Turn on "Apply diff locally" to apply it here, or open the task to create a PR.`);
    }
  }

  async cancel() { /* handled through the prompt's abort signal */ }

  // ---------- list / load ----------
  async list(cwd, cursor) {
    const repo = await repoInfo(cwd);
    const labels = new Set((await this.#environments(repo)).filter((e) => e.matchesRepo).map((e) => e.label));
    if (!labels.size) return { sessions: [] };
    // /wham/tasks/list ignores environment_id (checked live), and list items carry only the env label,
    // so page through and keep tasks whose environment belongs to this repo.
    const sessions = [];
    let next = cursor ?? null;
    for (let page = 0; page < 5 && sessions.length < 20; page++) {
      const q = new URLSearchParams({ limit: "20", task_filter: "current" });
      if (next) q.set("cursor", next);
      const res = await api("GET", `/wham/tasks/list?${q}`);
      for (const t of res.items ?? []) {
        const d = t.task_status_display ?? {};
        if (!labels.has(d.environment_label)) continue;
        sessions.push({ sessionId: t.id, cwd, title: t.title ?? null,
          updatedAt: isoFromEpochSeconds(t.updated_at) ?? isoFromEpochSeconds(t.created_at),
          _meta: { environment: d.environment_label, branch: d.branch_name ?? null, status: d.latest_turn_status_display?.turn_status ?? null } });
      }
      next = res.cursor ?? null;
      if (!next) break;
    }
    return { sessions, ...(next ? { nextCursor: next } : {}) };
  }

  // Bind to an existing task and replay its turns (user prompts + stored app-server thread_events).
  async replay(session, io) {
    const map = await api("GET", `/wham/tasks/${enc(session.cloudId)}/turns`);
    const turns = map.turn_mapping ?? {};
    const path = [];
    for (let id = map.current_turn_id; id && turns[id] && path.length < 500; id = turns[id].parent) path.unshift(turns[id]);
    const d = await api("GET", `/wham/tasks/${enc(session.cloudId)}`);
    session.title = d.task?.title ?? session.title;
    session.webUrl = taskUrl(session.cloudId);
    const updates = [];
    const collect = { update: (u) => updates.push(u), text: (t) => updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } }), signal: io.signal };
    for (const node of path) {
      let turn = node.turn ?? {};
      if (turn.role === "user" || node.id.includes("usertrn")) {
        const t = inputText(turn.input_items);
        if (t) updates.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: t } });
        continue;
      }
      if (!turn.thread_events && !turn.output_items) {
        try { turn = (await api("GET", `/wham/tasks/${enc(session.cloudId)}/turns/${enc(node.id)}`)).turn ?? turn; } catch (e) { log(`turn fetch failed: ${e.message}`); }
      }
      const st = new TurnState(session, collect, node.id, { replay: true });
      st.catchUp(turn.thread_events?.events ?? []);
      if (!st.sawText) for (const m of turnMessages(turn)) st.text(m);
      const diff = turnDiff(turn);
      if (diff) updates.push(diffToolCall({ toolCallId: `diff:${node.id}`, diff, cwd: session.cwd }));
      session.turnId = node.id;
    }
    if (session.title) updates.push({ sessionUpdate: "session_info_update", title: session.title });
    for (const u of updates) io.update(u);
    saveSessionRecord(session);
  }
}

function turnMessages(turn) {
  const out = [];
  for (const item of turn?.output_items ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) if (c.content_type === "text" && c.text) out.push(c.text);
  }
  return out;
}

// Maps codex app-server v2 notifications (thread_events) to ACP session updates for one turn.
class TurnState {
  constructor(session, io, turnId, { replay = false } = {}) {
    this.session = session; this.io = io; this.turnId = turnId; this.replay = replay;
    this.deltaItems = new Set(); this.doneItems = new Set(); this.startedTools = new Set();
    this.sawText = false; this.remoteCwd = null;
    this.setup = null; // {id, lines}
  }
  text(t) { if (t) { this.sawText = true; this.io.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } }); } }
  thought(t) { if (t) this.io.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: t } }); }
  // Cloud paths (/workspace/<repo>/...) -> paths in the local checkout.
  local(p) {
    if (typeof p !== "string" || !p) return p;
    const rc = this.remoteCwd;
    let rel = null;
    if (rc && (p === rc || p.startsWith(rc + "/"))) rel = p.slice(rc.length + 1);
    else if (/^\/workspace\/[^/]+\//.test(p)) rel = p.replace(/^\/workspace\/[^/]+\//, "");
    else if (!p.startsWith("/")) rel = posix.normalize(p);
    return rel === null ? p : join(this.session.cwd, ...rel.split("/"));
  }

  setupLog(line) {
    if (this.replay || !line) return;
    if (!this.setup) {
      this.setup = { id: `setup:${this.turnId}`, lines: [] };
      this.io.update({ sessionUpdate: "tool_call", toolCallId: this.setup.id, title: "Preparing the cloud environment", kind: "execute", status: "in_progress", rawInput: { command: "Codex Cloud setup" } });
    }
    const clean = cleanTerminal(line); if (!clean) return;
    this.setup.lines.push(clean);
    if (this.setup.lines.length % 10 === 1) this.io.update({ sessionUpdate: "tool_call_update", toolCallId: this.setup.id, rawOutput: { output: tail(this.setup.lines.join("\n")) } });
  }
  closeSetup() {
    if (!this.setup || this.setup.closed) return;
    this.setup.closed = true;
    this.io.update({ sessionUpdate: "tool_call_update", toolCallId: this.setup.id, status: "completed", rawOutput: { output: tail(this.setup.lines.join("\n")) } });
  }

  // Returns {status, error} when the turn ends.
  handle(method, p) {
    switch (method) {
      case "thread/started": this.remoteCwd = p.thread?.cwd ?? this.remoteCwd; return null;
      case "turn/started": this.closeSetup(); return null;
      case "item/agentMessage/delta": this.deltaItems.add(p.itemId); this.text(p.delta); return null;
      case "item/reasoning/summaryTextDelta": this.deltaItems.add(p.itemId); this.thought(p.delta); return null;
      case "item/reasoning/summaryPartAdded": if (this.deltaItems.has(p.itemId)) this.thought("\n\n"); return null;
      case "item/started": this.itemStarted(p.item); return null;
      case "item/completed": this.itemCompleted(p.item); return null;
      case "turn/plan/updated": {
        const entries = (p.plan ?? []).map((s) => ({ content: s.step ?? "", priority: "medium", status: s.status === "inProgress" ? "in_progress" : s.status === "completed" ? "completed" : "pending" }));
        if (entries.length) this.io.update({ sessionUpdate: "plan", entries });
        return null;
      }
      case "thread/tokenUsage/updated": {
        const u = p.tokenUsage ?? p.token_usage;
        const used = u?.last?.totalTokens ?? u?.total?.totalTokens;
        if (!this.replay && typeof used === "number") this.io.update({ sessionUpdate: "usage_update", used, size: u.modelContextWindow ?? 0 });
        return null;
      }
      case "error": if (p.willRetry === false || p.will_retry === false) this.lastError = p.error?.message ?? "error"; return null;
      case "turn/completed": {
        this.closeSetup();
        const s = p.turn?.status;
        return { status: s === "interrupted" ? "cancelled" : s === "failed" ? "failed" : "completed", error: p.turn?.error?.message ?? this.lastError };
      }
      default: return null;
    }
  }

  catchUp(events) {
    for (const e of events) {
      if (e.method === "thread/started") this.remoteCwd = e.params?.thread?.cwd ?? this.remoteCwd;
      if (e.method === "item/completed") this.itemCompleted(e.params?.item);
      if (this.replay && e.method === "turn/plan/updated") this.handle(e.method, e.params ?? {});
    }
  }

  toolFor(item) {
    switch (item.type) {
      case "commandExecution": {
        const cmd = displayCommand(item.command);
        return { title: cmd.replace(/\s+/g, " ").trim().slice(0, 200), kind: "execute", rawInput: { command: cmd },
          rawOutput: item.aggregatedOutput == null && item.exitCode == null ? undefined : { output: tail(item.aggregatedOutput ?? ""), exitCode: item.exitCode ?? undefined },
          failed: item.status === "failed" || item.status === "declined" };
      }
      case "fileChange": {
        const patch = codexChangesToPatch(item.changes);
        const paths = (item.changes ?? []).map((c) => c.path);
        return { title: `Edit ${paths.map((p) => p.split("/").pop()).join(", ")}`, kind: "edit",
          locations: paths.map((p) => ({ path: this.local(p) })), rawInput: { files: paths }, rawOutput: patch || undefined,
          failed: item.status === "failed" || item.status === "declined" };
      }
      case "mcpToolCall":
        return { title: `${item.server}.${item.tool}`, kind: "other", rawInput: item.arguments ?? {},
          rawOutput: item.error ? { error: item.error.message ?? item.error } : item.result ?? undefined, failed: item.status === "failed" };
      case "dynamicToolCall":
        return { title: item.tool, kind: "other", rawInput: item.arguments ?? {}, rawOutput: item.contentItems ?? undefined, failed: item.success === false };
      case "webSearch":
        return { title: `Web search: ${item.query ?? item.action?.query ?? ""}`.trim(), kind: "fetch", rawInput: { query: item.query ?? item.action?.query } };
      case "imageView":
        return { title: `View ${item.path}`, kind: "read", locations: [{ path: this.local(item.path) }], rawInput: { path: this.local(item.path) } };
      default: return null;
    }
  }

  itemStarted(item) {
    if (!item?.id || this.replay) return;
    this.closeSetup();
    const tool = this.toolFor(item);
    if (!tool) return;
    this.startedTools.add(item.id);
    const { failed: _f, rawOutput: _o, ...rest } = tool;
    this.io.update({ sessionUpdate: "tool_call", toolCallId: item.id, status: "in_progress", ...rest });
  }

  itemCompleted(item) {
    if (!item?.id || this.doneItems.has(item.id)) return;
    this.doneItems.add(item.id);
    this.closeSetup();
    if (item.type === "agentMessage") { if (!this.deltaItems.has(item.id)) this.text(item.text); return; }
    if (item.type === "reasoning") { if (!this.deltaItems.has(item.id)) this.thought((item.summary ?? []).join("\n\n")); return; }
    if (item.type === "userMessage") {
      if (this.replay) return; // user prompts come from the user turn's input_items
      return;
    }
    const tool = this.toolFor(item);
    if (!tool) return;
    const { failed, ...rest } = tool;
    const status = failed ? "failed" : "completed";
    if (this.startedTools.has(item.id)) this.io.update({ sessionUpdate: "tool_call_update", toolCallId: item.id, status, ...rest });
    else this.io.update({ sessionUpdate: "tool_call", toolCallId: item.id, status, ...rest });
  }
}
