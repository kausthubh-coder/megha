// Prompt cleanup against the exact shapes T3 Code sends (fixtures/t3-prompts.json, built from T3's
// own source strings by fixtures/build-t3-prompts.mjs).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { cleanPrompt, rewriteHandoffContext } from "../lib/prompt.mjs";
import { test, tmp } from "./harness.mjs";

const { fixtures } = JSON.parse(readFileSync(new URL("./fixtures/t3-prompts.json", import.meta.url), "utf8"));
const NO_T3 = /t3_code_instructions|user_request|runtime_info|pull_request_linking|t3_thread_read|preview_status|delegate_task|T3 Code orchestration/;

export async function run() {
  await test("first turn: the ~9 KB T3 instruction wrapper and runtime block are dropped", () => {
    assert.ok(fixtures.firstTurn[0].text.length > 8000, "fixture carries the real wrapper");
    const r = cleanPrompt(fixtures.firstTurn);
    assert.equal(r.text, "Fix the flaky login test in src/auth.test.ts");
    assert.equal(r.planMode, false);
    assert.equal(cleanPrompt(fixtures.firstTurnNoMcp).text, "Summarize README.md");
  });

  await test("follow-up: only the runtime block is dropped", () => {
    const r = cleanPrompt(fixtures.followUp);
    assert.equal(r.text, "Now also add a regression test.");
    assert.equal(r.planMode, null);
  });

  await test("plan-mode switch is detected", () => {
    const r = cleanPrompt(fixtures.planModeSwitch);
    assert.equal(r.text, "How should we split the API module?");
    assert.equal(r.planMode, true);
  });

  await test("megha slash commands are recognised, other slashes pass through", () => {
    assert.deepEqual(cleanPrompt(fixtures.slashCommand).command, { name: "pr", args: "" });
    assert.deepEqual(cleanPrompt(fixtures.slashCommandArgs).command, { name: "pr", args: "draft" });
    const other = cleanPrompt([{ type: "text", text: "/compact" }]);
    assert.equal(other.command, null); assert.equal(other.text, "/compact");
  });

  await test("restart continuation is recognised through the wrapper", () => {
    const r = cleanPrompt(fixtures.continueAfterRestart);
    assert.equal(r.isContinue, true);
    assert.equal(r.text, "Continue where you left off.");
  });

  await test("attached text file (in T3's attachment folder) is inlined; binary or unreadable files are named instead", () => {
    const dir = tmp("att");
    const file = join(dir, "notes.txt");
    writeFileSync(file, "port=3000\nmode=dev\n");
    const blocks = JSON.parse(JSON.stringify(fixtures.withFileAttachment).replace("__ATTACHMENT_PATH__", file.replace(/\\/g, "\\\\")));
    const opts = { attachmentDirs: [dir] };
    const r = cleanPrompt(blocks, opts);
    assert.equal(r.text, `Review this config\n\n<attached_file name="notes.txt">\nport=3000\nmode=dev\n</attached_file>`);
    assert.match(cleanPrompt(blocks, { ...opts, readFile: () => Buffer.from([0, 1, 2]) }).text, /not sent: it is binary or over 64 KB/);
    assert.match(cleanPrompt(blocks, { ...opts, readFile: () => null }).text, /could not be read/);
    assert.match(cleanPrompt(blocks).text, /megha only sends files from T3's attachment folder/, "outside the folder: named, not read");
  });

  await test("image: block kept, its local path line dropped", () => {
    const r = cleanPrompt(fixtures.withImage);
    assert.equal(r.text, "What is wrong in this screenshot?");
    assert.equal(r.images.length, 1);
    assert.equal(r.images[0].mimeType, "image/png");
    assert.ok(!r.text.includes("saved at"));
  });

  await test("context handoff: history kept, T3 tool instructions and ids removed", () => {
    const r = cleanPrompt(fixtures.handoffFirstTurn);
    assert.equal(r.userText, "Make the toggle remember the choice.");
    assert.ok(r.handoff);
    assert.ok(!NO_T3.test(r.text), r.text);
    assert.match(r.text, /^Earlier conversation from T3 Code \(context only, not a new request\):/);
    assert.match(r.text, /\[Earlier user\]\nAdd a dark mode toggle to the settings page\./);
    assert.match(r.text, /\[Earlier assistant\]\nI added the toggle/);
    assert.match(r.text, /\n\nUser message:\nMake the toggle remember the choice\.$/);
    assert.ok(!/item_a1|provider-thread=|Source item range/.test(r.text));
    const short = cleanPrompt(fixtures.handoffShortCoverage);
    assert.ok(!NO_T3.test(short.text), short.text);
    assert.match(short.text, /Context handoff \(full_thread_summary\)\. 3 handoff records; detailed coverage references omitted\.\n/);
  });

  await test("no fixture leaks T3 instructions through cleanup", () => {
    for (const [name, blocks] of Object.entries(fixtures)) {
      const r = cleanPrompt(blocks, { readFile: () => Buffer.from("x") });
      assert.ok(!NO_T3.test(r.text), `${name}: ${r.text.slice(0, 200)}`);
      assert.ok(r.text.trim(), `${name} is empty`);
    }
  });

  await test("rewriteHandoffContext keeps unknown lines and the user's own words", () => {
    assert.equal(rewriteHandoffContext("A line mentioning t3_thread_read somewhere else\nkeep me"), "keep me");
    assert.equal(rewriteHandoffContext("[Historical user; command_execution; thread=x; run=r; item=i; provider-thread=p; status=completed]\nls"), "[Earlier user (command execution)]\nls");
  });

  await test("a user request that itself contains the wrapper tag survives", () => {
    const text = "<t3_code_instructions>\n## T3 Code interaction mode: Default\n</t3_code_instructions>\n\n<user_request>\nExplain what </user_request> means in our parser\n</user_request>";
    assert.equal(cleanPrompt([{ type: "text", text }]).text, "Explain what </user_request> means in our parser");
  });
}
