// Sign-in for ACP clients (the ACP Registry, T3's "Sign in" button). megha has no login of its own: it
// reuses the codex / claude CLI login. So the auth method megha advertises is a terminal method whose
// command, `megha --backend <name> --login`, only reports whether that CLI login is there and how to
// make it. It never runs a CLI login, never refreshes a token and never writes a credential file
// (a refresh rotates the refresh token and would log the CLI out).

import { createInterface } from "node:readline";
import { loginCheck } from "./doctor.mjs";

const HOW = {
  codex: {
    methodId: "codex-login",
    name: "Codex CLI login",
    description: "megha uses the ChatGPT sign-in of the Codex CLI. Run `codex login` in a terminal, then sign in here again.",
    steps: [
      "Install the Codex CLI if you don't have it: npm install -g @openai/codex",
      "In any terminal, run: codex login",
      "Sign in with your ChatGPT account (Codex Cloud doesn't accept API keys).",
    ],
  },
  claude: {
    methodId: "claude-login",
    name: "Claude Code login",
    description: "megha uses the claude.ai sign-in of Claude Code. Run `claude`, type /login, then sign in here again.",
    steps: [
      "Install Claude Code if you don't have it: npm install -g @anthropic-ai/claude-code",
      "In any terminal, run: claude",
      "Type /login and sign in with your claude.ai account (Claude Code on the web doesn't accept API keys).",
    ],
  },
};

// The ACP auth method for a backend. `args` carries --backend because clients differ: T3 (and the ACP
// schema) append these args to the agent's own, the registry's AUTHENTICATION.md says they replace
// them. index.mjs reads the first --backend, so the repeated flag in T3's case is harmless.
export function authMethodFor(backendName) {
  const h = HOW[backendName];
  return { id: h.methodId, name: h.name, description: h.description, type: "terminal", args: ["--backend", backendName, "--login"] };
}

// ACP: advertise a terminal method only to a client that said it can run one. T3 sends
// clientCapabilities.auth.terminal; Zed and the registry's CI send _meta["terminal-auth"].
export function clientRunsTerminalAuth(clientCapabilities) {
  return clientCapabilities?.auth?.terminal === true || clientCapabilities?._meta?.["terminal-auth"] === true;
}

// `megha --backend <name> --login`. Exit 0 when the CLI login is present, 1 when it isn't. In a terminal
// (T3 runs this in a PTY) it waits so the user can sign in elsewhere and press Enter to check again.
export async function runLogin({ backend, input = process.stdin, write = (s) => process.stdout.write(s), check = () => loginCheck(backend) }) {
  const h = HOW[backend];
  const label = backend === "codex" ? "Codex Cloud" : "Claude Code on the web";
  const report = () => {
    const c = check();
    if (c.ok) write(`megha: ${label} is ready. ${c.detail}.\nNothing to do here; this window can close.\n`);
    return c;
  };
  write(`megha signs in to ${label} with your existing ${backend === "codex" ? "codex" : "claude"} CLI login.\n\n`);
  let c = report();
  if (c.ok) return 0;
  write(`Not signed in yet: ${c.detail}\n\nTo sign in:\n${h.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}\n\n`);
  if (!input.isTTY) { write("Then sign in here again.\n"); return 1; }
  const prompt = "Press Enter to check again, or type q and Enter to stop. ";
  const rl = createInterface({ input });
  try {
    write(prompt);
    for await (const line of rl) {
      if (line.trim().toLowerCase() === "q") break;
      c = report();
      if (c.ok) return 0;
      write(`Still not signed in: ${c.detail}\n${prompt}`);
    }
    write("\nStopped. Sign in again when your CLI login is ready.\n");
    return 1;
  } finally { rl.close(); }
}
