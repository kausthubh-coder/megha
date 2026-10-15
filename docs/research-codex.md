# Codex Cloud tasks: how the Codex CLI creates and manages them

Agent-facing notes. Researched 2026-10-14 against Codex CLI 0.162.1 (installed at
`C:\Users\kaust\scoop\persist\nodejs-lts\bin\node_modules\@openai\codex\`, native binary
`node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`).
Source: `src/` is a sparse clone of github.com/openai/codex at tag `rust-v0.162.1` (exact match).
Paths below are relative to `src/codex-rs/` unless noted.

Evidence labels:
- LIVE: confirmed with a read-only GET on the user's account, 2026-10-14.
- SRC: read in Rust source at rust-v0.162.1 (strings also present in the installed binary).
- DESKTOP: found in the installed Codex desktop app bundle (`C:\Program Files\WindowsApps\OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0\app\resources\app.asar`,
  file `/webview/assets/app-initial-b8e1c8014bb4.js` unless noted). The CLI does not use these. Not called live.
Nothing was created/applied/cancelled/archived. No token printed or written.

## 0. TL;DR for T3 Code
- Cloud task = plain REST on `https://chatgpt.com/backend-api/wham/...` with `Authorization: Bearer <ChatGPT access token>` (+ `ChatGPT-Account-Id`).
- Create: `POST /wham/tasks` `{new_task:{environment_id, branch, run_environment_in_qa_mode}, input_items:[...]}`.
- Poll: `GET /wham/tasks/list`, `GET /wham/tasks/{id}`. Diff: assistant turn `output_items[type=pr].output_diff.diff`. Apply = `git apply --3way`.
- The cloud container runs codex app-server; each assistant turn stores app-server v2 notifications in `thread_events.events` (LIVE). Desktop streams them live via SSE `GET /wham/tasks/{id}/turns/{turn}/stream` (DESKTOP). Reuse T3's app-server event reducer.
- app-server has NO cloud-task methods, but `getAuthStatus {includeToken:true}` returns the token and `account/read` returns `workspaceRouting` (LIVE). The desktop app authenticates `/wham` this way (DESKTOP). Use it; app-server owns refresh.
- ChatGPT login required; CLI rejects API-key auth (SRC).
- CLI covers create/list/status/diff/apply only. Follow-up, cancel, archive, recover, mark_read, PR, stream are desktop-only (DESKTOP).

## 1. Base URL
- Default `https://chatgpt.com/backend-api` (`cloud-tasks/src/lib.rs:54-56`). Override `CODEX_CLOUD_TASKS_BASE_URL`, must be https chatgpt.com / chat.openai.com / chatgpt-staging.com:443, no query/fragment (`cloud-tasks/src/util.rs:46-77`).
- Normalization: trim `/`, append `/backend-api` for chatgpt hosts (`backend-client/src/client.rs:208-230`). Base containing `/backend-api` → `/wham/...`, else `/api/codex/...` (`client.rs:142-157`). `https://chatgpt.com/api/codex/*` = Cloudflare 403 (LIVE).
- Task web URL: `https://chatgpt.com/codex/tasks/{id}` (`util.rs:134-146`). No redirects with credentials (`cloud-tasks-client/src/http.rs:36`).

## 2. Endpoints
### 2.1 CLI (SRC; GETs LIVE)
| Purpose | Request | Ref |
|---|---|---|
| List envs | `GET /wham/environments` | `cloud-tasks/src/env_detect.rs:89-93,372-376` |
| Envs for repo | `GET /wham/environments/by-repo/github/{owner}/{repo}` | `env_detect.rs:55-65,328-338` |
| List tasks | `GET /wham/tasks/list?limit&task_filter&cursor&environment_id` (CLI: limit 1-20, task_filter=current) | `backend-client/src/client.rs:438-483`, `cloud-tasks-client/src/http.rs:161-194` |
| Details | `GET /wham/tasks/{id}` | `client.rs:490-502` |
| Siblings | `GET /wham/tasks/{id}/turns/{turn_id}/sibling_turns` → `{sibling_turns:[turn...]}` | `client.rs:504-522` |
| Create | `POST /wham/tasks` | `client.rs:580-610`, `http.rs:332-393` |
| `codex apply <id>` | `GET /wham/tasks/{id}` | `chatgpt/src/get_task.rs:37-40` |
No cancel/archive/follow-up anywhere in codex-rs.

### 2.2 Desktop-only (DESKTOP)
- Follow-up: `POST /wham/tasks` `{follow_up:{task_id, turn_id, environment_mode:"ask"|"code"}, metadata?:{model_slug}, input_items}`
- `POST /wham/tasks/{id}/cancel`, `/archive`, `/recover` (unarchive), `/mark_read` (no body)
- `POST /wham/tasks/{id}/turns/{turn}/pr` `{mode, add_codex_tag, hide_pr_title_and_body, additional_labels}`
- `GET /wham/tasks/{id}/turns` (LIVE: `{turn_mapping:{<turn_id>:{id,turn,children,parent}}, current_turn_id}`)
- `GET /wham/tasks/{id}/turns/{turn}` (LIVE: `{task, user_turn, turn}`); `.../logs` (LIVE: `{logs:[{key:{name,type:"UserSetupScript",created_at},line}]}`)
- `GET /wham/tasks/search?query&limit&cursor` (LIVE, list shape); `task_filter=archived` (LIVE)
- SSE `GET /wham/tasks/{id}/turns/{turn}/stream?item_type=thread_event&item_type=log` (LIVE: 200 text/event-stream; finished turn sends nothing, stays open). data = `{item_type:"thread_event", id, event:{method,params}}` or `{item_type:"log", id, key:{type,created_at}, line}` (`/webview/assets/remote-conversation-page-ac36067c3c90.js`). Opened only while turn not completed/failed/cancelled.
- `GET /wham/github/branches/{repo_id}/search`; `POST /wham/worktree_snapshots/upload_url` `{repo_name, filename, content_type, anticipated_file_size}` → `POST /wham/worktree_snapshots/finish_upload` `{file_id, etag}`.

### 2.3 Create body (SRC exact, `cloud-tasks-client/src/http.rs:332-372`)
```json
{"new_task":{"environment_id":"<env>","branch":"<ref>","run_environment_in_qa_mode":false},
 "input_items":[{"type":"message","role":"user","content":[{"content_type":"text","text":"<prompt>"}]},
                {"type":"pre_apply_patch","output_diff":{"diff":"<unified diff>"}}],
 "metadata":{"best_of_n":2}}
```
- pre_apply_patch only if `CODEX_STARTING_DIFF` set; metadata only if best_of_n>1 (`--attempts` 1-4, `cloud-tasks/src/cli.rs:52-61`).
- CLI hardcodes qa_mode=false (`lib.rs:194,1525`). true = Ask mode. Tasks show `initial_intent`/`intent` = "pr" for code (LIVE).
- Desktop also sends `ide_context`, images, `prior_conversation {conversation, diff}`, comment attachments, optional `new_task.environment`, `metadata.model_slug`.
- Response: CLI reads `task.id` else `id` (`client.rs:591-609`). Unverified.

## 3. Auth
- Headers (`backend-client/src/client.rs:269-289`, `model-provider/src/bearer_auth_provider.rs:31-47`): `User-Agent: codex_cli_rs/0.162.1 (Windows 10.0.26200; x86_64) <terminal> (codex_cloud_tasks_<cmd>)` (`login/src/auth/default_client.rs:152-179`), `Authorization: Bearer <tokens.access_token>`, `ChatGPT-Account-ID: <tokens.account_id>`, `X-OpenAI-Fedramp: true` for FedRAMP. No separate originator header (originator `codex_cli_rs` is the UA prefix). Desktop adds `originator`, and for workspace routing swaps origin to `backendOrigin` + `X-OpenAI-Account-Routing-Override` unless NO_CONSTRAINT (`/.vite/build/bootstrap-487kJHw_.js`).
- LIVE: no account header → 200; no UA → 200; custom UA → 200; no auth → 401 `{"detail":"Unauthorized"}`; bad token → 401 "Could not parse your authentication token".
- auth.json (LIVE shape): `{auth_mode:"chatgpt", OPENAI_API_KEY:null, tokens:{id_token, access_token, refresh_token, account_id}, last_refresh}`. Access JWT aud `https://api.openai.com/v1`, client_id `app_EMoamEEZ73f0CkXaXp7hrann`; ~10 day life. account_id = JWT claim `https://api.openai.com/auth`.chatgpt_account_id.
- Refresh (SRC): `POST https://auth.openai.com/oauth/token` JSON `{client_id, grant_type:"refresh_token", refresh_token}` (`login/src/auth/manager.rs:212,1627-1680,1718`; `login/src/oauth/client.rs:75-112`); response `{id_token?,access_token?,refresh_token?}` persisted with `last_refresh` (`manager.rs:1600-1623`). Proactive when exp < 5 min or last_refresh > 8 days (`manager.rs:203-204,3000-3023`); also on 401. Errors refresh_token_expired/reused/invalidated are permanent → refresh tokens rotate; never refresh without writing back.
- API key: CLI exits "Not signed in..." unless `uses_codex_backend()` (`cloud-tasks/src/lib.rs:88-111`; true for Chatgpt/ChatgptAuthTokens/Headers/AgentIdentity/PersonalAccessToken, false for ApiKey/Bedrock: `app-server-protocol/src/protocol/common.rs:78-87`).
- app-server route (LIVE): initialize `{clientInfo:{name,title,version}, capabilities:{experimentalApi:true}}` → `initialized` → `getAuthStatus {includeToken:true, refreshToken:false}` → `{authMethod:"chatgpt", authToken, requiresOpenaiAuth}`; `account/read {refreshToken:false}` → `{account:{type:"chatgpt",email,planType}, workspaceRouting:{chatgptAccountId, backendOrigin:"https://chatgpt.com", accountRoutingOverride:"NO_CONSTRAINT"}}`. getAuthStatus is "deprecated" but the desktop app uses it for every backend call and retries with refreshToken:true on 401 (`/.vite/build/src-BJv5Mk7n.js`). Refs: `common.rs:1478-1483`, `v1.rs:190-210`, `app-server/src/request_processors/account_processor.rs:1116-1188`, `v2/account.rs:540-580`.

## 4. Environments / branch / attempts
- Discovery (`cloud-tasks/src/env_detect.rs`): `git config --get-regexp remote\..*\.url` (fallback `git remote -v`, :217-262), GitHub-only parse (:270-305), by-repo per origin, merge with full list (:317-424), sort pinned→label→id. Autodetect (:123-158): label match → single env → first pinned → max task_count → first. `--env` = exact id or unique case-insensitive label (`lib.rs:203-247`).
- LIVE: 1 env "inky" (29 fields: id, label, is_pinned, description, machine_id "wham-public/wham-universal", workspace_dir, agent_network_access, github_connector_id, repos, repo_map{repository_full_name, default_branch, clone_url, permissions...}, setup[], maintenance_setup[], env_vars{}, secrets{}, task_count, share_settings, permissions{can_write,can_delete}, cache_settings, ...). by-repo kausthubh-coder/inky → [env]; openai/codex → [].
- Branch (`lib.rs:150-176`): --branch → `git branch --show-current` → default branch (remote HEAD, local main/master, `git-utils/src/info.rs:505-528`) → "main". Only the name is sent; cloud clones GitHub, so unpushed work needs pre_apply_patch.
- Best-of-N: `metadata.best_of_n`; turns have `sibling_turn_ids`, `attempt_placement`; sorted by placement then created_at (`http.rs:647-659`); attempt_total = sibling_turn_ids.length+1.

## 5. Status, results, apply
- No polling loop in CLI. `status` = one GET, exit 1 unless ready (`lib.rs:515-529`). TUI refreshes on start / `r` / env change (5 s timeout, `app.rs:121-134`). Desktop: 5 s staleTime + SSE.
- Status (`http.rs:748-775`) from `task_status_display.latest_turn_status_display.turn_status`: pending/in_progress→Pending, completed→Ready, failed/cancelled→Error; fallback `task_status_display.state`.
- List item (LIVE): `{id, title, has_generated_title, created_at, updated_at (epoch float s), task_status_display:{latest_turn_status_display:{turn_id, turn_status, diff_stats:{files_modified,lines_added,lines_removed}, sibling_turn_ids, intent, cancellation_requested_at, ...}, environment_label, branch_name, fix_task_id, initial_intent}, archived, has_unread_turn, pull_requests[]}`, plus `cursor` (opaque ~330-char continuation token). No environment_id on list items.
- Details (LIVE): `{task:{id,title,created_at,current_turn_id,archived,task_status_display,denormalized_metadata{num_follow_ups...},external_pull_requests}, current_user_turn:{id "task_e_…~usertrn_e_…", input_items, user_model_slug, created_at}, current_assistant_turn:{id "task_e_…~assttrn_e_…", turn_status, error, sibling_turn_ids, attempt_placement, output_items:[message, partial_repo_snapshot, pr{pr_title, pr_message, output_diff{diff, base_commit_sha, files_modified, lines_added, lines_removed, commit_message,...}, pre_apply_patch}], worklog{messages}, thread_events{events:[{method,params}]}, app_server_events, latest_event, environment_id, environment{full}, branch, base_commit_sha, model_version, pull_request_status, logs, proxy_events, cancellation_requested_at}, current_diff_task_turn}`. thread_events for the sample: thread/started 1, thread/status/changed 2, turn/started 1, rawResponseItem/completed 27, item/completed 15, turn/completed 1; item/completed params `{completedAtMs,item,threadId,turnId}`.
- Extraction (`backend-client/src/types.rs:381-525`, `http.rs:577-709`): diff from current_diff_task_turn then current_assistant_turn, `output_diff.diff` or `pr.output_diff.diff`; messages from message items + assistant worklog parts; prompt from user turn; error `{code,message}`.
- Apply (`http.rs:443-574`, `git-utils/src/apply.rs:42-95`): validate unified diff, temp file, `git apply --3way` in git root of cwd (preflight `git apply --check`); no API call.

## 6. app-server
- No cloud-task methods (all method names checked; app-server doesn't depend on codex-cloud-tasks). Internal cloud hooks only: `rawResponseItem/completed`, `thread/start.experimentalRawEvents`, `thread/resume.history`.
- Useful: `getAuthStatus`, `account/read`, `gitDiffToRemote`. Unrelated: `remoteControl/*`, `environment/add|info|status`.
- `cloud-client/`: unused native gRPC client for `oaiproto.codex_app_server_backend.ThreadService/{Resume,Attach}` (thread_id; bearer + chatgpt-account-id metadata); not in the 0.162.1 binary. Likely the future cloud-thread transport.

## 7. Gotchas
- `codex cloud` appends `./error.log` in cwd (account id, env JSON, full patch on apply failure) (`util.rs:18-28`, `http.rs:911-921`).
- `status` exits 1 for non-ready. `CODEX_STARTING_DIFF` silently adds pre_apply_patch.
- Rotating refresh tokens: don't refresh auth.json yourself.
- Workspace routing ignored by CLI, honored by desktop.
- SSE stays silent/open for finished turns; use a timeout.
- Responses embed env `env_vars`/`secrets`; never log.
- Turn ids contain `~`; raw or encoded both work (LIVE).
- Git Bash: use `MSYS_NO_PATHCONV=1` or `/wham/...` args get rewritten.

## 8. Files
- `cloud.mjs`: envs [--detect] | list | show <id|url> [--diff] [--attempt N] [--events] | create (dry run unless --yes); `--auth file|app-server`. Read-only commands tested live with both auth sources; create only as dry run.
- `tmp/probe.mjs` (GET shape dumper), `tmp/asar-grep.mjs` (search Electron asar JS).
- `src/`: sparse clone at rust-v0.162.1 (long snapshot paths skipped by Windows path limits; none in the crates used).

## 9. Live streaming test (2026-10-14, krida env <krida-env-id>, Ask mode)
- Env created with `POST /wham/environments` (body = desktop VVt(): label, description, machine_id, repos:[github-<id>],
  github_connector_id, workspace_dir, agent_network_access, setup, maintenance_setup, env_vars, secrets_with_domains,
  share_settings, share_targets, auto_setup_settings, cache_settings, enable_authtranslator). Repo ids via
  `GET /wham/github/repositories/search/all-installations?query=`. Env detail: `GET /wham/environments/{id}/with-creator-and-machine` (plain GET is 405).
- Create response keys: task, user_turn, turn, rate_limit, paragen_forced_compare. Turn id from GET task current_assistant_turn.id.
- SSE (tmp/stream-codex.jsonl): stream open at 4.4 s, turn/started 39 s (container + `npm ci`), turn/completed 64 s.
  Methods: item/agentMessage/delta 164 (word-level, delivered in ~1 s bursts), item/reasoning/summaryTextDelta 3,
  item/completed 7 (NO item/started: commands show only when finished), rawResponseItem/completed 14, thread/tokenUsage/updated 4.
  No `log` items arrived (setup logs not streamed, or cached).

## 10. Found while building megha (2026-10-14)
- Models: `GET /wham/models?client_version=0.162.1` → `{models:[{slug, display_name, visibility, priority, default_reasoning_level, supported_reasoning_levels, context_window}]}`.
  `client_version` is required (a low value returns `[]`). Show `visibility:"list"`, sort by `priority`.
- Model choice: the desktop app sends top-level `metadata:{model_slug}` on new tasks and follow-ups. In live tests every turn still
  reported `model_version: gpt-5.6-sol` (tried gpt-5.6-luna and gpt-6.1-sol), and `user_model_slug` reads the literal `"slug"` on
  every task. Unclear whether the cloud honours the choice for this account.
- GitHub connector id `connector_76869538009648d5b282a4bb21c3d157` is a constant in the desktop bundle (the ChatGPT GitHub app), not per account.
- Repo search: `GET /wham/github/repositories/search/all-installations?query&limit&page&connector_id` → `{repositories:[{id:"github-<n>", repository_full_name, default_branch, visibility, permissions}]}`.
- PR from a turn: `POST /wham/tasks/{id}/turns/{turn}/pr` with `{}` or `{mode:"draft"}`.
- Images: uploaded through `/backend-api/files` the same way the desktop app does, then referenced from `input_items` (see packages/megha/lib/image.mjs).
- Task details carry `current_assistant_turn.environment_id` and the full `environment` (with `repo_map`); megha uses
  them to confirm a task belongs to the current repo before list/load/follow-up.
- `codex login status` only reads the stored login; the CLI refreshes when it next calls OpenAI.
