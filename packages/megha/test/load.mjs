// Replay an existing cloud task/session through session/load (read-only).
//   node test/load.mjs codex|claude <cloud id> [cwd]

import { startAgent, T3_INITIALIZE } from "./client.mjs";

const [backend, id, cwd = "C:\\Users\\kaust\\OneDrive\\Documents\\dev\\krida"] = process.argv.slice(2);
const updates = [];
const agent = startAgent({ backend, cwd, onUpdate: (u) => updates.push(u) });
try {
  await agent.request("initialize", T3_INITIALIZE);
  const t = Date.now();
  const res = await agent.request("session/load", { sessionId: id, cwd, mcpServers: [] });
  await new Promise((r) => setTimeout(r, 300));
  const counts = {};
  for (const u of updates) counts[u.update.sessionUpdate] = (counts[u.update.sessionUpdate] ?? 0) + 1;
  console.log(`session/load ${id}: ${Date.now() - t} ms, ${updates.length} updates ${JSON.stringify(counts)}, ${res.configOptions?.length} config options`);
  for (const u of updates) {
    const x = u.update;
    const text = x.content?.text ?? x.title ?? "";
    console.log(`  ${x.sessionUpdate.padEnd(20)} ${x.kind ?? ""} ${x.status ?? ""} ${String(text).replace(/\s+/g, " ").slice(0, 100)}`);
  }
} catch (e) {
  console.log(`FAILED: ${e.message}\n${agent.stderr.join("").slice(-1500)}`);
  process.exitCode = 1;
} finally { await agent.close(); }
