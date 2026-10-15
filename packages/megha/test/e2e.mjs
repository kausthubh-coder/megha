// Live end-to-end: ONE read-only prompt on krida through the agent, recording every session/update.
// Creates one cloud task/session. Run at most once per backend.
//   node test/e2e.mjs codex|claude
// Writes test/e2e-<backend>.jsonl: one line per notification {t, kind, ...summary}, then a summary line.

import { writeFileSync, appendFileSync } from "node:fs";
import { startAgent, T3_INITIALIZE } from "./client.mjs";

const backend = process.argv[2];
if (!["codex", "claude"].includes(backend)) { console.error("usage: node test/e2e.mjs codex|claude"); process.exit(2); }
const cwd = "C:\\Users\\kaust\\OneDrive\\Documents\\dev\\krida";
const PROMPT = "In two sentences, what does src/main.tsx render? Do not change files.";
const out = new URL(`./e2e-${backend}.jsonl`, import.meta.url);
writeFileSync(out, "");
let t0 = Date.now();
const rec = (o) => appendFileSync(out, JSON.stringify({ t: Date.now() - t0, ...o }) + "\n");

const counts = {};
let text = "", firstUpdateAt = null, firstTextAt = null;
const agent = startAgent({
  backend, cwd, verbose: true,
  onUpdate: ({ update: u }) => {
    counts[u.sessionUpdate] = (counts[u.sessionUpdate] ?? 0) + 1;
    firstUpdateAt ??= Date.now() - t0;
    const r = { kind: u.sessionUpdate };
    if (u.content?.type === "text") {
      r.len = u.content.text.length; r.text = u.content.text.slice(0, 160);
      if (u.sessionUpdate === "agent_message_chunk") { text += u.content.text; firstTextAt ??= Date.now() - t0; }
    }
    for (const k of ["toolCallId", "title", "status"]) if (u[k] !== undefined) r[k] = typeof u[k] === "string" ? u[k].slice(0, 160) : u[k];
    if (u.kind) r.toolKind = u.kind;
    if (u.sessionUpdate === "usage_update") Object.assign(r, { used: u.used, size: u.size, cost: u.cost });
    if (u.sessionUpdate === "plan") r.entries = u.entries.length;
    rec(r);
  },
  onRequest: async (method, params) => {
    rec({ kind: `request:${method}`, title: params.toolCall?.title });
    // Read-only test: allow reads and searches, deny anything else.
    const ok = ["read", "search", "fetch"].includes(params.toolCall?.kind);
    return { outcome: { outcome: "selected", optionId: ok ? "allow" : "reject" } };
  },
});

try {
  await agent.request("initialize", T3_INITIALIZE);
  const s = await agent.request("session/new", { cwd, mcpServers: [] });
  if (backend === "codex") {
    await agent.request("session/set_config_option", { sessionId: s.sessionId, configId: "environment", value: "<your-codex-env-id>" });
    await agent.request("session/set_config_option", { sessionId: s.sessionId, configId: "mode", value: "ask" });
  }
  const opts = (await agent.request("session/set_config_option", { sessionId: s.sessionId, configId: "apply", value: "off" })).configOptions;
  rec({ kind: "config", options: Object.fromEntries(opts.map((o) => [o.id, o.currentValue])) });
  t0 = Date.now();
  rec({ kind: "prompt", text: PROMPT });
  const res = await agent.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: PROMPT }] });
  const total = Date.now() - t0;
  const summary = { kind: "summary", stopReason: res.stopReason, totalMs: total, firstUpdateMs: firstUpdateAt, firstTextMs: firstTextAt, counts, textLen: text.length };
  rec(summary);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`--- agent text ---\n${text}`);
  if (res.stopReason !== "end_turn" || !text.trim()) process.exitCode = 1;
} catch (e) {
  rec({ kind: "error", message: e.message });
  console.log(`FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await agent.close();
}
