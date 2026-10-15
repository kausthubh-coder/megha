// The browser that verify-megha's site-check drives. Google Chrome when it's installed (my Windows
// machine), so nothing gets downloaded there. Otherwise Playwright's Chromium: the build this Playwright
// wants if it's installed, else the one a cloud VM ships under PLAYWRIGHT_BROWSERS_PATH (its build may not
// match this Playwright, so it is passed as executablePath).
//
// megha has no Playwright dependency. loadPlaywright() takes `playwright` from wherever Node resolves it
// (a cloud VM has it globally), else the newest stable copy in the npx cache.
//
//   import { launchBrowser } from "../../scripts/browser.mjs";
//   const browser = await launchBrowser();
//
// Nothing here imports a dependency at load time: scripts/doctor.mjs and scripts/cloud.mjs import it
// before or without `bun install`.

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const CHROME = [
  join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  join(process.env["PROGRAMFILES(X86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  "/Applications/Google Chrome.app",
  "/usr/bin/google-chrome",
];

// The playwright module, or null when there is none.
export function loadPlaywright() {
  const req = createRequire(import.meta.url);
  for (const name of ["playwright", "playwright-core"]) { try { return req(name); } catch {} }
  let cache;
  try { cache = execSync("npm config get cache", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
  const npx = cache && join(cache, "_npx");
  const found = (npx && existsSync(npx) ? readdirSync(npx) : [])
    .map((d) => join(npx, d, "node_modules", "playwright"))
    .filter((dir) => existsSync(join(dir, "package.json")))
    .map((dir) => ({ dir, v: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version }))
    .filter((c) => !c.v.includes("-"))
    .sort((a, b) => b.v.localeCompare(a.v, undefined, { numeric: true }));
  return found.length ? req(found[0].dir) : null;
}

// { name, launch } where launch goes into chromium.launch(); null when there's no browser.
export function findBrowser(chromium = loadPlaywright()?.chromium) {
  if (CHROME.some((file) => isAbsolute(file) && existsSync(file))) return { name: "Google Chrome", launch: { channel: "chrome" } };
  let bundled = "";
  try { bundled = chromium?.executablePath() ?? ""; } catch {} // throws on hosts Playwright doesn't support
  if (bundled && existsSync(bundled)) return { name: `Playwright's Chromium (${bundled})`, launch: {} };
  const shipped = join(process.env.PLAYWRIGHT_BROWSERS_PATH ?? "", "chromium");
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(shipped))
    return { name: `the VM's Chromium (${realpathSync(shipped)})`, launch: { executablePath: shipped } };
  return null;
}

export async function launchBrowser(options = {}) {
  const playwright = loadPlaywright();
  if (!playwright) throw new Error("Playwright not found. Run `npx -y playwright@latest --version` once, then retry.");
  const browser = findBrowser(playwright.chromium);
  if (!browser) throw new Error("no browser: install Google Chrome, or run `npx -y playwright@latest install chromium`");
  return playwright.chromium.launch({ ...options, ...browser.launch });
}
