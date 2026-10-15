// Live check on krida: creates ONE cloud task/session (read-only prompts) and drives it the way T3
// does. Turn 1: image + a non-default model. Turn 2: a long read-only job, cancelled after a delay.
// Turn 3: a steer sent right after the cancel. Then /status shows the model the cloud ran.
//   node test/live-steer.mjs codex|claude [cancelAfterSeconds]
// Prints timings; writes nothing to the repo.

import zlib from "node:zlib";
import { startAgent, T3_INITIALIZE } from "./client.mjs";

const backend = process.argv[2];
if (!["codex", "claude"].includes(backend)) { console.error("usage: node test/live-steer.mjs codex|claude [cancelAfterSeconds]"); process.exit(2); }
const cancelAfter = Number(process.argv[3] ?? 25) * 1000;
const cwd = "C:\\Users\\kaust\\OneDrive\\Documents\\dev\\krida";
const MODEL = backend === "codex" ? "gpt-5.6-luna" : "claude-haiku-5-5";

// A 32x32 solid red PNG, built here so the test needs no image file.
function redPng() {
  const w = 32, h = 32;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([220, 20, 20], y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

let turnText = "";
const counts = {};
const agent = startAgent({
  backend, cwd, verbose: true,
  onUpdate: ({ update: u }) => {
    counts[u.sessionUpdate] = (counts[u.sessionUpdate] ?? 0) + 1;
    if (u.sessionUpdate === "agent_message_chunk") turnText += u.content.text;
  },
  // Read-only: allow reads and searches, deny anything else.
  onRequest: async (_m, p) => ({ outcome: { outcome: "selected", optionId: ["read", "search", "fetch"].includes(p.toolCall?.kind) ? "allow" : "reject" } }),
});
const prompt = async (sessionId, blocks) => {
  turnText = "";
  const t = Date.now();
  const r = await agent.request("session/prompt", { sessionId, prompt: blocks });
  return { ...r, ms: Date.now() - t, text: turnText };
};
const say = (label, r) => console.log(`\n### ${label}: stopReason=${r.stopReason} in ${(r.ms / 1000).toFixed(1)} s\n${r.text.trim().slice(0, 1200)}\n`);

try {
  await agent.request("initialize", T3_INITIALIZE);
  const s = await agent.request("session/new", { cwd, mcpServers: [] });
  const set = (configId, value) => agent.request("session/set_config_option", { sessionId: s.sessionId, configId, value });
  await set("model", MODEL);
  await set("mode", backend === "codex" ? "ask" : "default");
  const opts = (await set("apply", "off")).configOptions;
  console.log(`config: ${JSON.stringify(Object.fromEntries(opts.map((o) => [o.id, o.currentValue])))}`);

  say("turn 1 (image, model)", await prompt(s.sessionId, [
    { type: "text", text: "What colour is the attached image? Answer in one word. Do not run commands or change files." },
    { type: "image", data: redPng().toString("base64"), mimeType: "image/png" },
  ]));

  const long = prompt(s.sessionId, [{ type: "text", text: "Read every file under src/ one at a time and write a detailed paragraph about each one. Do not change files." }]);
  await new Promise((r) => setTimeout(r, cancelAfter));
  const tc = Date.now();
  agent.notify("session/cancel", { sessionId: s.sessionId });
  const cancelled = await long;
  console.log(`\n### turn 2 (cancel after ${cancelAfter / 1000} s): stopReason=${cancelled.stopReason}, prompt returned ${((Date.now() - tc) / 1000).toFixed(2)} s after session/cancel`);

  say("turn 3 (steer right after cancel)", await prompt(s.sessionId, [{ type: "text", text: "Stop that. Instead, just tell me how many files are directly in src/ (one number). Do not change files." }]));
  say("/status", await prompt(s.sessionId, [{ type: "text", text: "/status" }]));
  console.log(`updates: ${JSON.stringify(counts)}`);
  if (agent.badLines.length) throw new Error(`non-JSON on stdout: ${agent.badLines[0].slice(0, 120)}`);
} catch (e) {
  console.log(`FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await agent.close();
}
