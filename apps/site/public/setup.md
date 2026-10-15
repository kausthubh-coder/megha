# Set up megha

You are a coding agent on the user's computer. The user asked you to set up megha and pointed you at this file. Follow the steps in order. Work in the user's terminal and report back after each step that can fail.

Megha is an open-source ACP agent (https://github.com/kausthubh-coder/megha). T3 Code starts it once per thread, and it runs that thread on Codex Cloud or Claude Code on the web with the codex and claude logins already saved on this computer. The npm package is `t3-megha` (https://www.npmjs.com/package/t3-megha), and the command it installs is `megha`.

## Rules

- Don't run the logins yourself (`codex login`, `claude`, `/login`). If a login is missing, tell the user the command and let them run it.
- Never open, read, print or copy any token or credential file, such as `~/.codex/auth.json` or `~/.claude/.credentials.json`. Megha reads them itself.
- Make a backup copy of T3 Code's settings.json before you edit it, and keep every setting that's already there.
- If a step says stop, stop and tell the user what happened. Don't work around it.
- Don't restart T3 Code or any other app.

## 1. Check Node.js

Run `node --version`. Megha needs Node.js 22 or newer. If node is missing or older, stop and tell the user.

## 2. Install megha

Run `npm install -g t3-megha`. Use npm even if bun or another package manager is installed, because step 4 looks in npm's global folder. If the install fails, stop and show the user the error.

## 3. Run the local check

Run `megha doctor` and show the user what it prints. It is a local check: it looks at Node, git and the saved codex and claude logins on this computer, and doesn't contact either cloud.

- If node or git fails, stop.
- A missing login only matters for a cloud the user will use. For that cloud, tell the user the command to run: `codex login` for Codex Cloud, or `claude` and then `/login` for Claude Code on the web.

## 4. Find the two paths T3 needs

- The node path is the output of `node -p "process.execPath"`. On Windows this is node.exe itself, which T3 needs because it won't start .cmd files.
- The megha path is the output of `npm root -g`, followed by `t3-megha/index.mjs` (`t3-megha\index.mjs` on Windows).

Then check the megha path by running `node "<megha path>" --version`. It should print a version number. If it doesn't, stop and tell the user, and don't edit any settings.

## 5. Add two providers to T3 Code

T3 Code keeps its settings in `~/.t3/userdata/settings.json` (`%USERPROFILE%\.t3\userdata\settings.json` on Windows).

1. Make a backup copy of the file next to it, for example `settings.json.bak`.
2. Add these two entries to its `"providerInstances"` object. Create the object if it isn't there. Put the paths from step 4 in place of `<node path>` and `<megha path>`. In JSON, write each Windows backslash as `\\`.

```json
{
  "providerInstances": {
    "megha-codex": {
      "driver": "acpRegistry",
      "displayName": "Codex Cloud",
      "config": {
        "source": "local",
        "commandPath": "<node path>",
        "commandArgs": ["<megha path>", "--backend", "codex"]
      }
    },
    "megha-claude": {
      "driver": "acpRegistry",
      "displayName": "Claude Code on the web",
      "config": {
        "source": "local",
        "commandPath": "<node path>",
        "commandArgs": ["<megha path>", "--backend", "claude"]
      }
    }
  }
}
```

3. Check that the file is still valid JSON. T3 notices the change by itself.

If the file doesn't exist or you can't edit it, give the user these values to enter by hand: Settings → Providers → Add provider → Local ACP command. Command: the node path. Arguments, one per row: the megha path, `--backend`, `codex`. Name it Codex Cloud. Then add a second one the same way with `claude` and name it Claude Code on the web.

## 6. Zed (only if the user asks for it)

Megha speaks ACP, so Zed can start it too. In Zed's settings.json (the user opens it with `zed: open settings`), add this, with the same two paths:

```json
{
  "agent_servers": {
    "Codex Cloud": {
      "type": "custom",
      "command": "<node path>",
      "args": ["<megha path>", "--backend", "codex"],
      "env": {}
    },
    "Claude Code on the web": {
      "type": "custom",
      "command": "<node path>",
      "args": ["<megha path>", "--backend", "claude"],
      "env": {}
    }
  }
}
```

## 7. Tell the user what's left

Tell the user what you changed and where the backup is. Then give them this list of what they still have to do in a browser. `megha doctor` doesn't check any of it, and you can't do it for them.

- For Codex Cloud: connect GitHub to Codex and give it access to the repo at https://chatgpt.com/codex/settings/environments. Megha creates the repo's environment on the first prompt if it doesn't have one.
- For Claude Code on the web: open https://claude.ai/code once, which creates the cloud environment. To get Claude's changes back on this computer, install the Claude GitHub App (https://github.com/apps/claude) on the repo, so Claude can push its branch.
- For both: the cloud starts from the user's branch on GitHub, so they should push it before starting a thread. With "Send local changes" on, Codex gets unpushed work as a patch and Claude gets a git bundle. A Claude session started from a bundle can't push a branch, so its changes stay on claude.ai.

Then tell them how to start: in T3 Code, open a thread in a repo that's on GitHub and pick Codex Cloud or Claude Code on the web as the provider.
