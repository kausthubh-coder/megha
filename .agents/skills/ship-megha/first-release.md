# First release

State on 2026-10-14: no GitHub remote, never published to npm (`npm view t3-megha` → 404, so the name looks free), npm CLI not logged in (`npm whoami` → 401), Vercel CLI not installed and `apps/site` not linked, nothing in the ACP Registry. Re-check each before acting; strike what's done.

## One-time steps only I can do

Ask me to run these (they need my accounts and browser). Check each result yourself afterwards.

1. **GitHub repo.** From `<main>`:
   ```
   gh repo create kausthubh-coder/megha --public --source . --remote origin --push
   ```
   This is the one direct push to `main`, ever. Check: `git -C <main> remote get-url origin`, and the Actions tab shows a CI run on `main` with three green jobs.
2. **Protect `main`** so CI gates every merge (after that first CI run exists, so the check names are known):
   ```
   gh api -X PUT repos/kausthubh-coder/megha/branches/main/protection --input - <<'EOF'
   {"required_status_checks":{"strict":true,"contexts":["check (ubuntu-latest)","check (macos-latest)","check (windows-latest)"]},
    "enforce_admins":true,"required_pull_request_reviews":{"required_approving_review_count":0},"restrictions":null}
   EOF
   ```
   Check: `gh api repos/kausthubh-coder/megha/branches/main/protection -q .required_status_checks.contexts`.
3. **npm.** `npm login` (browser), then `npm whoami` prints my npm user. Publishing needs 2FA on the account; `npm publish` will open the browser for it.
4. **Vercel.**
   ```
   npm install -g vercel
   vercel login
   cd <main> && vercel link          # create project "megha" in my scope
   ```
   Then in the Vercel dashboard (megha project, Settings, Build and Deployment): Root Directory `apps/site`, framework Next.js. Install picks bun from `bun.lock`. The root `.gitignore` already ignores `.vercel/`.
   Decide on the Git integration (Settings, Git): connected gives a preview per PR and deploys production on every merge to `main`; not connected means production only by `vercel deploy --prod`. Connect it after the first npm publish, so the site never goes live pointing at a package that doesn't exist yet.
5. **ACP Registry**: later; see [registry.md](registry.md). It needs code changes first.

## What changes in the ship steps for the first release

- Step 1.5: no bump. `packages/megha` is already `0.1.0` and npm has nothing, so 0.1.0 is the first version. `npm publish --dry-run` still runs.
- Step 2: the PR that carries the first release can be the first PR after the repo exists. CI must be green on all three OSes.
- Step 3 order is strict: npm publish 0.1.0, tag `v0.1.0`, then the first site deploy with `vercel deploy --prod` (Git integration still off), then I connect the Git integration if I want it.
- Step 4: also check the links on the live site: GitHub repo and `https://www.npmjs.com/package/t3-megha` both answer 200.
- Step 5: the main checkout is already on `main`; just `git -C <main> pull --ff-only` after the squash merge.

## Before the first publish, read once

- The npm tarball is `LICENSE`, `README.md`, `index.mjs`, `lib/` and `package.json` (about 44 KB, 14 files, checked 2026-10-14). `test/` is not shipped.
- The bin `megha` points at `index.mjs` with a `#!/usr/bin/env node` shebang; npm makes the `.cmd` shim on Windows. T3 can't start `.cmd` shims, which is why the site tells users to point T3 at `node` plus `index.mjs`.
- The install prompt on the site and `packages/megha/README.md` both say `npm install -g t3-megha`. After the publish, run that command into a throwaway prefix (`npm install -g --prefix %TEMP%\megha-first megha`) and run `megha --version` and `megha doctor` from it.
