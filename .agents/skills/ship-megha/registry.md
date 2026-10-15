# ACP Registry submission

The registry (`github.com/agentclientprotocol/registry`) is how T3 shows megha with its icon and installs it without a local path. T3 shows icons only for registry agents. Submission is a PR to that repo, with my go; after it merges, the registry picks up new npm versions by itself (hourly).

Rules from its CONTRIBUTING.md (read it again before submitting; it changes):

- One folder per agent id: `<id>/agent.json` and `<id>/icon.svg`.
- `agent.json` required fields: `id` (lowercase, hyphens, equals the folder), `name`, `version` (x.y.z), `description`, `license_url`, `distribution`. Optional: `repository`, `website`, `authors`, `license`.
- `icon.svg`: 16x16 (`width`/`height` or `viewBox`), monochrome, `fill="currentColor"` only, no hard-coded colors.
- CI checks the schema, that the npm package resolves, the icon, and **authentication**: the agent's `initialize` must return `authMethods` with at least one method of type `agent` or `terminal`.

## Blockers in megha today (2026-10-14)

Each is a code change, shipped through a normal PR and an npm release before the registry PR:

1. `initialize` returns `authMethods: []` (`packages/megha/lib/agent.mjs`). The registry's CI rejects that. A `terminal` method that tells the user to run `codex login` / `claude auth login` fits megha's "reuse the CLI login" design.
2. One registry entry runs one command line, and megha needs `--backend codex|claude`. Either two entries (`megha-codex`, `megha-claude`) with different `args`, or one agent that offers the backend as a session option. Decide with me.
3. No 16x16 `currentColor` icon. `assets/icons/megha.svg` is 32x32 with fixed fills; draw a monochrome version in `assets/icons/`.

## Entry shape (two-entry option)

```json
{
  "id": "megha-codex",
  "name": "Codex Cloud (megha)",
  "version": "<npm version>",
  "description": "Run threads on Codex Cloud with your existing codex login.",
  "repository": "https://github.com/kausthubh-coder/megha",
  "website": "<site url>",
  "license": "MIT",
  "license_url": "https://github.com/kausthubh-coder/megha/blob/main/LICENSE",
  "distribution": { "npx": { "package": "t3-megha@<npm version>", "args": ["--backend", "codex"] } }
}
```

`megha-claude` is the same with `--backend claude`.

## Steps

1. Blockers fixed and released to npm; `npx -y t3-megha@<version> --backend codex` answers `initialize` with a non-empty `authMethods` (check with `verify-megha`'s acp-drive using `--agent` pointed at the npx-installed `index.mjs`, or a steps file).
2. Fork the registry, add the folder(s), run its validation locally: `uv run --with jsonschema .github/workflows/build_registry.py` and `python3 .github/workflows/verify_agents.py --auth-check --agent megha-codex`.
3. Open the PR (with my go), watch its CI, answer review.
4. After merge: in T3, Settings, Providers, Add provider, ACP Registry, megha shows with its icon.
