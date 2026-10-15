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

## Trademarks

The OpenAI logo is a trademark of OpenAI. The Claude logo is a trademark of Anthropic. Megha uses them only
to show which cloud a provider runs on. Megha is not affiliated with or endorsed by OpenAI or Anthropic. The
logo paths are copied from T3 Code (`apps/web/src/components/Icons.tsx`).
