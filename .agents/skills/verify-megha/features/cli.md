# CLI

What a user runs in a terminal after `npm install -g t3-megha`: help, version, and a doctor that checks Node, git and both cloud logins without printing tokens.

## Sub-features

- `cli-help` prints usage, both backends and the T3 setup hint.
- `cli-version` prints the package version.
- `cli-doctor` prints one line per check and the data dir; exit 0 when all pass.
- `cli-bad-args` refuses to start without `--backend codex|claude`.

## How to get to it (user POV)

- `megha --help` / `megha -h`
- `megha --version` / `megha -v`
- `megha doctor`
- `megha` with no backend

## Driving it with node

Preconditions: run from the checkout root; `node` is 22 or newer.

- **Help.** Run `node packages/megha/index.mjs --help`. Exit 0; stdout starts `megha <version>:` and lists `--backend codex`, `--backend claude` and `megha doctor`.
- **Version.** Run `node packages/megha/index.mjs --version`. Exit 0; stdout equals `version` in `packages/megha/package.json`.
- **Doctor.** Run `node packages/megha/index.mjs doctor`. Exit 0 with `ok` on node, git, codex login, claude login, then `data dir: ...` and `Ready.`. No token text anywhere in the output.
- **Bad args.** Run `node packages/megha/index.mjs`. Exit 2; stderr says `pass --backend codex or --backend claude`; stdout is empty.
- **As installed.** For a release, also run `npm pack` in `packages/megha`, `npm install -g <tarball>` into a throwaway prefix (`npm install -g --prefix %TEMP%\megha-pack <tgz>`), and repeat the three commands with that `megha`. This is the only proof that `files` in package.json ships everything.

## Gotchas

- `--help` and `--version` win over everything else on the line, including `--backend`.
- A FAIL on one login is expected on machines with only one CLI; the doctor still exits 1.
- The Claude token lives about an hour. A FAIL there right after a long session means: tell me to run `claude auth status`.
