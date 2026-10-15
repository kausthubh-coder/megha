"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { detectOs } from "./install";

// When the clipboard API is blocked, the copy button hands over to the block it copies from: that
// block shows how to copy by hand, right above the text, selects the text and takes focus. The hero's
// button copies a prompt far down the page, so the instructions can't live next to the button.

type Fallback = { id: string; phase: "blocked" | "copied" } | null;

let current: Fallback = null;
const listeners = new Set<() => void>();
let clearTimer: ReturnType<typeof setTimeout> | undefined;

function set(next: Fallback) {
  current = next;
  for (const l of listeners) l();
}

/** Called by CopyButton when writeText fails. Returns false when no hint is mounted for `id`. */
export function showCopyFallback(id: string): boolean {
  if (!document.getElementById(hintId(id))) return false;
  clearTimeout(clearTimer);
  set({ id, phase: "blocked" });
  return true;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const hintId = (id: string) => `${id}-copy-hint`;

/** The instructions row. Renders nothing visible until its block's copy is blocked. */
export function CopyFallbackHint({ targetId, what }: { targetId: string; what: string }) {
  const state = useSyncExternalStore(subscribe, () => current, () => null);
  const phase = state?.id === targetId ? state.phase : null;
  const ref = useRef<HTMLParagraphElement>(null);
  const keys = useSyncExternalStore(
    subscribe,
    () => (detectOs(navigator.userAgent) === "macos" ? "⌘C" : "Ctrl+C"),
    () => "Ctrl+C",
  );

  useEffect(() => {
    if (phase !== "blocked") return;
    const hint = ref.current;
    const target = document.getElementById(targetId);
    if (!hint || !target) return;
    // Focus first, then select: the selection is what Ctrl+C copies, wherever focus is.
    hint.focus({ preventScroll: true });
    window.getSelection()?.selectAllChildren(target);
    // Bring the whole block (title, button, instructions) into view when its top is off screen or low.
    const block = hint.parentElement ?? hint;
    const top = block.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight * 0.5) block.scrollIntoView({ block: "start" });

    const onCopy = () => {
      set({ id: targetId, phase: "copied" });
      clearTimer = setTimeout(() => set(null), 2000);
    };
    document.addEventListener("copy", onCopy, { once: true });
    return () => document.removeEventListener("copy", onCopy);
  }, [phase, targetId]);

  return (
    <p
      ref={ref}
      id={hintId(targetId)}
      tabIndex={-1}
      hidden={!phase}
      className="border-b border-border bg-accent-soft px-4 py-2.5 text-sm text-ink focus-visible:outline-offset-[-2px]"
    >
      {phase === "copied"
        ? "Copied."
        : `Your browser blocked the clipboard, so the ${what} is selected instead. Press ${keys} to copy it.`}
    </p>
  );
}
