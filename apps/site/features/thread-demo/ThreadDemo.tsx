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
    <figure ref={figureRef} className="mx-auto w-full max-w-[72rem]">
      <div
        role="img"
        aria-label={DESCRIPTION}
        data-paused={paused ? "" : undefined}
        data-fading={phase === "fading" ? "" : undefined}
        className="t3-window group/demo relative overflow-hidden rounded-xl border border-border bg-surface text-left text-[13px] leading-normal text-ink shadow-(--shadow-window)"
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
            {/* Header: project / thread title, and the thread's actions. */}
            <div className="flex h-12 items-center gap-2.5 px-4 sm:px-5">
              <ProjectBadge />
              <span className="hidden text-[14px] text-muted sm:inline">{REPO}</span>
              <span className="hidden text-[14px] text-muted sm:inline">/</span>
              <span className="grid min-w-0 flex-1 text-[14px] font-medium [&>*]:col-start-1 [&>*]:row-start-1">
                <span className={`truncate text-muted ${transient}`} style={a(leave(T.title))}>
                  New thread
                </span>
                <span className="demo-fade truncate" style={a(enter(T.title, "t-show", 260))}>
                  {THREAD_TITLE}
                </span>
              </span>
              <span className="hidden items-center gap-1.5 sm:flex">
                <HeaderPill>
                  <PlusIcon />
                </HeaderPill>
                <HeaderPill>
                  <GitHubIcon />
                </HeaderPill>
              </span>
            </div>

            {/* Messages */}
            <div ref={viewportRef} className="relative h-[24rem] overflow-hidden sm:h-[28rem] md:h-[32rem]">
              <div
                ref={columnRef}
                className="demo-fade mx-auto grid max-w-[46rem] grid-cols-[minmax(0,1fr)] gap-3.5 px-4 pt-4 pb-6 sm:px-8"
              >
                <p
                  data-follow={T.bubble}
                  className="ml-auto max-w-[min(30rem,85%)] rounded-2xl bg-bubble px-4 py-3 text-[14px] text-ink"
                  style={a(enter(T.bubble, "t-pop", 420))}
                >
                  {PROMPT}
                </p>

                {/* "Working" while the cloud runs, then "Worked for", like T3's turn fold. */}
                <p
                  className="mt-3 grid text-[14px] text-muted [&>*]:col-start-1 [&>*]:row-start-1"
                  style={a(enter(T.send + 300))}
                >
                  <span className={`inline-flex items-center gap-2 ${transient}`} style={a(leave(T.done, 160))}>
                    <span className="text-accent">
                      <Spinner />
                    </span>
                    Working
                  </span>
                  <span className="demo-fade inline-flex items-center gap-1.5" style={a(enter(T.done, "t-show", 220))}>
                    Worked for 1m 12s
                    <ChevronRight />
                  </span>
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
                  <ol className="mt-2 grid gap-0.5 rounded-lg bg-bubble px-3 py-2.5 font-mono text-[12px] text-muted">
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
                  <div className="mt-2 overflow-hidden rounded-lg border border-border font-mono text-[12px]" data-follow={T.edit + 200}>
                    <div className="flex items-center justify-between gap-3 border-b border-border bg-bubble px-3 py-1.5 text-muted">
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
                            line.kind === "add" ? "text-ink" : line.kind === "del" ? "text-muted" : "text-muted opacity-70"
                          }`}
                          style={a(enter(T.diffTimes[i], "t-show", 240))}
                        >
                          {line.kind !== "hunk" && line.kind !== "ctx" ? (
                            <span
                              aria-hidden
                              className={`absolute inset-0 ${line.kind === "add" ? "bg-success/10" : "bg-danger/10"}`}
                            />
                          ) : null}
                          <span
                            className={`relative mr-2 select-none ${
                              line.kind === "add" ? "text-success" : line.kind === "del" ? "text-danger" : ""
                            }`}
                          >
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
                      Ran <span className="font-mono text-[12px] text-ink">{TEST_COMMAND}</span>
                    </>
                  }
                  meta="6s"
                >
                  <p
                    className="mt-1 pl-6 font-mono text-[12px] text-success"
                    data-follow={T.ranDone}
                    style={a(enter(T.ranDone, "t-show", 200))}
                  >
                    ✓ {TEST_RESULT}
                  </p>
                </WorkRow>

                <p data-follow={T.answer} className="mt-2 text-[14px] leading-relaxed text-ink text-pretty">
                  {ANSWER_WORDS.map((w, i) => (
                    <span key={i} style={a(enter(WORD_TIMES[i], "t-show", 180))}>
                      {w}{" "}
                    </span>
                  ))}
                </p>

                <div data-follow={T.done} className="grid gap-3" style={a(enter(T.done, "t-in", 320))}>
                  <p className="text-[14px] text-link">Open in Codex Cloud ↗</p>
                  {/* T3's changed-files card at the end of a turn. */}
                  <div className="flex items-center gap-2.5 rounded-2xl bg-bubble py-2.5 pr-2.5 pl-3.5 text-muted">
                    <ChevronRight />
                    <span className="text-ink">2 changed files</span>
                    <span>
                      <span className="text-success">+30</span> <span className="text-danger">−3</span>
                    </span>
                    <span className="hidden sm:inline">Show files</span>
                    <span className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-ink">
                      <FileIcon />
                      Open diff
                    </span>
                  </div>
                </div>
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

/** The icon T3 shows for a megha provider: the cloud's own logo with the megha cloud at its corner. */
function CloudProviderIcon({ provider, className = "size-3.5" }: { provider: "codex" | "claude"; className?: string }) {
  return (
    <span className="relative inline-flex shrink-0">
      {provider === "codex" ? (
        <OpenAIIcon className={`${className} text-ink`} />
      ) : (
        <ClaudeIcon className={`${className} text-claude`} />
      )}
      <MeghaMark className="absolute -right-1.5 -bottom-1 size-2.5 rounded-full bg-surface text-accent" />
    </span>
  );
}

function ProjectBadge() {
  return (
    <span className="grid size-4 shrink-0 place-items-center rounded-[4px] bg-ink text-[10px] leading-none font-bold text-surface">
      {REPO[0].toUpperCase()}
    </span>
  );
}

function HeaderPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border px-2 text-muted">
      {children}
      <ChevronDown />
    </span>
  );
}

const THREADS = [
  { title: "Skip-intro button for episodes", branch: "codex/skip-intro", provider: "codex", status: "done" },
  { title: "Why is the poster grid janky?", branch: "main", provider: "claude", status: "2h" },
  { title: "Explain the HLS fallback", branch: "main", provider: "claude", status: "1d" },
] as const;

function Sidebar({ a, transient }: { a: Anim; transient: string }) {
  return (
    <div className="hidden w-64 shrink-0 flex-col border-r border-border bg-inset md:flex">
      <div className="t3-sky flex h-12 items-center gap-3 px-4 text-[14px] font-semibold text-ink">
        <PanelIcon />
        T3 Code
      </div>
      <div className="flex items-center gap-2.5 px-4 pt-3 pb-1.5 text-[14px] text-muted">
        <SearchIcon />
        Search
        <span className="ml-auto">
          <ComposeIcon />
        </span>
      </div>
      <div className="flex items-center gap-2.5 px-4 pt-1.5 pb-2.5 text-[14px] text-muted">
        <FolderIcon />
        All projects
        <span className="ml-auto">
          <ChevronDown />
        </span>
      </div>
      <ul className="grid gap-1 px-2">
        <ThreadCard
          active
          status={
            <span className="grid [&>*]:col-start-1 [&>*]:row-start-1">
              <span className={`text-accent ${transient}`} style={a(`${enter(T.send, "t-show", 200)}, ${leave(T.done)}`)}>
                <Spinner />
              </span>
              <span className="demo-fade" style={a(enter(T.done, "t-show", 200))}>
                now
              </span>
            </span>
          }
          title={
            <span className="grid [&>*]:col-start-1 [&>*]:row-start-1">
              <span className={`truncate text-muted ${transient}`} style={a(leave(T.title))}>
                New thread
              </span>
              <span className="demo-fade truncate" style={a(enter(T.title, "t-show", 260))}>
                {THREAD_TITLE}
              </span>
            </span>
          }
          branch="main"
          provider="codex"
        />
        {THREADS.map((t) => (
          <ThreadCard
            key={t.title}
            title={t.title}
            branch={t.branch}
            provider={t.provider}
            status={
              t.status === "done" ? (
                <span className="inline-flex items-center gap-1 text-success">
                  <CheckCircleIcon />
                  Done
                </span>
              ) : (
                t.status
              )
            }
          />
        ))}
      </ul>
      <div className="mt-auto flex items-center gap-2 px-4 py-3 text-[12px] text-muted">
        Settled (38)
        <span className="h-px flex-1 bg-border" />
        <ChevronDown />
      </div>
    </div>
  );
}

function ThreadCard({
  title,
  branch,
  provider,
  status,
  active = false,
}: {
  title: React.ReactNode;
  branch: string;
  provider: "codex" | "claude";
  status: React.ReactNode;
  active?: boolean;
}) {
  return (
    <li className={`min-w-0 rounded-xl px-3 py-2.5 ${active ? "bg-subtle" : ""}`}>
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <ProjectBadge />
        {REPO}
        <span className="ml-auto">{status}</span>
      </div>
      <div className={`mt-1 min-w-0 truncate text-[14px] ${active ? "font-medium text-ink" : "text-ink/80"}`}>{title}</div>
      <div className="mt-1 flex items-center gap-2 text-[12px] text-muted">
        <span className="min-w-0 truncate">{branch}</span>
        <span className="ml-auto">
          <CloudProviderIcon provider={provider} />
        </span>
      </div>
    </li>
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
          <span className="ml-auto shrink-0 text-[12px] tabular-nums" style={a(enter(doneAt, "t-show", 200))}>
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
    <div className="px-3 pb-3 sm:px-8 sm:pb-4">
      <div className="mx-auto max-w-[46rem]">
        <div className="relative z-10 rounded-3xl border border-ink/6 bg-composer px-4 pt-3.5 pb-2.5">
          {/* The draft, the placeholder before it, and the follow-up placeholder share one cell. */}
          <div className="grid min-h-[3rem] text-[14px] text-ink [&>*]:col-start-1 [&>*]:row-start-1">
            <span className={`text-muted ${transient}`} style={a(leave(CHAR_TIMES[0], 1))}>
              Ask anything, @tag files/folders, or use / to show available commands
            </span>
            <span className={transient} style={a(leave(T.send, 120))}>
              {PROMPT.split("").map((ch, i) => (
                <span key={i} style={a(`t-show 1ms linear ${CHAR_TIMES[i]}ms both`)}>
                  {ch}
                </span>
              ))}
            </span>
            <span className="demo-fade text-muted" style={a(enter(T.send + 200, "t-show", 200))}>
              Ask for changes, send follow-ups, or attach images
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3 text-muted">
            <span className="inline-flex items-center gap-2 text-[14px] text-ink/90">
              <CloudProviderIcon provider="codex" className="size-4" />
              GPT-5.6-Sol
              <ChevronDown />
            </span>
            <span className="hidden sm:inline">Code</span>
            <span className="tracking-widest">···</span>
            <span className="ml-auto">
              <ClipIcon />
            </span>
            <span className="grid [&>*]:col-start-1 [&>*]:row-start-1">
              {/* Send, then Stop while the cloud works, then Send again. */}
              <span
                className="grid size-8 place-items-center rounded-full bg-send text-link"
                style={a(`t-press 220ms ease-out ${T.send - 120}ms, t-hide 1ms linear ${T.send + 100}ms forwards, ${returns(T.done)}`)}
              >
                <ArrowUp />
              </span>
              <span
                className={`grid size-8 place-items-center rounded-full bg-ink ${transient}`}
                style={a(`${enter(T.send + 100, "t-show", 120)}, ${leave(T.done, 120)}`)}
              >
                <span className="size-2.5 rounded-[2px] bg-surface" />
              </span>
            </span>
          </div>
        </div>
        {/* The strip under the composer: where the thread runs, and its branch. */}
        <div className="mx-5 -mt-4 flex items-center gap-3 rounded-b-2xl border border-t-0 border-border px-3.5 pt-5 pb-1.5 text-[12px] text-muted">
          <span className="inline-flex items-center gap-1.5">
            <MeghaMark className="size-3.5 text-accent" />
            Codex Cloud
          </span>
          <span className="hidden sm:inline">Env: {REPO}</span>
          <span className="ml-auto inline-flex items-center gap-1.5">
            <BranchIcon />
            main
            <ChevronDown />
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

const icon16 = { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, "aria-hidden": true } as const;

function KindIcon({ kind }: { kind: "setup" | "read" | "edit" | "run" }) {
  if (kind === "read") return <FileIcon />;
  if (kind === "edit")
    return (
      <svg {...icon16} className="size-3.5">
        <path d="M10.5 2.5l3 3-7.5 7.5H3v-3z" strokeLinejoin="round" />
      </svg>
    );
  if (kind === "run")
    return (
      <svg {...icon16} className="size-3.5">
        <path d="M3 4l4 4-4 4M8.5 12h4.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  return (
    <svg {...icon16} className="size-3.5 text-success">
      <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg {...icon16} className="size-3.5">
      <path d="M4 1.8h5l3 3v9.4H4z M9 1.8v3h3" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg {...icon16} className="size-4">
      <path d="M1.8 4.2c0-.6.5-1 1-1h3.3l1.4 1.6h5.7c.5 0 1 .4 1 1v6.7c0 .5-.5 1-1 1H2.8c-.5 0-1-.5-1-1z" strokeLinejoin="round" />
    </svg>
  );
}

function PanelIcon() {
  return (
    <svg {...icon16} className="size-4">
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M6 2.5v11" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg {...icon16} className="size-4">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" strokeLinecap="round" />
    </svg>
  );
}

function ComposeIcon() {
  return (
    <svg {...icon16} className="size-4">
      <path d="M7.5 2.5H4A1.5 1.5 0 0 0 2.5 4v8A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5V8.5" strokeLinecap="round" />
      <path d="M12 2.2l1.8 1.8-5.6 5.6-2.3.5.5-2.3z" strokeLinejoin="round" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg {...icon16} className="size-3.5">
      <circle cx="8" cy="8" r="6" />
      <path d="M5.5 8.2l1.7 1.7 3.3-3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg {...icon16} className="size-3">
      <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg {...icon16} className="size-3.5">
      <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg {...icon16} className="size-3.5">
      <path d="M8 3v10M3 8h10" strokeLinecap="round" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden>
      <path d="M8 .2a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.3 1.9.9 2.4.7 0-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.6 7.6 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.7-3.6 3.9.3.3.5.8.5 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 8 .2z" />
    </svg>
  );
}

function ClipIcon() {
  return (
    <svg {...icon16} className="size-4">
      <path
        d="M13 7.5l-5.2 5.2a3.2 3.2 0 0 1-4.5-4.5L8.8 2.7a2.1 2.1 0 0 1 3 3L6.5 11a1 1 0 0 1-1.5-1.5L9.8 4.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg {...icon16} className="size-3.5">
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7c0 3-3 2.5-6.2 4.6" strokeLinecap="round" />
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
