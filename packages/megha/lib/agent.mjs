// The ACP agent: sessions, prompts, fast cancel and steering, megha's own slash commands.
// Backends (lib/codex.mjs, lib/claude.mjs) do the cloud work; this file owns the turn lifecycle.

import crypto from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { log, sleep, UserError, CloudError, RecoveryNeeded, describeError, provenanceOf, loadSessionRecord, findSessionByCloudId, saveSessionRecord, sessionRecordOf, samePath, hintKey, saveHint, loadHint, addNotice, deliverNotices } from "./util.mjs";
import { Turn } from "./turn.mjs";
import { cleanPrompt, t3AttachmentDirs } from "./prompt.mjs";
import { t3McpFrom } from "./t3mcp.mjs";

// T3 sends session/cancel and waits only 10 s for session/prompt to return before it marks the turn
// failed (provider-acp adapter.ts interrupt path). Return `cancelled` well inside that; the cloud
// cancel and the end of the cloud turn finish in the background, owned by the turn (lib/turn.mjs).
export const CANCEL_GRACE_MS = 1500;
// A prompt waits this long for the session's previous turn to settle (its cloud cancel answered, its
// stream and poller wound down, its git calls ended); if it still hasn't, the prompt is refused rather
// than raced against the old turn's session state. Longer than a backend's stop wait (30 s) and the
// request bound (30 s), so a turn that settles on its own is always waited for.
export const DRAIN_WAIT_MS = 60_000;

// Fields of a session record that tie it to a cloud task (copied when a new session takes over a task).
const CLOUD_FIELDS = ["cloudId", "cloudState", "createdIn", "turnId", "doneTurnId", "lastSeq", "title", "webUrl", "bundle", "outcomeBranch", "baseBranch", "baseSha", "appliedPatchFile", "sentMode", "sentModel", "prUrl"];

export class MeghaAgent {
  constructor(conn, backend, { version = "0.0.0", env = process.env, drainWaitMs = DRAIN_WAIT_MS } = {}) {
    this.conn = conn;
    this.backend = backend;
    this.version = version;
    this.env = env;
    this.drainWaitMs = drainWaitMs;
    this.sessions = new Map(); // sessionId -> session
  }

  // The ACP error T3 shows. Its text follows describeError, the same policy as every log line: megha's
  // fixed messages pass, anything else is named by kind (never by a server's text).
  rpcError(e) {
    if (e instanceof acp.RequestError) return e;
    const msg = e instanceof UserError || e instanceof CloudError ? e.message : `${this.backend.label}: ${describeError(e)}`;
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
  // A session already bound in this process is reused only for the same folder. For another folder
  // it is bound again from its saved fields, with every check a fresh bind gets (the local record,
  // then the cloud's repo), and the old binding stays as it was unless all of them pass: a cached
  // session must never carry repo A's task into repo B's folder.
  async #bind(sessionId, cwd, mcpServers) {
    const cached = this.sessions.get(sessionId);
    if (cached && (!cwd || samePath(cwd, cached.cwd))) return cached;
    if (cached && (cached.active || (cached.turn && !cached.turn.isSettled))) {
      throw new UserError("This session still has a turn running in its current folder, so it can't be opened in another folder now. Try again once it has finished.");
    }
    if (cached) log("session reopened in another folder; checking it again");
    const rec = cached ? sessionRecordOf(cached) : loadSessionRecord(sessionId) ?? findSessionByCloudId(this.backend.name, sessionId);
    // createdIn (where megha created the cloud task) comes only from the record, never from this
    // bind's cwd: rebinding a session must not become evidence that it belongs here.
    const s = rec ? { ...rec, id: sessionId, cwd: cwd || rec.cwd, createdIn: provenanceOf(rec), config: { ...(rec.config ?? {}) } }
      : { id: sessionId, backend: this.backend.name, cwd, cloudId: sessionId, createdIn: null, config: {}, createdAt: new Date().toISOString() };
    // What the local record alone can refuse (a bundle session made in another folder) is refused
    // here, before a failing network check could let the session bind unchecked.
    this.backend.checkRecord?.(s);
    this.#attachT3(s, mcpServers);
    await this.backend.prepare(s);
    // A cloud id can name any task or session of the account: confirm it belongs to this repo. A wrong
    // repo always fails. If the check itself can't run (network), the session binds unchecked: replay
    // and every follow-up and command check again before showing or sending anything.
    if (s.cloudId) {
      try { await this.backend.checkRepo(s); } catch (e) {
        if (e instanceof UserError) throw e;
        log(`repo check deferred: ${describeError(e)}`);
      }
    }
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
    const input = cleanPrompt(params.prompt, { attachmentDirs: t3AttachmentDirs(this.env) });
    if (!input.text.trim() && !input.images.length) throw acp.RequestError.invalidParams(undefined, "Empty prompt");

    const turn = new Turn();
    s.active = turn;
    // The previous turn may still own the session's cloud state: a steer (session/cancel, then a new
    // prompt) arrives while the cancelled turn winds down, and even a turn that already answered T3 can
    // have its cloud cancel in flight. Wait for it to settle; if it won't in time, refuse.
    const prev = s.turn;
    if (prev && !prev.isSettled) {
      const giveUp = new AbortController(); // ends the losing wait, so its timer doesn't linger
      const drained = await Promise.race([prev.settled.then(() => true), sleep(this.drainWaitMs, AbortSignal.any([turn.signal, giveUp.signal])).then(() => false)]);
      giveUp.abort();
      if (!drained) {
        s.active = null;
        if (turn.stopped) return { stopReason: "cancelled" };
        log("previous turn still settling; refusing the new prompt");
        throw new acp.RequestError(-32603, "The previous cloud turn is still stopping. Try again in a moment.");
      }
    }
    s.turn = turn;
    const send = (u) => { if (!turn.muted) this.#send(s.id, u); };
    const say = (t) => send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
    const io = {
      turn,
      signal: turn.signal,
      update: send,
      text: say,
      // Something about the user's checkout they must see (lib/util.mjs addNotice): saved first, then
      // shown now while this turn can still talk to T3; once it is muted, at the next prompt. It stays
      // saved until its notification is written.
      notice: (t) => {
        addNotice(s, t);
        if (!turn.muted) deliverNotices(s, (n) => this.#write(s.id, `\n\n${n}`));
      },
      requestPermission: (p) => (turn.muted || !turn.permissionsValid ? Promise.resolve({ outcome: { outcome: "cancelled" } }) : this.conn.requestPermission(p)),
    };
    const t0 = Date.now();
    const run = turn.run(async () => {
      if (turn.stopped) return "cancelled";
      // A replacement session for this thread takes over its cloud task, and the notices that came with it.
      const adopted = !input.command && !s.cloudId ? this.#adoptFromHint(s, input) : null;
      // Notices a stopped turn (or a megha that has since restarted, or the session this one replaced)
      // could not show: first thing now, before any cloud or checkout work.
      await deliverNotices(s, (n) => this.#write(s.id, `${n}\n\n`));
      if (adopted) io.text(adopted);
      if (input.command) { await this.backend.command(s, input.command, io); return "end_turn"; }
      return this.backend.prompt(s, input, io);
    });
    const outcome = run.then((r) => ({ r }), (e) => ({ e }));
    const aborted = new Promise((resolve) => (turn.stopped ? resolve() : turn.signal.addEventListener("abort", resolve, { once: true })));
    const graceOver = new AbortController(); // the run answered first: end the grace timer too
    const first = await Promise.race([outcome, aborted.then(() => sleep(CANCEL_GRACE_MS, graceOver.signal)).then(() => null)]);
    graceOver.abort();

    if (first === null) {
      // Cancelled and the backend is still winding the cloud turn down: answer T3 now, finish quietly.
      turn.muted = true;
      turn.track(outcome.then((x) => {
        if (x.e) log(`cancelled turn ended with: ${describeError(x.e)}`);
        if (x.e instanceof RecoveryNeeded) io.notice(x.e.message); // muted: saved, shown at the next prompt
        this.#rememberThread(s);
      }), "cancelled turn");
      s.active = null;
      log(`prompt cancelled; answered in ${((Date.now() - t0) / 1000).toFixed(1)} s, cloud turn settles in the background`);
      return { stopReason: "cancelled" };
    }
    s.active = null;
    this.#rememberThread(s);
    if (first.e) {
      if (turn.stopped) {
        if (first.e instanceof RecoveryNeeded) { log(describeError(first.e)); io.notice(first.e.message); }
        return { stopReason: "cancelled" };
      }
      log(`prompt failed: ${describeError(first.e)}`);
      throw this.rpcError(first.e);
    }
    const stopReason = turn.stopped ? "cancelled" : first.r;
    log(`prompt done: ${stopReason} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return { stopReason };
  }

  async cancel(params) {
    const s = this.sessions.get(params.sessionId);
    s?.active?.stop();
  }

  // Rollback (and other session replacements) give megha a brand-new session for an existing thread,
  // and the next prompt carries T3's context handoff. If this thread was using a cloud task, keep
  // using it; otherwise the handoff travels as context to a new task. Either way, say which: returns
  // the text to show (null without a handoff). Adopting moves the old session's unshown notices here
  // too: the thread hint will point at this session, so nothing would ever show them otherwise.
  #adoptFromHint(s, input) {
    if (!input.handoff) return null;
    const hint = s.t3Key ? loadHint(s.t3Key) : null;
    const rec = hint && hint.backend === this.backend.name && hint.sessionId !== s.id ? loadSessionRecord(hint.sessionId) : null;
    if (!rec?.cloudId) return "Starting a new cloud task. The earlier conversation from this thread is sent along as context.\n\n";
    for (const k of CLOUD_FIELDS) if (rec[k] !== undefined) s[k] = rec[k];
    // The old session may still be open in this process: take the notices from that copy, the one
    // that would otherwise save them again.
    const old = this.sessions.get(hint.sessionId) ?? rec;
    if (old.notices?.length) {
      s.notices = [...old.notices, ...(s.notices ?? [])];
      saveSessionRecord(s); // saved here before they leave the old record: a crash duplicates, never loses
      old.notices = [];
      try { saveSessionRecord(old); } catch (e) { log(`session save failed: ${describeError(e)}`); }
    }
    input.text = `T3 Code started a new session for this conversation (for example after a rollback). The history below is the current state; where it differs from what you remember, follow it.\n\n${input.text}`;
    log(`adopted cloud task ${rec.cloudId} from session ${hint.sessionId}`);
    return `Continuing the same cloud task${rec.webUrl ? ` ([open](${rec.webUrl}))` : ""}; T3 started a new session for this thread, so the earlier conversation is sent along as the current state.\n\n`;
  }

  #rememberThread(s) {
    if (!s.t3Key || !s.cloudId) return;
    try { saveSessionRecord(s); saveHint(s.t3Key, { backend: this.backend.name, sessionId: s.id, cloudId: s.cloudId }); } catch (e) { log(`hint save failed: ${describeError(e)}`); }
  }

  // After the response to session/new|load|resume is on the wire (T3 waits briefly for this).
  #advertiseCommands(s) {
    setTimeout(() => this.#send(s.id, { sessionUpdate: "available_commands_update", availableCommands: this.backend.commands }), 0);
  }

  #send(sessionId, update) {
    this.conn.sessionUpdate({ sessionId, update }).catch((e) => log(`sessionUpdate failed: ${describeError(e)}`));
  }

  // One text chunk whose delivery the caller waits on (a notice is removed only once it is written).
  #write(sessionId, text) {
    return this.conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
  }
}
