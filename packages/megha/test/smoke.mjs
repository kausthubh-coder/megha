// Smoke test: spawn the agent like T3 would and exercise initialize -> session/new -> config options ->
// session/set_config_option -> session/list. Creates no cloud tasks.
//   node test/smoke.mjs [codex|claude] [cwd]

import { startAgent, T3_INITIALIZE } from "./client.mjs";

const backends = process.argv[2] ? [process.argv[2]] : ["codex", "claude"];
const cwd = process.argv[3] ?? "C:\\Users\\kaust\\OneDrive\\Documents\\dev\\krida";
let failed = false;

for (const backend of backends) {
  console.log(`\n=== ${backend} (cwd ${cwd}) ===`);
  const updates = [];
  const agent = startAgent({ backend, cwd, onUpdate: (u) => updates.push(u) });
  try {
    let t = Date.now();
    const init = await agent.request("initialize", T3_INITIALIZE);
    console.log(`initialize (${Date.now() - t} ms): protocolVersion=${init.protocolVersion} agent=${init.agentInfo?.title} caps=${JSON.stringify(init.agentCapabilities)}`);
    if (init.protocolVersion !== 1 || "info" in init) throw new Error("expected a v1 initialize response");
    if (!init.agentCapabilities?.loadSession || !init.agentCapabilities?.sessionCapabilities?.list) throw new Error("list/load not advertised");

    t = Date.now();
    const s = await agent.request("session/new", { cwd, mcpServers: [] });
    console.log(`session/new (${Date.now() - t} ms): sessionId=${s.sessionId}`);
    for (const o of s.configOptions ?? []) {
      console.log(`  option ${o.id} [${o.category ?? "-"}] = ${o.currentValue}  choices: ${o.options.map((c) => `${c.value}${c.name !== c.value ? ` (${c.name})` : ""}`).join(" | ")}`);
    }
    const mode = s.configOptions.find((o) => o.category === "mode");
    const other = mode.options.find((c) => c.value !== mode.currentValue)?.value;
    const set = await agent.request("session/set_config_option", { sessionId: s.sessionId, configId: mode.id, value: other });
    const after = set.configOptions.find((o) => o.id === mode.id).currentValue;
    console.log(`set_config_option ${mode.id}=${other} -> ${after}`);
    if (after !== other) throw new Error("set_config_option did not take");

    t = Date.now();
    const list = await agent.request("session/list", { cwd });
    console.log(`session/list (${Date.now() - t} ms): ${list.sessions.length} session(s)${list.nextCursor ? " +more" : ""}`);
    for (const x of list.sessions.slice(0, 8)) console.log(`  ${x.sessionId}  ${x.updatedAt ?? "?"}  ${x.title ?? ""}`);
    console.log(`session/update notifications during smoke: ${updates.length}`);
    if (agent.badLines.length) throw new Error(`non-JSON on stdout: ${agent.badLines[0].slice(0, 120)}`);
  } catch (e) {
    failed = true;
    console.log(`FAILED: ${e.message}`);
    console.log(agent.stderr.join("").slice(-2000));
  } finally {
    await agent.close();
  }
}
process.exitCode = failed ? 1 : 0;
