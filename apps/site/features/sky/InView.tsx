"use client";

import { useEffect, useRef } from "react";

/**
 * A div that marks itself data-inview="true" or "false". globals.css pauses every animation inside a
 * region that is out of view, so offscreen loops cost nothing. Before hydration the attribute is absent
 * and everything runs, which is the safe default.
 */
export function InView({ children, ...props }: React.ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      el.dataset.inview = String(entry.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} {...props}>
      {children}
    </div>
  );
}
