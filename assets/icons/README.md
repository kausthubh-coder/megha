# Icons

The megha mark and the two provider icons. `build.mjs` writes everything here from code; edit it, not the SVGs.

```
node assets/icons/build.mjs          # SVGs, png/<name>-<size>.png, and the site favicons in apps/site/app/
node assets/icons/build.mjs --sheet  # also writes apps/site/screenshots/icons-sheet.png to check small sizes by eye
```

sharp is resolved from `apps/site` (a dev dependency there), so run `bun install` first.

| File | What it is |
|---|---|
| `megha.svg` | The mark in ink, for light backgrounds |
| `megha-on-dark.svg` | The mark in pale ink, for dark backgrounds |
| `megha-accent.svg` | Ink cloud with a megha-blue tail |
| `favicon.svg` | The mark, switching ink with `prefers-color-scheme` (same as `apps/site/app/icon.svg`) |
| `codex-cloud.svg`, `codex-cloud-on-dark.svg` | OpenAI logo with the megha badge, black and white versions |
| `claude-cloud.svg` | Claude logo with the megha badge |
| `png/` | Each of the above at 16, 32, 64, 128, 256 and 512 px, plus `apple-touch-icon-180.png` |

The mark is a cloud whose base runs out into a speech-bubble tail: a thread that runs in the cloud. Colors:
ink `#18202e`, pale `#eef2f8`, megha blue `#2f6fd6`.

## ACP Registry icons

`registry/` holds the 16x16 monochrome glyphs the ACP Registry requires (`fill="currentColor"` only):
`megha-codex.svg` (the cloud with a hex nut cut out) and `megha-claude.svg` (the cloud with a
four-point spark cut out). Neither uses the OpenAI or Anthropic logo. `node assets/icons/registry/build.mjs`
writes them, copies them to `assets/registry/<id>/icon.svg`, and renders `registry/contact-sheet.png`
(16, 32 and 64 px on light and dark, plus the 16 px pixels zoomed) to check them by eye.

## Trademarks

The OpenAI logo is a trademark of OpenAI. The Claude logo is a trademark of Anthropic. Megha uses them only
to show which cloud a provider runs on. Megha is not affiliated with or endorsed by OpenAI or Anthropic. The
logo paths are copied from T3 Code (`apps/web/src/components/Icons.tsx`).
