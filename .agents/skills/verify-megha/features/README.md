# megha verification map

The maintained source for verifying what megha's users touch: the agent as T3 Code (or Zed) runs it, and the public site. Read this index, then the feature file for what you changed, and drive every entry point that file lists.

## Baseline preconditions

- `bun run doctor` and `node packages/megha/index.mjs doctor` pass for the backend you are driving.
- Agent drives run this checkout's `packages/megha/index.mjs` through `scripts/acp-drive.mjs`, with cwd = the krida checkout `C:\Users\kaust\OneDrive\Documents\dev\krida` (a GitHub repo with a Codex environment labelled `krida`; the Claude GitHub App is not installed on it, so Claude sessions there get a bundle upload and cannot push).
- Each drive gets a throwaway `MEGHA_DATA_DIR` inside its evidence folder.
- The site runs on this checkout's port from `bun run setup`, started as SKILL.md shows, and you hold its PID.
- Real T3 threads run the main checkout's code through the `codexCloud` and `claudeCloud` providers (SKILL.md, "The agent in real T3 Code").

## Driving conventions

- Read-only first. A file marks each step that creates a cloud task with **(cloud task)**; run those only when the change is in that path, once per backend, with a read-only prompt on krida.
- Agent: ACP methods and params in T3's shapes, sent by `acp-drive.mjs`. Assert on `session/update` kinds and texts in `transcript.jsonl`, not on megha's stderr log.
- Site: roles and accessible names (`button "Copy install prompt"`, `tablist "Operating system"`), and the ids `#hero-title`, `#install`, `#install-prompt`, `#os-panel`.

## Proof and skip reporting

- Agent proof: the evidence folder (`transcript.jsonl`, `summary.json`, `stderr.log`), naming the request and the updates it produced.
- Cloud-turn proof also carries the task or session id and its web URL, and krida's `git status --short` before and after (unchanged when apply is off).
- Site proof: the four `home-<size>-<scheme>.png` with their `.aria.yml`, and the drive's screenshots.
- A path you could not reach is reported with the command you tried and the unmet precondition. A skipped backend is not covered by the other one.

## Features

- [CLI](./cli.md): `megha --help`, `--version`, `megha doctor`.
- [ACP session and options](./acp-session.md): initialize, session/new, the option menus, slash-command list.
- [Cloud history](./acp-history.md): session/list, importing a task with session/load, `/status` and `/open`.
- [Cloud turn](./cloud-turn.md): prompt, follow-up, images, cancel and steer, the diff, `/apply` and `/pr`.
- [T3 thread](./t3-thread.md): the same, inside a real T3 Code thread.
- [Site page](./site-page.md): the page at both sizes and in both color schemes.
- [Site install](./site-install.md): copying the install prompt, the OS tabs and the config snippets.
