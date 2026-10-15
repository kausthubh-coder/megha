# Megha

Megha runs T3 Code threads (or any ACP client's sessions) on Codex Cloud and Claude Code on the web, using the user's
existing `codex` and `claude` logins. It is an ACP agent (`packages/megha`, published to npm as `megha`) plus a small
Next.js site (`apps/site`) that explains it and gives an install prompt. What users care about most: a cloud task starts
from their editor and its progress shows up reliably. Stack: Node 22+ ESM for the agent, Next.js + Tailwind for the
site, bun for development.

## Words we use

- **you**: the agent reading this file.
- **me**: the developer you are working for.
- **user**: a person who installs megha. Not me.
- **backend**: one cloud, `codex` (Codex Cloud, `chatgpt.com/backend-api/wham`) or `claude` (Claude Code on the web, `api.anthropic.com/v1/sessions`).
- **client**: the app that launches megha over ACP, usually T3 Code. T3 runs one megha process per thread.
- **environment**: a cloud's per-repo container config (Codex) or execution environment (Claude).

## Map

| Where | What lives there |
|---|---|
| `packages/megha/index.mjs` | ACP entry: initialize, session/new, prompt, cancel, list, load, config options |
| `packages/megha/lib/codex.mjs` | Codex Cloud backend |
| `packages/megha/lib/claude.mjs` | Claude Code on the web backend |
| `packages/megha/lib/diff.mjs`, `lib/util.mjs` | cloud diff + local apply; logging, session store, git, SSE |
| `packages/megha/test/` | `offline.mjs` (no network, runs in `bun run test`), `smoke.mjs` (live, read-only), `e2e.mjs` (live, creates a task) |
| `apps/site/` | the public site; feature code under `apps/site/features/<name>` |
| `assets/icons/` | megha mark and the Codex/Claude provider icons |
| `docs/` | reverse-engineering notes for both clouds and T3 (`research-*.md`) |

## Commands

- Install: `bun install`
- Setup a fresh worktree: `bun run setup`
- Doctor: `bun run doctor` (checks deps, both CLI logins, port)
- Site dev: `bun run dev` (port from `PORT`; ready when Next prints `Ready`)
- Agent tests (offline): `bun run test`
- Agent smoke against live clouds (read-only, creates nothing): `bun run --filter megha smoke`
- Full check (CI runs this): `bun run check`

## Start and ship

- Every task in a new worktree starts with the `worktree-megha` skill. Never two agents in one checkout.
- Ship only with the `ship-megha` skill, and only when I say ship, deploy or release.

## Proving a change works

- Done means you saw it work. For the agent: run it the way T3 does (`node packages/megha/index.mjs --backend codex|claude`, cwd = a real GitHub repo) and read the session/update stream. For the site: open it in a browser.
- Live cloud tasks cost the user's quota. Use read-only smoke tests by default; create a cloud task only when the change needs one, with a read-only prompt.
- A skipped check is not a pass. Report what you ran, what you saw, and what you did not check.

## Working with me

- A question gets an answer, not an action. When I ask for a plan, plan.
- Edit files with your edit tool, not shell one-liners (Windows quoting breaks them, especially backslashes).

## How we write code

- Boring and explicit. Names you can grep. Comments say why.
- The cloud APIs are undocumented. Every endpoint, header and body shape must match `docs/research-*.md`; update those notes when you learn something new.

## Rules and what enforces them

| Rule | Enforced by |
|---|---|
| Never print or write OAuth tokens, task JSON with `env_vars`/`secrets`, or account ids | `test/offline.mjs` scans fixtures; review |
| Never refresh the CLIs' OAuth tokens (refresh tokens rotate and would log the CLI out) | nothing yet |
| stdout is the ACP channel; logs go to stderr only | `test/offline.mjs` |

## Safety

- Never touch the user's CLI credentials (`~/.codex/auth.json`, `~/.claude/.credentials.json`) except to read the access token.
- Production needs my explicit go: npm publish, Vercel production deploys, ACP Registry submissions.
- No secrets in code, logs, screenshots or commits.
- Git: public repo. Open a PR and wait for CI and my review.
