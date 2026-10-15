// Per-provider starting values for new threads, from megha's command line (T3's commandArgs):
//   --default-mode <m>  --default-model <id>  --default-environment <id or name>  --default-apply on|off
// A default only picks the starting value of a thread's option; the user still changes it per thread.
// A value this account or backend doesn't have never fails a session: megha uses its usual default
// and logs one line to stderr (once per process, since T3 opens a session on every status probe).

import { log } from "./util.mjs";

export const DEFAULT_FLAGS = { "--default-mode": "mode", "--default-model": "model", "--default-environment": "environment", "--default-apply": "apply" };

// argv -> { mode?, model?, environment?, apply? }. Takes `--flag value` and `--flag=value`; a flag
// with no value is dropped with a log line. Other arguments are left alone.
export function parseDefaults(argv, warn = log) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const key = Object.hasOwn(DEFAULT_FLAGS, flag) ? DEFAULT_FLAGS[flag] : null;
    if (!key) continue;
    let value;
    if (eq > 0) value = arg.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) value = argv[++i];
    value = value?.trim();
    if (!value) { warn(`${flag} needs a value; ignoring it`); continue; }
    out[key] = value;
  }
  return out;
}

const warned = new Set();

// The configured default for `key`, as one of `choices` ({ value, names? }): the value itself, or a
// value or name matched without case ("bypasspermissions", "Opus 5.5", an environment's name).
// undefined when there is no default or it matches nothing; the miss is logged once.
export function defaultFor(defaults, key, choices, { backend, warn = log } = {}) {
  const want = defaults?.[key];
  if (!want) return undefined;
  const exact = choices.find((c) => c.value === want);
  if (exact) return exact.value;
  const lower = want.toLowerCase();
  const loose = choices.find((c) => [c.value, ...(c.names ?? [])].some((n) => typeof n === "string" && n.toLowerCase() === lower));
  if (loose) return loose.value;
  const line = `--default-${key} ${JSON.stringify(want.slice(0, 80))} isn't available${backend ? ` on ${backend}` : ""}${choices.length && choices.length <= 6 ? ` (one of: ${choices.map((c) => c.value).join(", ")})` : ""}; using megha's usual default`;
  if (!warned.has(line)) { warned.add(line); warn(line); }
  return undefined;
}

export const APPLY_CHOICES = [{ value: "off" }, { value: "on" }];

// For the startup log line.
export function describeDefaults(defaults) {
  const parts = Object.entries(defaults ?? {}).map(([k, v]) => `${k} ${v}`);
  return parts.length ? parts.join(", ") : "none";
}
