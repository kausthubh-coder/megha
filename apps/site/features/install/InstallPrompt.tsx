import { CopyButton } from "./CopyButton";
import { CopyFallbackHint } from "./CopyFallback";

/** The one-line setup prompt, shown in full so people can read what they paste, with its copy button. */
export function PromptBox({ id, prompt, className = "" }: { id: string; prompt: string; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-2xl border border-border bg-surface text-left shadow-(--shadow-window) ${className}`}>
      <CopyFallbackHint targetId={id} what="prompt" />
      <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:gap-4 sm:py-2.5 sm:pr-2.5 sm:pl-5">
        {/* The caret sits outside the text, so a hand copy after a blocked clipboard gets only the prompt. */}
        <div className="flex min-w-0 flex-1 gap-2 px-1 pt-1 font-mono text-xs leading-relaxed sm:p-0 sm:text-sm">
          <span aria-hidden className="text-accent select-none">
            ›
          </span>
          <p id={id} tabIndex={0} className="min-w-0 text-ink break-words">
            {/* From sm up the URL never splits at its hyphen; the line breaks before it instead. */}
            {prompt.split(/(https:\/\/\S+)/).map((part, i) =>
              i % 2 ? (
                <span key={i} className="[overflow-wrap:anywhere] sm:whitespace-nowrap">
                  {part}
                </span>
              ) : (
                part
              ),
            )}
          </p>
        </div>
        <CopyButton text={prompt} label="Copy prompt" fallbackTargetId={id} className="shrink-0" />
      </div>
    </div>
  );
}
