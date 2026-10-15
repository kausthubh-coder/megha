#!/usr/bin/env node
// cloud-acp: an ACP agent (stdio, newline-delimited JSON-RPC) that runs T3 Code threads on
// Codex Cloud (--backend codex) or Claude Code on the web (--backend claude).
// stdout is the protocol; all logging goes to stderr.

import { Readable, Writable } from "node:stream";
import crypto from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { CodexBackend } from "./lib/codex.mjs";
import { ClaudeBackend } from "./lib/claude.mjs";
import { log, setLogPrefix, UserError, loadSessionRecord, findSessionByCloudId, saveSessionRecord } from "./lib/util.mjs";

const VERSION = "0.1.0";
const argv = process.argv.slice(2);
const backendName = argv[argv.indexOf("--backend") + 1] ?? process.env.CLOUD_ACP_BACKEND;
if (!["codex", "claude"].includes(backendName ?? "") || !argv.includes("--backend") && !process.env.CLOUD_ACP_BACKEND) {
  process.stderr.write("usage: node index.mjs --backend codex|claude\n");
  process.exit(2);
}
setLogPrefix(`cloud-acp:${backendName}`);
const backend = backendName === "codex" ? new CodexBackend() : new ClaudeBackend();

// Errors thrown to the SDK become JSON-RPC errors; UserError messages are written for the person reading T3.
function rpcError(e) {
  if (e instanceof acp.RequestError) return e;
  const msg = e instanceof UserError ? e.message : `${backend.label}: ${e.message}`;
  return new acp.RequestError(-32603, msg);
}

class CloudAgent {
  constructor(conn) {
    this.conn = conn;
    this.sessions = new Map(); // sessionId -> session
  }

  async initialize() {
    return {
      protocolVersion: 1,
      agentInfo: { name: `cloud-acp-${backend.name}`, title: backend.label, version: VERSION },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { list: {}, resume: {} },
      },
      authMethods: [],
    };
  }

  async authenticate() { return {}; }

  // Lazy: T3 calls this on every status probe. Only a local record and option lists; no cloud task.
  async newSession(params) {
    try {
      backend.checkAuth();
      const session = { id: `ca_${crypto.randomUUID()}`, backend: backend.name, cwd: params.cwd, config: {}, createdAt: new Date().toISOString() };
      await backend.prepare(session);
      this.sessions.set(session.id, session);
      return { sessionId: session.id, configOptions: backend.configOptions(session) };
    } catch (e) { throw rpcError(e); }
  }

  // Resolve a session id that may be ours (persisted) or a cloud id picked from session/list.
  async #bind(sessionId, cwd) {
    let s = this.sessions.get(sessionId);
    if (s) return s;
    const rec = loadSessionRecord(sessionId) ?? findSessionByCloudId(backend.name, sessionId);
    s = rec ? { ...rec, id: sessionId, cwd: cwd || rec.cwd, config: { ...(rec.config ?? {}) } }
      : { id: sessionId, backend: backend.name, cwd, cloudId: sessionId, config: {}, createdAt: new Date().toISOString() };
    await backend.prepare(s);
    this.sessions.set(sessionId, s);
    return s;
  }

  async loadSession(params) {
    try {
      backend.checkAuth();
      const s = await this.#bind(params.sessionId, params.cwd);
      if (s.cloudId) await backend.replay(s, { update: (u) => this.#send(s.id, u) });
      saveSessionRecord(s);
      return { configOptions: backend.configOptions(s) };
    } catch (e) { throw rpcError(e); }
  }

  async resumeSession(params) {
    try {
      backend.checkAuth();
      const s = await this.#bind(params.sessionId, params.cwd);
      return { configOptions: backend.configOptions(s) };
    } catch (e) { throw rpcError(e); }
  }

  async listSessions(params) {
    try {
      backend.checkAuth();
      return await backend.list(params.cwd ?? process.cwd(), params.cursor ?? undefined);
    } catch (e) { throw rpcError(e); }
  }

  async setSessionConfigOption(params) {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw acp.RequestError.invalidParams(undefined, `Unknown session ${params.sessionId}`);
    try { backend.setConfig(s, params.configId, String(params.value)); } catch (e) { throw rpcError(e); }
    if (s.cloudId) saveSessionRecord(s);
    return { configOptions: backend.configOptions(s) };
  }

  async setSessionMode(params) {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw acp.RequestError.invalidParams(undefined, `Unknown session ${params.sessionId}`);
    try { backend.setConfig(s, "mode", params.modeId); } catch (e) { throw rpcError(e); }
    return {};
  }

  async prompt(params) {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw acp.RequestError.invalidParams(undefined, `Unknown session ${params.sessionId}`);
    if (s.active) throw new acp.RequestError(-32603, "A turn is already running in this session.");
    const text = promptText(params.prompt);
    if (!text.trim()) throw acp.RequestError.invalidParams(undefined, "Empty prompt");
    const ac = new AbortController();
    s.active = ac;
    const t0 = Date.now();
    try {
      const stopReason = await backend.prompt(s, text, {
        signal: ac.signal,
        update: (u) => this.#send(s.id, u),
        text: (t) => this.#send(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } }),
        requestPermission: (p) => this.conn.requestPermission(p),
      });
      log(`prompt done: ${stopReason} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      return { stopReason };
    } catch (e) {
      if (ac.signal.aborted) return { stopReason: "cancelled" };
      log(`prompt failed: ${e.message}`);
      throw rpcError(e);
    } finally {
      s.active = null;
    }
  }

  async cancel(params) {
    const s = this.sessions.get(params.sessionId);
    s?.active?.abort();
  }

  #send(sessionId, update) {
    this.conn.sessionUpdate({ sessionId, update }).catch((e) => log(`sessionUpdate failed: ${e.message}`));
  }
}

function promptText(blocks) {
  const parts = [];
  for (const b of blocks ?? []) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "resource_link") parts.push(`[${b.name ?? b.title ?? "file"}](${b.uri})`);
    else if (b.type === "resource" && "text" in (b.resource ?? {})) parts.push(`<file uri="${b.resource.uri}">\n${b.resource.text}\n</file>`);
  }
  return parts.join("\n\n");
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const conn = new acp.AgentSideConnection((c) => new CloudAgent(c), stream);
conn.closed?.then?.(() => process.exit(0));
log(`ready (v${VERSION}, cwd ${process.cwd()})`);
