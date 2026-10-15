// Test helpers: a fetch mock that routes by method + path, temp git repos, fake CLI logins.
// No network: an unrouted request throws.

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../lib/util.mjs";

let failures = 0;
export async function test(name, fn) {
  try { await fn(); console.log(`ok  ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack?.split("\n").slice(0, 4).join("\n     ") ?? e}`); }
}
export const failed = () => failures;

export const tmp = (prefix) => mkdtempSync(join(tmpdir(), `megha-test-${prefix}-`));

export const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
// SSE body from frames: {data, event?, id?} or plain objects (sent as data).
export function sse(frames) {
  const text = frames.map((f) => {
    const fr = f && typeof f === "object" && "data" in f ? f : { data: f };
    return `${fr.event ? `event: ${fr.event}\n` : ""}${fr.id ? `id: ${fr.id}\n` : ""}data: ${typeof fr.data === "string" ? fr.data : JSON.stringify(fr.data)}\n\n`;
  }).join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}
// An SSE response that stays open until the request is aborted (like a live cloud stream).
export function hangingSse(signal) {
  const body = new ReadableStream({
    start(controller) {
      const stop = () => { try { controller.error(new DOMException("aborted", "AbortError")); } catch {} };
      if (signal?.aborted) stop(); else signal?.addEventListener("abort", stop, { once: true });
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

// routes: [[method, RegExp on `host+path`, (req) => Response | Promise<Response>]]
export function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch {} }
    const req = { method, url, path: url.host + url.pathname, body, rawBody: init.body, headers: init.headers ?? {}, signal: init.signal };
    calls.push(req);
    for (const [m, re, handler] of routes) if (m === method && re.test(req.path)) return handler(req);
    throw new Error(`unmocked ${method} ${req.path}`);
  };
  return calls;
}

export function fakeJwt(claims) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "none" })}.${b(claims)}.sig`;
}

// Recognizable canaries: none of these may ever reach stdout, stderr, ACP or a file megha writes.
export const CANARY = {
  codexRefresh: "canary-codex-refresh-token-7f3a",
  codexAccount: "acct-canary-0c41",
  codexIdToken: "canary-codex-id-token-91d2",
  claudeRefresh: "sk-ant-ort01-canary-refresh-55e0",
  envSecret: "CANARY_ENV_SECRET_b81f",
  serverBody: "canary-server-diagnostic-2d6c",
  initError: "canary-init-error-a9e4",
};

export function writeFakeLogins(root) {
  const codexHome = join(root, "codex"); mkdirSync(codexHome, { recursive: true });
  const codexToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, canary: "codex-access" });
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: codexToken, refresh_token: CANARY.codexRefresh, id_token: CANARY.codexIdToken, account_id: CANARY.codexAccount } }));
  const claudeHome = join(root, "claude"); mkdirSync(claudeHome, { recursive: true });
  const claudeToken = "test-claude-oauth-token-not-real";
  writeFileSync(join(claudeHome, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: claudeToken, refreshToken: CANARY.claudeRefresh, expiresAt: Date.now() + 3600_000, scopes: ["user:sessions:claude_code"] } }));
  return { codexHome, claudeHome, codexToken, claudeToken };
}

// A repo with one commit on main and origin/main pointing at it (no network remote needed).
export async function makeRepo({ origin = "https://github.com/acme/widget.git", files = { "a.txt": "one\n" } } = {}) {
  const dir = tmp("repo");
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@example.com"]); await git(dir, ["config", "user.name", "t"]);
  await git(dir, ["config", "core.autocrlf", "false"]);
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  await git(dir, ["add", "."]); await git(dir, ["commit", "-qm", "init"]);
  if (origin) {
    await git(dir, ["remote", "add", "origin", origin]);
    await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  }
  return dir;
}

// An io object like the agent passes to backends, recording everything.
export function recorder({ signal } = {}) {
  const updates = [];
  return {
    updates,
    text: () => updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join(""),
    io: {
      signal: signal ?? new AbortController().signal,
      update: (u) => updates.push(u),
      text: (t) => updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } }),
      requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
    },
  };
}

// A promise you resolve from outside: lets a mocked request stay pending until the test says so.
export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
// A mocked request that never answers, except by failing when its AbortSignal fires (like fetch).
export function untilAborted(signal) {
  return new Promise((_resolve, reject) => {
    const stop = () => reject(new DOMException("aborted", "AbortError"));
    if (signal?.aborted) stop(); else signal?.addEventListener("abort", stop, { once: true });
  });
}
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Everything the agent sends over ACP, from every fake connection in the run (the secrecy suite
// scans it at the end).
export const acpCaptured = [];
export function fakeConn() {
  const notes = [];
  return {
    notes,
    sessionUpdate: async (n) => { notes.push(n); acpCaptured.push(n); },
    requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
  };
}
// Record an ACP error (or anything else the client would see) for the secrecy suite.
export function captureAcp(value) {
  acpCaptured.push(value instanceof Error ? { message: value.message, code: value.code, data: value.data } : value);
  return value;
}

// stdout and stderr of the whole offline run, teed (still printed) so the secrecy suite can scan them.
export const stdio = { out: [], err: [] };
export function teeStdio() {
  for (const [name, sink] of [["stdout", stdio.out], ["stderr", stdio.err]]) {
    const stream = process[name];
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => { sink.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")); return write(chunk, ...rest); };
  }
}

export const PNG_1x1 ="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
