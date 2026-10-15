import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CODE_URL,
  CLAUDE_GITHUB_APP_URL,
  CODEX_CONNECT_URL,
  EXAMPLE_PATHS,
  buildInstallPrompt,
  detectOs,
  meghaPathFrom,
  t3SettingsSnippet,
  zedSettingsSnippet,
} from "./install";

describe("install prompt", () => {
  const prompt = buildInstallPrompt();

  test("installs from npm, runs doctor, and finds both paths", () => {
    expect(prompt).toContain("npm install -g megha");
    expect(prompt).toContain("megha doctor");
    expect(prompt).toContain('node -p "process.execPath"');
    expect(prompt).toContain("npm root -g");
  });

  test("adds one T3 provider per backend, with the paths left for the agent to fill", () => {
    const entry = (id: string) => {
      const line = prompt.split("\n").find((l) => l.trimStart().startsWith(`"${id}":`));
      if (!line) throw new Error(`no ${id} line in the prompt`);
      return JSON.parse(line.slice(line.indexOf(":") + 1).replace(/,$/, ""));
    };
    expect(entry("megha-codex").config).toEqual({
      source: "local",
      commandPath: "<node path>",
      commandArgs: ["<megha path>", "--backend", "codex"],
    });
    expect(entry("megha-claude").config.commandArgs[2]).toBe("claude");
    expect(prompt).toContain("write each Windows backslash as \\\\");
    expect(prompt).toContain("Settings → Providers → Add provider → Local ACP command");
  });

  test("tells the agent to leave logins and credentials alone, and to back up T3's settings", () => {
    expect(prompt).toContain("Don't run the logins yourself");
    expect(prompt).toContain("don't open or print any token or credential files");
    expect(prompt).toContain("Make a backup copy");
  });

  test("stops on Node, install and git failures, but not on a login for an unused cloud", () => {
    expect(prompt).toContain("If it's missing or older, stop");
    expect(prompt).toContain("If it fails, stop and show me the error");
    expect(prompt).toContain("If node or git fails, stop");
    expect(prompt).toContain("A missing login only matters for a cloud I'll use");
  });

  test("checks the megha path runs before any settings are edited", () => {
    const check = prompt.indexOf('node "<megha path>" --version');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(prompt.indexOf("Make a backup copy"));
  });

  test("says doctor is local and hands the browser setup for each cloud to the user", () => {
    expect(prompt).toContain("It is a local check");
    expect(prompt).toContain("what I still have to do myself in a browser");
    expect(prompt).toContain(CODEX_CONNECT_URL);
    expect(prompt).toContain(`open ${CLAUDE_CODE_URL} once`);
    expect(prompt).toContain(`Claude GitHub App (${CLAUDE_GITHUB_APP_URL})`);
    expect(prompt).toContain("A Claude session started from a bundle can't push a branch");
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
        commandArgs: ["C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\megha\\index.mjs", "--backend", "codex"],
      },
    });
    expect(parsed.providerInstances["megha-claude"].config.commandArgs[2]).toBe("claude");
  });

  test("Zed settings declare two custom agent servers", () => {
    const parsed = JSON.parse(zedSettingsSnippet(EXAMPLE_PATHS.macos));
    expect(parsed.agent_servers["Claude Code on the web"]).toEqual({
      type: "custom",
      command: "/opt/homebrew/bin/node",
      args: ["/opt/homebrew/lib/node_modules/megha/index.mjs", "--backend", "claude"],
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
