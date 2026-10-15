# Site page

The one public page: a headline, a "Copy install prompt" button, a drawn T3 thread running in the cloud (the thread mock), the install section, what you need, a support table, an "unofficial" note and a closing call to copy the prompt. It follows the system color scheme.

## Sub-features

- `hero` headline "Run T3 Code threads on Codex Cloud and Claude Code on the web", the copy button and "Read the prompt first" link to `#install`.
- `mock` the thread mock (an image with an accessible description) with a short log reveal on load, skipped with reduced motion.
- `sections` "Install with one prompt", needs, support table (icons labelled "Works" / "Doesn't work"), unofficial note, closing section.
- `nav` the Main nav: Install (hidden under 640 px), GitHub (`https://github.com/kausthubh-coder/megha`), npm (`https://www.npmjs.com/package/megha`).
- `schemes` light and dark from `prefers-color-scheme`.
- `responsive` no horizontal scroll at 390; the mock shows on the first screen at 390 and 1440.

## How to get to it (user POV)

- Open the site URL on a phone or a desktop, in light or dark mode.

## Driving it with site-check

Preconditions: the site runs on this checkout's port and answers 200 (SKILL.md, "The site").

- **All sizes and schemes.** Run `node .agents/skills/verify-megha/scripts/site-check.mjs http://localhost:<port>/ --no-drive`. Every line `ok`; four `home-<390|1440>-<light|dark>.png` and `.aria.yml` in the evidence folder.
- **Look.** Open the screenshots of the sections you changed, in both schemes and both sizes. Compare against `.critly/direction.md` in `apps/site` (palette, type, one accent, shadow only on the mock).
- **Structure.** The `.aria.yml` shows the `navigation "Main"` with three links, `heading "Run T3 Code threads..." [level=1]`, the `img` with the mock's description, and the section headings at level 2.
- **Reduced motion.** When the mock's animation changed: in a Playwright script, `browser.newContext({ reducedMotion: "reduce" })`, load, screenshot at once; the full log is there without waiting.

## Gotchas

- Next's dev indicator (a dark "N" button, bottom left) appears in dev screenshots only.
- The GitHub and npm links 404 until the repo is public and the package is published; that is expected before the first release.
- The page is statically rendered with `cacheComponents`; a change that only shows after hydration can differ between the first paint and the screenshot, so check the ARIA snapshot too.
