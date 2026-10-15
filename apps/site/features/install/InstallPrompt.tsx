import { CopyButton } from "./CopyButton";

/** The install prompt, shown in full so people can read what they paste. */
export function CodeBlockPrompt({ id, prompt }: { id: string; prompt: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface shadow-(--shadow-window)">
      <div className="flex items-center justify-between gap-3 border-b border-border py-2 pr-2 pl-4">
        <span className="text-sm text-muted">Install prompt</span>
        <CopyButton text={prompt} label="Copy prompt" fallbackTargetId={id} />
      </div>
      <pre
        id={id}
        tabIndex={0}
        className="p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap sm:p-5"
      >
        {prompt}
      </pre>
    </div>
  );
}
