// The ACP agent: sessions, prompts, fast cancel and steering, megha's own slash commands.
// Backends (lib/codex.mjs, lib/claude.mjs) do the cloud work; this file owns the turn lifecycle.

import crypto from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { log, sleep, UserError, loadSessionRecord, findSessionByCloudId, saveSessionRecord, hintKey, saveHint, loadHint } from "./util.mjs";
import { cleanPrompt } from "./prompt.mjs";
import { t3McpFrom } from "./t3mcp.mjs";

// T3 sends session/cancel and waits only 10 s for session/prompt to return before it marks the turn
// failed (provider-acp adapter.ts interrupt path). Return `cancelled` well inside that; the cloud
// cancel and the end of the cloud turn finish in the background.
export const CANCEL_GRACE_MS = 1500;
// A prompt that follows a cancel waits this long for the cancelled cloud turn to settle first.
export const DRAIN_WAIT_MS = 60_000;

// Fields of a session record that tie it to a cloud task (copied when a new session takes over a task).
const CLOUD_FIELDS = ["cloudId", "turnId", "doneTurnId", "lastSeq", "title", "webUrl", "bundle", "outcomeBranch", "baseBranch", "baseSha", "appliedPatchFile", "sentMode", "sentModel", "prUrl"];

export class MeghaAgent {
  constructor(conn, backend, { version = "0.0.0", env = process.env } = {}) {
    this.conn = conn;
    this.backend = backend;
    this.version = version;
    this.env = env;
    this.sessions = new Map(); // sessionId -> session
  }

  rpcError(e) {
    if (e instanceof acp.RequestError) return e;
    const msg = e instanceof UserError ? e.message : `${this.backend.label}: ${e.message}`;
    return new acp.RequestError(-32603, msg);
  }

  async initialize() {
    return {
      protocolVersion: 1,
      agentInfo: { name: `megha-${this.backend.name}`, title: this.backend.title, version: this.version },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { list: {}, resume: {} },
      },
      authMethods: [],
    };
  }

  async authenticate() { return {}; }

  #attachT3(s, mcpServers) {
    s.t3 = t3McpFrom(mcpServers, this.env);
    s.t3Key = s.t3 ? hintKey(s.cwd, s.t3.authorization) : null;
  }

  // Lazy: T3 calls this on every status probe. Only a local record and option lists; no cloud task.
  async newSession(params) {
    try {
      this.backend.checkAuth();
      const session = { id: `mg_${crypto.randomUUID()}`, backend: this.backend.name, cwd: params.cwd, config: {}, createdAt: new Date().toISOString() };
      this.#attachT3(session, params.mcpServers);
      await this.backend.prepare(session);
      this.sessions.set(session.id, session);
      this.#advertiseCommands(session);
      return { sessionId: session.id, configOptions: this.backend.configOptions(session) };
    } catch (e) { throw this.rpcError(e); }
  }

  // Resolve a session id that may be ours (persisted) or a cloud id picked from session/list.
  async #bind(sessionId, cwd, mcpServers) {
    let s = this.sessions.get(sessionId);
    if (s) return s;
    const rec = loadSessionRecord(sessionId) ?? findSessionByCloudId(this.backend.name, sessionId);
    s = rec ? { ...rec, id: sessionId, cwd: cwd || rec.cwd, config: { ...(rec.config ?? {}) } }
      : { id: sessionId, backend: this.backend.name, cwd, cloudId: sessionId, config: {}, createdAt: new Date().toISOString() };
    this.#attachT3(s, mcpServers);
    await this.backend.prepare(s);
    this.sessions.set(sessionId, s);
    return s;
  }

  async loadSession(params) {
    try {
      this.backend.checkAuth();
      const s = await this.#bind(params.sessionId, params.cwd, params.mcpServers);
      if (s.cloudId) await this.backend.replay(s, { update: (u) => this.#send(s.id, u) });
      saveSessionRecord(s);
      this.#advertiseCommands(s);
      return { configOptions: this.backend.configOptions(s) };
    } catch (e) { throw this.rpcError(e); }
  }

  async resumeSession(params) {
    try {
      this.backend.checkAuth();
      const s = await this.#bind(params.sessionId, params.cwd, params.mcpServers);
      this.#advertiseCommands(s);
      return { configOptions: this.backend.configOptions(s) };
    } catch (e) { throw this.rpcError(e); }
  }

  async listSessions(params) {
    try {
      this.backend.checkAuth();
      return await this.backend.list(params.cwd ?? process.cwd(), params.cursor ?? undefined);
    } catch (e) { throw this.rpcError(e); }
  }

  async setSessionConfigOption(params) {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw acp.RequestError.invalidParams(undefined, `Unknown session ${params.sessionId}`);
    try { this.backend.setConfig(s, params.configId, String(params.value)); } catch (e) { throw this.rpcError(e); }
    if (s.cloudId) saveSessionRecord(s);
    return { configOptions: this.backend.configOptions(s) };
  }

  async setSessionMode(params) {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw acp.RequestError.invalidParams(undefined, `Unknown session ${params.sessionId}`);
    try { this.backend.setConfig(s, "mode", params.modeId); } catch (e) { throw this.rpcError(e); }
    return {};
  }

  async prompt(params) {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw acp.RequestError.invalidParams(undefined, `Unknown session ${params.sessionId}`);
    if (s.active) throw new acp.RequestError(-32603, "A turn is already running in this session.");
    const input = cleanPrompt(params.prompt);
    if (!input.text.trim() && !input.images.length) throw acp.RequestError.invalidParams(undefined, "Empty prompt");

    const ac = new AbortController();
    const turn = { muted: false };
    s.active = ac;
    const send = (u) => { if (!turn.muted) this.#send(s.id, u); };
    const io = {
      signal: ac.signal,
      update: send,
      text: (t) => send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } }),
      requestPermission: (p) => (turn.muted ? Promise.resolve({ outcome: { outcome: "cancelled" } }) : this.conn.requestPermission(p)),
    };
    const t0 = Date.now();
    const run = (async () => {
      // A steer is session/cancel followed by a new prompt: let the cancelled cloud turn settle so the
      // follow-up lands on a finished turn instead of racing it.
      if (s.draining) {
        const drained = await Promise.race([s.draining.then(() => true), sleep(DRAIN_WAIT_MS, ac.signal).then(() => false)]);
        if (!drained && !ac.signal.aborted) log("previous turn still settling; sending anyway");
      }
      if (ac.signal.aborted) return "cancelled";
      if (input.command) { await this.backend.command(s, input.command, io); return "end_turn"; }
      if (!s.cloudId) this.#adoptFromHint(s, input, io);
      return this.backend.prompt(s, input, io);
    })();
    const settled = run.then((r) => ({ r }), (e) => ({ e }));
    const aborted = new Promise((resolve) => ac.signal.addEventListener("abort", resolve, { once: true }));
    const first = await Promise.race([settled, aborted.then(() => sleep(CANCEL_GRACE_MS)).then(() => null)]);

    if (first === null) {
      // Cancelled and the backend is still winding the cloud turn down: answer T3 now, finish quietly.
      turn.muted = true;
      const draining = settled.then((x) => { if (x.e) log(`cancelled turn ended with: ${x.e.message}`); this.#rememberThread(s); });
      s.draining = draining;
      draining.finally(() => { if (s.draining === draining) s.draining = null; });
      s.active = null;
      log(`prompt cancelled; answered in ${((Date.now() - t0) / 1000).toFixed(1)} s, cloud turn settles in the background`);
      return { stopReason: "cancelled" };
    }
    s.active = null;
    this.#rememberThread(s);
    if (first.e) {
      if (ac.signal.aborted) return { stopReason: "cancelled" };
      log(`prompt failed: ${first.e.message}`);
      throw this.rpcError(first.e);
    }
    const stopReason = ac.signal.aborted ? "cancelled" : first.r;
    log(`prompt done: ${stopReason} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return { stopReason };
  }

  async cancel(params) {
    const s = this.sessions.get(params.sessionId);
    s?.active?.abort();
  }

  // Rollback (and other session replacements) give megha a brand-new session for an existing thread,
  // and the next prompt carries T3's context handoff. If this thread was using a cloud task, keep
  // using it; otherwise the handoff travels as context to a new task. Either way, say which.
  #adoptFromHint(s, input, io) {
    if (!input.handoff) return;
    const hint = s.t3Key ? loadHint(s.t3Key) : null;
    const rec = hint && hint.backend === this.backend.name && hint.sessionId !== s.id ? loadSessionRecord(hint.sessionId) : null;
    if (rec?.cloudId) {
      for (const k of CLOUD_FIELDS) if (rec[k] !== undefined) s[k] = rec[k];
      input.text = `T3 Code started a new session for this conversation (for example after a rollback). The history below is the current state; where it differs from what you remember, follow it.\n\n${input.text}`;
      io.text(`Continuing the same cloud task${rec.webUrl ? ` ([open](${rec.webUrl}))` : ""}; T3 started a new session for this thread, so the earlier conversation is sent along as the current state.\n\n`);
      log(`adopted cloud task ${rec.cloudId} from session ${hint.sessionId}`);
    } else {
      io.text("Starting a new cloud task. The earlier conversation from this thread is sent along as context.\n\n");
    }
  }

  #rememberThread(s) {
    if (!s.t3Key || !s.cloudId) return;
    try { saveSessionRecord(s); saveHint(s.t3Key, { backend: this.backend.name, sessionId: s.id, cloudId: s.cloudId }); } catch (e) { log(`hint save failed: ${e.message}`); }
  }

  // After the response to session/new|load|resume is on the wire (T3 waits briefly for this).
  #advertiseCommands(s) {
    setTimeout(() => this.#send(s.id, { sessionUpdate: "available_commands_update", availableCommands: this.backend.commands }), 0);
  }

  #send(sessionId, update) {
    this.conn.sessionUpdate({ sessionId, update }).catch((e) => log(`sessionUpdate failed: ${e.message}`));
  }
}
