// Streamed answer text reaches the client whole and exactly once, through the real MeghaAgent and a
// backend, with the SSE body split across network chunks the way a live connection delivers it.
//
// Codex Cloud's live stream loses item/agentMessage/delta events: words go missing mid-message and
// the tail of a message can be dropped (a live capture on 2026-10-15 delivered 453 of 551 answer
// characters; the 2026-10-14 recording in research-codex.md §9 delivered 843 of 1161). The complete
// text arrives in item/completed and in the stored turn. Megha once streamed the deltas as they came,
// so T3 showed answers with words and endings missing.

import assert from "node:assert/strict";
import { MeghaAgent } from "../lib/agent.mjs";
import { CodexBackend } from "../lib/codex.mjs";
import { ClaudeBackend } from "../lib/claude.mjs";
import { test, makeRepo, mockFetch, json, fakeConn, wait } from "./harness.mjs";
import { codexBase, codexEnv, details, thread, claudeBase, crow } from "./suite-hardening.mjs";

const CX = "chatgpt\\.com/backend-api";
const AN = "api\\.anthropic\\.com";
const text = (t) => [{ type: "text", text: t }];
const chunksOf = (conn, sessionId) => conn.notes.filter((n) => n.sessionId === sessionId && n.update.sessionUpdate === "agent_message_chunk").map((n) => n.update.content.text);
const count = (hay, needle) => hay.split(needle).length - 1;

// The answer from the live failure (task_e_6ad06f7a…), in word-level deltas like the live stream.
const ANSWER = "`convex/schema.ts` defines Krida’s Convex database schema, including reusable validators and the tables, fields, relationships, and indexes for profiles, media, recommendations, tracking, playback, syncing, and watch parties.";
const TOKENS = ANSWER.match(/\s*[^\s,.`/’]+|[,.`/’]/g);

// A deterministic RNG, so a failing split can be replayed.
function rng(seed) { return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; }

// An SSE response whose bytes arrive in random-size network chunks (UTF-8 characters split too),
// with 1 ms gaps between some of them, like a live connection. Fails when the request is aborted.
function chunkedSse(frames, signal, seed = 1) {
  const bytes = Buffer.from(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""));
  const rand = rng(seed);
  const body = new ReadableStream({
    async start(c) {
      const stop = () => { try { c.error(new DOMException("aborted", "AbortError")); } catch {} };
      signal?.addEventListener("abort", stop, { once: true });
      for (let i = 0; i < bytes.length && !signal?.aborted;) {
        const n = 1 + Math.floor(rand() * 300);
        c.enqueue(bytes.subarray(i, i + n)); i += n;
        if (rand() < 0.3) await wait(1);
      }
      // Like the live stream: open and silent after the turn ends, until megha closes it.
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

// Deltas for ANSWER with some dropped (every 5th one, and the last three), as the live stream does.
function lossyDeltas(itemId) {
  return TOKENS.map((t, i) => (i % 5 === 3 || i >= TOKENS.length - 3 ? null : thread("item/agentMessage/delta", { itemId, delta: t }))).filter(Boolean);
}

export async function run() {
  async function codexTurn(name, frames, { stored = [] } = {}) {
    const repo = await makeRepo({ origin: `https://github.com/acme/${name}.git` });
    const env = codexEnv(`env_${name}`, name, `acme/${name}`);
    const task = `task_e_${name}`;
    let ended = false;
    mockFetch(codexBase([env], [
      ["POST", new RegExp(`^${CX}/wham/tasks$`), () => json({ task: { id: task, title: "t" }, turn: { id: `${task}~assttrn_e_1` } })],
      ["GET", new RegExp(`^${CX}/wham/tasks/${task}/turns/[^/]+/stream$`), (req) => { ended = true; return chunkedSse(frames, req.signal); }],
      ["GET", new RegExp(`^${CX}/wham/tasks/${task}$`), () => {
        const d = details(task, env, { status: ended ? "completed" : "in_progress", output_items: ended ? stored.map((t) => ({ type: "message", content: [{ content_type: "text", text: t }] })) : [] });
        if (ended) d.current_assistant_turn.thread_events = { events: stored.map((t, i) => ({ method: "item/completed", params: { item: { id: `msg_${i + 1}`, type: "agentMessage", text: t } } })) };
        return json(d);
      }],
    ]));
    const conn = fakeConn();
    const a = new MeghaAgent(conn, new CodexBackend({ pollMs: 60_000 }), { env: {} });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    a.sessions.get(sessionId).config.mode = "ask";
    const res = await a.prompt({ sessionId, prompt: text("What does convex/schema.ts define?") });
    return { res, chunks: chunksOf(conn, sessionId) };
  }

  await test("codex: an answer whose live deltas lost words and its tail is shown whole, once (item/completed)", async () => {
    const { res, chunks } = await codexTurn("lossy1", [
      thread("turn/started"),
      ...lossyDeltas("msg_1"),
      thread("item/completed", { item: { id: "msg_1", type: "agentMessage", text: ANSWER } }),
      thread("turn/completed", { turn: { status: "completed" } }),
    ], { stored: [ANSWER] });
    assert.equal(res.stopReason, "end_turn");
    const all = chunks.join("");
    assert.equal(count(all, ANSWER), 1, `the full answer exactly once; got ${JSON.stringify(all)}`);
    assert.ok(all.startsWith(ANSWER), "nothing garbled before it");
  });

  await test("codex: when the stream also lost item/completed, the stored turn supplies the answer once", async () => {
    const { res, chunks } = await codexTurn("lossy2", [
      thread("turn/started"),
      ...lossyDeltas("msg_1"),
      thread("turn/completed", { turn: { status: "completed" } }),
    ], { stored: [ANSWER] });
    assert.equal(res.stopReason, "end_turn");
    const all = chunks.join("");
    assert.equal(count(all, ANSWER), 1, `the full answer exactly once; got ${JSON.stringify(all)}`);
    assert.ok(all.startsWith(ANSWER), "nothing garbled before it");
  });

  await test("codex: a commentary message and the final answer each show once, in order", async () => {
    const note = "I'll read the schema file first.";
    const { chunks } = await codexTurn("lossy3", [
      thread("turn/started"),
      thread("item/agentMessage/delta", { itemId: "msg_1", delta: "I'll read" }),
      thread("item/completed", { item: { id: "msg_1", type: "agentMessage", text: note } }),
      thread("item/completed", { item: { id: "cmd_1", type: "commandExecution", command: "cat convex/schema.ts", aggregatedOutput: "", exitCode: 0, status: "completed" } }),
      ...lossyDeltas("msg_2"),
      thread("item/completed", { item: { id: "msg_2", type: "agentMessage", text: ANSWER } }),
      thread("turn/completed", { turn: { status: "completed" } }),
    ], { stored: [note, ANSWER] });
    const all = chunks.join("");
    assert.equal(count(all, note), 1); assert.equal(count(all, ANSWER), 1);
    assert.ok(all.indexOf(note) < all.indexOf(ANSWER));
    assert.ok(!all.includes("I'll read I'll read"), "the commentary is not repeated");
  });

  await test("claude: a long multi-block answer split across network chunks arrives intact, once", async () => {
    const repo = await makeRepo({ origin: "https://github.com/acme/longc.git" });
    const paras = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}: ${ANSWER} Ünïcödé — “quoted” ✓ ${"word ".repeat(40).trim()}.`);
    const blocks = paras.map((p) => ({ type: "text", text: `${p}\n\n` }));
    const frames = [
      crow(11, { type: "assistant", message: { content: blocks.slice(0, 5) } }),
      crow(12, { type: "assistant", message: { content: [{ type: "thinking", thinking: "checking" }, ...blocks.slice(5, 9)] } }),
      crow(13, { type: "assistant", message: { content: blocks.slice(9) } }),
      crow(14, { type: "result", subtype: "success", is_error: false }),
    ];
    const chunkedRows = (signal) => {
      const bytes = Buffer.from(frames.map((f) => `event: ${f.event}\nid: ${f.id}\ndata: ${JSON.stringify(f.data)}\n\n`).join(""));
      const rand = rng(7);
      return new Response(new ReadableStream({ async start(c) {
        signal?.addEventListener("abort", () => { try { c.error(new DOMException("aborted", "AbortError")); } catch {} }, { once: true });
        for (let i = 0; i < bytes.length && !signal?.aborted;) { const n = 1 + Math.floor(rand() * 200); c.enqueue(bytes.subarray(i, i + n)); i += n; if (rand() < 0.3) await wait(1); }
      } }), { headers: { "content-type": "text/event-stream" } });
    };
    mockFetch(claudeBase([
      ["POST", new RegExp(`^${AN}/v1/code/sessions/cse_long/events$`), () => json({ results: [{ sequence_num: "10" }] })],
      ["GET", new RegExp(`^${AN}/v1/code/sessions/cse_long/events/stream$`), (req) => chunkedRows(req.signal)],
      ["GET", new RegExp(`^${AN}/v1/code/sessions/cse_long$`), () => json({ session: { id: "cse_long", worker_status: "idle", title: "t", config: { sources: [{ type: "git_repository", url: "https://github.com/acme/longc" }] } } })],
    ]));
    const conn = fakeConn();
    const a = new MeghaAgent(conn, new ClaudeBackend({ statusPollMs: 60_000 }), { env: {} });
    const { sessionId } = await a.newSession({ cwd: repo, mcpServers: [] });
    Object.assign(a.sessions.get(sessionId), { cloudId: "cse_long", bundle: false, lastSeq: 9 });
    a.sessions.get(sessionId).config.apply = "off";
    const res = await a.prompt({ sessionId, prompt: text("Explain the schema at length.") });
    assert.equal(res.stopReason, "end_turn");
    const all = chunksOf(conn, sessionId).join("");
    const expected = blocks.map((b) => b.text).join("");
    assert.equal(count(all, expected), 1, "every block, in order, exactly once");
  });
}
