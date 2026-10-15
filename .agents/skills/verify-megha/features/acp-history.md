# Cloud history

Lets a user see and reopen cloud work: T3's provider card lists the repo's Codex Cloud tasks or Claude sessions, Import replays one into a thread, and `/status` and `/open` report on the task a thread is attached to. All read-only.

## Sub-features

- `list` session/list returns this repo's tasks/sessions, newest first, with titles.
- `load` session/load replays a task's history as `user_message_chunk`, `agent_thought_chunk`, `tool_call`, `agent_message_chunk` and a `session_info_update` title.
- `status` `/status` prints title, status, environment, branch, model and the web link.
- `open` `/open` prints the `[Open in Codex Cloud](...)` (or claude.ai) link.
- `no-task` `/status` on a session with no cloud task says to send a prompt first.

## How to get to it (user POV)

- T3: Settings, Providers, the megha provider card, List sessions, then Import.
- In a thread attached to a task: type `/status` or `/open`.

## Driving it with acp-drive

Preconditions: doctor passes; krida has at least one task/session for the backend (the default drive's `session/list` line shows ids).

- **List.** Run `node .agents/skills/verify-megha/scripts/acp-drive.mjs --backend codex`. `session/list` prints a count and the first ids (`task_e_...` for Codex, `cse_...` for Claude) with titles.
- **Import and commands.** Pick an id from that list. Run `node .agents/skills/verify-megha/scripts/acp-drive.mjs --backend codex --load <id> --steps .agents/skills/verify-megha/steps/load-status.json`. `session/load` prints the options (mode and model as the task ran); both prompts end `end_turn`; in `transcript.jsonl` the `agent_message_chunk` after the first prompt starts with the task title in bold and contains `Status:`, and the one after the second is the `[Open in ...]` link.
- **Load alone.** `--load <id>` without `--steps` replays only; `session/update kinds` shows the replayed kinds.
- **No task yet.** A steps file with initialize, session/new, then `/status`: the reply is `No cloud task yet: send a prompt first.`

## Gotchas

- Codex lists only tasks whose environment label belongs to this repo, and pages at most 5 x 20 tasks.
- Claude session titles can be T3's wrapper text (`<t3_code_instructions>`) for sessions created before megha stripped it. That is old data, not a regression.
- `/status` calls the cloud API (read-only). `/apply` and `/pr` are not read-only: see cloud-turn.md.
