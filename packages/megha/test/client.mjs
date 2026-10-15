// Minimal ACP client over stdio, spawning the agent the way T3 Code does
// (node.exe + script args, cwd = thread folder, shell:false).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const AGENT = join(dirname(fileURLToPath(import.meta.url)), "..", "index.mjs");

export function startAgent({ backend, cwd, onUpdate, onRequest, verbose = false }) {
  const child = spawn(process.execPath, [AGENT, "--backend", backend], { cwd, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
  const pending = new Map();
  let nextId = 1;
  const stderr = [];
  child.stderr.on("data", (d) => { const s = d.toString(); stderr.push(s); if (verbose) process.stderr.write(s); });
  const rl = createInterface({ input: child.stdout });
  const badLines = [];
  rl.on("line", async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { badLines.push(line); return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code })) : p.resolve(msg.result);
      return;
    }
    if (msg.method === "session/update") { onUpdate?.(msg.params); return; }
    if (msg.method && msg.id !== undefined) {
      const result = (await onRequest?.(msg.method, msg.params)) ?? null;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const close = () => new Promise((resolve) => { child.once("exit", resolve); child.stdin.end(); setTimeout(() => child.kill(), 3000).unref(); });
  return { child, request, notify, close, stderr, badLines };
}

// The initialize T3 sends: v2 fields plus v1 clientCapabilities/clientInfo (toNegotiatingInitializeRequest).
export const T3_INITIALIZE = {
  protocolVersion: 2,
  info: { name: "t3-code", version: "0.0.46-nightly" },
  capabilities: {},
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "t3-code", version: "0.0.46-nightly" },
};
