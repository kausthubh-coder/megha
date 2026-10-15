// Codex Cloud backend (chatgpt.com/backend-api/wham). Endpoint and body shapes: docs/research-codex.md.
// Auth: ~/.codex/auth.json, read fresh per request and never refreshed here (refresh tokens rotate).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import {
  log, sleep, sseFrames, tail, repoInfo, UserError, isoFromEpochSeconds, saveSessionRecord, cleanTerminal,
  cachedList, readCache, writeCache, localChanges, localPatch, setupCommandsFor, findPullRequestUrl,
} from "./util.mjs";
import { codexChangesToPatch, diffToolCall, applyLocally, diffFiles } from "./diff.mjs";
import { imageSize, imageExtension } from "./image.mjs";
import { linkPullRequest } from "./t3mcp.mjs";
import { VERSION } from "./version.mjs";

const BASE = (process.env.CODEX_CLOUD_TASKS_BASE_URL || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
const WEB = BASE.replace(/\/backend-api$/, "");
const USER_AGENT = `megha/${VERSION} (ACP agent for Codex Cloud)`;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const POLL_MS = 5000;
const CLIENT_VERSION = "0.162.1"; // the Codex CLI version the model list is requested for
// The ChatGPT GitHub connector id the desktop app hardcodes for GitHub environments (research-codex.md §9).
const GITHUB_CONNECTOR_ID = "connector_76869538009648d5b282a4bb21c3d157";
export const DEFAULT_MODEL = "gpt-5.6-sol";
// Used when the live list can't be fetched (slugs from GET /wham/models, 2026-10-14).
export const FALLBACK_MODELS = [
  { id: "gpt-6.1-sol", name: "GPT-6.1-Sol" }, { id: "gpt-6-astra", name: "GPT-6-Astra" }, { id: "gpt-6-sol", name: "GPT-6-Sol" },
  { id: "gpt-6-luna", name: "GPT-6-Luna" }, { id: "gpt-5.6-sol", name: "GPT-5.6-Sol" }, { id: "gpt-5.6-terra", name: "GPT-5.6-Terra" },
  { id: "gpt-5.6-luna", name: "GPT-5.6-Luna" },
];
const MODES = ["code", "ask", "plan"];
const PLAN_PREFIX = "Plan mode: investigate with read-only actions and reply with a concrete implementation plan. Do not implement it.\n\n";

const AUTH_HELP = "Run `codex login status` (or any `codex` command) so the Codex CLI refreshes its login, then retry. megha never refreshes tokens itself.";

export function readAuth() {
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
  return { token: t.access_token, accountId: t.account_id ?? claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? null, expiresAt: claims?.exp ? claims.exp * 1000 : null };
}

function authHeaders(accept = "application/json") {
  const auth = readAuth();
  const headers = { Authorization: `Bearer ${auth.token}`, "User-Agent": USER_AGENT, Accept: accept };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
  return headers;
}

async function api(method, path, body, { signal } = {}) {
  const headers = authHeaders();
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
  const res = await fetch(BASE + path, { headers: authHeaders("text/event-stream"), signal, redirect: "error" });
  if (!res.ok) throw new Error(`Codex Cloud stream failed: HTTP ${res.status}`);
  return res;
}

const enc = encodeURIComponent;
const taskUrl = (id) => `${WEB}/codex/tasks/${id}`;
const message = (text) => ({ type: "message", role: "user", content: [{ content_type: "text", text }] });

// Environments: keep only the fields we show. The API also returns env_vars/secrets; never keep those.
const slimEnv = (e) => ({ id: e.id, label: e.label ?? e.id, pinned: !!e.is_pinned, taskCount: e.task_count ?? 0,
  repos: Object.values(e.repo_map ?? {}).map((r) => r.repository_full_name).filter(Boolean) });

// Only environments that belong to this repo: a task in another repo's environment edits the wrong code.
export function pickDefaultEnv(envs, repoName) {
  if (!envs.length) return null;
  return envs.find((e) => repoName && e.label.toLowerCase() === repoName.toLowerCase())
    ?? (envs.length === 1 ? envs[0] : null)
    ?? envs.find((e) => e.pinned)
    ?? [...envs].sort((a, b) => b.taskCount - a.taskCount)[0];
}

// GET /wham/models -> listable models in the server's priority order.
export function modelsFromResponse(j) {
  return (j?.models ?? [])
    .filter((m) => m?.slug && m.visibility === "list")
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    .map((m) => ({ id: m.slug, name: m.display_name || m.slug, ...(m.description ? { description: m.description } : {}) }));
}

// The body the Codex desktop app sends to create a GitHub environment (research-codex.md §9). No env
// vars or secrets: users add those on chatgpt.com if they need them.
export function environmentBody({ repoId, fullName, label, setup }) {
  return {
    label, description: `Created by megha for ${fullName}`,
    machine_id: "wham-public/wham-universal", repos: [repoId],
    github_connector_id: GITHUB_CONNECTOR_ID, workspace_dir: "/workspace",
    agent_network_access: { mode: "on", preset_allowlist: "all", allowlist_domains: "" },
    setup, maintenance_setup: [], env_vars: {}, secrets_with_domains: [],
    share_settings: "workspace", share_targets: [], auto_setup_settings: { use_auto_setup: false },
    cache_settings: { post_setup_cache_enabled: true, cache_invalidation_key: "" }, enable_authtranslator: false,
  };
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
  title = "Megha · Codex Cloud";
  commands = [
    { name: "pr", description: "Open a GitHub pull request from the latest cloud diff (add \"draft\" for a draft PR)", input: { hint: "draft" } },
    { name: "apply", description: "Apply the latest cloud diff to this checkout" },
    { name: "open", description: "Link to this task on chatgpt.com" },
    { name: "status", description: "Show the cloud task's status" },
  ];

  checkAuth() { readAuth(); }
  webUrl(id) { return taskUrl(id); }

  async #models() {
    return cachedList("models-codex", 10 * 60_000, async () =>
      modelsFromResponse(await api("GET", `/wham/models?client_version=${CLIENT_VERSION}`, undefined, { signal: AbortSignal.timeout(5000) })), FALLBACK_MODELS);
  }

  // Environments for this repo (by-repo lookup only). Slim records are safe to cache on disk.
  async #environments(repo) {
    if (!repo?.github) return [];
    const key = `envs-codex-${repo.github.owner}-${repo.github.name}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_");
    const hit = readCache(key, 2 * 60_000);
    if (hit?.fresh && Array.isArray(hit.value)) return hit.value;
    const envs = (await api("GET", `/wham/environments/by-repo/github/${enc(repo.github.owner)}/${enc(repo.github.name)}`)).map(slimEnv)
      .sort((a, b) => (b.pinned - a.pinned) || a.label.localeCompare(b.label));
    writeCache(key, envs);
    return envs;
  }

  // Is the repo visible to the ChatGPT GitHub connector (so an environment can be created for it)?
  async #connectorRepo(repo) {
    const full = `${repo.github.owner}/${repo.github.name}`;
    const q = new URLSearchParams({ query: repo.github.name, limit: "20", page: "1", connector_id: GITHUB_CONNECTOR_ID });
    const r = await api("GET", `/wham/github/repositories/search/all-installations?${q}`);
    const hit = (r.repositories ?? []).find((x) => x.repository_full_name?.toLowerCase() === full.toLowerCase());
    return hit?.id ? { repoId: hit.id, fullName: hit.repository_full_name } : null;
  }

  // session/new: no cloud task, just local defaults + option lists.
  async prepare(session) {
    // T3 waits on this for every probe and new thread: run the model list, git and env lookups side by side.
    const settle = (p) => p.then((v) => ({ v }), (e) => ({ e }));
    const modelsP = settle(this.#models());
    session.repo = await repoInfo(session.cwd);
    const repo = session.repo;
    const localP = settle(session.config?.localChanges ? Promise.resolve(null) : localChanges(session.cwd, repo));
    let envs = [];
    session.envProblem = !repo.isRepo ? "no-git" : !repo.github ? "no-github" : null;
    session.creatable = null;
    if (repo.github) {
      try { envs = await this.#environments(repo); } catch (e) { if (e instanceof UserError) throw e; log(`environment lookup failed: ${e.message}`); session.envProblem = "lookup-failed"; }
      if (!envs.length && !session.envProblem) {
        try { session.creatable = await this.#connectorRepo(repo); session.envProblem = session.creatable ? null : "not-visible"; }
        catch (e) { if (e instanceof UserError) throw e; log(`connector lookup failed: ${e.message}`); session.envProblem = "lookup-failed"; }
      }
    }
    session.envs = envs;
    const models = await modelsP;
    if (models.e) throw models.e;
    session.models = models.v;
    const cfg = session.config ?? (session.config = {});
    const createValue = session.creatable ? `create:${session.creatable.fullName}` : null;
    if (!cfg.environment || !(envs.some((e) => e.id === cfg.environment) || cfg.environment === createValue)) {
      cfg.environment = pickDefaultEnv(envs, repo.github?.name)?.id ?? createValue ?? "none";
    }
    cfg.model ??= session.models.some((m) => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : session.models[0]?.id ?? DEFAULT_MODEL;
    cfg.mode ??= "code";
    cfg.apply ??= "off";
    const local = await localP;
    if (!cfg.localChanges) cfg.localChanges = local.v?.any ? "on" : "off";
  }

  configOptions(session) {
    const cfg = session.config;
    const envOptions = (session.envs ?? []).map((e) => ({ value: e.id, name: e.label, description: e.repos.join(", ") || "no repos" }));
    if (session.creatable) {
      const setup = setupCommandsFor(session.repo?.root);
      envOptions.push({ value: `create:${session.creatable.fullName}`, name: `Create environment for ${session.creatable.fullName}`,
        description: `Created on first prompt. Setup: ${setup.join(" && ") || "none"}` });
    }
    if (!envOptions.some((o) => o.value === cfg.environment)) {
      envOptions.unshift({ value: cfg.environment, name: cfg.environment === "none" ? this.#noEnvLabel(session) : cfg.environment });
    }
    const models = (session.models ?? FALLBACK_MODELS).map((m) => ({ value: m.id, name: m.name, ...(m.description ? { description: m.description } : {}) }));
    if (!models.some((m) => m.value === cfg.model)) models.unshift({ value: cfg.model, name: cfg.model });
    return [
      // Sent as metadata.model_slug exactly like the Codex app, but on 2026-10-14 every cloud turn still
      // reported model_version gpt-5.6-sol (tried gpt-5.6-luna and gpt-6.1-sol).
      { id: "model", name: "Model", category: "model", description: "Requested from Codex Cloud; it may still run its default model.", type: "select", currentValue: cfg.model, options: models },
      { id: "environment", name: "Environment", description: "Codex Cloud environment for this repo.", type: "select", currentValue: cfg.environment, options: envOptions },
      { id: "mode", name: "Mode", category: "mode", description: "Code makes changes; Ask and Plan only answer.", type: "select", currentValue: cfg.mode,
        options: [{ value: "code", name: "Code" }, { value: "ask", name: "Ask" }, { value: "plan", name: "Plan", description: "Ask mode, asked for a plan" }] },
      { id: "apply", name: "Apply diff locally", description: "Apply the cloud diff to this checkout at the end of each turn (git apply, never forced).", type: "select", currentValue: cfg.apply,
        options: [{ value: "off", name: "Off" }, { value: "on", name: "On" }] },
      { id: "localChanges", name: "Send local changes", description: "Send commits not on origin and uncommitted tracked changes as the task's starting patch.", type: "select", currentValue: cfg.localChanges,
        options: [{ value: "off", name: "Off" }, { value: "on", name: "On" }] },
    ];
  }

  setConfig(session, id, value) {
    const allowed = { environment: null, model: null, mode: MODES, apply: ["off", "on"], localChanges: ["off", "on"] };
    if (!(id in allowed)) throw new UserError(`Unknown config option ${id}`);
    if (allowed[id] && !allowed[id].includes(value)) throw new UserError(`Invalid value ${value} for ${id}`);
    if (id === "model" && !/^[\w.:-]+$/.test(value)) throw new UserError(`Invalid model ${value}`);
    session.config[id] = value;
  }

  #noEnvLabel(session) {
    switch (session.envProblem) {
      case "no-git": return "No environment: not a git repo";
      case "no-github": return "No environment: no GitHub remote";
      case "not-visible": return "No environment: repo not visible to Codex";
      default: return "No environment for this repo";
    }
  }

  #noEnvMessage(session) {
    const repo = session.repo ?? {};
    const full = repo.github ? `${repo.github.owner}/${repo.github.name}` : null;
    const claude = "Megha · Claude Cloud can run it without that: it uploads a git bundle of your local repo.";
    switch (session.envProblem) {
      case "no-git": return `Codex Cloud runs on a GitHub repo, and ${session.cwd} is not a git repository. Run \`git init\`, commit, then \`gh repo create --source . --push\`, and retry. ${claude}`;
      case "no-github": return `This repo has no GitHub remote (origin), and Codex Cloud clones from GitHub. Run \`gh repo create --source . --push\` (or add a GitHub origin and push), then retry. ${claude}`;
      case "not-visible": return `The ChatGPT Codex connector can't see ${full}. Give it access to the repo (connect GitHub at https://chatgpt.com/codex/settings/environments, or GitHub Settings > Applications > ChatGPT Codex Connector > Configure), then retry. ${claude}`;
      default: return `No Codex Cloud environment for ${full ?? "this repo"}. Create one at https://chatgpt.com/codex/settings/environments, then pick it in the Environment option.`;
    }
  }

  async #ensureEnvironment(session, io) {
    const cfg = session.config;
    if (cfg.environment && cfg.environment !== "none" && !cfg.environment.startsWith("create:")) return cfg.environment;
    if (!cfg.environment?.startsWith("create:") || !session.creatable) throw new UserError(this.#noEnvMessage(session));
    const repo = session.repo;
    const setup = setupCommandsFor(repo.root);
    const created = await api("POST", "/wham/environments", environmentBody({ ...session.creatable, label: repo.github.name, setup }));
    if (!created?.id) throw new Error("Codex Cloud created an environment but returned no id");
    const env = slimEnv(created);
    if (!env.repos.length) env.repos = [session.creatable.fullName];
    session.envs = [env];
    session.creatable = null;
    session.envProblem = null;
    cfg.environment = env.id;
    writeCache(`envs-codex-${repo.github.owner}-${repo.github.name}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_"), [env]);
    log(`created environment ${env.id}`);
    io.update({ sessionUpdate: "config_option_update", configOptions: this.configOptions(session) });
    io.text(`Created the Codex Cloud environment "${env.label}" for ${env.repos[0]} (setup: ${setup.join(" && ") || "none"}). Change it at https://chatgpt.com/codex/settings/environments.\n\n`);
    return env.id;
  }

  // ChatGPT file upload, as the desktop app does for composer images: create entry -> PUT the bytes
  // to the returned blob URL -> mark uploaded. The upload URL embeds a signed credential: never log it.
  async #uploadImage(img, index) {
    const bytes = Buffer.from(img.data, "base64");
    const size = imageSize(bytes) ?? { width: 1, height: 1 };
    const entry = await api("POST", "/files", { file_name: `image-${index + 1}.${imageExtension(img.mimeType)}`, file_size: bytes.length, use_case: "codex",
      timezone_offset_min: new Date().getTimezoneOffset(), reset_rate_limits: false });
    if (!entry?.file_id || !entry.upload_url) throw new Error("Codex Cloud returned no upload slot for an image");
    const url = new URL(entry.upload_url, WEB);
    let res;
    if (url.pathname.endsWith("/estuary/upload_content_bytes")) {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: img.mimeType }), `image-${index + 1}.${imageExtension(img.mimeType)}`);
      const h = authHeaders(); res = await fetch(url, { method: "POST", headers: h, body: form, redirect: "error" });
    } else {
      const target = url.href.toLowerCase().includes("estuary") ? url.searchParams.get("upload_url") : url.href;
      if (!target) throw new Error("Codex Cloud image upload URL is missing its blob target");
      res = await fetch(target, { method: "PUT", body: bytes, redirect: "error",
        headers: { "Content-Type": img.mimeType, "x-ms-blob-type": "BlockBlob", "x-ms-version": "2020-04-08", "x-ms-blob-content-type": img.mimeType } });
    }
    if (!res.ok) throw new Error(`Codex Cloud image upload failed: HTTP ${res.status}`);
    await res.text().catch(() => {});
    try { await api("POST", `/files/${enc(entry.file_id)}/uploaded`, {}); } catch (e) { log(`image finalize failed: ${e.message}`); }
    const id = entry.file_id;
    return { type: "image_asset_pointer", asset_pointer: id.startsWith("file_") ? `sediment://${id}` : `file-service://${id}`, width: size.width, height: size.height, size_bytes: bytes.length };
  }

  async #imageItems(images, io) {
    const items = [];
    for (const [i, img] of images.entries()) items.push(await this.#uploadImage(img, i));
    if (items.length) io.text(`Sent ${items.length} image${items.length === 1 ? "" : "s"} with the prompt.\n\n`);
    return items;
  }

  // ---------- prompt ----------
  async prompt(session, input, io) {
    const cfg = session.config;
    if (input.isContinue && session.cloudId) {
      const r = await this.#continueTurn(session, io);
      if (r) return r;
    }
    const text = cfg.mode === "plan" ? PLAN_PREFIX + input.text : input.text;
    const metadata = cfg.model ? { metadata: { model_slug: cfg.model } } : {};
    let turnId;
    if (!session.cloudId) {
      const environmentId = await this.#ensureEnvironment(session, io);
      const repo = session.repo ?? (session.repo = await repoInfo(session.cwd));
      let branch = repo.branch;
      const sendLocal = cfg.localChanges === "on" && repo.isRepo;
      if (!branch || !repo.branchSha) {
        branch = repo.defaultBranch;
        io.text(`Note: ${repo.branch ? `branch \`${repo.branch}\` is not on origin` : "no current branch"}, so the cloud task starts from \`${branch}\`${sendLocal ? " with your local changes applied" : ". Push your branch, or turn on \"Send local changes\""}.\n\n`);
      }
      const input_items = [message(text), ...(await this.#imageItems(input.images, io))];
      if (sendLocal) {
        const info = await localChanges(session.cwd, repo);
        const patch = await localPatch(session.cwd, info);
        if (patch.trim()) {
          input_items.push({ type: "pre_apply_patch", output_diff: { diff: patch } });
          io.text(`Sending your local changes as the starting patch (${diffFiles(patch).length} files; ${info.unpushed} commit${info.unpushed === 1 ? "" : "s"} not on origin, ${info.dirty.length} uncommitted; untracked files are not included).\n\n`);
        }
      }
      const res = await api("POST", "/wham/tasks", { new_task: { environment_id: environmentId, branch, run_environment_in_qa_mode: cfg.mode !== "code" }, ...metadata, input_items });
      session.cloudId = res?.task?.id ?? res?.id;
      if (!session.cloudId) throw new Error("Codex Cloud created a task but returned no id");
      session.webUrl = taskUrl(session.cloudId);
      session.title = res?.task?.title ?? session.title;
      saveSessionRecord(session);
      log(`created task ${session.cloudId} (model ${cfg.model})`);
      turnId = typeof res?.turn?.id === "string" && res.turn.id.includes("assttrn") ? res.turn.id : await this.#waitForNewTurn(session.cloudId, null, io.signal);
    } else {
      const before = await api("GET", `/wham/tasks/${enc(session.cloudId)}`);
      const prev = before.task?.current_turn_id ?? session.turnId;
      const res = await api("POST", "/wham/tasks", {
        follow_up: { task_id: session.cloudId, turn_id: prev, environment_mode: cfg.mode === "code" ? "code" : "ask" },
        ...metadata, input_items: [message(text), ...(await this.#imageItems(input.images, io))],
      });
      turnId = typeof res?.turn?.id === "string" && res.turn.id.includes("assttrn") && res.turn.id !== prev ? res.turn.id : await this.#waitForNewTurn(session.cloudId, prev, io.signal);
    }
    if (!turnId) {
      // Cancelled before the cloud reported the new turn: cancel the task's running turn and stop.
      try { await api("POST", `/wham/tasks/${enc(session.cloudId)}/cancel`); log("cancel requested"); } catch (e) { log(`cancel failed: ${e.message}`); }
      return "cancelled";
    }
    session.turnId = turnId;
    saveSessionRecord(session);
    const result = await this.#streamTurn(session, turnId, io);
    return this.#afterTurn(session, result, io);
  }

  // T3's automatic "Continue where you left off." after a restart: if the cloud turn is still running,
  // follow it; if it finished while nobody watched, show its result. Otherwise it is a normal prompt.
  async #continueTurn(session, io) {
    const d = await api("GET", `/wham/tasks/${enc(session.cloudId)}`);
    const turn = d.current_assistant_turn;
    if (!turn?.id) return null;
    session.title = d.task?.title ?? session.title;
    session.webUrl ??= taskUrl(session.cloudId);
    if (!TERMINAL.has(turn.turn_status)) {
      log(`reattaching to running turn ${turn.id}`);
      session.turnId = turn.id;
      return this.#afterTurn(session, await this.#streamTurn(session, turn.id, io), io);
    }
    if (turn.id === session.doneTurnId) return null;
    log(`showing turn ${turn.id} that finished while detached`);
    session.turnId = turn.id;
    io.text("The cloud turn finished while T3 Code was away. Its result:\n\n");
    const st = new TurnState(session, io, turn.id, { replay: true });
    st.catchUp(turn.thread_events?.events ?? []);
    if (!st.sawText) for (const m of turnMessages(turn)) st.text(m);
    return this.#afterTurn(session, { status: turn.turn_status, error: turn.error?.message }, io);
  }

  async #afterTurn(session, result, io) {
    if (session.title) io.update({ sessionUpdate: "session_info_update", title: session.title, updatedAt: new Date().toISOString() });
    if (result.status === "completed") await this.#finishDiff(session, io);
    if (TERMINAL.has(result.status)) session.doneTurnId = session.turnId;
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
    if (signal?.aborted) return null;
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
        // A cancel wakes the poller, which then polls faster so the background wind-down ends soon.
        await sleep(io.signal.aborted ? 2000 : POLL_MS, io.signal.aborted ? ac.signal : AbortSignal.any([ac.signal, io.signal]));
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
    return { status, error: finished?.error };
  }

  async #latestDiff(session) {
    const d = await api("GET", `/wham/tasks/${enc(session.cloudId)}`);
    session.title = d.task?.title ?? session.title;
    // The PR endpoint wants the turn that holds the diff.
    const diffTurn = turnDiff(d.current_diff_task_turn) ? d.current_diff_task_turn : turnDiff(d.current_assistant_turn) ? d.current_assistant_turn : null;
    return { diff: turnDiff(diffTurn), turnId: diffTurn?.id ?? session.turnId,
      stats: d.task?.task_status_display?.latest_turn_status_display?.diff_stats, task: d.task };
  }

  async #finishDiff(session, io) {
    // The diff lands in output_items once the turn is done; it can lag turn/completed a little.
    let latest = null;
    for (let i = 0; i < 4; i++) {
      latest = await this.#latestDiff(session);
      if (latest.diff || !(latest.stats?.files_modified > 0)) break;
      await sleep(2000);
    }
    const diff = latest?.diff;
    if (!diff) return;
    io.update(diffToolCall({ toolCallId: `diff:${session.turnId}`, diff, cwd: session.cwd }));
    const n = diffFiles(diff).length;
    if (session.config.apply === "on") {
      const r = await applyLocally({ cwd: session.cwd, diff, name: `${session.cloudId}-${session.turnId.split("~").pop()}`, previousFile: session.appliedPatchFile });
      if (r.ok && !r.unchanged) session.appliedPatchFile = r.patchFile;
      io.text(`\n\n${r.message} Type /pr to open a pull request.`);
    } else {
      io.text(`\n\nThe cloud produced a diff (${n} file${n === 1 ? "" : "s"}). Type /apply to apply it here, or /pr to open a pull request.`);
    }
  }

  // ---------- megha's slash commands ----------
  async command(session, { name, args }, io) {
    if (name === "open") { io.text(session.webUrl ? `[Open in Codex Cloud](${session.webUrl})` : "No cloud task yet: send a prompt first."); return; }
    if (!session.cloudId) { io.text("No cloud task yet: send a prompt first."); return; }
    switch (name) {
      case "status": {
        const d = await api("GET", `/wham/tasks/${enc(session.cloudId)}`);
        const t = d.current_assistant_turn ?? {};
        const disp = d.task?.task_status_display ?? {};
        const st = disp.latest_turn_status_display?.diff_stats;
        io.text([`**${d.task?.title ?? "Cloud task"}**`, `Status: ${t.turn_status ?? disp.latest_turn_status_display?.turn_status ?? "unknown"}`,
          `Environment: ${disp.environment_label ?? session.config.environment}`, `Branch: ${disp.branch_name ?? t.branch ?? "?"}`,
          `Model: ${t.model_version ?? session.config.model}`, ...(st ? [`Diff: ${st.files_modified ?? 0} files (+${st.lines_added ?? 0} -${st.lines_removed ?? 0})`] : []),
          ...(session.prUrl ? [`Pull request: ${session.prUrl}`] : []), `[Open in Codex Cloud](${session.webUrl})`].join("\n"));
        return;
      }
      case "apply": {
        const { diff, turnId } = await this.#latestDiff(session);
        if (!diff) { io.text("The cloud task has no diff to apply yet."); return; }
        const r = await applyLocally({ cwd: session.cwd, diff, name: `${session.cloudId}-${String(turnId).split("~").pop()}`, previousFile: session.appliedPatchFile });
        if (r.ok && !r.unchanged) session.appliedPatchFile = r.patchFile;
        saveSessionRecord(session);
        io.text(r.message);
        return;
      }
      case "pr": {
        if (session.prUrl) {
          const linked = await linkPullRequest(session.t3, session.prUrl);
          io.text(`This task already has a pull request: ${session.prUrl}${linked ? `\n\n${linked}` : ""}`);
          return;
        }
        const { diff, turnId, task } = await this.#latestDiff(session);
        const existing = findPullRequestUrl(task?.external_pull_requests);
        if (existing) session.prUrl = existing;
        else {
          if (!diff) { io.text("The cloud task has no diff yet, so there is nothing to open a pull request from."); return; }
          const res = await api("POST", `/wham/tasks/${enc(session.cloudId)}/turns/${enc(turnId)}/pr`, args === "draft" ? { mode: "draft" } : {});
          session.prUrl = findPullRequestUrl(res);
          for (let i = 0; i < 5 && !session.prUrl; i++) {
            await sleep(2000);
            const d = await api("GET", `/wham/tasks/${enc(session.cloudId)}`);
            session.prUrl = findPullRequestUrl(d.task?.external_pull_requests) ?? findPullRequestUrl(d.task?.pull_requests);
          }
        }
        saveSessionRecord(session);
        if (!session.prUrl) { io.text(`Codex Cloud accepted the pull request request, but no PR link came back yet. Check the task: ${session.webUrl}`); return; }
        const linked = await linkPullRequest(session.t3, session.prUrl);
        io.text(`Opened ${session.prUrl}${linked ? `\n\n${linked}` : ""}`);
        return;
      }
      default: io.text(`Unknown command /${name}`);
    }
  }

  // ---------- list / load ----------
  async list(cwd, cursor) {
    const repo = await repoInfo(cwd);
    const labels = new Set((await this.#environments(repo)).map((e) => e.label));
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
      if (TERMINAL.has(turn.turn_status)) session.doneTurnId = node.id;
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
export class TurnState {
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
    if (item.type === "userMessage") return; // user prompts come from the user turn's input_items
    const tool = this.toolFor(item);
    if (!tool) return;
    const { failed, ...rest } = tool;
    const status = failed ? "failed" : "completed";
    if (this.startedTools.has(item.id)) this.io.update({ sessionUpdate: "tool_call_update", toolCallId: item.id, status, ...rest });
    else this.io.update({ sessionUpdate: "tool_call", toolCallId: item.id, status, ...rest });
  }
}
