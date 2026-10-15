"use client";

import { useEffect, useRef, useState } from "react";
import { showCopyFallback } from "./CopyFallback";

// handedOff: the clipboard is blocked and the copied block now shows how to copy by hand.
type State = "idle" | "copied" | "handedOff" | "failed";

const RESET_MS = 2000;

/**
 * Copies `text`. The label says what happened ("Copied", or how to copy by hand when the clipboard
 * is blocked) and a polite live region announces it. The width is held by the longest label so
 * nothing next to the button moves.
 */
export function CopyButton({
  text,
  label,
  variant = "primary",
  fallbackTargetId,
  srContext,
  className = "",
}: {
  text: string;
  label: string;
  /** Extra words for screen readers when several buttons share one short label ("Copy" + "Zed settings.json"). */
  srContext?: string;
  variant?: "primary" | "quiet";
  /** Element whose text gets selected when the clipboard API fails, so Ctrl+C / Cmd+C works. */
  fallbackTargetId?: string;
  className?: string;
}) {
  const [state, setState] = useState<State>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    clearTimeout(timer.current);
    let next: State = "copied";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // The block being copied shows the instructions, selects its text and takes focus.
      next = fallbackTargetId && showCopyFallback(fallbackTargetId) ? "handedOff" : "failed";
    }
    setState(next);
    // A failure needs longer: the person has to read the label and press the keys.
    timer.current = setTimeout(() => setState("idle"), next === "copied" ? RESET_MS : RESET_MS * 2);
  }

  const labels: Record<State, string> = {
    idle: label,
    copied: "Copied",
    handedOff: "Text selected",
    failed: "Copy blocked",
  };

  const base =
    "group relative inline-grid cursor-pointer select-none place-items-center whitespace-nowrap rounded-sm font-medium transition-transform duration-100 ease-out active:scale-[0.97]";
  const look =
    variant === "primary"
      ? "h-11 px-5 text-sm bg-accent text-accent-fg hover:bg-accent-hover"
      : "h-11 px-3 text-sm text-ink bg-subtle hover:bg-border sm:h-9";

  return (
    <>
      <button type="button" onClick={copy} data-state={state} className={`${base} ${look} ${className}`}>
        {/* Every label sits in the same grid cell; the invisible ones hold the widest width. */}
        {(Object.keys(labels) as State[]).map((key) => (
          <span
            key={key}
            aria-hidden={key !== state}
            className={`col-start-1 row-start-1 inline-flex items-center gap-2 transition-[opacity,scale,filter] duration-200 ease-out motion-reduce:transition-none ${
              key === state ? "scale-100 opacity-100 blur-none" : "pointer-events-none scale-90 opacity-0 blur-[2px]"
            }`}
          >
            {key === "copied" ? <CheckIcon /> : key === "idle" ? <CopyIcon /> : null}
            {labels[key]}
            {key === "idle" && srContext ? <span className="sr-only"> {srContext}</span> : null}
          </span>
        ))}
      </button>
      {/* handedOff says nothing here: focus moves to the visible instructions, which get read out. */}
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "Copied to clipboard" : state === "failed" ? "The clipboard is blocked." : ""}
      </span>
    </>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-[1.125em]" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <rect x="6.5" y="6.5" width="10" height="10" rx="2" />
      <path d="M13.5 6.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v7A1.5 1.5 0 0 0 5 13.5h1.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-[1.125em]" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M4.5 10.5l3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
