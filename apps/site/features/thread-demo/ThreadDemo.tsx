"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { MeghaMark } from "@/features/brand/MeghaMark";
import { ClaudeIcon, OpenAIIcon } from "@/features/brand/ProviderIcons";
import { PROMPT_SENT_EVENT } from "@/features/sky/LightningFlash";
import {
  ANSWER_WORDS,
  CHAR_TIMES,
  DESCRIPTION,
  DIFF,
  DIFF_FILE,
  PROMPT,
  REPO,
  SETUP_LOG,
  T,
  TEST_COMMAND,
  TEST_RESULT,
  THREAD_TITLE,
  WORD_TIMES,
} from "./script";

// A T3 Code thread that plays from prompt to answer. The server renders the finished thread, so the
// content is all there without JS, with reduced motion, and before the first run. When the window
// scrolls into view the thread fades, resets and plays as a CSS timeline: every element gets an inline
// animation with its start time, so the compositor runs the whole run and React renders once per run.
// It loops, pauses offscreen and has its own Pause and Replay buttons.

type Phase = "static" | "fading" | "playing";

const EASE = "var(--ease-out)";
const enter = (at: number, kind = "t-in", ms = 320) => `${kind} ${ms}ms ${EASE} ${at}ms both`;
const leave = (at: number, ms = 160) => `t-hide ${ms}ms ease-in ${at}ms forwards`;
const returns = (at: number, ms = 220) => `t-show ${ms}ms ${EASE} ${at}ms forwards`;

const subscribeMotion = (cb: () => void) => {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const useReducedMotion = () =>
  useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );

export function ThreadDemo() {
  const [phase, setPhase] = useState<Phase>("static");
  const [run, setRun] = useState(0);
  const [userPaused, setUserPaused] = useState(false);
  const [offscreen, setOffscreen] = useState(false);
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  const figureRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const scrollAnim = useRef<Animation | null>(null);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const playing = phase === "playing";
  const paused = playing && (userPaused || offscreen);

  useEffect(() => {
    reducedRef.current = reduced;
  }, [reduced]);

  const start = useCallback(() => {
    setUserPaused(false);
    setPhase("fading");
    clearTimeout(fadeTimer.current);
    fadeTimer.current = setTimeout(() => {
      setRun((r) => r + 1);
      setPhase("playing");
    }, 260);
  }, []);

  useEffect(() => () => clearTimeout(fadeTimer.current), []);

  // Pause stops every loop on the page, not just this one: the rain, the drifting clouds and the
  // diagram run for as long as the page is open, so they need the same off switch (WCAG 2.2.2).
  useEffect(() => {
    const root = document.documentElement;
    if (userPaused) root.dataset.motion = "paused";
    else delete root.dataset.motion;
    return () => {
      delete root.dataset.motion;
    };
  }, [userPaused]);

  // Pause offscreen, and start the first run once a quarter of the window is in view.
  useEffect(() => {
    const el = figureRef.current;
    if (!el) return;
    let started = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver(
      ([entry]) => {
        setOffscreen(!entry.isIntersecting);
        if (!started && entry.intersectionRatio >= 0.25 && !reducedRef.current) {
          started = true;
          timer = setTimeout(start, 900);
        }
      },
      { threshold: [0, 0.25] },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clearTimeout(timer);
    };
  }, [start]);

  // Keep the newest item in view, like a thread that sticks to the bottom. Block heights are reserved
  // from the start, so they can be measured once per run; the scroll plays as one WAAPI animation.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const column = columnRef.current;
    if (!viewport || !column) return;
    const overflow = () => Math.max(0, column.offsetHeight - viewport.clientHeight);

    if (phase !== "playing") {
      // The finished thread: show its end when it doesn't fit.
      const place = () => (column.style.transform = `translateY(${-overflow()}px)`);
      if (phase === "static") place();
      window.addEventListener("resize", place);
      return () => window.removeEventListener("resize", place);
    }

    column.style.transform = "";
    const height = viewport.clientHeight;
    const blocks = [...column.querySelectorAll<HTMLElement>("[data-follow]")]
      .map((el) => ({ at: Number(el.dataset.follow), bottom: el.offsetTop + el.offsetHeight }))
      .sort((a, b) => a.at - b.at);
    const frames: Keyframe[] = [{ offset: 0, transform: "translateY(0px)" }];
    let current = 0;
    let lastOffset = 0;
    for (const b of blocks) {
      const target = Math.min(overflow(), Math.max(current, b.bottom + 20 - height));
      if (target <= current) continue;
      const from = Math.max(b.at / T.end, lastOffset);
      const to = Math.min((b.at + (reducedRef.current ? 1 : 500)) / T.end, 1);
      if (to <= from) continue;
      frames.push({ offset: from, transform: `translateY(${-current}px)`, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
      frames.push({ offset: to, transform: `translateY(${-target}px)` });
      current = target;
      lastOffset = to;
    }
    frames.push({ offset: 1, transform: `translateY(${-current}px)` });
    const anim = column.animate(frames, { duration: T.end, fill: "forwards" });
    scrollAnim.current = anim;
    return () => {
      anim.cancel();
      scrollAnim.current = null;
    };
  }, [phase, run]);

  useEffect(() => {
    const anim = scrollAnim.current;
    if (!anim) return;
    if (paused) anim.pause();
    else if (anim.playState === "paused") anim.play();
  }, [paused, run]);

  function onRunEnd(e: React.AnimationEvent) {
    if (e.animationName !== "t-hold") return;
    if (reducedRef.current) setPhase("static");
    else start();
  }

  const a = (animation: string) => (playing ? { animation } : undefined);
  // Elements that only exist mid-run (spinners, the typed draft) are hidden in the finished thread.
  const transient = playing ? "" : "opacity-0";

  const label = phase === "static" ? "Play" : paused && userPaused ? "Resume" : "Pause";

  return (
    <figure ref={figureRef} className="mx-auto w-full max-w-[68rem]">
      <div
        role="img"
        aria-label={DESCRIPTION}
        data-paused={paused ? "" : undefined}
        data-fading={phase === "fading" ? "" : undefined}
        className="group/demo relative overflow-hidden rounded-md border border-border bg-surface text-left text-sm shadow-(--shadow-window)"
      >
        {/* The sentinel times the run; its animationend starts the next one. */}
        <span
          aria-hidden
          className="pointer-events-none invisible absolute size-px"
          style={playing ? { animation: `t-hold ${T.end}ms linear both` } : undefined}
          onAnimationEnd={onRunEnd}
        />
        {/* The moment the prompt is sent, the sky flashes. */}
        <span
          aria-hidden
          className="pointer-events-none invisible absolute size-px"
          style={playing && !reduced ? { animation: `t-hold 1ms linear ${T.send}ms both` } : undefined}
          onAnimationStart={(e) => e.animationName === "t-hold" && window.dispatchEvent(new Event(PROMPT_SENT_EVENT))}
        />

        <div key={run} aria-hidden className="flex">
          <Sidebar a={a} transient={transient} />

          <div className="flex min-w-0 flex-1 flex-col">
            {/* Header */}
            <div className="flex h-12 items-center gap-3 border-b border-border px-4 sm:px-5">
              <span className="grid min-w-0 flex-1 font-medium [&>*]:col-start-1 [&>*]:row-start-1">
                <span className={`truncate text-muted ${transient}`} style={a(leave(T.title))}>
                  New thread
                </span>
                <span className="demo-fade truncate" style={a(enter(T.title, "t-show", 260))}>
                  {THREAD_TITLE}
                </span>
              </span>
              <ProviderChip />
            </div>

            {/* Messages */}
            <div ref={viewportRef} className="relative h-[24rem] overflow-hidden sm:h-[28rem] md:h-[34rem]">
              <div ref={columnRef} className="demo-fade grid grid-cols-[minmax(0,1fr)] gap-3.5 px-4 py-5 sm:px-6">
                <p
                  data-follow={T.bubble}
                  className="ml-auto max-w-[44ch] rounded-md rounded-br-sm bg-subtle px-3.5 py-2.5 text-ink"
                  style={a(enter(T.bubble, "t-pop", 420))}
                >
                  {PROMPT}
                </p>

                <WorkRow
                  follow={T.setup}
                  a={a}
                  transient={transient}
                  at={T.setup}
                  doneAt={T.setupDone}
                  title="Preparing the cloud environment"
                  meta="14s"
                >
                  <ol className="mt-2 grid gap-0.5 rounded-sm bg-inset px-3 py-2.5 font-mono text-xs text-muted">
                    {SETUP_LOG.map((line, i) => (
                      <li
                        key={line}
                        data-follow={T.logTimes[i]}
                        className="truncate"
                        style={a(enter(T.logTimes[i], "t-in", 260))}
                      >
                        
                        {line}
                      </li>
                    ))}
                  </ol>
                </WorkRow>

                <WorkRow follow={T.read} a={a} transient={transient} at={T.read} doneAt={T.read + 300} kind="read" title={`Read ${DIFF_FILE}`} />

                <WorkRow
                  follow={T.edit}
                  a={a}
                  transient={transient}
                  at={T.edit}
                  doneAt={T.diffTimes.at(-1)! + 200}
                  kind="edit"
                  title="Edited sync.ts, sync.test.ts"
                  meta={
                    <>
                      <span className="text-success">+30</span> <span className="text-danger">−3</span>
                    </>
                  }
                >
                  <div className="mt-2 overflow-hidden rounded-sm border border-border font-mono text-xs" data-follow={T.edit + 200}>
                    <div className="flex items-center justify-between gap-3 border-b border-border bg-inset px-3 py-1.5 text-muted">
                      <span className="truncate">{DIFF_FILE}</span>
                      <span className="shrink-0">
                        <span className="text-success">+6</span> <span className="text-danger">−3</span>
                      </span>
                    </div>
                    <div className="py-1">
                      {DIFF.map((line, i) => (
                        <div
                          key={i}
                          data-follow={T.diffTimes[i]}
                          className={`relative overflow-hidden px-3 leading-[1.6rem] whitespace-pre ${
                            line.kind === "add"
                              ? "text-ink"
                              : line.kind === "del"
                                ? "text-muted"
                                : "text-muted opacity-70"
                          }`}
                          style={a(enter(T.diffTimes[i], "t-show", 240))}
                        >
                          {line.kind !== "hunk" && line.kind !== "ctx" ? (
                            <span
                              aria-hidden
                              className={`absolute inset-0 ${line.kind === "add" ? "bg-success/12" : "bg-danger/10"}`}
                            />
                          ) : null}
                          <span className={`relative mr-2 select-none ${line.kind === "add" ? "text-success" : line.kind === "del" ? "text-danger" : ""}`}>
                            {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                          </span>
                          <span className="relative">{line.text}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </WorkRow>

                <WorkRow
                  follow={T.ran}
                  a={a}
                  transient={transient}
                  at={T.ran}
                  doneAt={T.ranDone}
                  kind="run"
                  title={
                    <>
                      Ran <span className="font-mono text-xs text-ink">{TEST_COMMAND}</span>
                    </>
                  }
                  meta="6s"
                >
                  <p className="mt-1 pl-6 font-mono text-xs text-success" data-follow={T.ranDone} style={a(enter(T.ranDone, "t-show", 200))}>
                    ✓ {TEST_RESULT}
                  </p>
                </WorkRow>

                <p data-follow={T.answer} className="mt-1 max-w-[62ch] text-ink text-pretty">
                  {ANSWER_WORDS.map((w, i) => (
                    <span key={i} style={a(enter(WORD_TIMES[i], "t-show", 180))}>
                      {w}{" "}
                    </span>
                  ))}
                </p>

                <p data-follow={T.done} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted" style={a(enter(T.done, "t-show", 260))}>
                  <span className="text-accent underline decoration-accent/40 underline-offset-4">Open in Codex Cloud ↗</span>
                  <span>Worked for 1m 12s</span>
                </p>
              </div>
              {/* A fade on the top edge once the thread scrolls. */}
              <div className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-linear-to-b from-surface to-[transparent]" />
            </div>

            <Composer a={a} transient={transient} />
          </div>
        </div>
      </div>

      <figcaption className="mt-4 flex flex-col gap-3 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
        <span>Illustration of a T3 Code thread on Codex Cloud, drawn for this page. Not a screenshot.</span>
        <span className="flex gap-2">
          <DemoButton
            onClick={() => {
              if (phase === "static") start();
              else setUserPaused((p) => !p);
            }}
            icon={label === "Pause" ? "pause" : "play"}
          >
            {label === "Play" ? "Play the thread" : label}
            {label === "Play" ? null : <span className="sr-only"> animations</span>}
          </DemoButton>
          {phase !== "static" ? (
            <DemoButton onClick={start} icon="replay">
              Replay
            </DemoButton>
          ) : null}
        </span>
      </figcaption>
    </figure>
  );
}

type Anim = (animation: string) => React.CSSProperties | undefined;

function ProviderChip() {
  return (
    <span className="inline-flex shrink-0 items-center gap-2 rounded-full bg-subtle py-1 pr-2.5 pl-2 text-xs text-muted">
      <span className="relative inline-flex">
        <OpenAIIcon className="size-3.5 text-ink" />
        <MeghaMark className="absolute -right-1.5 -bottom-1 size-2.5 rounded-full bg-subtle text-accent" />
      </span>
      Codex Cloud
    </span>
  );
}

const THREADS = [
  { title: "Why is the poster grid janky?", provider: "claude", when: "2m" },
  { title: "Skip-intro button for episodes", provider: "codex", when: "1h" },
  { title: "Explain the HLS fallback", provider: "claude", when: "Yesterday" },
] as const;

function Sidebar({ a, transient }: { a: Anim; transient: string }) {
  return (
    <div className="hidden w-60 shrink-0 flex-col border-r border-border bg-inset p-3 md:flex">
      <div className="flex items-center justify-between px-2 pb-3 text-xs text-muted">
        <span className="flex items-center gap-2 font-medium text-ink">
          <FolderIcon />
          {REPO}
        </span>
        <span>4 threads</span>
      </div>
      <ul className="grid gap-0.5">
        <li className="flex min-w-0 items-center gap-2 rounded-sm bg-subtle px-2 py-1.5 text-ink">
          <OpenAIIcon className="size-3.5 shrink-0" />
          <span className="grid min-w-0 flex-1 [&>*]:col-start-1 [&>*]:row-start-1">
            <span className={`truncate text-muted ${transient}`} style={a(leave(T.title))}>
              New thread
            </span>
            <span className="demo-fade truncate" style={a(enter(T.title, "t-show", 260))}>
              {THREAD_TITLE}
            </span>
          </span>
          <span className="grid shrink-0 text-xs [&>*]:col-start-1 [&>*]:row-start-1">
            <span className={`text-accent ${transient}`} style={a(`${enter(T.send, "t-show", 200)}, ${leave(T.done)}`)}>
              <Spinner />
            </span>
            <span className="demo-fade text-muted" style={a(enter(T.done, "t-show", 200))}>
              now
            </span>
          </span>
        </li>
        {THREADS.map((t) => (
          <li key={t.title} className="flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-muted">
            {t.provider === "codex" ? <OpenAIIcon className="size-3.5 shrink-0" /> : <ClaudeIcon className="size-3.5 shrink-0" />}
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            <span className="shrink-0 text-xs">{t.when}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WorkRow({
  a,
  transient,
  at,
  doneAt,
  follow,
  title,
  meta,
  kind = "setup",
  children,
}: {
  a: Anim;
  transient: string;
  at: number;
  doneAt: number;
  follow: number;
  title: React.ReactNode;
  meta?: React.ReactNode;
  kind?: "setup" | "read" | "edit" | "run";
  children?: React.ReactNode;
}) {
  return (
    <div data-follow={follow} style={a(enter(at))}>
      <div className="flex min-w-0 items-center gap-2.5 text-muted">
        <span className="grid size-4 shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1">
          <span className={`text-accent ${transient}`} style={a(leave(doneAt, 120))}>
            <Spinner />
          </span>
          <span style={a(enter(doneAt, "t-show", 200))}>
            <KindIcon kind={kind} />
          </span>
        </span>
        <span className="min-w-0 truncate">{title}</span>
        {meta ? (
          <span className="ml-auto shrink-0 text-xs tabular-nums" style={a(enter(doneAt, "t-show", 200))}>
            {meta}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function Composer({ a, transient }: { a: Anim; transient: string }) {
  return (
    <div className="border-t border-border px-4 py-3 sm:px-5">
      <div className="rounded-sm border border-border bg-bg px-3 pt-2.5 pb-2">
        {/* The draft, the placeholder before it, and the follow-up placeholder share one cell. */}
        <div className="grid min-h-[2.75rem] text-ink [&>*]:col-start-1 [&>*]:row-start-1">
          <span className={`text-muted ${transient}`} style={a(leave(CHAR_TIMES[0], 1))}>
            Ask anything, @ to mention files
          </span>
          <span className={transient} style={a(leave(T.send, 120))}>
            {PROMPT.split("").map((ch, i) => (
              <span key={i} style={a(`t-show 1ms linear ${CHAR_TIMES[i]}ms both`)}>
                {ch}
              </span>
            ))}
          </span>
          <span className="demo-fade text-muted" style={a(enter(T.send + 200, "t-show", 200))}>
            Ask for follow-up changes
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-xs text-muted">
          <span className="rounded-full bg-subtle px-2 py-0.5">Env: {REPO}</span>
          <span className="hidden rounded-full bg-subtle px-2 py-0.5 sm:inline">Apply diff locally: off</span>
          <span className="ml-auto grid [&>*]:col-start-1 [&>*]:row-start-1">
            {/* Send, then Stop while the cloud works, then Send again. */}
            <span
              className="grid size-7 place-items-center rounded-full bg-accent text-accent-fg"
              style={a(`t-press 220ms ease-out ${T.send - 120}ms, t-hide 1ms linear ${T.send + 100}ms forwards, ${returns(T.done)}`)}
            >
              <ArrowUp />
            </span>
            <span
              className={`grid size-7 place-items-center rounded-full bg-ink ${transient}`}
              style={a(`${enter(T.send + 100, "t-show", 120)}, ${leave(T.done, 120)}`)}
            >
              <span className="size-2.5 rounded-[2px] bg-bg" />
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

function DemoButton({
  onClick,
  icon,
  children,
}: {
  onClick: () => void;
  icon: "play" | "pause" | "replay";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-full bg-subtle px-4 text-sm font-medium text-ink transition-transform duration-100 ease-out hover:bg-border active:scale-[0.97] sm:h-9"
    >
      <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden>
        {icon === "play" ? (
          <path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.3-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5Z" />
        ) : icon === "pause" ? (
          <path d="M4 2.5h2.6v11H4zM9.4 2.5H12v11H9.4z" />
        ) : (
          <path d="M8 2.5a5.5 5.5 0 1 1-5.3 4H1l2.6-3 2.6 3H4.3A4 4 0 1 0 8 4Z" />
        )}
      </svg>
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 16 16" className="t-spin size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M8 2a6 6 0 1 0 6 6" strokeLinecap="round" />
    </svg>
  );
}

function KindIcon({ kind }: { kind: "setup" | "read" | "edit" | "run" }) {
  const common = { viewBox: "0 0 16 16", className: "size-3.5", fill: "none", stroke: "currentColor", strokeWidth: 1.5, "aria-hidden": true } as const;
  if (kind === "read")
    return (
      <svg {...common}>
        <path d="M4 1.8h5l3 3v9.4H4z M9 1.8v3h3" strokeLinejoin="round" />
      </svg>
    );
  if (kind === "edit")
    return (
      <svg {...common}>
        <path d="M10.5 2.5l3 3-7.5 7.5H3v-3z" strokeLinejoin="round" />
      </svg>
    );
  if (kind === "run")
    return (
      <svg {...common}>
        <path d="M3 4l4 4-4 4M8.5 12h4.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  return (
    <svg {...common} className="size-3.5 text-success">
      <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M1.8 4.2c0-.6.5-1 1-1h3.3l1.4 1.6h5.7c.5 0 1 .4 1 1v6.7c0 .5-.5 1-1 1H2.8c-.5 0-1-.5-1-1z" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowUp() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M8 13V3M3.8 7.2L8 3l4.2 4.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
