// Codex backend against a mocked chatgpt.com: environments (by-repo only, create for a new repo, clear
// errors), models, images, follow-ups, cancel, restart continuation, /pr and /apply.

import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CodexBackend, pickDefaultEnv, modelsFromResponse, environmentBody } from "../lib/codex.mjs";
import { cleanPrompt } from "../lib/prompt.mjs";
import { test, tmp, makeRepo, mockFetch, json, sse, hangingSse, recorder, PNG_1x1 } from "./harness.mjs";

const API = "chatgpt.com/backend-api";
const MODELS = { models: [
  { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide", priority: 0 },
  { slug: "gpt-b", display_name: "GPT-B", visibility: "list", priority: 2, description: "second" },
  { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 1 },
] };
const input = (text, extra = []) => cleanPrompt([{ type: "text", text }, ...extra]);
const thread = (method, params = {}) => ({ item_type: "thread_event", event: { method, params } });
const doneStream = (text) => sse([thread("turn/started"), thread("item/agentMessage/delta", { itemId: "m1", delta: text }), thread("turn/completed", { turn: { status: "completed" } })]);

// A small stateful chatgpt.com: one task whose current turn moves forward on each follow-up.
function fakeCodex({ byRepo = [], installations = [], envCreated, streamFor } = {}) {
  const state = { turn: null, status: "completed", taskTitle: "Widget task", cancelled: false };
  const routes = [
    ["GET", new RegExp(`^${API}/wham/models$`), () => json(MODELS)],
    ["GET", new RegExp(`^${API}/wham/environments/by-repo/github/`), () => json(byRepo)],
    ["GET", new RegExp(`^${API}/wham/github/repositories/search/all-installations$`), () => json({ repositories: installations })],
    ["POST", new RegExp(`^${API}/wham/environments$`), () => json(envCreated)],
    ["POST", new RegExp(`^${API}/wham/tasks$`), (req) => {
      const n = req.body.follow_up ? 2 : 1;
      state.turn = `task_e_1~assttrn_e_${n}`; state.status = "in_progress";
      return json({ task: { id: "task_e_1", title: state.taskTitle }, turn: { id: state.turn } });
    }],
    ["POST", new RegExp(`^${API}/wham/tasks/task_e_1/cancel$`), () => { state.cancelled = true; state.status = "cancelled"; return json({}); }],
    ["GET", new RegExp(`^${API}/wham/tasks/task_e_1/turns/[^/]+/stream$`), (req) => (streamFor ? streamFor(req) : (state.status = "completed", doneStream("Hello from the cloud")))],
    ["GET", new RegExp(`^${API}/wham/tasks/task_e_1$`), () => json({ task: { id: "task_e_1", title: state.taskTitle, current_turn_id: state.turn },
      current_assistant_turn: { id: state.turn, turn_status: state.status, output_items: [], model_version: "gpt-5.6-sol" } })],
  ];
  return { state, routes };
}

export async function run() {
  await test("pickDefaultEnv only chooses among this repo's environments", () => {
    const e = (id, label, extra = {}) => ({ id, label, pinned: false, taskCount: 0, repos: [], ...extra });
    assert.equal(pickDefaultEnv([], "widget"), null, "no environments: no pick (never another repo's)");
    assert.equal(pickDefaultEnv([e("1", "other"), e("2", "Widget")], "widget").id, "2");
    assert.equal(pickDefaultEnv([e("1", "a"), e("2", "b", { pinned: true })], "widget").id, "2");
    assert.equal(pickDefaultEnv([e("1", "a", { taskCount: 1 }), e("2", "b", { taskCount: 5 })], "widget").id, "2");
  });

  await test("models: listed ones only, in priority order", () => {
    assert.deepEqual(modelsFromResponse(MODELS).map((m) => m.id), ["gpt-5.6-sol", "gpt-b"]);
  });

  await test("environment body matches the desktop app's shape, with no env vars or secrets", () => {
    const b = environmentBody({ repoId: "github-42", fullName: "acme/widget", label: "widget", setup: ["npm ci"] });
    assert.deepEqual(Object.keys(b).sort(), ["agent_network_access", "auto_setup_settings", "cache_settings", "description", "enable_authtranslator", "env_vars", "github_connector_id",
      "label", "machine_id", "maintenance_setup", "repos", "secrets_with_domains", "setup", "share_settings", "share_targets", "workspace_dir"]);
    assert.deepEqual(b.repos, ["github-42"]); assert.deepEqual(b.env_vars, {}); assert.deepEqual(b.secrets_with_domains, []);
    assert.equal(b.github_connector_id, "connector_76869538009648d5b282a4bb21c3d157");
  });

  const repo = await makeRepo({ files: { "a.txt": "one\n", "package-lock.json": "{}\n" } });
  const be = new CodexBackend();
  const session = { id: "mg_codex_1", backend: "codex", cwd: repo, config: {} };
  let calls;

  await test("new GitHub repo with no environment: offers to create one, and the first prompt creates it", async () => {
    const fake = fakeCodex({ installations: [{ id: "github-42", repository_full_name: "acme/widget" }],
      envCreated: { id: "env_new", label: "widget", repo_map: { r: { repository_full_name: "acme/widget" } }, env_vars: { SHOULD_NOT_LEAK: "x" } } });
    calls = mockFetch(fake.routes);
    await be.prepare(session);
    const opts = be.configOptions(session);
    const env = opts.find((o) => o.id === "environment");
    assert.equal(env.currentValue, "create:acme/widget");
    assert.ok(env.options.some((o) => o.name === "Create environment for acme/widget" && /npm ci/.test(o.description)));
    const model = opts.find((o) => o.id === "model");
    assert.equal(model.category, "model"); assert.equal(model.currentValue, "gpt-5.6-sol");
    assert.deepEqual(model.options.map((o) => o.value), ["gpt-5.6-sol", "gpt-b"]);
    assert.deepEqual(opts.find((o) => o.id === "mode").options.map((o) => o.value), ["code", "ask", "plan"]);
    assert.equal(opts.find((o) => o.id === "localChanges").currentValue, "off", "clean, pushed checkout");
    assert.ok(!calls.some((c) => c.method === "GET" && c.path === `${API}/wham/environments`), "never lists every environment");

    const rec = recorder();
    const stop = await be.prompt(session, input("Fix the bug"), rec.io);
    assert.equal(stop, "end_turn");
    const envPost = calls.find((c) => c.method === "POST" && c.path === `${API}/wham/environments`);
    assert.deepEqual(envPost.body, environmentBody({ repoId: "github-42", fullName: "acme/widget", label: "widget", setup: ["npm ci"] }));
    const task = calls.find((c) => c.method === "POST" && c.path === `${API}/wham/tasks`).body;
    assert.deepEqual(task.new_task, { environment_id: "env_new", branch: "main", run_environment_in_qa_mode: false });
    assert.deepEqual(task.metadata, { model_slug: "gpt-5.6-sol" });
    assert.deepEqual(task.input_items, [{ type: "message", role: "user", content: [{ content_type: "text", text: "Fix the bug" }] }]);
    assert.equal(session.config.environment, "env_new");
    assert.ok(rec.updates.some((u) => u.sessionUpdate === "config_option_update"));
    assert.match(rec.text(), /Created the Codex Cloud environment "widget" for acme\/widget \(setup: npm ci\)/);
    assert.match(rec.text(), /Hello from the cloud/);
    assert.ok(!JSON.stringify(session).includes("SHOULD_NOT_LEAK"), "environment secrets are not kept");
  });

  await test("follow-up: model change and an image travel as model_slug and an image_asset_pointer", async () => {
    const fake = fakeCodex();
    fake.state.turn = "task_e_1~assttrn_e_1";
    const uploads = [];
    calls = mockFetch([...fake.routes,
      ["POST", new RegExp(`^${API}/files$`), (req) => { uploads.push(req.body); return json({ file_id: "file_img1", upload_url: "https://files.blob.example.net/c/f?sig=SIGNED" }); }],
      ["PUT", /^files\.blob\.example\.net\/c\/f$/, (req) => { uploads.push({ put: req.headers["x-ms-blob-type"], bytes: req.rawBody.length }); return new Response(null, { status: 201 }); }],
      ["POST", new RegExp(`^${API}/files/file_img1/uploaded$`), () => json({})],
    ]);
    be.setConfig(session, "model", "gpt-b");
    const rec = recorder();
    const stop = await be.prompt(session, input("What is in this image?", [{ type: "image", data: PNG_1x1, mimeType: "image/png" }]), rec.io);
    assert.equal(stop, "end_turn");
    const fu = calls.filter((c) => c.method === "POST" && c.path === `${API}/wham/tasks`).at(-1).body;
    assert.deepEqual(fu.follow_up, { task_id: "task_e_1", turn_id: "task_e_1~assttrn_e_1", environment_mode: "code" });
    assert.deepEqual(fu.metadata, { model_slug: "gpt-b" });
    assert.deepEqual(fu.input_items[1], { type: "image_asset_pointer", asset_pointer: "sediment://file_img1", width: 1, height: 1, size_bytes: Buffer.from(PNG_1x1, "base64").length });
    assert.equal(uploads[0].use_case, "codex");
    assert.equal(uploads[1].put, "BlockBlob");
    assert.ok(!rec.text().includes("SIGNED"), "the signed upload URL is never shown");
  });

  await test("plan mode = Ask mode with a plan request", async () => {
    const fake = fakeCodex(); fake.state.turn = "task_e_1~assttrn_e_1";
    calls = mockFetch(fake.routes);
    be.setConfig(session, "mode", "plan");
    await be.prompt(session, input("Split the API module"), recorder().io);
    const fu = calls.filter((c) => c.method === "POST" && c.path === `${API}/wham/tasks`).at(-1).body;
    assert.equal(fu.follow_up.environment_mode, "ask");
    assert.match(fu.input_items[0].content[0].text, /^Plan mode: .*\n\nSplit the API module$/s);
    be.setConfig(session, "mode", "code");
  });

  await test("cancel: the cloud cancel goes out at once and the turn winds down", async () => {
    const fake = fakeCodex({ streamFor: (req) => hangingSse(req.signal) }); fake.state.turn = "task_e_1~assttrn_e_1";
    calls = mockFetch(fake.routes);
    const ac = new AbortController();
    const rec = recorder({ signal: ac.signal });
    const t0 = Date.now();
    const p = be.prompt(session, input("long job"), rec.io);
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const stop = await p;
    const cancelAt = calls.findIndex((c) => c.path.endsWith("/cancel"));
    assert.ok(cancelAt >= 0, "POST /cancel sent");
    assert.equal(stop, "cancelled");
    assert.ok(Date.now() - t0 < 6000, `wind-down took ${Date.now() - t0} ms`);
  });

  await test("restart continuation: reattaches to a running turn instead of sending a follow-up", async () => {
    const fake = fakeCodex(); fake.state.turn = "task_e_1~assttrn_e_7"; fake.state.status = "in_progress";
    calls = mockFetch(fake.routes);
    const rec = recorder();
    assert.equal(await be.prompt(session, input("Continue where you left off."), rec.io), "end_turn");
    assert.ok(!calls.some((c) => c.method === "POST" && c.path === `${API}/wham/tasks`), "no follow-up was sent");
    assert.match(rec.text(), /Hello from the cloud/);
    assert.equal(session.doneTurnId, "task_e_1~assttrn_e_7");
  });

  await test("restart continuation: a turn that finished unseen is shown; an already-seen one gets a real follow-up", async () => {
    const fake = fakeCodex(); fake.state.turn = "task_e_1~assttrn_e_8"; fake.state.status = "completed";
    const routes = [["GET", new RegExp(`^${API}/wham/tasks/task_e_1$`), () => json({ task: { id: "task_e_1", title: "t", current_turn_id: fake.state.turn },
      current_assistant_turn: { id: fake.state.turn, turn_status: fake.state.status, output_items: [],
        thread_events: { events: [{ method: "item/completed", params: { item: { id: "m9", type: "agentMessage", text: "Finished while you were away" } } }] } } })], ...fake.routes];
    calls = mockFetch(routes);
    let rec = recorder();
    assert.equal(await be.prompt(session, input("Continue where you left off."), rec.io), "end_turn");
    assert.match(rec.text(), /finished while T3 Code was away[\s\S]*Finished while you were away/);
    assert.ok(!calls.some((c) => c.method === "POST" && c.path === `${API}/wham/tasks`));
    rec = recorder();
    await be.prompt(session, input("Continue where you left off."), rec.io);
    assert.ok(calls.some((c) => c.method === "POST" && c.path === `${API}/wham/tasks` && c.body.follow_up), "seen turn: normal follow-up");
  });

  await test("/pr opens a PR from the diff turn and links it in T3; /apply applies the diff", async () => {
    const diff = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n";
    const mcp = [];
    calls = mockFetch([
      ["GET", new RegExp(`^${API}/wham/tasks/task_e_pr$`), () => json({ task: { id: "task_e_pr", external_pull_requests: [] },
        current_diff_task_turn: { id: "task_e_pr~assttrn_e_5", output_items: [{ type: "pr", output_diff: { diff } }] }, current_assistant_turn: { id: "task_e_pr~assttrn_e_6", output_items: [] } })],
      ["POST", new RegExp(`^${API}/wham/tasks/task_e_pr/turns/task_e_pr~assttrn_e_5/pr$`), () => json({ pull_request: { url: "https://github.com/acme/widget/pull/9" } })],
      ["POST", /^127\.0\.0\.1:4999\/mcp$/, (req) => {
        mcp.push(req.body);
        if (req.body.method === "initialize") return json({ jsonrpc: "2.0", id: req.body.id, result: { protocolVersion: "2025-06-18" } });
        if (!req.body.id) return new Response(null, { status: 202 });
        return json({ jsonrpc: "2.0", id: req.body.id, result: { content: [] } });
      }],
    ]);
    const s = { id: "mg_pr", cwd: repo, cloudId: "task_e_pr", webUrl: "https://chatgpt.com/codex/tasks/task_e_pr", config: {}, t3: { endpoint: "http://127.0.0.1:4999/mcp", authorization: "Bearer t" } };
    let rec = recorder();
    await be.command(s, { name: "pr", args: "" }, rec.io);
    assert.match(rec.text(), /Opened https:\/\/github\.com\/acme\/widget\/pull\/9/);
    assert.match(rec.text(), /Linked the pull request to this thread in T3 Code/);
    const pr = calls.find((c) => c.path.endsWith("/pr"));
    assert.deepEqual(pr.body, {});
    assert.deepEqual(mcp.find((m) => m.method === "tools/call").params, { name: "link_pull_request", arguments: { url: "https://github.com/acme/widget/pull/9" } });
    rec = recorder();
    await be.command(s, { name: "apply", args: "" }, rec.io);
    assert.match(rec.text(), /Applied the cloud diff/);
    assert.equal(readFileSync(join(repo, "a.txt"), "utf8").replace(/\r\n/g, "\n"), "two\n");
  });

  await test("repo not visible to the Codex connector: clear error, suggests Claude Cloud", async () => {
    const r = await makeRepo({ origin: "https://github.com/acme/hidden.git" });
    calls = mockFetch(fakeCodex({ installations: [{ id: "github-1", repository_full_name: "acme/hidden-other" }] }).routes);
    const s = { id: "mg_hidden", cwd: r, config: {} };
    await be.prepare(s);
    assert.equal(s.config.environment, "none");
    assert.match(be.configOptions(s).find((o) => o.id === "environment").options[0].name, /not visible to Codex/);
    await assert.rejects(be.prompt(s, input("hi"), recorder().io), /ChatGPT Codex connector can't see acme\/hidden[\s\S]*Claude Cloud/);
  });

  await test("no GitHub remote / no git: says what to run", async () => {
    calls = mockFetch(fakeCodex().routes);
    const gl = { id: "mg_gl", cwd: await makeRepo({ origin: "https://gitlab.com/acme/x.git" }), config: {} };
    await be.prepare(gl);
    await assert.rejects(be.prompt(gl, input("hi"), recorder().io), /gh repo create --source \. --push[\s\S]*Claude Cloud/);
    const plain = { id: "mg_plain", cwd: tmp("nogit"), config: {} };
    await be.prepare(plain);
    await assert.rejects(be.prompt(plain, input("hi"), recorder().io), /is not a git repository/);
    assert.ok(!calls.some((c) => c.path.includes("/by-repo/")), "no environment lookup without a GitHub remote");
  });

  await test("unpushed branch with local changes: starts from the default branch with a starting patch", async () => {
    const r = await makeRepo({ origin: "https://github.com/acme/widget.git" });
    const { git } = await import("../lib/util.mjs");
    await git(r, ["checkout", "-qb", "feature"]);
    writeFileSync(join(r, "a.txt"), "changed\n");
    const fake = fakeCodex({ byRepo: [{ id: "env_w", label: "widget", repo_map: { x: { repository_full_name: "acme/widget" } } }] });
    calls = mockFetch(fake.routes);
    const s = { id: "mg_local", cwd: r, config: {} };
    await be.prepare(s);
    assert.equal(s.config.localChanges, "on", "branch not on origin turns it on by default");
    const rec = recorder();
    await be.prompt(s, input("go"), rec.io);
    const task = calls.find((c) => c.method === "POST" && c.path === `${API}/wham/tasks`).body;
    assert.equal(task.new_task.branch, "main");
    assert.equal(task.input_items.at(-1).type, "pre_apply_patch");
    assert.match(task.input_items.at(-1).output_diff.diff, /\+changed/);
    assert.match(rec.text(), /starts from `main` with your local changes applied/);
  });
}
