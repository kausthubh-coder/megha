"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { CodeBlock } from "./CodeBlock";
import {
  CLAUDE_CODE_URL,
  CLAUDE_GITHUB_APP_URL,
  CODEX_CONNECT_URL,
  EXAMPLE_PATHS,
  INSTALL_COMMAND,
  NODE_PATH_COMMAND,
  NPM_PACKAGE,
  NPM_ROOT_COMMAND,
  OSES,
  detectOs,
  meghaCheckCommand,
  t3SettingsSnippet,
  zedSettingsSnippet,
  type Os,
} from "./install";

const link = "underline decoration-border underline-offset-4 hover:decoration-current";

// The visitor's OS picks the default tab. The server render (and the static shell) shows Windows,
// then the client switches once; every tab has the same structure, so only the paths change.
const subscribe = () => () => {};
const useDetectedOs = () =>
  useSyncExternalStore<Os>(subscribe, () => detectOs(navigator.userAgent), () => "windows");

export function ManualSteps() {
  const detected = useDetectedOs();
  const [chosen, setChosen] = useState<Os | null>(null);
  const os = chosen ?? detected;
  const paths = EXAMPLE_PATHS[os];
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + OSES.length) % OSES.length;
    setChosen(OSES[next].id);
    tabs.current[next]?.focus();
  }

  return (
    <div>
      <div role="tablist" aria-label="Operating system" className="inline-flex gap-1 rounded-full bg-subtle p-1">
        {OSES.map((o, i) => (
          <button
            key={o.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            id={`os-tab-${o.id}`}
            role="tab"
            type="button"
            aria-selected={o.id === os}
            aria-controls="os-panel"
            tabIndex={o.id === os ? 0 : -1}
            onClick={() => setChosen(o.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`h-11 cursor-pointer rounded-full px-4 text-sm font-medium sm:h-9 ${
              o.id === os ? "bg-surface text-ink shadow-[0_1px_2px_oklch(0_0_0/0.12)]" : "text-muted hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div id="os-panel" role="tabpanel" aria-labelledby={`os-tab-${os}`} className="mt-8">
        <ol className="grid gap-10">
          <Step n={1} title="Install megha and check your logins">
            <CodeBlock id={`cmd-install-${os}`} label="Terminal" copyName="install commands" code={`${INSTALL_COMMAND}\nmegha doctor`} />
            <p className="mt-3 max-w-[52ch] text-sm text-muted">
              The package is <code className="font-mono text-xs text-ink">{NPM_PACKAGE}</code>; the command is{" "}
              <code className="font-mono text-xs text-ink">megha</code>. Use npm even if you have bun, because the next step
              looks in npm&apos;s global folder. The doctor checks Node, git and your logins on this computer only.
            </p>
          </Step>

          <Step n={2} title="Find the two paths T3 needs">
            <CodeBlock id={`cmd-paths-${os}`} label="Terminal" copyName="path commands" code={`${NODE_PATH_COMMAND}\n${NPM_ROOT_COMMAND}`} />
            <p className="mt-3 max-w-[52ch] text-sm text-muted">
              The first prints the node path. The megha path is the second one&apos;s output followed by{" "}
              <code className="font-mono text-xs text-ink">{os === "windows" ? `\\${NPM_PACKAGE}\\index.mjs` : `/${NPM_PACKAGE}/index.mjs`}</code>, for
              example <code className="font-mono text-xs wrap-anywhere text-ink">{paths.megha}</code>. Check it prints a version:
            </p>
            <div className="mt-3">
              <CodeBlock id={`cmd-check-${os}`} label="Terminal" copyName="path check" code={meghaCheckCommand(paths.megha)} />
            </div>
          </Step>

          <Step n={3} title="Add two providers in T3 Code">
            <p className="max-w-[52ch] text-sm text-muted">
              In <code className="font-mono text-xs wrap-anywhere text-ink">{paths.settings}</code>, with your paths. T3 picks up
              the change while it runs. Or use Settings → Providers → Add provider → Local ACP command, with the same values.
            </p>
            <div className="mt-3">
              <CodeBlock id={`t3-settings-${os}`} label="T3 Code settings.json" code={t3SettingsSnippet(paths)} />
            </div>
            <details className="group mt-4 text-sm">
              <summary className="inline-flex h-11 cursor-pointer items-center gap-2 font-medium text-ink sm:h-9 [&::-webkit-details-marker]:hidden">
                <svg viewBox="0 0 16 16" className="size-3.5 text-muted group-open:rotate-90" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                  <path d="M6 3.5L10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Using Zed instead?
              </summary>
              <p className="mt-2 mb-3 max-w-[52ch] text-muted">
                Megha speaks ACP, so Zed can start it too. Run <code className="font-mono text-xs text-ink">zed: open settings</code>{" "}
                and add:
              </p>
              <CodeBlock id={`zed-settings-${os}`} label="Zed settings.json" code={zedSettingsSnippet(paths)} />
            </details>
          </Step>

          <Step n={4} title="Connect each cloud to your repo">
            <ul className="grid max-w-[52ch] gap-2 text-sm text-muted">
              <li>
                <strong className="font-semibold text-ink">Codex Cloud:</strong>{" "}
                <a href={CODEX_CONNECT_URL} className={`text-ink ${link}`}>
                  connect GitHub to Codex
                </a>{" "}
                and give it the repo. Megha creates the environment on your first prompt.
              </li>
              <li>
                <strong className="font-semibold text-ink">Claude Code on the web:</strong> open{" "}
                <a href={CLAUDE_CODE_URL} className={`text-ink ${link}`}>
                  claude.ai/code
                </a>{" "}
                once. To get Claude&apos;s changes back, install the{" "}
                <a href={CLAUDE_GITHUB_APP_URL} className={`text-ink ${link}`}>
                  Claude GitHub App
                </a>{" "}
                on the repo.
              </li>
            </ul>
          </Step>
        </ol>
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="min-w-0">
      <h4 className="mb-3 flex items-center gap-3 font-semibold">
        <span
          aria-hidden
          className="grid size-7 shrink-0 place-items-center rounded-full bg-subtle font-mono text-xs font-normal text-muted tabular-nums"
        >
          {n}
        </span>
        {title}
      </h4>
      <div className="min-w-0 sm:pl-10">{children}</div>
    </li>
  );
}
