import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLAUDE_CODE_URL,
  CLAUDE_GITHUB_APP_URL,
  CODEX_CONNECT_URL,
  EXAMPLE_PATHS,
  INSTALL_COMMAND,
  NODE_PATH_COMMAND,
  NPM_ROOT_COMMAND,
  NPM_URL,
  PLACEHOLDER_PATHS,
  REPO_URL,
  SETUP_PATH,
  SITE_URL,
  buildInstallPrompt,
  detectOs,
  meghaCheckCommand,
  meghaPathFrom,
  t3SettingsSnippet,
  zedSettingsSnippet,
} from "./install";

// Next serves public/<path> at /<path>, so this is the file behind the prompt's URL.
const SITE_ROOT = join(import.meta.dir, "..", "..");
const setupFile = join(SITE_ROOT, "public", ...SETUP_PATH.split("/").filter(Boolean));
const setup = readFileSync(setupFile, "utf8").replace(/\r\n/g, "\n");

describe("short prompt", () => {
  const prompt = buildInstallPrompt();

  test("is one short line that points at the hosted setup file", () => {
    expect(prompt).toBe("Set up megha for me: read https://t3-megha.vercel.app/setup.md and follow it.");
    expect(prompt).not.toContain("\n");
  });

  test("its URL is this site's, and its path is a file in public/", () => {
    const url = new URL(prompt.match(/https:\/\/\S+?(?=\s|$)/)![0]);
    expect(url.origin).toBe(SITE_URL);
    expect(url.pathname).toBe(SETUP_PATH);
    expect(existsSync(join(SITE_ROOT, "public", url.pathname))).toBe(true);
  });
});

describe("setup.md", () => {
  const section = (n: number) => {
    const start = setup.indexOf(`\n## ${n}. `);
    if (start < 0) throw new Error(`no step ${n}`);
    const end = setup.indexOf("\n## ", start + 1);
    return setup.slice(start, end < 0 ? undefined : end);
  };

  test("keeps the safety rules: no logins, no credential files, back up T3's settings", () => {
    expect(setup).toContain("Don't run the logins yourself");
    expect(setup).toContain("Never open, read, print or copy any token or credential file");
    expect(setup).toContain("~/.codex/auth.json");
    expect(setup).toContain("~/.claude/.credentials.json");
    expect(setup).toContain("Make a backup copy of T3 Code's settings.json before you edit it");
    expect(section(5)).toContain("Make a backup copy of the file");
  });

  test("installs with npm, runs doctor, and stops on Node, install and git failures", () => {
    expect(section(1)).toContain("Node.js 22 or newer");
    expect(section(1)).toContain("stop and tell the user");
    expect(INSTALL_COMMAND).toBe("npm install -g t3-megha");
    expect(section(2)).toContain(INSTALL_COMMAND);
    expect(section(2)).toContain("stop and show the user the error");
    expect(section(3)).toContain("megha doctor");
    expect(section(3)).toContain("It is a local check");
    expect(section(3)).toContain("If node or git fails, stop.");
    expect(section(3)).toContain("A missing login only matters for a cloud the user will use");
  });

  test("finds both paths with node and npm root -g, and checks megha runs before any edit", () => {
    const paths = section(4);
    expect(paths).toContain(NODE_PATH_COMMAND);
    expect(paths).toContain(NPM_ROOT_COMMAND);
    expect(paths).toContain(meghaCheckCommand("<megha path>"));
    expect(paths).toContain("don't edit any settings");
    expect(setup.indexOf(meghaCheckCommand("<megha path>"))).toBeLessThan(setup.indexOf("## 5."));
  });

  test("has the exact T3 and Zed snippets the site generates", () => {
    expect(section(5)).toContain(t3SettingsSnippet(PLACEHOLDER_PATHS));
    expect(section(6)).toContain(zedSettingsSnippet(PLACEHOLDER_PATHS));
    expect(section(5)).toContain("write each Windows backslash as `\\\\`");
    expect(section(5)).toContain("Settings → Providers → Add provider → Local ACP command");
  });

  test("its T3 entries use the acpRegistry driver, a local source and node as the command", () => {
    const json = section(5).match(/```json\n([\s\S]*?)```/)![1];
    const entry = JSON.parse(json).providerInstances["megha-codex"];
    expect(entry).toEqual({
      driver: "acpRegistry",
      displayName: "Codex Cloud",
      config: { source: "local", commandPath: "<node path>", commandArgs: ["<megha path>", "--backend", "codex"] },
    });
  });

  test("hands the browser setup for each cloud to the user", () => {
    const left = section(7);
    expect(left).toContain("you can't do it for them");
    expect(left).toContain(CODEX_CONNECT_URL);
    expect(left).toContain(`open ${CLAUDE_CODE_URL} once`);
    expect(left).toContain(`Claude GitHub App (${CLAUDE_GITHUB_APP_URL})`);
    expect(left).toContain("A Claude session started from a bundle can't push a branch");
  });

  test("links the repo and the npm package, which is t3-megha", () => {
    expect(setup).toContain(REPO_URL);
    expect(NPM_URL).toBe("https://www.npmjs.com/package/t3-megha");
    expect(setup).toContain(NPM_URL);
    expect(section(4)).toContain("`t3-megha/index.mjs`");
    expect(setup).not.toMatch(/install -g megha\b/);
  });
});

describe("config snippets", () => {
  test("T3 settings for Windows round-trip to the exact node.exe and index.mjs paths", () => {
    const parsed = JSON.parse(t3SettingsSnippet(EXAMPLE_PATHS.windows));
    expect(parsed.providerInstances["megha-codex"]).toEqual({
      driver: "acpRegistry",
      displayName: "Codex Cloud",
      config: {
        source: "local",
        commandPath: "C:\\Program Files\\nodejs\\node.exe",
        commandArgs: ["C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\t3-megha\\index.mjs", "--backend", "codex"],
      },
    });
    expect(parsed.providerInstances["megha-claude"].config.commandArgs[2]).toBe("claude");
  });

  test("Zed settings declare two custom agent servers", () => {
    const parsed = JSON.parse(zedSettingsSnippet(EXAMPLE_PATHS.macos));
    expect(parsed.agent_servers["Claude Code on the web"]).toEqual({
      type: "custom",
      command: "/opt/homebrew/bin/node",
      args: ["/opt/homebrew/lib/node_modules/t3-megha/index.mjs", "--backend", "claude"],
      env: {},
    });
  });
});

describe("paths", () => {
  test("megha path joins npm root with the OS separator and ignores a trailing slash", () => {
    expect(meghaPathFrom("C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\", "windows")).toBe(
      EXAMPLE_PATHS.windows.megha,
    );
    expect(meghaPathFrom("/usr/lib/node_modules/", "linux")).toBe(EXAMPLE_PATHS.linux.megha);
  });

  test("every example megha path matches its npm root", () => {
    for (const os of ["windows", "macos", "linux"] as const) {
      expect(meghaPathFrom(EXAMPLE_PATHS[os].npmRoot, os)).toBe(EXAMPLE_PATHS[os].megha);
    }
  });

  test("detects the OS from real user agents", () => {
    expect(detectOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/155.0 Safari/537.36")).toBe("windows");
    expect(detectOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15")).toBe("macos");
    expect(detectOs("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("linux");
  });
});
