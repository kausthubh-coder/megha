import { CopyButton } from "./CopyButton";
import { CopyFallbackHint } from "./CopyFallback";
import { SETUP_PATH } from "./install";

/** The one-line setup prompt, shown in full so people can read what they paste, and the file it points to. */
export function CodeBlockPrompt({ id, prompt }: { id: string; prompt: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface shadow-(--shadow-window)">
      <div className="flex items-center justify-between gap-3 border-b border-border py-2 pr-2 pl-4">
        <span className="text-sm text-muted">Setup prompt</span>
        <CopyButton text={prompt} label="Copy prompt" variant="quiet" fallbackTargetId={id} />
      </div>
      <CopyFallbackHint targetId={id} what="prompt" />
      <p id={id} tabIndex={0} className="px-4 py-5 font-mono text-sm leading-relaxed text-ink break-words sm:px-5 sm:text-base">
        {prompt}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-inset px-4 py-3 text-sm text-muted sm:px-5">
        <a
          href={SETUP_PATH}
          className="inline-flex h-11 items-center gap-1.5 font-medium text-ink underline decoration-border underline-offset-4 hover:decoration-current sm:h-auto sm:py-1"
        >
          Read the full setup
          <span aria-hidden>↗</span>
        </a>
        <span>It&apos;s the file the agent follows: what it runs, what it edits, and what it never touches.</span>
      </div>
    </div>
  );
}
