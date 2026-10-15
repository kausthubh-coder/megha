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

export function writeFakeLogins(root) {
  const codexHome = join(root, "codex"); mkdirSync(codexHome, { recursive: true });
  const codexToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: codexToken, account_id: "acct_test" } }));
  const claudeHome = join(root, "claude"); mkdirSync(claudeHome, { recursive: true });
  const claudeToken = "test-claude-oauth-token-not-real";
  writeFileSync(join(claudeHome, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: claudeToken, expiresAt: Date.now() + 3600_000, scopes: ["user:sessions:claude_code"] } }));
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

export const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
