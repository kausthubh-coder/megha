// Everything the site tells people to type or paste to install megha. Kept in one module so the
// prompt, the manual steps and the config snippets can't disagree, and so they can be tested.

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

const PLACEHOLDER_PATHS: Paths = { node: "<node path>", megha: "<megha path>" };

/** The prompt people paste into Claude Code, Codex or T3. It works on any OS: the agent finds the paths. */
export function buildInstallPrompt(): string {
  // One line per provider, with a space after each colon and comma so it reads like hand-written JSON.
  const entries = Object.entries(t3ProviderInstances(PLACEHOLDER_PATHS))
    .map(([id, entry]) => `   "${id}": ${JSON.stringify(entry).replaceAll('":', '": ').replaceAll(',"', ', "')}`)
    .join(",\n");

  return `Install megha and add it to T3 Code. Megha is an open-source ACP agent (${REPO_URL}) that runs T3 threads on Codex Cloud and Claude Code on the web, using my existing codex and claude logins.

1. Check that Node.js 22 or newer is installed: node --version. If it's missing or older, stop and tell me.
2. Install megha globally with npm (not bun or another package manager, because step 4 uses npm's global folder): npm install -g megha. If it fails, stop and show me the error.
3. Run megha doctor and show me what it prints. It is a local check: it looks at Node, git and the saved codex and claude logins on this computer, and doesn't contact either cloud. If node or git fails, stop. A missing login only matters for a cloud I'll use; for that one, tell me the command to run (codex login for Codex; claude, then /login, for Claude). Don't run the logins yourself, and don't open or print any token or credential files.
4. Find two absolute paths:
   - node path: the output of ${NODE_PATH_COMMAND}
   - megha path: the output of ${NPM_ROOT_COMMAND}, followed by megha/index.mjs (with backslashes on Windows)
   Then run ${meghaCheckCommand("<megha path>")}. It should print a version number. If it doesn't, stop and tell me; don't edit any settings.
5. Add two providers to T3 Code. T3 keeps its settings in ~/.t3/userdata/settings.json (%USERPROFILE%\\.t3\\userdata\\settings.json on Windows). Make a backup copy, then add these two entries to its "providerInstances" object, with the paths from step 4 (in JSON, write each Windows backslash as \\\\). Keep every other setting as it is.
${entries}
   T3 notices the change by itself; don't restart anything.
   If the file doesn't exist or you can't edit it, give me the values to enter by hand instead: Settings → Providers → Add provider → Local ACP command, command = the node path, arguments = the megha path, --backend, codex. Then the same again with claude.
6. Tell me what you changed. Then give me this list of what I still have to do myself in a browser. megha doctor doesn't check any of it, and you can't do it for me:
   - For Codex Cloud: connect GitHub to Codex and give it access to my repo at ${CODEX_CONNECT_URL}. Megha creates the repo's environment on my first prompt if it doesn't have one.
   - For Claude Code on the web: open ${CLAUDE_CODE_URL} once, which creates my cloud environment. If I want Claude's changes back on this computer, install the Claude GitHub App (${CLAUDE_GITHUB_APP_URL}) on the repo, so Claude can push its branch.
   - For both: the cloud starts from my branch on GitHub, so push it before I start a thread. If I turn on "Send local changes" instead, Codex gets my unpushed work as a patch, and Claude gets a git bundle. A Claude session started from a bundle can't push a branch, so its changes stay on claude.ai.`;
}

export function detectOs(userAgent: string): Os {
  const ua = userAgent.toLowerCase();
  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac os") || ua.includes("macintosh")) return "macos";
  return "linux";
}
