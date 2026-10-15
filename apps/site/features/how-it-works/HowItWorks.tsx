import { MeghaMark } from "@/features/brand/MeghaMark";
import { ClaudeIcon, OpenAIIcon } from "@/features/brand/ProviderIcons";
import { InView } from "@/features/sky/InView";

// Your computer at the bottom, the clouds at the top, megha in between. A prompt rises to Codex Cloud
// and progress rains back down, then the same with Claude: one 12 s loop in globals.css, with the
// step list lighting up in time. Dots move with transform in container units (cqw/cqh), so they follow
// the lines at any size. Reduced motion: the diagram and steps stand still, nothing is lost.

const STEPS = [
  {
    title: "You send a prompt in a T3 thread",
    body: "T3 starts one megha process for the thread, on your computer, and talks to it over ACP.",
  },
  {
    title: "Megha starts a cloud task",
    body: "It uses the access token your codex or claude CLI already saved. The task starts from your branch on GitHub.",
  },
  {
    title: "The cloud does the work",
    body: "In its own container it clones the repo, runs your setup script, edits files and runs commands.",
  },
  {
    title: "Progress comes back to the thread",
    body: "Megha streams the setup log, each command, the diff and the answer as they happen. A follow-up continues the same task.",
  },
];

// Raindrops: three per cloud, each a 12 s loop delayed into its cloud's half.
const DROPS = [
  { x: "-22cqw", delay: "3.6s" },
  { x: "-22cqw", delay: "3.95s" },
  { x: "-22cqw", delay: "4.3s" },
  { x: "22cqw", delay: "9.6s" },
  { x: "22cqw", delay: "9.95s" },
  { x: "22cqw", delay: "10.3s" },
];

export function HowItWorks() {
  return (
    <InView className="grid items-center gap-12 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] md:gap-16">
      <Diagram />
      <ol className="grid gap-7">
        {STEPS.map((s, i) => (
          <li key={s.title} className="relative grid grid-cols-[2rem_1fr] gap-x-3" data-reveal style={{ "--i": i } as React.CSSProperties}>
            <span className="relative grid size-8 place-items-center rounded-full bg-subtle font-mono text-xs text-muted tabular-nums">
              {i + 1}
              {/* Lit while the diagram shows this step. */}
              <span
                aria-hidden
                className="flow-step absolute inset-0 grid place-items-center rounded-full bg-accent text-accent-fg opacity-0"
                style={{ "--step": `step-${i + 1}` } as React.CSSProperties}
              >
                {i + 1}
              </span>
            </span>
            <div>
              <h3 className="font-semibold">{s.title}</h3>
              <p className="mt-1 max-w-[46ch] text-muted">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </InView>
  );
}

function Diagram() {
  return (
    <figure
      aria-label="Diagram: T3 Code on your computer talks to megha over ACP. Megha, also on your computer, talks to Codex Cloud and Claude Code on the web over HTTPS with your saved login."
      role="img"
      className="relative mx-auto aspect-[5/6] w-full max-w-[30rem] [container-type:size]"
    >
      <div aria-hidden className="absolute inset-0">
        {/* Lines. The viewBox is stretched to the box, so the stroke keeps its width with non-scaling-stroke. */}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
          <g fill="none" stroke="var(--border)" strokeWidth="1.5" strokeDasharray="3 5">
            <path d="M50 86 V62" vectorEffect="non-scaling-stroke" />
            <path d="M50 62 L28 26" vectorEffect="non-scaling-stroke" />
            <path d="M50 62 L72 26" vectorEffect="non-scaling-stroke" />
          </g>
        </svg>

        {/* Line labels */}
        <span className="absolute top-[72%] left-[54%] font-mono text-xs text-muted">ACP over stdio</span>
        <span className="absolute top-[45%] left-1/2 -translate-x-1/2 rounded-full bg-bg px-2 font-mono text-xs whitespace-nowrap text-muted">
          HTTPS, your login
        </span>

        {/* A prompt going up, once to each cloud. They pass behind megha and sink into the cloud. */}
        <span className="flow-up-codex absolute top-[86%] left-1/2 -mt-1.5 -ml-1.5 size-3 rounded-full bg-accent opacity-0 shadow-[0_0_12px_var(--accent)]" />
        <span className="flow-up-claude absolute top-[86%] left-1/2 -mt-1.5 -ml-1.5 size-3 rounded-full bg-accent opacity-0 shadow-[0_0_12px_var(--accent)]" />
        {/* Progress coming back down as rain. */}
        {DROPS.map((d) => (
          <span
            key={d.delay}
            className="flow-drop absolute top-[86%] left-1/2 -mt-2.5 -ml-px h-5 w-0.5 rounded-full bg-ink opacity-0"
            style={{ "--x": d.x, "--delay": d.delay } as React.CSSProperties}
          />
        ))}

        <CloudNode left="28%" glow="flow-glow-codex" label="Codex Cloud" icon={<OpenAIIcon className="size-6 text-ink" />} />
        <CloudNode left="72%" glow="flow-glow-claude" label="Claude Code on the web" icon={<ClaudeIcon className="size-6" />} />

        {/* megha */}
        <div className="absolute top-[62%] left-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="flex items-center gap-2 rounded-full border border-border bg-surface py-2 pr-4 pl-3 shadow-[0_8px_24px_-12px_oklch(0_0_0/0.35)]">
            <MeghaMark className="size-6" tailClassName="text-accent" />
            <span className="font-semibold">megha</span>
          </div>
        </div>

        {/* T3 Code */}
        <div className="absolute top-[86%] left-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
          <div className="mx-auto flex h-11 w-32 flex-col justify-center gap-1 rounded-sm border border-border bg-surface px-2.5">
            <span className="h-1 w-3/5 rounded-full bg-border" />
            <span className="h-1 w-4/5 rounded-full bg-border" />
            <span className="h-1 w-2/5 rounded-full bg-accent" />
          </div>
          <span className="mt-1.5 block text-xs whitespace-nowrap text-muted">T3 Code, your computer</span>
        </div>
      </div>
    </figure>
  );
}

// A small cloud from the mark's circles, its label above it.
function CloudNode({ left, glow, label, icon }: { left: string; glow: string; label: string; icon: React.ReactNode }) {
  return (
    <div className="absolute top-[26%] w-[44%] -translate-x-1/2 -translate-y-[62%] text-center" style={{ left }}>
      <span className="mb-1.5 block text-xs leading-tight font-medium text-ink">{label}</span>
      <div className="relative mx-auto w-full max-w-44">
        <span
          aria-hidden
          className={`${glow} absolute -inset-6 rounded-full bg-[radial-gradient(closest-side,var(--accent-soft),transparent)] opacity-0`}
        />
        <svg viewBox="0 0 120 72" className="relative w-full overflow-visible" aria-hidden>
          <g fill="var(--bank-rim)" transform="translate(0 -2)">
            <CloudPuffs />
          </g>
          <g fill="var(--bank-low)">
            <CloudPuffs />
          </g>
        </svg>
        <span className="absolute inset-0 grid place-items-center pt-3">{icon}</span>
      </div>
    </div>
  );
}

function CloudPuffs() {
  return (
    <>
      <circle cx="34" cy="44" r="20" />
      <circle cx="60" cy="30" r="26" />
      <circle cx="88" cy="44" r="19" />
      <rect x="22" y="40" width="78" height="24" rx="12" />
    </>
  );
}
