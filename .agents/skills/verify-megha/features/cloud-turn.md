# Cloud turn

The core of megha: a prompt in a thread starts a Codex Cloud task (or Claude session), the setup log, commands and answer stream back, a follow-up continues the same task, and cancel or steer answers fast. Every step here marked **(cloud task)** costs the user's quota.

## Sub-features

- `first-prompt` creates the task with only the user's request (T3's wrapper instructions stripped) and streams a setup `tool_call`, reasoning, command `tool_call`s and the answer, ending with an `[Open in ...]` link.
- `follow-up` a second prompt continues the same task id.
- `image` an attached image reaches the cloud (Codex: uploaded file; Claude: image block).
- `cancel` session/cancel answers the pending prompt with `stopReason: "cancelled"` within about 1.5 s; the cloud turn winds down in the background.
- `steer` a prompt sent right after a cancel waits for the cancelled turn to settle, then goes as a follow-up.
- `diff` a turn that changed files emits an `edit` tool_call with the diff; apply=on applies it with `git apply`; `/apply` applies on demand; `/pr` opens a pull request.

## How to get to it (user POV)

- T3: send a message in a thread on a megha provider; attach an image; press stop; send while it runs (steer); type `/apply` or `/pr`.

## Driving it with acp-drive

Preconditions: doctor passes; record `git -C C:\Users\kaust\OneDrive\Documents\dev\krida status --short` first.

- **First prompt (cloud task).** Run `node .agents/skills/verify-megha/scripts/acp-drive.mjs --backend codex --allow-cloud-task --prompt "In two sentences, what does src/main.tsx render? Do not change files."`. The `$readonly-config` line shows apply=off (and on Codex environment=krida, mode=ask); `session/prompt` ends `end_turn`; kinds include `tool_call` and `agent_message_chunk`; the transcript's last agent text has an `[Open in Codex Cloud](https://chatgpt.com/codex/tasks/task_e_...)` link. krida's `git status` is unchanged.
- **Follow-up, cancel and steer (cloud task).** Write a steps file: initialize; session/new; `{"method":"$readonly-config"}`; a long read-only prompt with `"async": true` (for example "Read every file under src/ and summarise each in one line. Do not change files."); `{"method":"session/cancel","notify":true,"params":{"sessionId":"$sessionId"},"waitMs":25000}`; then a short read-only prompt with `"waitMs":300`. Run with `--allow-cloud-task --steps <file>`. The first prompt's row shows `{"stopReason":"cancelled"}` and its `ms` is at most about 1500 more than the cancel's send time; the steer ends `end_turn` on the same task (one `[Open in ...]` URL across the transcript). `node packages/megha/test/live-steer.mjs codex|claude` does the same plus an image and a non-default model.
- **Diff and apply.** Not driven by default: a turn that writes files, `/apply` and `/pr` change krida or GitHub. Do it only when that path changed and I agreed, in a throwaway krida worktree, and remove the cloud branch or PR afterwards.

## Gotchas

- Cloud setup takes 10 to 60 s before the first answer text; use timeouts of minutes, not seconds.
- Codex may ignore the requested model and run its default; `/status` shows what actually ran.
- Claude on krida gets a git bundle (the Claude GitHub App is not installed), so its sessions can't push a branch, and `/pr` can't work there.
- `localChanges=on` sends unpushed commits and tracked changes as the starting patch; untracked files never travel.
- Each run here is a new task in my Codex or Claude history. Say in the report how many you created.
