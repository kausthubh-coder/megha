#!/usr/bin/env node
// Open the megha site in real Chrome at 390 and 1440 px in light and dark, check the page, and drive the
// install section (copy the prompt, switch OS tabs). Evidence: a full-page screenshot and an ARIA snapshot
// per size and scheme, plus summary.json.
//
//   node .agents/skills/verify-megha/scripts/site-check.mjs <url> [--out <dir>] [--no-drive]
//
// <url> is the dev server (http://localhost:<PORT>/) or a deployed URL. Default --out:
// %TEMP%/megha-verify/<stamp>-site. Exit 1 when any check fails.
// Playwright and the browser come from scripts/browser.mjs: system Chrome when installed, else Playwright's
// Chromium (on a cloud VM, the one under PLAYWRIGHT_BROWSERS_PATH).

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchBrowser } from "../../../../scripts/browser.mjs";

const argv = process.argv.slice(2);
const url = argv.find((a) => !a.startsWith("--"));
if (!url) { console.error("usage: site-check.mjs <url> [--out <dir>] [--no-drive]"); process.exit(2); }
const outIdx = argv.indexOf("--out");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const out = resolve(outIdx >= 0 ? argv[outIdx + 1] : join(tmpdir(), "megha-verify", `${stamp}-site`));
const drive = !argv.includes("--no-drive");
mkdirSync(out, { recursive: true });

const browser = await launchBrowser().catch((e) => { console.error(e.message); process.exit(2); });
const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`); };

for (const colorScheme of ["light", "dark"]) {
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    const tag = `${width}-${colorScheme}`;
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme, deviceScaleFactor: width < 500 ? 2 : 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`); });
    const res = await page.goto(url, { waitUntil: "load" });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400); // the thread mock's log reveal
    check(`${tag} status`, res?.ok(), String(res?.status()));
    const h1 = (await page.locator("h1#hero-title").innerText().catch(() => "")).trim();
    check(`${tag} headline`, h1.startsWith("Run T3 Code threads"), h1.slice(0, 60));
    const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
    check(`${tag} color-scheme applied`, scheme.includes(colorScheme), scheme);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`${tag} no horizontal scroll`, overflow <= 0, `${overflow}px wider than the viewport`);
    // The hero shows the whole prompt with its copy button, above the fold.
    const heroPrompt = page.locator("#hero-prompt");
    check(`${tag} hero prompt visible`, await heroPrompt.isVisible());
    const copyBtn = page.getByRole("button", { name: "Copy prompt" }).first();
    const box = await copyBtn.boundingBox();
    check(`${tag} hero copy button above the fold`, !!box && box.y + box.height <= height, box ? `bottom at ${Math.round(box.y + box.height)}px` : "not found");
    await page.screenshot({ path: join(out, `home-${tag}.png`), fullPage: true });
    writeFileSync(join(out, `home-${tag}.aria.yml`), await page.locator("body").ariaSnapshot());
    check(`${tag} no console or page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
    await ctx.close();
  }
}

if (drive) {
  // Copy the install prompt: what lands on the clipboard must be exactly the prompt the page shows.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load" });
  await page.getByRole("button", { name: "Copy prompt" }).first().click();
  const live = page.locator('[aria-live="polite"]', { hasText: "Copied to clipboard" }).first();
  check("copy: live region says Copied to clipboard", await live.waitFor({ state: "attached", timeout: 3000 }).then(() => true, () => false));
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const shown = await page.locator("#hero-prompt").innerText();
  const norm = (s) => s.replace(/\r\n/g, "\n").trim();
  check("copy: clipboard equals the prompt on the page", norm(clip) === norm(shown), `clipboard ${clip.length} chars, shown ${shown.length}`);
  check("copy: prompt points at the hosted setup", clip.includes("/setup.md"));
  await page.screenshot({ path: join(out, "copy-copied-1440-light.png") });

  // OS tabs in "Or set it up by hand": click switches the panel, arrow keys move selection and focus.
  const tabs = page.getByRole("tablist", { name: "Operating system" });
  const before = await page.locator("#os-panel").innerText();
  await tabs.getByRole("tab", { name: "macOS" }).click();
  check("tabs: macOS selected after click", (await tabs.getByRole("tab", { name: "macOS" }).getAttribute("aria-selected")) === "true");
  const mac = await page.locator("#os-panel").innerText();
  check("tabs: panel text changed for macOS", mac !== before);
  await page.keyboard.press("ArrowRight");
  const linux = tabs.getByRole("tab", { name: "Linux" });
  check("tabs: ArrowRight selects and focuses Linux", (await linux.getAttribute("aria-selected")) === "true" && (await linux.evaluate((el) => el === document.activeElement)));
  await page.locator("#install").screenshot({ path: join(out, "install-linux-1440-light.png") });
  writeFileSync(join(out, "install.aria.yml"), await page.locator("#install").ariaSnapshot());
  await ctx.close();
}

await browser.close();
const ok = checks.every((c) => c.ok);
writeFileSync(join(out, "summary.json"), JSON.stringify({ url, ok, checks }, null, 2));
console.log(`${ok ? "PASSED" : "FAILED"}  evidence: ${out}`);
process.exit(ok ? 0 : 1);
