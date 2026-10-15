---
name: verify-megha
description: "Prove a megha change works on its real surfaces: drive the ACP agent the way T3 Code does (read-only by default, real cloud turns only on krida), run it inside a real T3 thread through the codexCloud and claudeCloud providers, and check the site in Chrome at 390 and 1440 px in light and dark. Use before saying any change to packages/megha or apps/site is done, and when a cloud thread or the site looks wrong."
---

# Verify megha

megha has two surfaces. Pick by what changed; a change to both needs both.

- **The agent** (`packages/megha`): a stdio ACP process. T3 Code spawns one per thread as `node.exe <checkout>\packages\megha\index.mjs --backend codex|claude` with cwd = the thread's repo. Three levels, cheapest first: the read-only ACP drive, a real cloud turn over ACP, a real T3 thread.
- **The site** (`apps/site`): one Next.js page. Run it on this checkout's port and check it in Chrome.

The feature map in [`features/README.md`](features/README.md) lists every user-facing feature and how to drive it. Read the feature file for what you changed before driving; a proof covers every entry point its file lists.

## Cost rules

- **Read-only is free.** initialize, session/new, set_config_option, session/list and session/load create nothing in either cloud. Use them freely.
- **A cloud turn costs the user's quota.** Run one only when the change is in the prompt/turn path (prompt, follow-up, cancel, steer, slash commands, streaming, diffs). Always on the krida repo (`C:\Users\kaust\OneDrive\Documents\dev\krida`, Codex environment labelled `krida`), always a read-only prompt that ends "Do not change any files.", always with "Apply diff locally" off. One turn per backend per proof, not a loop.
- Never touch `~/.codex/auth.json` or `~/.claude/.credentials.json` beyond what megha itself reads. When a login has expired, tell me to run `codex login status` or `claude auth status`; refreshing the tokens yourself logs the CLI out.

## Doctor

Run first, and again whenever anything looks off. All read-only.

```
bun run doctor                                  # deps vs bun.lock, node, git, both logins, gh, PORT, origin/main
node packages/megha/index.mjs doctor            # the agent's own view: node, git, both logins, data dir
```

A login line marked FAIL blocks only that backend. The Claude token lives about an hour; if it expired mid-run, the drive fails at session/new with a login message.

**Known doctor gap:** the PORT check test-binds `127.0.0.1` only, and Next listens on `0.0.0.0`/`[::]`, so on Windows it reports a port free while a dev server is on it (seen 2026-10-14). Before using a port, confirm nothing answers: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/` must print `000`.

## The agent over ACP

There is nothing to keep running: each drive spawns its own agent from this checkout and tears it down.

```
node .agents/skills/verify-megha/scripts/acp-drive.mjs --backend codex            # read-only: initialize, session/new, session/list
node .agents/skills/verify-megha/scripts/acp-drive.mjs --backend claude
node .agents/skills/verify-megha/scripts/acp-drive.mjs --backend codex --load <task_e_...>    # replay a cloud task (read-only)
node .agents/skills/verify-megha/scripts/acp-drive.mjs --backend codex --allow-cloud-task \
  --prompt "In two sentences, what does src/main.tsx render? Do not change files."           # ONE real turn on krida
node .agents/skills/verify-megha/scripts/acp-drive.mjs --backend claude --steps <file.json>   # custom sequence
```

- It sends T3's exact `initialize`, answers permission requests like T3's read-only test (allow read/search/fetch, reject the rest), and points `MEGHA_DATA_DIR` at a throwaway folder so the session store the live T3 threads use (`%LOCALAPPDATA%\megha`) stays untouched. `--shared-data` opts out, for bugs that need the real store.
- `--prompt` first sets apply=off and, on Codex, the `krida` environment and Ask mode. The script refuses `session/prompt` without `--allow-cloud-task` or outside krida, except a prompt that is exactly `/status` or `/open` (they only read the task): `--load <id> --steps .agents/skills/verify-megha/steps/load-status.json` replays a task and runs both, for free.
- Ready/healthy: every step prints `ok` and the last line is `PASSED  evidence: <dir>`. Exit 1 on a failed step or any non-JSON line on stdout (stdout is the protocol; a stray log line breaks T3).
- Steps files: a JSON array of `{method, params, notify, async, waitMs, timeoutMs, expectError}`; `"$sessionId"`, `"$cwd"` and `"$loadId"` (the `--load` value) are filled in. `async` sends without waiting, which is how to race a cancel or a steer against a running prompt. Examples are in the feature files.
- Also available, unchanged: `bun run --filter t3-megha smoke` (read-only, both backends, uses the shared data dir), `node packages/megha/test/e2e.mjs codex|claude` (ONE live turn, writes `test/e2e-<backend>.jsonl`), `node packages/megha/test/live-steer.mjs codex|claude` (one task, three turns: image + model, cancel, steer).

## The agent in real T3 Code

The T3 providers `codexCloud` ("Codex Cloud") and `claudeCloud` ("Claude Cloud") in `~/.t3/userdata/settings.json` run the **main checkout's** `packages\megha\index.mjs`. A T3 thread therefore tests what the main checkout has (merged and pulled), not your worktree.

- **After a ship, or for behavior already on main:** launch a thread on krida with T3's MCP tools.
  ```
  t3_thread_launch {
    "projectId": "c87a3bf3-c7ba-47a6-91ab-cda5ea2d2d7e",            // krida; omit workspaceStrategy = krida's root checkout
    "title": "megha verify: codex on krida",
    "modelSelection": { "instanceId": "codexCloud", "model": "default" },   // or claudeCloud
    "message": "List the three biggest files in src/ by line count and say in one sentence each what they do. Do not change any files."
  }
  t3_thread_wait  { "threadId": "<id>", "timeoutMs": 600000 }
  t3_thread_read  { "threadId": "<id>", "view": "activity", "maxCharsPerItem": 1500 }
  ```
  A follow-up is `t3_thread_send` on the same thread; a cancel is `t3_thread_interrupt`. Link the thread for me as `[title](t3-thread://v1/<threadId>)`.
- **Before merge, for this worktree's code:** T3 needs a provider pointed at the worktree. Ask me first. With my OK: back up `settings.json`, add a `meghaDevCodex` / `meghaDevClaude` entry copied from `codexCloud` with `commandArgs[0]` set to `<worktree>\packages\megha\index.mjs`, launch with that `instanceId`, and remove the entry afterwards. T3 reloads providers by itself. Write the file with a Node script using `String.raw` paths, never shell one-liners (backslashes break).
- What a working thread shows in `activity`: a `command_execution` titled "Ran command" whose text starts `$ Codex Cloud setup` (or the Claude equivalent), reasoning items, the tool calls the cloud ran, and an `assistant_message` ending in `[Open in Codex Cloud](https://chatgpt.com/codex/tasks/task_e_...)`. Status `completed`. Then `git -C C:\Users\kaust\OneDrive\Documents\dev\krida status --short` is unchanged from before the run.
- Proven working on 2026-10-14: threads "Cloud test: Codex Cloud on krida" (`mcp:af758377-70ec-464c-9669-1903e3672f22`) and "Cloud test: Claude Cloud on krida" (`mcp:66265872-2b66-4661-af4f-65bd5fcd516a`) in the krida project. Read them to see a good transcript.

## The site

Launch on this checkout's port, in PowerShell so you hold the real Windows PID:

```
bun run setup                     # prints PORT=<n>; confirm with curl that nothing answers on it (doctor gap above)
$log = "$env:TEMP\megha-site-<n>.log"
$p = Start-Process cmd.exe -ArgumentList '/c', "set PORT=<n>&& bun run dev > `"$log`" 2>&1" -WorkingDirectory <checkout> -WindowStyle Hidden -PassThru
$p.Id                             # keep this PID for cleanup
```

On Linux or macOS (a cloud session), start it in its own process group so stopping the group stops Next too:

```
PORT=<n> setsid bash -c 'echo $$ > /tmp/megha-site-<n>.pgid; exec bun run dev' > /tmp/megha-site-<n>.log 2>&1 < /dev/null &
```

Ready when the log prints `Ready in` (about 15 s cold, 3 s warm; under 1 s on a cloud VM). Healthy: `curl -s http://localhost:<n>/ | grep -o "Run T3 Code threads"` prints the phrase. `next dev` reads `PORT` only from the process environment, never from `.env` files.

Then:

```
node .agents/skills/verify-megha/scripts/site-check.mjs http://localhost:<n>/
```

It loads the page in Chrome (on a cloud VM, Playwright's Chromium; `scripts/browser.mjs` picks) at 390x844 and 1440x900 in light and dark and checks status, headline, that the color scheme applied, no horizontal scroll, the hero copy button, and no console or page errors. Then it drives the install section: copies the prompt and compares the clipboard with the text on the page, and switches the OS tabs by click and arrow key. `--no-drive` skips the interactions. It writes a full-page screenshot and an ARIA snapshot per size and scheme.

**Look at the screenshots** for the screens you changed, all four. The checks catch breakage; they don't catch a layout that is wrong but valid. The dark "N" button bottom-left is Next's dev indicator, not the site.

Production (after a Vercel deploy) is the same command against the deployed URL; it only reads.

## Evidence

Everything goes to `%TEMP%\megha-verify\<stamp>-<acp-codex|acp-claude|site>\` (the scripts print the path; `--out` overrides). Cleanup never deletes it.

- ACP: `transcript.jsonl` (every JSON-RPC line both ways, with ms timestamps), `stderr.log` (the agent's log), `summary.json`.
- Site: `home-<390|1440>-<light|dark>.png` + `.aria.yml`, `copy-copied-1440-light.png`, `install-linux-1440-light.png`, `install.aria.yml`, `summary.json`.
- T3: the thread id and link, the `activity` items you read, and krida's `git status` before and after.

Proof standards:
- Drive the path a user takes: ACP messages in T3's shapes, a T3 thread, clicks in Chrome. Calling a backend function directly or reading a fixture proves nothing about the surface.
- Capture the action and the resulting state: the request and the `session/update`s it produced, the click and what the page shows after.
- Check side effects: a cloud turn leaves a task id and web URL; apply=on leaves a diff in the checkout; a turn with apply=off leaves `git status` unchanged.
- `bun run test` is offline and fully mocked. It is the regression net, never the proof that the live path works.
- Report what you ran, what you saw, and what you skipped. A skipped surface is not a pass.

## Cleanup

- Site: `taskkill /T /F /PID <the PID you saved>` on Windows; `kill -- -$(cat /tmp/megha-site-<n>.pgid)` on Linux or macOS. Then `curl` the port and expect `000`. Kill only PIDs you started; other worktrees serve on neighboring ports.
- ACP drives exit by themselves. Their throwaway data dir sits inside the evidence folder; leave it.
- T3 threads you launched stay as evidence; list them in your report. Cloud tasks and sessions can't be deleted from here and stay in my Codex and Claude history, so keep the count low.
- Removing a temporary `meghaDev*` provider: restore from your `settings.json` backup or delete just that entry.

## Maintenance

When a feature is added or its handles change, update its file in `features/`. `/maintain-verification-skill` re-syncs the map with the app.
