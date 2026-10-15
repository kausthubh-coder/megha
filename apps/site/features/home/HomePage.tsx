import Link from "next/link";
import { MeghaMark } from "@/features/brand/MeghaMark";
import { ClaudeIcon, OpenAIIcon } from "@/features/brand/ProviderIcons";
import { HowItWorks } from "@/features/how-it-works/HowItWorks";
import { CodeBlockPrompt } from "@/features/install/InstallPrompt";
import { CopyButton } from "@/features/install/CopyButton";
import { ManualSteps } from "@/features/install/ManualSteps";
import {
  CLAUDE_CODE_URL,
  CLAUDE_GITHUB_APP_URL,
  CODEX_CONNECT_URL,
  NPM_URL,
  REPO_URL,
  SETUP_PATH,
  buildInstallPrompt,
} from "@/features/install/install";
import { CloudBank } from "@/features/sky/CloudBank";
import { CloudBreak } from "@/features/sky/CloudBreak";
import { StormSky } from "@/features/sky/StormSky";
import { ThreadDemo } from "@/features/thread-demo/ThreadDemo";
import { Reveal } from "./Reveal";
import { SupportTable } from "./SupportTable";

const prompt = buildInstallPrompt();

const link = "underline decoration-border underline-offset-4 hover:decoration-current";
const h2 = "font-display text-h2 font-semibold text-balance";
const section = "px-5 pt-28 sm:px-8 sm:pt-40";

export function HomePage() {
  return (
    <>
      <Reveal />
      <main>
        <section aria-labelledby="hero-title" className="relative isolate pb-8">
          <StormSky />

          <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-5 py-3 sm:px-8">
            <Link href="/" className="-mx-2 inline-flex items-center gap-2 rounded-full px-2 py-2 text-lg font-semibold tracking-tight">
              <MeghaMark form className="size-8" tailClassName="text-accent" />
              megha
              <span lang="sa" className="font-deva text-sm font-normal text-muted">
                मेघ
              </span>
            </Link>
            <nav aria-label="Main" className="flex items-center text-sm text-muted">
              <a href="#install" className="hidden h-11 items-center rounded-full px-3 hover:text-ink sm:inline-flex">
                Install
              </a>
              <a href={REPO_URL} className="inline-flex h-11 items-center rounded-full px-3 hover:text-ink">
                GitHub
              </a>
              <a href={NPM_URL} className="-mr-3 inline-flex h-11 items-center rounded-full px-3 hover:text-ink">
                npm
              </a>
            </nav>
          </header>

          <CloudBank
            id="hero"
            animateIn
            className="mx-auto mt-16 max-w-[64rem] px-6 pt-2 pb-9 sm:mx-12 sm:mt-24 sm:px-14 sm:pb-11 lg:mx-auto"
            tailClassName="left-[22%] w-20 sm:left-[30%] sm:w-28"
          >
            <div className="text-center">
              <h1 id="hero-title" className="mx-auto max-w-[17ch] font-display text-h1 font-semibold text-balance sm:max-w-[21ch]">
                Run T3 Code threads on Codex Cloud and Claude Code on the web
              </h1>
              <p className="mx-auto mt-5 max-w-[50ch] text-muted text-pretty">
                An open-source ACP agent for T3 Code. Your prompt starts a cloud task, and its setup log, commands, diff
                and answer stream back into the thread. It uses the codex and claude logins you already have.
              </p>
              <div className="mt-7 flex flex-col items-center justify-center gap-x-6 gap-y-2 sm:flex-row">
                <CopyButton text={prompt} label="Copy install prompt" fallbackTargetId="install-prompt" />
                <a href={SETUP_PATH} className={`inline-flex h-11 items-center text-sm text-ink ${link}`}>
                  Read the full setup
                </a>
              </div>
              <p className="mx-auto mt-4 hidden text-xs text-muted sm:block">
                Copies one line: <code className="font-mono text-ink">{prompt}</code>
              </p>
            </div>
          </CloudBank>

          <div className="mt-20 px-3 sm:mt-24 sm:px-8">
            <ThreadDemo />
          </div>
        </section>

        <CloudBreak className="mt-16 sm:mt-24" />

        <section id="how" aria-labelledby="how-title" className="px-5 pt-8 sm:px-8 sm:pt-12">
          <div className="mx-auto max-w-6xl">
            <div data-reveal className="max-w-2xl">
              <h2 id="how-title" className={h2}>
                How a cloud thread runs
              </h2>
              <p className="mt-4 max-w-[52ch] text-muted">
                T3 Code and megha run on your computer. The work runs in Codex Cloud or Claude Code on the web, on the
                plan you already pay for.
              </p>
            </div>
            <div className="mt-14">
              <HowItWorks />
            </div>
          </div>
        </section>

        <section id="install" aria-labelledby="install-title" className={section}>
          <div className="mx-auto max-w-3xl">
            <div data-reveal>
              <h2 id="install-title" className={h2}>
                Set it up with one prompt
              </h2>
              <p className="mt-4 max-w-[54ch] text-muted">
                Paste it into Claude Code, Codex or a T3 thread on your computer. The agent reads the setup file, installs
                megha from npm, checks that it runs, and adds two providers to T3 Code: Codex Cloud and Claude Code on the
                web. It backs up T3&apos;s settings first, and it never runs your logins or opens your credential files.
              </p>
            </div>
            <div className="mt-8" data-reveal>
              <CodeBlockPrompt id="install-prompt" prompt={prompt} />
            </div>

            <h3 className="mt-24 text-lg font-semibold" data-reveal>
              Or set it up by hand
            </h3>
            <p className="mt-2 mb-6 text-muted">Pick your system to see its paths.</p>
            <ManualSteps />
          </div>
        </section>

        <section aria-labelledby="needs-title" className={section}>
          <div className="mx-auto max-w-3xl">
            <h2 id="needs-title" className={h2} data-reveal>
              What you need
            </h2>
            <ul className="mt-10 grid gap-x-10 gap-y-9 sm:grid-cols-2">
              <Need i={0} icon={<OpenAIIcon className="size-5" />} title="Codex Cloud">
                A ChatGPT plan with Codex, signed in on this computer with{" "}
                <code className="font-mono text-sm">codex login</code>. Then{" "}
                <a href={CODEX_CONNECT_URL} className={link}>
                  connect GitHub to Codex
                </a>{" "}
                and give it your repo. Megha creates the repo&apos;s environment on your first prompt if it has none.
              </Need>
              <Need i={1} icon={<ClaudeIcon className="size-5" />} title="Claude Code on the web">
                A Claude subscription, signed in by running <code className="font-mono text-sm">claude</code>, then{" "}
                <code className="font-mono text-sm">/login</code>. Open{" "}
                <a href={CLAUDE_CODE_URL} className={link}>
                  claude.ai/code
                </a>{" "}
                once to create your cloud environment. To get Claude&apos;s changes back here, install the{" "}
                <a href={CLAUDE_GITHUB_APP_URL} className={link}>
                  Claude GitHub App
                </a>{" "}
                on the repo.
              </Need>
              <Need i={2} icon={<BranchIcon />} title="Your branch on GitHub">
                Both clouds start from what&apos;s pushed. With &quot;Send local changes&quot; on, megha sends unpushed
                work instead: a patch for Codex, a git bundle for Claude. A Claude session started from a bundle
                can&apos;t push back, so its changes stay on claude.ai.
              </Need>
              <Need i={3} icon={<NodeIcon />} title="Node.js 22 or newer">
                T3 Code starts megha with node, once per thread. <code className="font-mono text-sm">megha doctor</code>{" "}
                checks Node, git and both logins on this computer, not the cloud setup. You only need the login for the
                cloud you use.
              </Need>
            </ul>
          </div>
        </section>

        <section aria-labelledby="support-title" className={section}>
          <div className="mx-auto max-w-3xl">
            <h2 id="support-title" className={h2} data-reveal>
              What works, and what doesn&apos;t
            </h2>
            <SupportTable />
          </div>
        </section>

        <section aria-labelledby="unofficial-title" className={section}>
          <div className="mx-auto max-w-3xl rounded-md bg-subtle p-6 sm:p-8" data-reveal>
            <h2 id="unofficial-title" className="text-lg font-semibold">
              Unofficial, so read this first
            </h2>
            <div className="mt-3 grid max-w-[54ch] gap-3 text-muted">
              <p>
                Megha calls the same endpoints the Codex and Claude web apps use. OpenAI and Anthropic don&apos;t document
                them, so they can change or stop working without notice.
              </p>
              <p>
                It reads the access token your codex and claude CLIs already saved. It sends it only to the cloud it belongs
                to, never refreshes it, and never writes it anywhere. Use it with your own account only.
              </p>
              <p>Megha is not affiliated with or endorsed by OpenAI or Anthropic.</p>
            </div>
          </div>
        </section>

        <CloudBreak className="mt-20 sm:mt-28" />

        <section aria-labelledby="start-title" className="px-5 pt-36 pb-32 sm:px-8 sm:pt-44 sm:pb-40">
          <CloudBank
            id="end"
            className="mx-auto max-w-3xl px-6 pt-2 pb-12 sm:px-14"
            tailClassName="left-[26%] w-16 sm:w-24"
          >
            <div className="text-center" data-reveal>
              <h2 id="start-title" className={h2}>
                Start your first cloud thread
              </h2>
              <p className="mx-auto mt-4 max-w-[44ch] text-muted">
                Paste the prompt into your coding agent, then pick Codex Cloud or Claude Code on the web in T3.
              </p>
              <div className="mt-8">
                <CopyButton text={prompt} label="Copy install prompt" fallbackTargetId="install-prompt" />
              </div>
            </div>
          </CloudBank>
        </section>
      </main>

      <footer className="border-t border-border px-5 pt-12 pb-10 sm:px-8">
        <div className="mx-auto grid max-w-6xl gap-8 sm:grid-cols-[auto_1fr] sm:items-end sm:gap-12">
          <p
            lang="sa"
            aria-hidden
            className="bg-[linear-gradient(var(--bank-top),var(--bank-low))] bg-clip-text font-deva text-[clamp(4.5rem,3rem+8vw,8rem)] leading-[1.15] text-[transparent] select-none"
          >
            मेघ
          </p>
          <div className="flex flex-col gap-4 text-sm text-muted sm:flex-row sm:items-end sm:justify-between">
            <p className="flex max-w-[48ch] items-start gap-2">
              <MeghaMark className="mt-0.5 size-5 shrink-0 text-ink" />
              <span>
                Megha (<span lang="sa">मेघ</span>) is Sanskrit for cloud, the monsoon kind that brings the rain. MIT
                license. No analytics, no cookies.
              </span>
            </p>
            <p className="flex gap-5">
              <a href={REPO_URL} className={`inline-flex h-11 min-w-11 items-center justify-center hover:text-ink ${link}`}>
                GitHub
              </a>
              <a href={NPM_URL} className={`inline-flex h-11 min-w-11 items-center justify-center hover:text-ink ${link}`}>
                npm
              </a>
            </p>
          </div>
        </div>
      </footer>
    </>
  );
}

function Need({ i, icon, title, children }: { i: number; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <li data-reveal style={{ "--i": i % 2 } as React.CSSProperties}>
      <h3 className="flex items-center gap-2.5 font-semibold">
        <span className="grid size-8 place-items-center rounded-full bg-subtle text-ink">{icon}</span>
        {title}
      </h3>
      <p className="mt-2 text-muted">{children}</p>
    </li>
  );
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7c0 3-3 2.5-6.2 4.6" strokeLinecap="round" />
    </svg>
  );
}

function NodeIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M8 1.5l5.6 3.25v6.5L8 14.5l-5.6-3.25v-6.5z" strokeLinejoin="round" />
    </svg>
  );
}
