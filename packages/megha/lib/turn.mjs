// One prompt's lifecycle, from session/prompt until every piece of work it started has ended.
//
// T3 waits only 10 s for session/prompt to return after session/cancel, so the agent answers
// `cancelled` quickly. The cloud work the turn started can outlive that answer: the cloud cancel or
// interrupt request, the stream and poller winding down, permission prompts still open in T3, git
// subprocesses. All of it belongs to the Turn:
//   - `signal` aborts on Stop (or the backend's own deadline); pass it to every request and git call.
//   - `live` is false once the turn was stopped or its prompt has finished. Check it right before any
//     mutation a callback makes (a late permission answer must not reach the cloud).
//   - `ended` resolves when the turn stops or finishes, so a callback can stop waiting on the client.
//   - `track(promise)` registers work that may outlive the prompt's answer.
//   - `settled` resolves once the prompt's own run and all tracked work are done. The next prompt in
//     the session waits for it before it touches the session's cloud state.

import { Cancelled, log, describeError } from "./util.mjs";

export class Turn {
  #ac = new AbortController();
  #pending = new Set();
  #finished = false;
  #runDone = false;
  #onEnded;
  #onSettled;
  isSettled = false;
  muted = false; // T3 already has its answer: send it nothing more from this turn

  // signal: an outer signal that also stops the turn (tests driving a backend directly).
  constructor({ signal } = {}) {
    this.signal = signal ? AbortSignal.any([this.#ac.signal, signal]) : this.#ac.signal;
    this.ended = new Promise((resolve) => { this.#onEnded = resolve; });
    this.settled = new Promise((resolve) => { this.#onSettled = resolve; });
    if (this.signal.aborted) this.#onEnded();
    else this.signal.addEventListener("abort", () => this.#onEnded(), { once: true });
  }

  stop() { this.#ac.abort(); }
  get stopped() { return this.signal.aborted; }
  get finished() { return this.#finished; }
  get live() { return !this.signal.aborted && !this.#finished; }
  assertLive() { if (!this.live) throw new Cancelled(); }

  // The prompt's own work. When it ends the turn is finished: its callbacks may no longer act.
  run(fn) {
    const p = Promise.resolve().then(fn);
    p.then(() => {}, () => {}).then(() => {
      this.#finished = true;
      this.#onEnded();
      this.#runDone = true;
      this.#check();
    });
    return p;
  }

  // Work that may outlive the prompt's answer. Its failure is logged (through describeError, so no
  // server text), never thrown: the returned promise always resolves (to undefined on failure).
  track(work, label = "background work") {
    const p = Promise.resolve(work).then((v) => v, (e) => {
      if (!(e instanceof Cancelled)) log(`${label} failed: ${describeError(e)}`);
      return undefined;
    });
    this.#pending.add(p);
    p.then(() => { this.#pending.delete(p); this.#check(); });
    return p;
  }

  #check() {
    if (this.#runDone && !this.#pending.size && !this.isSettled) {
      this.isSettled = true;
      this.#onSettled();
    }
  }
}
