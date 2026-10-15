# ACP session and options

What T3 sees when it adds megha as a provider and opens a thread: the handshake, a session bound to the repo, the composer's option menus (model, environment, mode, apply, send local changes), and megha's slash commands in the `/` menu. None of this creates a cloud task.

## Sub-features

- `init` answers v1 initialize to T3's v2-style request, advertising loadSession, list, resume and image prompts.
- `new-lazy` session/new returns a session id and options and creates nothing in the cloud (T3 probes with it every 15 minutes).
- `options` model (category `model`, never `default`/`auto`), environment, mode (category `mode`; Codex: code, ask, plan; Claude: default, acceptEdits, plan, bypassPermissions), apply (off/on), localChanges (off/on).
- `set-option` session/set_config_option returns the updated options; the value sticks.
- `commands` an `available_commands_update` right after session/new with `/pr`, `/apply`, `/open`, `/status`.
- `stdout-clean` stdout carries only JSON-RPC lines.

## How to get to it (user POV)

- T3: add the provider, open a new thread on a repo, open the model picker and the option menus, type `/`.
- Zed or any ACP client: start a new agent thread with megha configured as a custom agent server.

## Driving it with acp-drive

Preconditions: doctor passes for the backend; krida exists.

- **Handshake and session.** Run `node .agents/skills/verify-megha/scripts/acp-drive.mjs --backend codex` (then `claude`). `initialize` prints protocolVersion 1 and caps with `loadSession`, `sessionCapabilities.list`, `promptCapabilities.image`; `session/new` prints a `mg_...` session id and the five options; `session/update kinds` includes `available_commands_update`.
- **Option change.** Write a steps file: initialize, session/new, then `{"method":"session/set_config_option","params":{"sessionId":"$sessionId","configId":"mode","value":"plan"}}` and the same for `model` with a non-default id from the session/new list. Run with `--steps <file>`. Each response's `configOptions` shows the new `currentValue`.
- **Nothing created.** After the drive, `node .agents/skills/verify-megha/scripts/acp-drive.mjs --backend <b>` again: `session/list` shows the same first entries as before (no new task titled after this run).
- **Stdout.** `summary.json` has `"nonJsonStdoutLines": 0`.
- Also: `bun run --filter megha smoke` asserts the same for both backends (it writes to the shared data dir).

## Gotchas

- The Codex environment list holds only environments for this repo's GitHub remote. In a repo without one, the option offers to create one, and the first prompt would create it: that is a cloud write.
- The model list is cached for 10 minutes in the data dir; a throwaway data dir always fetches live.
- `localChanges` defaults to `on` when the checkout has unpushed commits or uncommitted tracked changes. krida's main checkout is usually clean, so it shows `off`.
- T3 waits only briefly for `available_commands_update` after session/new; it must come right after the response, not later.
