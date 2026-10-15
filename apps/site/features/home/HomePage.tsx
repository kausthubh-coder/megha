import Link from "next/link";
import { MeghaMark } from "@/features/brand/MeghaMark";
import { CodeBlockPrompt } from "@/features/install/InstallPrompt";
import { CopyButton } from "@/features/install/CopyButton";
import { ManualSteps } from "@/features/install/ManualSteps";
import { NPM_URL, REPO_URL, buildInstallPrompt } from "@/features/install/install";
import { ThreadMock } from "@/features/thread-mock/ThreadMock";
import { SupportTable } from "./SupportTable";

const prompt = buildInstallPrompt();

const link = "underline decoration-border underline-offset-4 hover:decoration-current";

export function HomePage() {
  return (
    <>
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
        <Link href="/" className="-mx-2 inline-flex items-center gap-2 rounded-sm px-2 py-2 text-lg font-semibold tracking-tight">
          <MeghaMark className="size-7" />
          megha
        </Link>
        <nav aria-label="Main" className="flex items-center text-sm text-muted">
          <a href="#install" className="hidden h-11 items-center rounded-sm px-3 hover:text-ink sm:inline-flex">
            Install
          </a>
          <a href={REPO_URL} className="inline-flex h-11 items-center rounded-sm px-3 hover:text-ink">
            GitHub
          </a>
          <a href={NPM_URL} className="-mr-3 inline-flex h-11 items-center rounded-sm px-3 hover:text-ink">
            npm
          </a>
        </nav>
      </header>

      <main>
        <section aria-labelledby="hero-title" className="px-5 pt-10 sm:px-8 sm:pt-16">
          <div className="mx-auto max-w-3xl text-center">
            <h1 id="hero-title" className="mx-auto max-w-[18ch] text-h1 font-medium tracking-[-0.03em] text-balance">
              Run T3 Code threads on Codex Cloud and Claude Code on the web
            </h1>
            <p className="mx-auto mt-5 max-w-[50ch] text-muted text-pretty">
              Megha is an open-source ACP agent for T3 Code. Pick it as a provider, and your prompt starts a cloud task. The
              setup log, commands and answer stream back into the thread. It uses the codex and claude logins you already
              have.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-x-5 gap-y-3 sm:flex-row">
              <CopyButton text={prompt} label="Copy install prompt" fallbackTargetId="install-prompt" />
              <a href="#install" className={`inline-flex h-11 items-center text-sm text-muted hover:text-ink ${link}`}>
                Read the prompt first
              </a>
            </div>
          </div>
          <div className="mt-12 sm:mt-14">
            <ThreadMock />
          </div>
        </section>

        <section id="install" aria-labelledby="install-title" className="px-5 pt-24 sm:px-8 sm:pt-32">
          <div className="mx-auto max-w-3xl">
            <h2 id="install-title" className="text-h2 font-semibold tracking-[-0.02em] text-balance">
              Install with one prompt
            </h2>
            <p className="mt-4 max-w-[50ch] text-muted">
              Paste this into Claude Code, Codex or a T3 thread on your computer. The agent installs megha from npm, checks
              your logins, and adds two providers to T3 Code: Codex Cloud and Claude Code on the web.
            </p>
            <div className="mt-8">
              <CodeBlockPrompt id="install-prompt" prompt={prompt} />
            </div>

            <h3 className="mt-20 text-lg font-semibold tracking-[-0.01em]">Or set it up by hand</h3>
            <p className="mt-2 mb-6 text-muted">Pick your system to see its paths.</p>
            <ManualSteps />
          </div>
        </section>

        <section aria-labelledby="needs-title" className="px-5 pt-24 sm:px-8 sm:pt-32">
          <div className="mx-auto max-w-3xl">
            <h2 id="needs-title" className="text-h2 font-semibold tracking-[-0.02em]">
              What you need
            </h2>
            <ul className="mt-8 grid gap-6 sm:grid-cols-2">
              <Need title="Codex Cloud">
                A ChatGPT account with Codex, signed in on this computer with{" "}
                <code className="font-mono text-sm">codex login</code>.
              </Need>
              <Need title="Claude Code on the web">
                A Claude subscription, signed in by running <code className="font-mono text-sm">claude</code>, then{" "}
                <code className="font-mono text-sm">/login</code>.
              </Need>
              <Need title="A repo on GitHub">
                The cloud clones your repo from GitHub, not from your disk. Push your branch before you start a thread.
              </Need>
              <Need title="Node.js 22 or newer">
                T3 Code starts megha with node, once per thread. You only need the CLI for the cloud you use.
              </Need>
            </ul>
          </div>
        </section>

        <section aria-labelledby="support-title" className="px-5 pt-24 sm:px-8 sm:pt-32">
          <div className="mx-auto max-w-3xl">
            <h2 id="support-title" className="text-h2 font-semibold tracking-[-0.02em]">
              What works, and what doesn&apos;t
            </h2>
            <SupportTable />
          </div>
        </section>

        <section aria-labelledby="unofficial-title" className="px-5 pt-24 sm:px-8 sm:pt-32">
          <div className="mx-auto max-w-3xl rounded-md bg-subtle p-6 sm:p-8">
            <h2 id="unofficial-title" className="text-lg font-semibold">
              Unofficial, so read this first
            </h2>
            <div className="mt-3 grid max-w-[50ch] gap-3 text-muted">
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

        <section aria-labelledby="start-title" className="px-5 py-24 sm:px-8 sm:py-32">
          <div className="mx-auto flex max-w-3xl flex-col items-start gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 id="start-title" className="text-h2 font-semibold tracking-[-0.02em]">
                Start your first cloud thread
              </h2>
              <p className="mt-2 max-w-[44ch] text-muted">
                Paste the prompt into your coding agent, then pick Codex Cloud or Claude Code on the web in T3.
              </p>
            </div>
            <CopyButton text={prompt} label="Copy install prompt" fallbackTargetId="install-prompt" />
          </div>
        </section>
      </main>

      <footer className="border-t border-border px-5 py-10 sm:px-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-2">
            <MeghaMark className="size-5 text-ink" />
            <span>
              Megha (<span lang="sa">मेघ</span>) is Sanskrit for cloud. MIT license. No analytics, no cookies.
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
      </footer>
    </>
  );
}

function Need({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <li>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1.5 text-muted">{children}</p>
    </li>
  );
}
