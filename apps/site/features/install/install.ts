// Everything the site tells people to type or paste to install megha: the short prompt, the manual
// steps and the config snippets. public/setup.md holds the agent's full instructions; install.test.ts
// checks that it agrees with what this module generates.

export const REPO_URL = "https://github.com/kausthubh-coder/megha";
export const NPM_URL = "https://www.npmjs.com/package/megha";

// Cloud setup the user does in a browser. megha can't do it and `megha doctor` doesn't check it.
// Codex needs the ChatGPT GitHub connector to see the repo (megha then creates the environment if
// there isn't one). Claude needs one cloud environment, which claude.ai/code creates on first visit,
// and its GitHub App on the repo to clone it and push the claude/ branch megha applies.
export const CODEX_CONNECT_URL = "https://chatgpt.com/codex/settings/environments";
export const CLAUDE_CODE_URL = "https://claude.ai/code";
export const CLAUDE_GITHUB_APP_URL = "https://github.com/apps/claude";

export type Os = "windows" | "macos" | "linux";
export const OSES: { id: Os; label: string }[] = [
  { id: "windows", label: "Windows" },
  { id: "macos", label: "macOS" },
  { id: "linux", label: "Linux" },
];

export type Backend = "codex" | "claude";
export const BACKENDS: { id: Backend; instanceId: string; displayName: string }[] = [
  { id: "codex", instanceId: "megha-codex", displayName: "Codex Cloud" },
  { id: "claude", instanceId: "megha-claude", displayName: "Claude Code on the web" },
];

export type Paths = { node: string; megha: string };

// Typical paths after `npm install -g megha` with Node from the official installer (Windows),
// Homebrew (macOS) or the distro package (Linux). Shown as examples next to the commands that
// print the real ones.
export const EXAMPLE_PATHS: Record<Os, Paths & { npmRoot: string; settings: string }> = {
  windows: {
    node: "C:\\Program Files\\nodejs\\node.exe",
    npmRoot: "C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules",
    megha: "C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\megha\\index.mjs",
    settings: "%USERPROFILE%\\.t3\\userdata\\settings.json",
  },
  macos: {
    node: "/opt/homebrew/bin/node",
    npmRoot: "/opt/homebrew/lib/node_modules",
    megha: "/opt/homebrew/lib/node_modules/megha/index.mjs",
    settings: "~/.t3/userdata/settings.json",
  },
  linux: {
    node: "/usr/bin/node",
    npmRoot: "/usr/lib/node_modules",
    megha: "/usr/lib/node_modules/megha/index.mjs",
    settings: "~/.t3/userdata/settings.json",
  },
};

// `node -p process.execPath` prints the real binary on every OS, which matters on Windows: T3 refuses
// .cmd shims, so commandPath has to be node.exe itself.
export const NODE_PATH_COMMAND = 'node -p "process.execPath"';
export const NPM_ROOT_COMMAND = "npm root -g";

/** Proves the megha path is right before it goes into a config: prints megha's version, or fails. */
export function meghaCheckCommand(meghaPath: string): string {
  return `node "${meghaPath}" --version`;
}

export function meghaPathFrom(npmRoot: string, os: Os): string {
  const sep = os === "windows" ? "\\" : "/";
  return [npmRoot.replace(/[\\/]+$/, ""), "megha", "index.mjs"].join(sep);
}

/** The two entries for the "providerInstances" object in T3 Code's settings.json. */
export function t3ProviderInstances(paths: Paths) {
  return Object.fromEntries(
    BACKENDS.map((b) => [
      b.instanceId,
      {
        driver: "acpRegistry",
        displayName: b.displayName,
        config: { source: "local", commandPath: paths.node, commandArgs: [paths.megha, "--backend", b.id] },
      },
    ]),
  );
}

/** Pretty JSON, but with arrays of plain values kept on one line so the args read as a command line. */
function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/\[\s*\n([^[\]{}]*?)\n\s*\]/g, (_, items: string) =>
    `[${items
      .split(",\n")
      .map((item) => item.trim())
      .join(", ")}]`,
  );
}

export function t3SettingsSnippet(paths: Paths): string {
  return prettyJson({ providerInstances: t3ProviderInstances(paths) });
}

/** Zed's settings.json: one custom agent server per backend. */
export function zedSettingsSnippet(paths: Paths): string {
  const servers = Object.fromEntries(
    BACKENDS.map((b) => [
      b.displayName,
      { type: "custom", command: paths.node, args: [paths.megha, "--backend", b.id], env: {} },
    ]),
  );
  return prettyJson({ agent_servers: servers });
}

/** The paths in public/setup.md, which the agent replaces with the real ones. */
export const PLACEHOLDER_PATHS: Paths = { node: "<node path>", megha: "<megha path>" };

// The full agent instructions live in public/setup.md, served at SETUP_URL. It is the single source of
// truth for what an agent does on a user's computer; the copied prompt only points at it, so it stays
// short enough to read before pasting. The tests check that setup.md agrees with the snippets above.
export const SITE_URL = "https://t3-megha.vercel.app";
export const SETUP_PATH = "/setup.md";
export const SETUP_URL = `${SITE_URL}${SETUP_PATH}`;

/** The prompt people paste into Claude Code, Codex or a T3 thread. It works on any OS: setup.md says how to find the paths. */
export function buildInstallPrompt(): string {
  return `Set up megha for me: read ${SETUP_URL} and follow it.`;
}

export function detectOs(userAgent: string): Os {
  const ua = userAgent.toLowerCase();
  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac os") || ua.includes("macintosh")) return "macos";
  return "linux";
}
