---
name: worktree-megha
description: Make a megha checkout ready to work in, isolated from other checkouts and from my live T3 cloud threads. Use at the start of every task in a new worktree, when deps, port, logins or the skills link look wrong, and before giving a helper agent its own checkout.
---

# Worktree setup for megha

## Setup and doctor

From the checkout root:

```
bun run setup     # bun install --frozen-lockfile, then prints a free PORT
bun run doctor    # read-only: node, git, deps vs bun.lock, codex + claude logins, gh auth, PORT, commits behind origin/main
```

Setup takes about 15 s in a fresh worktree (712 packages) and about 1 s when nothing changed. A healthy doctor is eight `ok` lines and exit 0:

```
ok    node          24.19.0
ok    git           git version 2.55.0.windows.3
ok    deps          14 direct dependencies match bun.lock
ok    codex login   ChatGPT sign-in found, token valid for 5 days
ok    claude login  claude.ai login found, token valid for 1 h
ok    gh auth       signed in to github.com
ok    port          PORT 3000 is free
ok    origin/main   up to date
```

A FAIL prints its fix. Login FAILs: tell me to run `codex login status` or `claude auth status`; never refresh the tokens yourself (the refresh token rotates and logs the CLI out).

Then link the skills, which setup doesn't do yet (`.claude/skills` is not in git, so new worktrees lack it):

```
cmd /c mklink /J .claude\skills .agents\skills
```

## Port: pick it yourself

The site is the only thing that binds a port. Setup's port pick is not per-checkout yet, and its check misses Next on Windows: Next listens on `0.0.0.0` and `[::]`, setup and doctor test-bind only `127.0.0.1`, and Windows allows that, so both report a busy port as free (seen 2026-10-14 with two worktrees on 3000).

1. Take the number setup prints. If you are in a worktree and it printed 3000, use a number in 3100-3899 instead (3000 is the main checkout's).
2. `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<n>/` must print `000`. Anything else: someone serves there, try the next number.
3. Pass it on every command: `PORT=<n> bun run dev` (Bash) or `$env:PORT=<n>; bun run dev` (PowerShell). `next dev` reads `PORT` only from the process environment, never from `.env` files.
4. Give the number to anyone you hand the checkout to. `verify-megha` shows how to start dev with a PID you can stop.

## What is shared, and how to stay off it

There is no backend, database or env file to copy; the site is static and the agent talks to the clouds directly. What checkouts do share:

- **megha's data dir** `%LOCALAPPDATA%\megha` (session map, thread hints, model caches). My live T3 cloud threads use it. Any agent you start by hand gets `MEGHA_DATA_DIR=<throwaway folder>`; `verify-megha`'s `acp-drive.mjs` does this for you. `bun run --filter t3-megha smoke` does not, and adds a local session record there (harmless, but know it).
- **The CLI logins** `~/.codex/auth.json` and `~/.claude/.credentials.json`: read-only, always.
- **The cloud accounts.** A prompt creates a real task in my Codex or Claude account and costs quota. Read-only checks are free; see `verify-megha`.

## The main checkout

`C:\Users\kaust\OneDrive\Documents\dev\megha`. My T3 providers `codexCloud` and `claudeCloud` run `packages\megha\index.mjs` from there, so an edit in the main checkout changes my live cloud threads at once. Work only in worktrees and leave it alone. Only `ship-megha` touches it, with a fast-forward pull.

## Helpers

One worktree per helper agent, never two agents in one checkout:

```
git -C C:\Users\kaust\OneDrive\Documents\dev\megha fetch origin
git -C C:\Users\kaust\OneDrive\Documents\dev\megha worktree add C:\Users\kaust\.t3\worktrees\megha\<name> -b <name> origin/main
cd C:\Users\kaust\.t3\worktrees\megha\<name>
bun run setup
cmd /c mklink /J .claude\skills .agents\skills
```

Until the GitHub remote exists, use `main` instead of `origin/main` and skip the fetch. Give the helper the path and the port you picked for it.

## Remove a worktree

There is no remove script yet. From the main checkout, in this order:

1. Stop the processes you started in it, by PID with their children: `taskkill /T /F /PID <pid>`.
2. Delete the skills junction alone: `cmd /c rmdir C:\Users\kaust\.t3\worktrees\megha\<name>\.claude\skills` (plain `rmdir` removes the link, never the target).
3. `git -C C:\Users\kaust\OneDrive\Documents\dev\megha worktree remove C:\Users\kaust\.t3\worktrees\megha\<name>`. If it refuses because of build output, `--force` is fine for a merged or throwaway worktree.
4. If the folder is still there (Turbopack leaves junctions under `apps\site\.next`), `cmd /c rmdir /s /q <path>`; cmd's rmdir deletes junctions without following them.
5. `git -C C:\Users\kaust\OneDrive\Documents\dev\megha branch -D <branch>` once its PR is merged.

Remove a worktree only when its work is merged or I say so, and never one another live thread uses: check `t3_thread_list` for its path first. A thread can't remove its own worktree; list it in your report instead.

## T3

T3 makes worktrees under `C:\Users\kaust\.t3\worktrees\megha\`. Its "run setup on worktree create" is not wired for megha yet: project settings are folded, so T3 reads scripts only from `projectSettingsOverrides["mcp:3223fa55-4413-4ce6-9609-6bc00d09a61c"]` in `~/.t3/userdata/settings.json`, which has no entry. Until I add it, run `bun run setup` yourself first thing.
