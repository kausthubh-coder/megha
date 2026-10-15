import { MeghaMark } from "@/features/brand/MeghaMark";
import { ClaudeIcon, OpenAIIcon } from "@/features/brand/ProviderIcons";

// An illustration of a T3 Code thread running on Codex Cloud through megha, drawn in HTML so it
// follows the theme and stays sharp. Nothing here is interactive; screen readers get one description.

const DESCRIPTION =
  "Illustration: a T3 Code thread titled 'Add a --version flag', running on Codex Cloud. The work log shows the cloud task starting on kausthubh-coder/megha at main, bun install finishing, a test run with 19 passing tests and two edited files, then the answer streaming in.";

const THREADS = [
  { title: "Add a --version flag", provider: "codex", status: "Running", active: true },
  { title: "Explain the SSE parser", provider: "claude", status: "2m", active: false },
  { title: "Bump the ACP SDK to 1.8", provider: "codex", status: "1h", active: false },
  { title: "Why does apply fail on CRLF?", provider: "claude", status: "Yesterday", active: false },
] as const;

function ProviderGlyph({ provider }: { provider: "codex" | "claude" }) {
  return provider === "codex" ? (
    <OpenAIIcon className="size-3.5 shrink-0" />
  ) : (
    <ClaudeIcon className="size-3.5 shrink-0" />
  );
}

export function ThreadMock() {
  return (
    <figure className="mx-auto w-full max-w-5xl">
      <div
        role="img"
        aria-label={DESCRIPTION}
        className="overflow-hidden rounded-md border border-border bg-surface text-left text-sm shadow-(--shadow-window)"
      >
        <div className="flex min-h-0">
          {/* Sidebar: wide screens only. Shows both clouds side by side in one thread list. */}
          <div aria-hidden className="hidden w-64 shrink-0 border-r border-border bg-inset p-3 md:block">
            <div className="flex items-center justify-between px-2 pb-2 text-xs text-muted">
              <span className="font-medium text-ink">megha</span>
              <span>4 threads</span>
            </div>
            <ul className="grid gap-0.5">
              {THREADS.map((t) => (
                <li
                  key={t.title}
                  className={`flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 ${t.active ? "bg-subtle text-ink" : "text-muted"}`}
                >
                  <ProviderGlyph provider={t.provider} />
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <span className={`shrink-0 text-xs ${t.active ? "text-accent" : ""}`}>{t.status}</span>
                </li>
              ))}
            </ul>
          </div>

          <div aria-hidden className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-3 border-b border-border px-4 py-3 sm:px-5">
              <span className="min-w-0 truncate font-medium">Add a --version flag</span>
              <span className="inline-flex shrink-0 items-center gap-2.5 rounded-full bg-subtle py-0.5 pr-2 pl-2 text-xs text-muted">
                <span className="relative inline-flex">
                  <OpenAIIcon className="size-3.5 text-ink" />
                  <MeghaMark className="absolute -right-1.5 -bottom-1 size-2.5 rounded-full bg-subtle text-accent" />
                </span>
                Codex Cloud
              </span>
              <span className="ml-auto hidden shrink-0 text-xs text-muted sm:inline">Open task on chatgpt.com ↗</span>
            </div>

            <div className="grid gap-4 px-4 py-5 sm:px-5">
              <p className="ml-auto max-w-[34ch] rounded-md bg-subtle px-3.5 py-2.5">
                Add a <code className="font-mono text-xs">--version</code> flag to the CLI that prints the version from
                package.json. Add a test.
              </p>

              <ol className="grid gap-1.5 rounded-sm bg-inset p-3 font-mono text-xs text-muted">
                <LogRow i={0} mark={<span className="size-1.5 rounded-full bg-accent" />}>
                  Cloud task started · kausthubh-coder/megha @ main
                </LogRow>
                <LogRow i={1} mark={<Tick />}>
                  Setup <span className="text-ink">bun install</span> · 41 packages · 2.1s
                </LogRow>
                <LogRow i={2} mark={<Tick />}>
                  Ran <span className="text-ink">node test/offline.mjs</span> · <span className="text-success">19 passed</span>
                </LogRow>
                <LogRow i={3} mark={<Tick />}>
                  Edited index.mjs, test/offline.mjs · <span className="text-success">+14</span> −2
                </LogRow>
              </ol>

              <p className="max-w-[62ch] text-ink">
                Added <code className="font-mono text-xs">--version</code> and <code className="font-mono text-xs">-v</code> to{" "}
                <code className="font-mono text-xs">index.mjs</code>. It reads the version from package.json at startup, so it
                can&apos;t drift from what npm publishes. The offline test now runs the flag and checks the output
                <span className="ml-0.5 inline-block h-[1.1em] w-[0.5ch] translate-y-[0.2em] bg-accent" />
              </p>
            </div>

            <div className="mt-auto border-t border-border px-4 py-3 sm:px-5">
              <div className="flex items-center gap-2 rounded-sm border border-border bg-bg px-3 py-2">
                <span className="flex-1 truncate text-muted">Ask for follow-up changes</span>
                <span className="hidden rounded-full bg-subtle px-2 py-0.5 text-xs text-muted sm:inline">Env: megha</span>
                <span className="hidden rounded-full bg-subtle px-2 py-0.5 text-xs text-muted lg:inline">Apply diff locally</span>
                <span className="grid size-7 place-items-center rounded-sm bg-ink" title="Stop">
                  <span className="size-2.5 rounded-[2px] bg-bg" />
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-xs text-muted">
        Illustration of a T3 Code thread running on Codex Cloud, drawn for this page. Not a screenshot.
      </figcaption>
    </figure>
  );
}

function LogRow({ i, mark, children }: { i: number; mark: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="mock-reveal flex items-center gap-2.5" style={{ "--i": i } as React.CSSProperties}>
      <span className="grid w-3 shrink-0 place-items-center">{mark}</span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function Tick() {
  return (
    <svg viewBox="0 0 12 12" className="size-3 text-success" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M2.5 6.5l2.2 2.2L9.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
