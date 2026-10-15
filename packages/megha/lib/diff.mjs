// Cloud diffs: summarize, render as an ACP `edit` tool call, and optionally apply to the local checkout.

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { DATA_DIR, git, log, Cancelled, RecoveryNeeded, throwIfCancelled } from "./util.mjs";

const MAX_DIFF_CHARS = 400_000;

// Files touched by a unified (git-style) diff, with line counts.
export function diffFiles(diff) {
  const files = [];
  let cur = null;
  for (const line of diff.split("\n")) {
    const g = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (g) { cur = { path: g[2], added: 0, removed: 0 }; files.push(cur); continue; }
    const plus = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (plus) {
      const p = plus[1].trim();
      if (!cur) { cur = { path: p, added: 0, removed: 0 }; files.push(cur); }
      else if (p !== "/dev/null") cur.path = p;
      continue;
    }
    if (line.startsWith("--- ")) {
      if (!cur) { cur = { path: line.slice(4).replace(/^a\//, "").trim(), added: 0, removed: 0 }; files.push(cur); }
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("+")) cur.added++;
    else if (line.startsWith("-")) cur.removed++;
  }
  return files;
}

// Codex fileChange item -> one unified diff. `update` changes carry a unified diff (sometimes without
// file headers); `add`/`delete` carry the file content.
export function codexChangesToPatch(changes) {
  const parts = [];
  for (const ch of changes ?? []) {
    const path = ch.path;
    const type = ch.kind?.type ?? ch.kind;
    const body = String(ch.diff ?? "");
    if (type === "add" || type === "delete") {
      if (body.startsWith("--- ") || body.startsWith("diff --git") || body.startsWith("@@")) {
        parts.push(withHeaders(path, body, type)); continue;
      }
      const lines = body.endsWith("\n") ? body.slice(0, -1).split("\n") : body.split("\n");
      const sign = type === "add" ? "+" : "-";
      const header = type === "add"
        ? `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n`
        : `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n`;
      parts.push(header + lines.map((l) => sign + l).join("\n") + "\n");
    } else {
      const target = ch.kind?.move_path ?? ch.kind?.movePath ?? path;
      parts.push(withHeaders(path, body, "update", target));
    }
  }
  return parts.join("");
}
function withHeaders(path, body, type, target = path) {
  const text = body.endsWith("\n") ? body : body + "\n";
  if (text.startsWith("diff --git")) return text;
  if (text.startsWith("--- ")) return `diff --git a/${path} b/${target}\n${text}`;
  const from = type === "add" ? "/dev/null" : `a/${path}`;
  const to = type === "delete" ? "/dev/null" : `b/${target}`;
  return `diff --git a/${path} b/${target}\n--- ${from}\n+++ ${to}\n${text}`;
}

const toLocal = (cwd, p) => (isAbsolute(p) ? p : join(cwd, p));

// ACP tool_call for a whole-turn diff. T3 renders kind:"edit" as a file_change whose diffStr is the
// raw patch text (rawOutput), so the multi-file git patch shows as-is.
export function diffToolCall({ toolCallId, diff, cwd, title }) {
  const files = diffFiles(diff);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const text = diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + "\n[diff truncated]\n" : diff;
  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title: title ?? `Cloud diff: ${files.length} file${files.length === 1 ? "" : "s"} (+${added} -${removed})`,
    kind: "edit",
    status: "completed",
    locations: files.slice(0, 50).map((f) => ({ path: toLocal(cwd, f.path) })),
    rawInput: { files: files.map((f) => f.path) },
    rawOutput: text,
  };
}

function savePatch(name, diff) {
  const dir = join(DATA_DIR, "patches");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name.replace(/[^A-Za-z0-9_.-]+/g, "_")}.patch`);
  writeFileSync(file, diff);
  return file;
}

// Apply a cloud diff to cwd. Preflight with `git apply --check`; never force. If an earlier diff of this
// session was applied and the cloud now reports a newer cumulative diff, swap it (reverse the old one,
// apply the new one) and restore the old one if the new one does not apply.
//
// signal: the turn's Stop. The read-only git steps (rev-parse, the --check preflights, status) are
// killed by it; each step that changes the working tree checks it right before it starts and is never
// killed by Stop once running. A Stop after the previous diff was reversed puts it back, then throws
// Cancelled, so a stopped turn leaves the checkout as it found it.
//
// Nothing here is assumed. The shared git timeout can still kill a step that changes the tree
// (git() answers { timedOut: true } once the process is gone), so such a step is followed by --check
// probes that tell whether its patch is now fully in, not in at all, or partly in. Putting the
// previous diff back is checked the same way. When the checkout is not as megha meant to leave it,
// the result says so, with the saved patch files and the exact commands to recover; a Stop that hits
// such a failure throws RecoveryNeeded (shown to the user) instead of Cancelled. `run` replaces git
// in tests.
export async function applyLocally({ cwd, diff, name, previousFile, signal, run = git }) {
  const read = (dir, args) => { throwIfCancelled(signal); return run(dir, args, { signal }); };
  const change = (dir, args) => { throwIfCancelled(signal); return run(dir, args); };
  let previous = null;
  try { if (previousFile) previous = readFileSync(previousFile, "utf8"); } catch {}
  const patchFile = savePatch(name, diff);
  const top = await read(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { ok: false, message: `Not applied: ${cwd} is not a git repository. Patch saved to ${patchFile}.` };
  const root = top.stdout.trim();
  if (previous === diff) return { ok: true, patchFile, unchanged: true, message: "The cloud diff is unchanged since the last apply; nothing to do." };
  const cmd = (args) => `\`git -C "${root}" ${args}\``;
  const files = diffFiles(diff).map((f) => f.path);
  const n = files.length;

  // Where a `git apply [-R] <file>` that the timeout killed left the tree, from its own --check
  // probes (no signal: megha must know, even after Stop): "done" (fully applied, or fully reversed
  // with -R), "none" (untouched) or "partial" (neither; partly written, or the probes can't tell).
  const killedOutcome = async (file, reverse) => {
    if ((await run(root, ["apply", ...(reverse ? [] : ["-R"]), "--check", file])).code === 0) return "done";
    if ((await run(root, ["apply", ...(reverse ? ["-R"] : []), "--check", file])).code === 0) return "none";
    return "partial";
  };
  // One tree-changing `git apply`. git apply is all or nothing when it runs to its end, so a non-zero
  // exit changed nothing; only a kill by the timeout needs the probes.
  const step = async (args, file) => {
    const res = await change(root, args);
    const outcome = res.timedOut ? await killedOutcome(file, args.includes("-R")) : res.code === 0 ? "done" : "none";
    return { res, outcome };
  };

  let prevFile = null;
  if (previous) {
    const file = savePatch(`${name}-previous`, previous);
    const rev = await read(root, ["apply", "-R", "--check", file]);
    if (rev.code === 0) {
      const { outcome } = await step(["apply", "-R", file], file);
      if (outcome === "done") prevFile = file;
      else if (outcome === "partial") {
        return { ok: false, message: `Not applied: undoing the cloud diff applied before was stopped by its time limit partway through, so the files it touches (${diffFiles(previous).map((f) => f.path).slice(0, 8).join(", ")}) are partly changed. Saved patches: the earlier diff is ${file}, the new one ${patchFile}. See what changed with ${cmd("diff")}. Once those files are as you want them, ${cmd(`apply --check "${patchFile}"`)} shows whether the new diff applies.` };
      }
    } else {
      log("previous diff no longer reverses cleanly; applying the new diff on top");
    }
  }
  // Put the reversed previous diff back (no signal: this undo must run to the end) and check that it
  // is back. null when it is (or nothing was reversed); otherwise the failure, with recovery steps.
  const restore = async () => {
    if (!prevFile) return null;
    const res = await run(root, ["apply", prevFile]);
    const back = await run(root, ["apply", "-R", "--check", prevFile]);
    if ((res.code === 0 || res.timedOut) && back.code === 0) return null;
    return `megha could not put back the cloud diff it had applied before: it reversed that diff to make room for the new one, and \`git apply\` of it then ${res.timedOut ? "was stopped by its time limit" : "failed"} (the files may have changed meanwhile). Your checkout may have neither diff. Saved patches: the earlier diff is ${prevFile}, the new one ${patchFile}. See what changed with ${cmd("diff")}. To put the earlier diff back once the files allow it: ${cmd(`apply "${prevFile}"`)} (${cmd(`apply --check "${prevFile}"`)} tells you if it will). To apply the new one instead: ${cmd(`apply "${patchFile}"`)}.`;
  };
  const partlyApplied = (what) => {
    const prevNote = prevFile ? ` The cloud diff applied before was reversed first; it is saved at ${prevFile}.` : "";
    return `Not applied: ${what} was stopped by its time limit partway through, so the checkout is partly changed (${files.slice(0, 8).join(", ")}). The new diff is saved at ${patchFile}.${prevNote} See what changed with ${cmd(`diff -- ${files.slice(0, 8).map((f) => `"${f}"`).join(" ")}`)}. ${cmd(`apply -R --check "${patchFile}"`)} succeeds once the diff is fully in; ${cmd(`apply --check "${patchFile}"`)} once none of it is.`;
  };

  try {
    const swapped = prevFile ? ", replacing the previously applied diff" : "";
    const applied = (how) => ({ ok: true, patchFile, message: `Applied the cloud diff ${how} (${n} file${n === 1 ? "" : "s"}${swapped}).` });
    const check = await read(root, ["apply", "--check", patchFile]);
    if (check.code === 0) {
      // Applies cleanly: a plain apply touches only the working tree (no index changes).
      const { res, outcome } = await step(["apply", patchFile], patchFile);
      if (outcome === "done") return applied("to your working tree");
      if (outcome === "partial") return { ok: false, message: partlyApplied("`git apply` of the cloud diff") };
      if (res.timedOut) {
        const failed = await restore();
        if (failed) return { ok: false, message: `Not applied: \`git apply\` was stopped by its time limit before it changed anything, and ${failed}` };
        return { ok: false, message: `Not applied: \`git apply\` did not finish within its time limit and was stopped before it changed anything. Nothing was changed. Patch saved to ${patchFile}.` };
      }
    }
    // Does not apply cleanly. Fall back to a 3-way merge, but only when the touched files have no local
    // edits (--3way works through the index and we must not clobber unstaged work).
    const failing = [...new Set([...check.stderr.matchAll(/error: (?:patch failed: )?([^:\n]+)/g)].map((m) => m[1].trim()))];
    const dirty = (await read(root, ["status", "--porcelain", "--", ...files])).stdout.trim();
    if (!dirty) {
      const res = await change(root, ["apply", "--3way", patchFile]);
      // A 3-way apply works file by file through the index; one the timeout killed can't be probed.
      if (res.timedOut) return { ok: false, message: partlyApplied("`git apply --3way` of the cloud diff") };
      const conflicted = [...res.stderr.matchAll(/Applied patch to '([^']+)' with conflicts/g)].map((m) => m[1]);
      if (res.code === 0) return applied("with a 3-way merge");
      if (conflicted.length) {
        return { ok: false, message: `Applied with conflicts in ${conflicted.join(", ")}: resolve the conflict markers there (the changes are staged by git apply --3way). Patch saved to ${patchFile}.` };
      }
    }
    const why = `the cloud diff does not apply cleanly${failing.length ? ` (${failing.slice(0, 8).join(", ")})` : ""}${dirty ? " and the touched files have local edits" : ""}`;
    const failed = await restore();
    if (failed) return { ok: false, message: `Not applied: ${why}, and ${failed}` };
    return { ok: false, message: `Not applied: ${why}. Nothing was changed. Patch saved to ${patchFile}.` };
  } catch (e) {
    // Only reads and the checks before a change throw here, so the new diff was not applied: undo the
    // reversal of the previous one, and say what really happened.
    const failed = await restore();
    if (failed) {
      log("apply stopped, and putting the previous diff back failed");
      throw new RecoveryNeeded(`${e instanceof Cancelled ? "Stopped while applying the cloud diff" : "Applying the cloud diff failed"}, and ${failed}`);
    }
    if (e instanceof Cancelled) log(prevFile ? "apply stopped; the previous diff is back and checked" : "apply stopped before changing anything");
    throw e;
  }
}
