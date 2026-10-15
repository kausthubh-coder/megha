// Cloud diffs: summarize, render as an ACP `edit` tool call, and optionally apply to the local checkout.

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { DATA_DIR, git, log } from "./util.mjs";

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
export async function applyLocally({ cwd, diff, name, previousFile }) {
  let previous = null;
  try { if (previousFile) previous = readFileSync(previousFile, "utf8"); } catch {}
  const patchFile = savePatch(name, diff);
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { ok: false, message: `Not applied: ${cwd} is not a git repository. Patch saved to ${patchFile}.` };
  const root = top.stdout.trim();
  if (previous === diff) return { ok: true, patchFile, unchanged: true, message: "The cloud diff is unchanged since the last apply; nothing to do." };

  let reversedPrevious = false;
  if (previous) {
    const prevFile = savePatch(`${name}-previous`, previous);
    const rev = await git(root, ["apply", "-R", "--check", prevFile]);
    if (rev.code === 0) {
      await git(root, ["apply", "-R", prevFile]);
      reversedPrevious = true;
    } else {
      log("previous diff no longer reverses cleanly; applying the new diff on top");
    }
  }

  const files = diffFiles(diff).map((f) => f.path);
  const n = files.length;
  const swapped = reversedPrevious ? ", replacing the previously applied diff" : "";
  const check = await git(root, ["apply", "--check", patchFile]);
  if (check.code === 0) {
    // Applies cleanly: a plain apply touches only the working tree (no index changes).
    const res = await git(root, ["apply", patchFile]);
    if (res.code === 0) return { ok: true, patchFile, message: `Applied the cloud diff to your working tree (${n} file${n === 1 ? "" : "s"}${swapped}).` };
  }
  // Does not apply cleanly. Fall back to a 3-way merge, but only when the touched files have no local
  // edits (--3way works through the index and we must not clobber unstaged work).
  const failing = [...new Set([...check.stderr.matchAll(/error: (?:patch failed: )?([^:\n]+)/g)].map((m) => m[1].trim()))];
  const dirty = (await git(root, ["status", "--porcelain", "--", ...files])).stdout.trim();
  if (!dirty) {
    const res = await git(root, ["apply", "--3way", patchFile]);
    const conflicted = [...res.stderr.matchAll(/Applied patch to '([^']+)' with conflicts/g)].map((m) => m[1]);
    if (res.code === 0) return { ok: true, patchFile, message: `Applied the cloud diff with a 3-way merge (${n} file${n === 1 ? "" : "s"}${swapped}).` };
    if (conflicted.length) {
      return { ok: false, message: `Applied with conflicts in ${conflicted.join(", ")}: resolve the conflict markers there (the changes are staged by git apply --3way). Patch saved to ${patchFile}.` };
    }
  }
  if (reversedPrevious) await git(root, ["apply", savePatch(`${name}-previous`, previous)]);
  return {
    ok: false,
    message: `Not applied: the cloud diff does not apply cleanly${failing.length ? ` (${failing.slice(0, 8).join(", ")})` : ""}${dirty ? " and the touched files have local edits" : ""}. Nothing was changed. Patch saved to ${patchFile}.`,
  };
}
