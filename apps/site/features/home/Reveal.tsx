"use client";

import { useEffect } from "react";

/**
 * Scroll reveals for every [data-reveal] element. Only elements that start below the fold get hidden,
 * and only once this has run, so the server HTML, no-JS visitors and anything already on screen see the
 * page complete. Each element shows once, when it scrolls in. With reduced motion globals.css applies
 * no styles to these states. Before printing, everything shows.
 */
export function Reveal() {
  useEffect(() => {
    if (!("IntersectionObserver" in window)) return;
    const els = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          (e.target as HTMLElement).dataset.reveal = "shown";
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    for (const el of els) {
      if (el.getBoundingClientRect().top > window.innerHeight) {
        el.dataset.reveal = "hidden";
        io.observe(el);
      }
    }
    const showAll = () => {
      for (const el of els) el.dataset.reveal = "shown";
      io.disconnect();
    };
    window.addEventListener("beforeprint", showAll);
    return () => {
      io.disconnect();
      window.removeEventListener("beforeprint", showAll);
    };
  }, []);

  return null;
}
