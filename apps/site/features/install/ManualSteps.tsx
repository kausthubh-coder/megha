"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { CodeBlock } from "./CodeBlock";
import {
  EXAMPLE_PATHS,
  NODE_PATH_COMMAND,
  NPM_ROOT_COMMAND,
  OSES,
  detectOs,
  t3SettingsSnippet,
  zedSettingsSnippet,
  type Os,
} from "./install";

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
      <div role="tablist" aria-label="Operating system" className="inline-flex gap-1 rounded-md bg-subtle p-1">
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
            className={`h-11 cursor-pointer rounded-sm px-3.5 text-sm font-medium sm:h-9 ${
              o.id === os ? "bg-surface text-ink shadow-[0_1px_2px_oklch(0_0_0/0.08)]" : "text-muted hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div id="os-panel" role="tabpanel" aria-labelledby={`os-tab-${os}`} className="mt-6">
        <ol className="grid gap-10">
          <Step n={1} title="Install megha and check your logins">
            <CodeBlock id={`cmd-install-${os}`} label="Terminal" copyName="install commands" code={"npm install -g megha\nmegha doctor"} />
            <p className="mt-3 max-w-[50ch] text-sm text-muted">
              Using bun? <code className="font-mono text-xs text-ink">bun add -g megha</code> works too; the file is then
              under <code className="font-mono text-xs wrap-anywhere text-ink">~/.bun/install/global/node_modules/megha</code>.
            </p>
          </Step>

          <Step n={2} title="Find the two paths T3 needs">
            <CodeBlock id={`cmd-paths-${os}`} label="Terminal" copyName="path commands" code={`${NODE_PATH_COMMAND}\n${NPM_ROOT_COMMAND}`} />
            <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-muted">Node path, for example</dt>
              <dd className="min-w-0 font-mono text-xs leading-6 wrap-anywhere">{paths.node}</dd>
              <dt className="text-muted">Megha path, for example</dt>
              <dd className="min-w-0 font-mono text-xs leading-6 wrap-anywhere">{paths.megha}</dd>
            </dl>
            <p className="mt-3 max-w-[50ch] text-sm text-muted">
              The megha path is the second command&apos;s output followed by{" "}
              <code className="font-mono text-xs text-ink">{os === "windows" ? "\\megha\\index.mjs" : "/megha/index.mjs"}</code>.
              {os === "windows" ? " Point T3 at node.exe itself, because T3 won't start .cmd files." : ""}
            </p>
          </Step>

          <Step n={3} title="Add two providers in T3 Code">
            <p className="max-w-[50ch] text-sm">
              Settings → Providers → Add provider → <strong className="font-semibold">Local ACP command</strong>. Command: the node
              path. Arguments, one per row: the megha path, <code className="font-mono text-xs">--backend</code>,{" "}
              <code className="font-mono text-xs">codex</code>. Name it Codex Cloud. Then add a second one with{" "}
              <code className="font-mono text-xs">claude</code> and name it Claude Code on the web.
            </p>
            <p className="mt-3 mb-3 max-w-[50ch] text-sm text-muted">
              Or add the same thing to <code className="font-mono text-xs wrap-anywhere text-ink">{paths.settings}</code>, with
              your paths. T3 picks up the change while it runs.
            </p>
            <CodeBlock id={`t3-settings-${os}`} label="T3 Code settings.json" code={t3SettingsSnippet(paths)} />
          </Step>

          <Step n={4} title="Or use it from Zed">
            <p className="mb-3 max-w-[50ch] text-sm text-muted">
              Megha speaks ACP, so any ACP client can start it. In Zed, run{" "}
              <code className="font-mono text-xs text-ink">zed: open settings</code> and add:
            </p>
            <CodeBlock id={`zed-settings-${os}`} label="Zed settings.json" code={zedSettingsSnippet(paths)} />
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
