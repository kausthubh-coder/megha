import { CopyButton } from "./CopyButton";

/** A labelled block of code or commands with its own copy button. */
export function CodeBlock({
  id,
  label,
  code,
  copyName = label,
  wrap = false,
}: {
  id: string;
  label: string;
  code: string;
  /** What the copy button copies, for screen readers. Defaults to the label. */
  copyName?: string;
  wrap?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border py-1.5 pr-1.5 pl-4">
        <span className="truncate text-xs text-muted">{label}</span>
        <CopyButton text={code} label="Copy" srContext={copyName} variant="quiet" fallbackTargetId={id} />
      </div>
      <pre
        id={id}
        tabIndex={0}
        className={`overflow-x-auto p-4 font-mono text-xs leading-relaxed ${wrap ? "whitespace-pre-wrap break-words" : ""}`}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
