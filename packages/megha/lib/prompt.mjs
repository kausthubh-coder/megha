// Turn the ACP prompt T3 Code sends into what the cloud should actually see.
//
// T3 has no system-prompt channel for ACP agents, so it puts its own context into the user prompt
// (t3/upstream, provider-acp/src/server/adapter.ts resolvePromptParts):
//   1. the first turn, and every interaction-mode change, is wrapped as
//      <t3_code_instructions>...</t3_code_instructions>\n\n<user_request>\n<text>\n</user_request>
//      (provider-core/src/server/orchestrationInstructions.ts t3AcpPromptWithInstructions)
//   2. every turn ends with a separate text block: <runtime_info>...</runtime_info>\n\n<pull_request_linking>...
//      (provider-core/src/server/runtimeInstructions.ts buildRuntimeInstructions)
//   3. attachments become lines `[Attached file "a.txt" is saved at: C:\...]`
//      (provider-core/src/server/attachmentPrompt.ts providerMessageTextWithAttachmentPaths)
//   4. a provider switch, rollback or restart prepends a context handoff:
//      `Context handoff (<strategy>):\n<coverage + history>\n\nUser message:\n<text>`
//      (apps/server/src/orchestration-v2/ProviderTurnStartService.ts, ContextHandoffDelivery.ts, handoffBudget.ts)
// None of that is useful in the cloud: it describes T3's local browser and MCP tools, which the cloud
// container can't reach, and some of it tells the agent to call t3_thread_read. Only the user's request
// (plus history as plain context, and attachment contents) goes through.

import { readFileSync, statSync } from "node:fs";

export const CONTINUE_PROMPT = "Continue where you left off."; // apps/server/src/orchestration-v2/RestartContinuation.ts
const MAX_INLINE_FILE_BYTES = 64 * 1024;
const OUR_COMMANDS = new Set(["pr", "open", "apply", "status"]);

// Remove <tag>...</tag> blocks (T3 never nests them).
function dropBlock(text, tag) {
  return text.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), "");
}

// <t3_code_instructions>…</t3_code_instructions><user_request>\n X \n</user_request> -> X.
// The request may itself contain the closing tag, so take the last one.
function unwrapUserRequest(text) {
  const hasWrapper = /<t3_code_(?:orchestration_)?instructions>/.test(text);
  const open = text.indexOf("<user_request>");
  const close = text.lastIndexOf("</user_request>");
  if (!hasWrapper || open < 0 || close < open) return { text, planMode: null };
  const planMode = /## T3 Code interaction mode: Plan/.test(text.slice(0, open)) ? true
    : /## T3 Code interaction mode: Default/.test(text.slice(0, open)) ? false : null;
  let inner = text.slice(open + "<user_request>".length, close);
  if (inner.startsWith("\n")) inner = inner.slice(1);
  if (inner.endsWith("\n")) inner = inner.slice(0, -1);
  return { text: inner, planMode };
}

// Drop T3 tool instructions from handoff coverage lines, and shorten the T3-internal headers of
// historical messages. Everything else in the history stays.
export function rewriteHandoffContext(context) {
  const lines = [];
  for (let line of context.split("\n")) {
    if (/t3_thread_read/.test(line)) {
      line = line.replace(/\s*Recover (?:omitted )?history (?:with|using) t3_thread_read[\s\S]*$/, "");
      if (/t3_thread_read/.test(line)) continue; // some other phrasing: drop the whole line
      if (!line.trim()) continue;
    }
    if (/^Source item range: /.test(line)) continue;
    line = line.replace(/^\[Historical (user|assistant); ([a-z_]+);[^\]\n]*\]$/, (_m, role, kind) =>
      `[Earlier ${role}${kind === "user_message" || kind === "assistant_message" ? "" : ` (${kind.replace(/_/g, " ")})`}]`);
    lines.push(line);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function splitHandoff(text) {
  if (!text.startsWith("Context handoff (") && !text.startsWith("Provider context handoff.")) return null;
  const marker = "\n\nUser message:\n";
  const i = text.lastIndexOf(marker);
  if (i < 0) return null;
  return { context: text.slice(0, i), user: text.slice(i + marker.length) };
}

function looksLikeText(buf) {
  if (buf.includes(0)) return false;
  const s = buf.toString("utf8");
  return !s.includes("\uFFFD");
}

// `[Attached image "x.png" is saved at: C:\...]` lines. Images travel as image blocks, so their line is
// dropped; small text files are inlined; anything else is named so the cloud knows it is missing.
function resolveAttachments(text, { hasImages, readFile }) {
  const notes = [];
  const out = text.replace(/^\[Attached (image|file) "([^"\n]*)" is saved at: ([^\n]+)\]$/gm, (_m, type, name, path) => {
    if (type === "image") {
      if (hasImages) return "";
      notes.push(name);
      return `[An image "${name}" was attached in T3 Code but could not be sent to the cloud.]`;
    }
    const file = readFile(path);
    if (file === null) return `[A file "${name}" was attached in T3 Code but could not be read.]`;
    if (file.length > MAX_INLINE_FILE_BYTES || !looksLikeText(file)) {
      return `[A file "${name}" was attached in T3 Code but not sent: it is binary or over ${MAX_INLINE_FILE_BYTES / 1024} KB.]`;
    }
    return `<attached_file name="${name}">\n${file.toString("utf8").replace(/\s+$/, "")}\n</attached_file>`;
  });
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), unsentImages: notes };
}

function defaultReadFile(path) {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    if (st.size > MAX_INLINE_FILE_BYTES) return Buffer.alloc(MAX_INLINE_FILE_BYTES + 1);
    return readFileSync(path);
  } catch { return null; }
}

/**
 * ACP prompt blocks -> {
 *   text: what to send to the cloud, images: [{data (base64), mimeType}],
 *   userText: the request alone (no history), handoff: cleaned history or null,
 *   isContinue, command: {name, args} for megha's own slash commands, planMode: true|false|null }
 */
export function cleanPrompt(blocks, { readFile = defaultReadFile } = {}) {
  const texts = [];
  const images = [];
  for (const b of blocks ?? []) {
    if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
    else if (b.type === "image" && b.data) images.push({ data: b.data, mimeType: b.mimeType || "image/png" });
    else if (b.type === "resource_link") texts.push(`[${b.name ?? b.title ?? "file"}](${b.uri})`);
    else if (b.type === "resource" && typeof b.resource?.text === "string") texts.push(`<file uri="${b.resource.uri}">\n${b.resource.text}\n</file>`);
  }

  let planMode = null;
  const parts = [];
  for (let t of texts) {
    t = dropBlock(dropBlock(t, "runtime_info"), "pull_request_linking");
    const u = unwrapUserRequest(t);
    if (u.planMode !== null) planMode = u.planMode;
    t = dropBlock(dropBlock(u.text, "t3_code_instructions"), "t3_code_orchestration_instructions");
    if (t.trim()) parts.push(t.trim());
  }
  let text = parts.join("\n\n");

  let handoff = null;
  const split = splitHandoff(text);
  let userText = text;
  if (split) {
    handoff = rewriteHandoffContext(split.context);
    userText = split.user;
  }
  const att = resolveAttachments(userText, { hasImages: images.length > 0, readFile });
  userText = att.text;
  text = handoff
    ? `Earlier conversation from T3 Code (context only, not a new request):\n\n${handoff}\n\nUser message:\n${userText}`
    : userText;

  const trimmed = userText.trim();
  const m = !handoff && trimmed.match(/^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i);
  const command = m && OUR_COMMANDS.has(m[1].toLowerCase()) ? { name: m[1].toLowerCase(), args: (m[2] ?? "").trim() } : null;
  return { text, userText, images, handoff, planMode, command, isContinue: trimmed === CONTINUE_PROMPT, unsentImages: att.unsentImages };
}
