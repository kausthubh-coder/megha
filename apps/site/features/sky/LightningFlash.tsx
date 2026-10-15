"use client";

import { useEffect, useRef } from "react";

/** Fired by the thread demo when its prompt is sent; the sky answers with a flash. */
export const PROMPT_SENT_EVENT = "megha:prompt-sent";

/**
 * Sheet lightning behind the cloud bank: a soft glow that pulses on its own every 11 s, and once more
 * whenever the thread demo sends its prompt. Opacity only, dim enough to stay far below flash limits,
 * and off with reduced motion (globals.css).
 */
export function LightningFlash() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onSent = () => {
      // Restart the one-shot animation: drop the attribute, flush styles, set it again.
      el.removeAttribute("data-now");
      void el.offsetWidth;
      el.setAttribute("data-now", "");
      clearTimeout(timer);
      timer = setTimeout(() => el.removeAttribute("data-now"), 1000);
    };
    window.addEventListener(PROMPT_SENT_EVENT, onSent);
    return () => {
      window.removeEventListener(PROMPT_SENT_EVENT, onSent);
      clearTimeout(timer);
    };
  }, []);

  return (
    <div
      ref={ref}
      className="sky-flash absolute inset-x-0 top-0 h-[40rem] opacity-0 bg-[radial-gradient(42%_36%_at_58%_30%,var(--flash),transparent_72%)]"
    />
  );
}
