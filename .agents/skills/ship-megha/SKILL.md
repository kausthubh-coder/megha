---
name: ship-megha
description: Take verified megha work to main and, on my go, to production (npm package, Vercel site, the main checkout my T3 runs, later the ACP Registry), then leave main and the worktree list clean. Use only when I say ship, deploy, release, publish, or merge and deploy.
---

# Ship megha

megha ships from `main` on `kausthubh-coder/megha` (public) to these surfaces:

| Surface | What ships it | When |
|---|---|---|
| `main` | a PR, CI green on ubuntu, macos and windows (`.github/workflows/ci.yml`), squash merge | every change |
| npm package `megha` | `npm publish` from `packages/megha` at the merge commit, plus tag `v<version>` | when `packages/megha` changed and its version was bumped |
| site (Vercel) | Vercel's Git integration on push to `main` if connected, else `vercel deploy --prod` | when `apps/site` changed |
| my T3 | `git pull --ff-only` in the main checkout: `codexCloud`/`claudeCloud` run its `packages\megha\index.mjs` | after every merge that touches `packages/megha` |
| ACP Registry | a PR to `agentclientprotocol/registry` ([registry.md](registry.md)) | once, later; then it follows npm by itself |

`<main>` below is `C:\Users\kaust\OneDrive\Documents\dev\megha`.

**First release.** If `git -C <main> remote get-url origin` fails, `npm view t3-megha version` returns 404, or `vercel` isn't installed or linked, read [first-release.md](first-release.md) first: it lists the one-time steps only I can do, and what changes in the steps below.

**Rules.**
- Production needs my go in this conversation. "Ship" (or deploy, release) is that go for every step below that I named, including the merge, the Vercel deploy it triggers, the main checkout pull and cleanup: don't stop to ask between steps.
- `npm publish` and the ACP Registry PR are the exceptions: each needs its own go, by name ("publish", "release to npm", "submit to the registry"). "Ship" alone never covers them. Launching T3 cloud threads also needs my go (it costs quota).
- When a step fails because of this change (a failing check, a CI job, a build or deploy error), fix it, rerun the checks and carry on. Stop and tell me only when the cause is outside the change or the fix needs my decision.
- Never end the turn while a CI run, build or deploy you started is queued or running. Watch it to the end.
- Never force-push, skip or disable checks, raise a warning cap to get through, or push to `main` directly.
- Write the rollback (end of this file) into your notes before step 2.

## 1. Ready

1. `git fetch origin`; `git status --short` prints nothing; `git rev-list --count HEAD..origin/main` is 0 (else `git merge origin/main` and resolve).
2. `bun run check` exits 0 (offline agent tests, site lint, typecheck, build; about a minute).
3. Every changed surface has `verify-megha` evidence: ACP drive transcripts for the agent (and a cloud turn if the turn path changed), site-check screenshots for the site. Missing evidence means not ready.
4. List what's going out: `git log --oneline origin/main..HEAD` and `git diff --stat origin/main...HEAD`. Name the surfaces: `packages/megha` → npm and my T3; `apps/site` → Vercel; `docs/`, `.agents/`, `.github/` → `main` only.
5. **Release only:** bump the version in this PR. Edit `"version"` in `packages/megha/package.json` with your edit tool (`npm version` here runs a full npm install of the workspace and writes a `package-lock.json`), then:
   ```
   bun install                       # updates the workspace version recorded in bun.lock
   npm view t3-megha version         # must be lower than the new version (404 before the first publish)
   cd packages/megha && npm publish --dry-run   # name t3-megha, the new version, 16 files: LICENSE, README.md, index.mjs, lib/*.mjs (12), package.json
   ```
   Commit `packages/megha/package.json` and `bun.lock` together, and nothing else from the bump (no `package-lock.json`).

## 2. Land

```
git push -u origin <branch>
gh pr create --fill --base main
gh pr checks <pr> --watch --fail-fast       # three CI jobs plus the Vercel preview; give up after 20 minutes
```

A red check caused by this change: fix it on the branch, rerun `bun run check`, push, watch again. When all checks are green and I said ship, merge:

```
gh pr merge <pr> --squash
gh pr view <pr> --json mergeCommit -q .mergeCommit.oid      # <sha>, used below
```

Leave out `--delete-branch`: gh would try to check out `main` in this worktree, which the main checkout holds. Step 6 deletes the branch.

**From a cloud session** (`## Cloud sessions` in AGENTS.md) `gh pr` doesn't work; `gh api` does. Run these outside the checkout (`cd /tmp`) so gh doesn't read the repo's remotes:

```
gh api repos/kausthubh-coder/megha/pulls -f head=<branch> -f base=main -f title="<title>" -F body=@<body.md> --jq .number   # <pr>
gh api repos/kausthubh-coder/megha/commits/<head sha>/check-runs --jq '.check_runs[] | [.name,.status,.conclusion] | @tsv'
                                            # poll every 30 s until all three "check (<os>)" runs are completed; all success
gh api repos/kausthubh-coder/megha/commits/<head sha>/status --jq '.statuses[] | [.context,.state] | @tsv'   # Vercel preview
gh api -X PUT repos/kausthubh-coder/megha/pulls/<pr>/merge -f merge_method=squash --jq .sha                  # <sha>
```

A failed job's log: `gh api repos/kausthubh-coder/megha/actions/runs/<run id>/jobs --jq '.jobs[] | [.name,.conclusion,.id] | @tsv'`, then `gh api repos/kausthubh-coder/megha/actions/jobs/<job id>/logs`. Re-running a job is refused from the cloud (403 from `gh api` and the GitHub MCP tools), so a failure outside this change (seen 2026-10-15: `next build` on ubuntu failing with "next/font/google queries have exactly one entry" while Google Fonts misbehaved, main and a local cold build green) needs a new real commit or my re-run. Never an empty commit.

## 3. Release and deploy

Package first: the site tells users `npm install -g t3-megha`.

1. **npm** (release only, on my go). Publish from the exact merge commit, not this branch's pre-squash HEAD:
   ```
   git fetch origin
   git checkout --detach origin/main            # HEAD = <sha>
   git status --short                           # nothing
   cd packages/megha
   npm publish --dry-run                        # name megha, the new version, the file list from step 1.5
   npm publish                                  # opens the browser for my npm 2FA; tell me it's waiting
   cd ../..
   git tag -a v<version> -m "megha <version>" <sha>
   git push origin v<version>
   gh release create v<version> --generate-notes --verify-tag
   ```
2. **Site.** Vercel's Git integration is connected (2026-10-15): every merge to `main` deploys production, whatever it changed, so watch it on every ship.
   - Git integration connected: the merge already started the deploy. Poll every 30 s, at most 10 minutes: `gh api repos/kausthubh-coder/megha/commits/<sha>/status -q '.statuses[] | select(.context | test("Vercel")) | .state'`. Done at `success`; stop at `failure` or `error`.
   - Not connected: from the repo root at `<sha>` (step 3.1's detached checkout, or `git checkout --detach origin/main`), `vercel deploy --prod`. It prints the deployment URL and waits for the build; done when it prints the production URL. `vercel inspect <url>` shows the state if the wait was cut off.
3. **ACP Registry**: never part of a normal ship. Follow [registry.md](registry.md) when I ask for it.

## 4. Check production

Read only.

- npm: `npm view t3-megha version` is the new version; `npx -y t3-megha@<version> --version` prints it; `npx -y t3-megha@<version> doctor` runs (it reads logins, prints no tokens).
- Site: `curl -s -o /dev/null -w "%{http_code}" <production url>` is 200, and `node .agents/skills/verify-megha/scripts/site-check.mjs <production url>` passes. Look at the screenshots of what changed.

## 5. Update the main checkout (my T3)

From a cloud session the main checkout isn't reachable: skip this step and list it in the report.

Pulling is a deploy: every new T3 thread on Codex Cloud or Claude Cloud runs the pulled code. Threads already open keep their old process until restarted.

- If `git -C <main> status --short` prints nothing and `git -C <main> branch --show-current` is `main`: `git -C <main> pull --ff-only`, then `bun install --frozen-lockfile` in `<main>`.
- If it's dirty or on another branch: leave it, and tell me my T3 still runs the old megha.
- If `packages/megha` changed, offer a T3 check (`verify-megha`, features/t3-thread.md). It creates a cloud task, so only on my go.

## 6. Clean up

- `git push origin --delete <branch>`, then `git -C <main> branch -D <branch>` (possible once this worktree is detached from it). From a cloud session: `git push origin --delete <branch>` only; the VM is thrown away with its clone.
- This thread can't remove its own worktree: list it for removal (`worktree-megha`, "Remove a worktree"). Remove other finished worktrees only if no live thread uses them (`t3_thread_list`).

## 7. Report

A few lines: the PR and merge commit; what went live where (npm version and tag, site URL, main checkout pulled or not); the evidence (CI run, verify-megha folders, production checks); anything skipped or waiting on me.

## Rollback

- **Code:** `git revert <sha>` on a new branch, PR, CI, merge; then pull the main checkout (step 5) so my T3 runs the revert.
- **npm:** `npm dist-tag add t3-megha@<previous> latest`, then publish a fixed patch. Don't unpublish.
- **Site:** `vercel rollback` (or promote the previous production deployment in the Vercel dashboard), then fix forward with a PR.
- **Registry:** the listing follows npm's `latest`, so the npm dist-tag move covers it.
