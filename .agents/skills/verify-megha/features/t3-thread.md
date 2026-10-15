# T3 thread

megha as users meet it: a T3 Code thread whose provider is Codex Cloud or Claude Cloud. T3 spawns megha per thread, renders its updates as commands, reasoning and messages, and handles stop, follow-ups, rollback and restarts. Every launch here is a **(cloud task)**.

## Sub-features

- `launch` a new thread on the provider runs its first prompt in the cloud and completes.
- `render` the setup log shows as a "Ran command" item starting `$ Codex Cloud setup`, cloud commands as "Ran command" items, the answer as an assistant message with the `[Open in ...]` link.
- `follow-up` a message on the same thread reuses the same task (same link).
- `interrupt` stopping a running turn ends the run as interrupted, quickly.
- `import` the provider card's List sessions, Import opens an old task as a thread (manual: T3 UI only).

## How to get to it (user POV)

- T3: new thread, pick "Codex Cloud" or "Claude Cloud" as the model provider, send.
- T3's MCP tools from an agent thread: `t3_thread_launch`, `t3_thread_send`, `t3_thread_interrupt`.

## Driving it with T3 MCP tools

Preconditions: the code under test is in the main checkout (the providers run `C:\Users\kaust\OneDrive\Documents\dev\megha\packages\megha\index.mjs`), or I approved a temporary `meghaDev*` provider (SKILL.md). Record krida's `git status --short`.

- **Launch.** `t3_thread_launch` with `projectId` `c87a3bf3-c7ba-47a6-91ab-cda5ea2d2d7e` (krida), `title` starting `megha verify:`, `modelSelection` `{"instanceId":"codexCloud","model":"default"}` (or `claudeCloud`), and a read-only `message` ending "Do not change any files.". Keep the returned `threadId`.
- **Wait.** `t3_thread_wait` with `timeoutMs` 600000. Status `completed`.
- **Read.** `t3_thread_read` with `view` `activity`. In order: the user message, "Workspace ready", a "Ran command" item whose text starts `$ Codex Cloud setup`, `reasoning`, "Ran command" items with the cloud's commands, an `assistant_message` ending `[Open in Codex Cloud](https://chatgpt.com/codex/tasks/task_e_...)`, a `checkpoint` with `[]` (no local file changes).
- **Follow-up.** `t3_thread_send` with a second read-only question. A second run completes, and its assistant message links the same task URL.
- **Interrupt.** Send a long read-only request, wait about 20 s, `t3_thread_interrupt`. The run ends `interrupted` within a few seconds.
- **Unchanged repo.** krida's `git status --short` matches the record.

## Gotchas

- Without `workspaceStrategy` the thread runs in krida's root checkout; that is fine for read-only prompts with apply off (megha's default).
- A thread keeps the megha process T3 started for it. After pulling new code into the main checkout, launch a new thread to test it.
- T3 caches a successful provider probe for 15 minutes; a broken provider can look healthy in Settings for that long.
- The new thread can't run with broader modes than the calling thread.
- Good reference transcripts: `mcp:af758377-70ec-464c-9669-1903e3672f22` (Codex) and `mcp:66265872-2b66-4661-af4f-65bd5fcd516a` (Claude), both in the krida project.
