# Site install

The page's job: get the install prompt copied. Two "Copy install prompt" buttons (hero and closing section) and a "Copy prompt" button on the prompt itself copy the same text; a "Copy" button on each code block copies its commands or config. "Or set it up by hand" has OS tabs (Windows, macOS, Linux) that switch the example paths. All text comes from `apps/site/features/install/install.ts`.

## Sub-features

- `copy-prompt` the clipboard gets exactly the prompt shown in `#install-prompt`; the button reads "Copied" for 2 s and a polite live region says "Copied to clipboard".
- `copy-blocked` when the clipboard API fails, the text is selected, the button reads "Text selected", and the live region tells the user to press Control C or Command C.
- `copy-block` each code block's "Copy" copies its own text (screen readers hear "Copy install commands", "Copy T3 Code settings.json"...).
- `os-tabs` the visitor's OS is the default tab; click or arrow keys switch; the panel's paths change.
- `snippets` the T3 `settings.json` and Zed `settings.json` snippets use the selected OS's paths.

## How to get to it (user POV)

- Hero: "Copy install prompt". Install section: "Copy prompt". Closing section: "Copy install prompt".
- "Or set it up by hand": the Operating system tabs and each block's "Copy".

## Driving it with site-check

Preconditions: the site runs and answers 200.

- **Copy the prompt and switch tabs.** Run `node .agents/skills/verify-megha/scripts/site-check.mjs http://localhost:<port>/`. Lines `copy: live region says Copied to clipboard`, `copy: clipboard equals the prompt on the page`, `copy: prompt installs from npm`, `tabs: macOS selected after click`, `tabs: panel text changed for macOS`, `tabs: ArrowRight selects and focuses Linux` are `ok`. Evidence: `copy-copied-1440-light.png`, `install-linux-1440-light.png`, `install.aria.yml`.
- **Other copy buttons.** When you changed one, extend a copy of the script: click `page.getByRole("button", { name: "Copy prompt" })` or `getByRole("button", { name: "Copy T3 Code settings.json" })`, then compare `navigator.clipboard.readText()` with the matching `<pre>` text.
- **Blocked clipboard.** In a context without clipboard permissions, stub it before clicking: `page.addInitScript(() => { navigator.clipboard.writeText = () => Promise.reject(new Error("blocked")); })`. The button reads "Text selected" and `window.getSelection().toString()` equals the prompt.
- **Prompt content.** `bun run --filter site test` checks that the prompt, manual steps and snippets agree. The prompt is what another agent will execute on a user's machine: read it whole when it changed.

## Gotchas

- On Windows the clipboard comes back with CRLF line endings; compare after normalizing (the script does).
- The default tab follows the browser's user agent; Playwright's Chrome on Windows starts on Windows.
- The prompt tells users `npm install -g megha`. Before the first npm publish that command fails for real users: don't deploy the site to production before the package exists.
