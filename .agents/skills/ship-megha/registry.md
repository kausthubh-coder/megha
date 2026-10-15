# ACP Registry submission

The registry (`github.com/agentclientprotocol/registry`) is how T3 shows megha with its icon and installs it without a local path. T3 shows icons only for registry agents. Submission is a PR to that repo, with my go; after it merges, the registry picks up new npm versions by itself (hourly).

Rules from its CONTRIBUTING.md, AUTHENTICATION.md and CI scripts (re-read 2026-10-15; read them again before submitting, they change):

- One folder per agent id: `<id>/agent.json` and `<id>/icon.svg`.
- `agent.json` required fields: `id` (lowercase, hyphens, equals the folder), `name`, `version` (x.y.z), `description`, `license_url`, `distribution`. Optional: `repository`, `website`, `authors`, `license`. The npx `package` must pin the exact version (`t3-megha@0.1.1`, never `@latest`) and it must equal `version`.
- `icon.svg`: 16x16 (`width`/`height` or `viewBox`), square, every `fill`/`stroke` is `currentColor`, `none` or `inherit`, at least one `currentColor`, no `<!-- -->` comments.
- CI checks the schema, that the npm package resolves, the icon, and **authentication** (`verify_agents.py --auth-check`): it runs the npx command with `HOME` set to an empty sandbox, sends `initialize` with `clientCapabilities._meta["terminal-auth"]: true`, and needs `authMethods` with at least one method of type `agent` or `terminal`.
- After merge the registry bumps `version` by itself when npm `latest` moves (hourly).

## Status (2026-10-15)

The three blockers are fixed in megha 0.1.1 (PR `registry/prep`), not yet on npm:

1. Auth: `initialize` offers a `terminal` method (`codex-login` / `claude-login`, args `--backend <name> --login`) to clients that can run one (`clientCapabilities.auth.terminal` or `_meta["terminal-auth"]`). See `packages/megha/README.md`, "Sign-in for ACP clients", and `test/suite-auth.mjs`.
2. Two entries, `megha-codex` and `megha-claude`, drafted in `assets/registry/<id>/` (agent.json + icon.svg).
3. Icons: `assets/icons/registry/` (built by its `build.mjs`, which also copies them into `assets/registry/`).

How T3 treats the terminal method (T3 `packages/provider-acp-registry/src/server/auth.ts`, `probe.ts`, `driver.ts`): it never calls `authenticate` for a terminal method. "Sign in" runs the agent's own command plus the method's args (appended) in a PTY, waits for exit 0, then starts a new session to verify. The status probe treats a working `session/new` as ready (auth "unknown", no prompt), and `-32000` or an error naming a login as "Sign in in provider settings".

## Validate locally

Clone the registry to `%TEMP%`, copy `assets/registry/megha-*` into it, then:

- Schema and icon: `SKIP_URL_VALIDATION=1 uv run --with jsonschema .github/workflows/build_registry.py --agents megha-codex,megha-claude`. Without `SKIP_URL_VALIDATION` it fails until the version is on npm.
- Auth before publishing: `npm pack` packages/megha and set the copied entries' `package` to `t3-megha@file:C:/.../t3-megha-<version>.tgz` (a bare tarball path makes npx exit without running anything). `verify_agents.py` polls pipes with `select()`, which fails on Windows: run it on Linux/macOS, or through a small shim that swaps `client.read_jsonrpc` for a thread-based read, resolves `npx` to `npx.cmd`, and isolates `USERPROFILE` like `HOME` (set `PYTHONUTF8=1` for its output). Pass: `Auth OK: codex-login(terminal)`.

## Steps

1. Blockers fixed and released to npm; `npx -y t3-megha@<version> --backend codex` answers `initialize` with a non-empty `authMethods` (check with `verify-megha`'s acp-drive using `--agent` pointed at the npx-installed `index.mjs`, or a steps file).
2. Fork the registry, add the folder(s), run its validation locally: `uv run --with jsonschema .github/workflows/build_registry.py` and `python3 .github/workflows/verify_agents.py --auth-check --agent megha-codex`.
3. Open the PR (with my go), watch its CI, answer review.
4. After merge: in T3, Settings, Providers, Add provider, ACP Registry, megha shows with its icon.
