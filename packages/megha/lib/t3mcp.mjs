// Calls into T3 Code's own MCP server (the "t3-code" tools), the same way T3's `acp-mcp-call` fallback
// does (t3/upstream apps/server/src/mcp/AcpMcpStdioBridge.ts callAcpMcpTool): a fresh streamable-HTTP
// MCP session per call. T3 puts the endpoint and a per-thread bearer credential in megha's environment
// (provider-acp adapter.ts acpMcpContext) and in the stdio server it passes in session/new.mcpServers.
// The credential is only ever sent to that endpoint; it is never logged or written.

import { sseFrames, log } from "./util.mjs";

const MCP_PROTOCOL_VERSION = "2025-06-18";

// {endpoint, authorization} from session/new mcpServers (stdio entry env) or the process environment.
export function t3McpFrom(mcpServers, env = process.env) {
  for (const s of mcpServers ?? []) {
    const vars = Object.fromEntries((s.env ?? []).map((e) => [e.name, e.value]));
    if (vars.T3_ACP_MCP_ENDPOINT && vars.T3_ACP_MCP_AUTHORIZATION) return { endpoint: vars.T3_ACP_MCP_ENDPOINT, authorization: vars.T3_ACP_MCP_AUTHORIZATION };
  }
  if (env.T3_ACP_MCP_ENDPOINT && env.T3_ACP_MCP_AUTHORIZATION) return { endpoint: env.T3_ACP_MCP_ENDPOINT, authorization: env.T3_ACP_MCP_AUTHORIZATION };
  return null;
}

async function payloads(res) {
  const type = res.headers.get("content-type") ?? "";
  if (res.status === 202 || res.status === 204) return [];
  if (type.includes("text/event-stream")) {
    const out = [];
    for await (const f of sseFrames(res)) { try { out.push(JSON.parse(f.data)); } catch {} }
    return out;
  }
  const text = await res.text();
  if (!text.trim()) return [];
  const j = JSON.parse(text);
  return Array.isArray(j) ? j : [j];
}

export async function callT3Tool(t3, tool, args, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  if (!t3) throw new Error("T3 Code's MCP endpoint is not available");
  let sessionId = null, protocolVersion = null;
  const signal = AbortSignal.timeout(timeoutMs);
  const send = async (message) => {
    const res = await fetchImpl(t3.endpoint, {
      method: "POST", signal,
      headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream", authorization: t3.authorization,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}), ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
      },
      body: JSON.stringify(message),
    });
    sessionId = res.headers.get("mcp-session-id") ?? sessionId;
    if (!res.ok) { await res.text().catch(() => {}); throw new Error(`T3 Code MCP endpoint responded with HTTP ${res.status}`); }
    return payloads(res);
  };
  const init = await send({ jsonrpc: "2.0", id: "megha-init", method: "initialize",
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "megha", version: "0" } } });
  const initRes = init.find((m) => m?.id === "megha-init");
  if (!initRes || initRes.error) throw new Error("T3 Code MCP endpoint rejected initialization");
  protocolVersion = initRes.result?.protocolVersion ?? MCP_PROTOCOL_VERSION;
  await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const out = await send({ jsonrpc: "2.0", id: "megha-call", method: "tools/call", params: { name: tool, arguments: args } });
  const r = out.find((m) => m?.id === "megha-call");
  if (!r) throw new Error(`T3 Code MCP tool ${tool} returned nothing`);
  if (r.error) throw new Error(`T3 Code MCP tool ${tool} failed: ${String(r.error.message ?? "error").slice(0, 200)}`);
  if (r.result?.isError) {
    const msg = (r.result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ").slice(0, 200);
    throw new Error(`T3 Code MCP tool ${tool} failed: ${msg || "error"}`);
  }
  return r.result;
}

// Register a PR with the T3 thread so it shows beside the thread. Returns a short line for the user.
export async function linkPullRequest(t3, url, opts) {
  if (!t3) return null;
  try {
    await callT3Tool(t3, "link_pull_request", { url }, opts);
    return "Linked the pull request to this thread in T3 Code.";
  } catch (e) {
    log(`link_pull_request failed: ${e.message}`);
    return `Could not link the pull request in T3 Code (${e.message}).`;
  }
}
