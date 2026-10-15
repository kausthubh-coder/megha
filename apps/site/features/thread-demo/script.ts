// What the thread demo shows and when. The content follows what megha really streams into a T3 thread
// for a Codex Cloud task (packages/megha/lib/codex.mjs): a "Preparing the cloud environment" step with
// the container's setup log, then the cloud agent's reads, edits and commands, the answer, and an
// "Open in Codex Cloud" link. The repo is a made-up watch-party app.

export const REPO = "leela";
export const THREAD_TITLE = "Fix watch-party drift after seek";

export const PROMPT =
  "Guests drift out of sync after the host seeks. Snap them to the host's position when they're more than 2 seconds apart, and add a test.";

export const SETUP_LOG = [
  "Waiting for the cloud container (clone + setup script)...",
  "Cloning into '/workspace/leela'...",
  "+ npm ci",
  "added 412 packages, and audited 413 packages in 9s",
];

export type DiffLine = { kind: "hunk" | "del" | "add" | "ctx"; text: string };
export const DIFF_FILE = "src/party/sync.ts";
export const DIFF: DiffLine[] = [
  { kind: "hunk", text: "@@ -38,9 +38,12 @@ export function onHostState(state: HostState) {" },
  { kind: "del", text: '  if (state.event !== "play") return;' },
  { kind: "del", text: "  const drift = player.currentTime - state.position;" },
  { kind: "del", text: "  if (drift > 5) player.seek(state.position);" },
  { kind: "add", text: "  const target = expectedPosition(state);" },
  { kind: "add", text: "  const drift = Math.abs(player.currentTime - target);" },
  { kind: "add", text: "  if (drift > MAX_DRIFT_S) {" },
  { kind: "add", text: "    player.seek(target);" },
  { kind: "add", text: "  }" },
];

export const TEST_COMMAND = "npx vitest run src/party";
export const TEST_RESULT = "Test Files  2 passed · Tests  9 passed";

export const ANSWER =
  "Guests now snap to the host whenever they're more than 2 seconds apart. Before, the check only ran on play events and allowed 5 seconds, so a seek left guests behind until the next play. The new test seeks the host to 1:30 and checks the guest follows on the next sync tick.";

export const DESCRIPTION =
  `Illustration: a T3 Code thread running on Codex Cloud through megha, in a repo called ${REPO}. ` +
  `The prompt asks to fix watch-party guests drifting out of sync after the host seeks. ` +
  `The thread shows the cloud environment being prepared (clone, npm ci), the agent reading ${DIFF_FILE}, ` +
  `editing it and its test, running ${TEST_COMMAND} with 9 passing tests, then the answer and a link to the task on Codex Cloud.`;

// ---- Timeline, in ms from the start of a run ----

const TYPE_START = 500;
const CHAR_MS = 17;
// Typing pauses a little after punctuation, the way people type.
const PAUSE_AFTER: Record<string, number> = { ".": 220, ",": 140, "'": 0 };

/** When each prompt character appears in the composer. */
export const CHAR_TIMES: number[] = (() => {
  const times: number[] = [];
  let t = TYPE_START;
  for (const ch of PROMPT) {
    times.push(t);
    t += CHAR_MS + (PAUSE_AFTER[ch] ?? 0);
  }
  return times;
})();

const typed = CHAR_TIMES.at(-1)! + 60;
const send = typed + 380;
const setup = send + 900;
const logTimes = SETUP_LOG.map((_, i) => setup + 350 + i * 420);
const setupDone = logTimes.at(-1)! + 600;
const read = setupDone + 450;
const edit = read + 650;
const diffTimes = DIFF.map((_, i) => edit + 200 + i * 80);
const ran = diffTimes.at(-1)! + 700;
const ranDone = ran + 1400;
const answer = ranDone + 450;

export const ANSWER_WORDS = ANSWER.split(" ");
const WORD_MS = 42;
export const WORD_TIMES = ANSWER_WORDS.map((_, i) => answer + i * WORD_MS);
const done = WORD_TIMES.at(-1)! + 350;

export const T = {
  typed,
  send,
  bubble: send + 60,
  title: send + 650,
  setup,
  logTimes,
  setupDone,
  read,
  edit,
  diffTimes,
  ran,
  ranDone,
  answer,
  done,
  /** The run ends here: the finished thread holds for a few seconds before the next one. */
  end: done + 5200,
} as const;
