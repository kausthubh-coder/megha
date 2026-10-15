# megha

An ACP agent that lets T3 Code run a thread on Codex Cloud or on Claude Code on the web instead of on
this machine. T3 starts it as a "Local ACP command" provider. It talks newline-delimited JSON-RPC on
stdio and runs with cwd set to the thread's repo folder.

It reuses the logins of the local CLIs: `~/.codex/auth.json` for Codex and
`~/.claude/.credentials.json` for Claude (on macOS, the "Claude Code-credentials" Keychain item, read
with `security find-generic-password`). It never refreshes or writes tokens, because refresh tokens rotate and
a refresh here would log the CLI out. When a token expires, start `codex` or `claude` once so the CLI
renews it, or sign in again (`codex login`; `claude`, then `/login`).

## Run

```
npm install -g t3-megha           # or: node index.mjs ...
megha --backend codex           # ACP agent for Codex Cloud
megha --backend claude          # ACP agent for Claude Code on the web
megha doctor                    # checks Node, git and both logins; prints no tokens
megha --version
```

Logs go to stderr. stdout carries only the protocol.

Tests:

```
node test/offline.mjs              # everything with mocked clouds, no network (bun run test)
node test/smoke.mjs                # initialize, session/new, options, session/list for both backends; creates no tasks
node test/load.mjs codex <task_id> # replay an existing task through session/load (read-only)
node test/e2e.mjs codex|claude     # ONE live read-only prompt on krida; writes test/e2e-<backend>.jsonl
```

`test/fixtures/t3-prompts.json` holds the exact prompt shapes T3 sends. Rebuild it from a T3 checkout
with `node test/fixtures/build-t3-prompts.mjs <t3code path>` when T3 changes its wrappers.

## Add to T3 Code

Settings, then Providers, then Add provider, then Local ACP command. Add one instance per backend.
T3 on Windows refuses `.cmd` shims, so `commandPath` must be `node.exe` and the script goes in
`commandArgs`:

```json
"meghaCodex": {
  "driver": "acpRegistry",
  "displayName": "Megha · Codex Cloud",
  "config": {
    "source": "local",
    "commandPath": "C:\\path\\to\\node.exe",
    "commandArgs": ["C:\\path\\to\\megha\\index.mjs", "--backend", "codex"]
  }
}
```

## How a thread maps to the cloud

- `session/new` reads the cwd's git remote and branch, the model list and the environment list. It
  never creates a cloud task, because T3 calls it on every status probe. Model lists are cached for
  10 minutes in the data dir.
- The first prompt creates the task (Codex) or session (Claude). Later prompts are follow-ups on it.
- T3 wraps prompts in its own instructions (about 9 KB on the first turn, describing T3's browser and
  MCP tools) and adds runtime and PR-linking blocks to every turn. megha sends only the user's request.
  A context handoff (after a provider switch or rollback) goes along as plain history, without T3's
  instructions to call `t3_thread_read`.
- Options: model, environment, mode, "Apply diff locally" and "Send local changes".
  - Codex modes are Code, Ask and Plan (Ask mode, asked for a plan). Claude modes are its permission
    modes, including Plan.
  - Codex only offers environments for this repo. If the repo is on GitHub and the ChatGPT Codex
    connector can see it but it has no environment, the option offers to create one; the first prompt
    then creates it with a setup command picked from the lockfile (`bun install`, `pnpm i`, `npm ci` or
    `yarn`) and no secrets.
  - "Send local changes" is on by default when the checkout has work origin doesn't: a branch that
    isn't pushed, commits ahead of origin, or uncommitted changes to tracked files. Codex gets them as a
    starting patch against the merge-base with origin. Claude gets a git bundle, which means the
    session can't push a branch back. Untracked files never travel.
- Images attached in T3 go to the cloud (Codex uploads them as ChatGPT files; Claude gets image
  blocks). Attached text files up to 64 KB are inlined into the prompt, but only files that sit
  directly in T3's attachment folder (`<T3CODE_HOME or ~/.t3>/userdata/attachments`). Any other path
  in an attachment line is named in the prompt and not read.
- Cancel answers T3 within about 1.5 s. The cloud cancel and the end of the cloud turn finish in the
  background. After Stop, megha starts no new cloud or local work for that turn: no automatic local
  apply, and no late permission answer. A permission prompt stops counting as soon as the turn
  starts ending (Stop, the time limit, or the cloud's result). git calls in flight are stopped
  together with every process they started. If Stop lands in the middle of `/apply`, megha puts the
  checkout back and checks that it did. If it can't, it tells you so, with the saved patch files and
  the git commands to recover. The next prompt (a steer) waits up to 60 s for the stopped turn to
  settle, including the cloud's answer to the cancel, and is refused if it hasn't.
- A turn that runs past megha's 3-hour limit is cancelled in the cloud the same way.
- megha saves in its session record whether it has seen the cloud turn end. An accepted cancel
  doesn't count, and neither does a prompt request whose answer never came. Before every prompt,
  `/apply` or `/pr`, megha reads the task or session from the cloud again, and what the cloud says
  replaces the saved state in both directions: a turn started on the web or from another client
  blocks the next prompt even if megha saw the last one end. Resume and `/status` read the cloud the
  same way. A prompt is refused while a turn still runs.
- A failed turn (Codex) or a Claude session whose container never started counts as ended. `/status`
  and the automatic "Continue where you left off." say so and tell you to send a prompt to try again
  or open it on the web.
- When a local apply changes the checkout or leaves it needing recovery, megha saves the message
  with the session before it shows it. If the turn was already stopped, or megha restarts, the
  message shows at the start of the next prompt.
- Loading or resuming a session in another folder checks it against that folder's repo again.
- Cloud errors, including failed turns, show the operation, the HTTP status and a known error code.
  megha never shows or logs the cloud's own error text or the response body.
- megha only lists, imports or continues tasks and sessions of the folder's repo. For Codex it
  checks the task's environment and repo map; for Claude it checks the session's source or outcome
  repo, and accepts bundle-seeded sessions only if megha made them in this folder.
- After a T3 restart, "Continue where you left off." reattaches to a cloud turn that is still running,
  or shows the result of one that finished in the meantime.
- Slash commands: `/pr` (Codex opens a PR from the latest diff and links it to the thread through T3's
  MCP server; Claude links to a GitHub compare page for its pushed `claude/` branch), `/apply` (apply
  the latest cloud diff here), `/open` and `/status`.
- At the end of a turn, the cloud diff (Codex, or a pushed Claude branch) shows as an edit tool call.
  With "Apply diff locally" on, megha runs `git apply --check`, then applies. If the patch doesn't
  apply cleanly and the touched files have no local edits, it tries `git apply --3way`. Otherwise it
  changes nothing and saves the patch under `%LOCALAPPDATA%\megha\patches`.
- `session/list` shows this repo's recent cloud tasks, and `session/load` replays one, so T3's
  "List sessions" and "Import" work. The map from T3 session to cloud id lives in
  `%LOCALAPPDATA%\megha\sessions\<id>.json`, one file per session so parallel T3 threads can't
  overwrite each other (ids and settings, never tokens). Records from an older single
  `sessions.json` (megha 0.1.0, or `%LOCALAPPDATA%\cloud-acp`) are imported once.
- When T3 replaces the session for a thread (rollback), megha recognises the thread by a hash of T3's
  per-thread MCP credential and keeps using the same cloud task. Without that it starts a new task and
  says so.

## Known limitations

- If the request that creates a task or session times out and no id comes back, megha can't check
  whether the cloud made it. Look on chatgpt.com/codex or claude.ai/code before you retry, because a
  duplicate may already be running.
- Claude reports no turn status of its own, so megha treats the worker going idle as the end of the
  turn. The worker can also be idle while a message megha sent waits for a container to start.
- If a Claude container reports a startup error but the session never reaches a failed status, megha
  can't tell whether it will retry. It refuses new prompts until the cloud reports the session idle
  or failed.
- A local apply that already started may finish after you press Stop. If git's time limit kills a
  `git apply --3way` partway, the checkout can be left partly changed. megha tells you which files and
  gives the git commands to check them, but you have to fix them yourself.
