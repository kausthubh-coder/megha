# cloud-acp

An ACP agent that lets T3 Code run a thread on Codex Cloud or on Claude Code on the web instead of on
this machine. T3 starts it as a "Local ACP command" provider. It talks newline-delimited JSON-RPC on
stdio and runs with cwd set to the thread's repo folder.

It reuses the logins of the local CLIs: `~/.codex/auth.json` for Codex and
`~/.claude/.credentials.json` for Claude. It never refreshes tokens, because refresh tokens rotate and
a refresh here would log the CLI out. When a token expires, the error tells you to run
`codex login status` or `claude auth status`, which refresh it.

## Run

```
npm install
node index.mjs --backend codex     # or --backend claude
```

Logs go to stderr. stdout carries only the protocol.

Tests:

```
node test/offline.mjs              # diff/apply on a temp repo + schema checks, no network
node test/smoke.mjs                # initialize, session/new, options, session/list for both backends; creates no tasks
node test/load.mjs codex <task_id> # replay an existing task through session/load (read-only)
node test/e2e.mjs codex|claude     # ONE live read-only prompt on krida; writes test/e2e-<backend>.jsonl
```

## Add to T3 Code

Settings, then Providers, then Add provider, then Local ACP command. Add one instance per backend. The
settings.json entries look like this:

```json
"codexCloud": {
  "driver": "acpRegistry",
  "displayName": "Codex Cloud",
  "config": {
    "source": "local",
    "commandPath": "C:\\Users\\kaust\\scoop\\apps\\nodejs-lts\\current\\node.exe",
    "commandArgs": ["C:\\Users\\kaust\\OneDrive\\Documents\\dev\\sandbox\\cloud-acp\\index.mjs", "--backend", "codex"]
  }
},
"claudeCloud": {
  "driver": "acpRegistry",
  "displayName": "Claude Code on the web",
  "config": {
    "source": "local",
    "commandPath": "C:\\Users\\kaust\\scoop\\apps\\nodejs-lts\\current\\node.exe",
    "commandArgs": ["C:\\Users\\kaust\\OneDrive\\Documents\\dev\\sandbox\\cloud-acp\\index.mjs", "--backend", "claude"]
  }
}
```

T3 on Windows refuses `.cmd` shims, so `commandPath` must be `node.exe` itself.

## How a thread maps to the cloud

- `session/new` only records the cwd, the GitHub remote and the branch. T3 calls it on every status
  probe, so it never creates a cloud task.
- The first prompt creates the task (Codex) or session (Claude). Later prompts are follow-ups on it.
- Composer options: environment, mode (Codex: Code or Ask; Claude: permission mode, default Accept
  edits), "Apply diff locally" (default off), and for Codex "Send local changes", which sends
  `git diff origin/<branch>` as the starting patch. Claude also exposes a model list, built from the
  models your recent cloud sessions used.
- The cloud clones from GitHub, so your branch must be pushed. If it isn't, the task starts from the
  default branch and the thread says so.
- Claude falls back to a git bundle of your committed work when its GitHub app can't reach the repo.
  A bundle-seeded session can't push a branch.
- At the end of a turn, the cloud diff (Codex, or a pushed Claude branch) shows as an edit tool call.
  With "Apply diff locally" on, it runs `git apply --check` first, then applies. If the patch doesn't
  apply cleanly and the touched files have no local edits, it tries `git apply --3way` and reports
  any conflicts. Otherwise it changes nothing and saves the patch under
  `%LOCALAPPDATA%\cloud-acp\patches`. Applying locally is what fills T3's own diff panel.
- Every turn ends with a link to the task on chatgpt.com or claude.ai.
- `session/list` shows this repo's recent cloud tasks, and `session/load` replays one, so T3's
  "List sessions" and "Import" work. The mapping from T3 session to cloud id lives in
  `%LOCALAPPDATA%\cloud-acp\sessions.json`. That file holds ids and settings, never tokens.
