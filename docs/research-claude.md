# Claude Code cloud sessions: how the CLI starts and drives them

Source: Claude Code 2.1.288 (Bun exe `C:\Users\kaust\scoop\persist\nodejs-lts\bin\node_modules\@anthropic-ai\claude-code\bin\claude.exe`)
plus public docs (code.claude.com claude-code-on-the-web, routines; platform.claude.com api/claude-code/routines-fire). 2026-10-14.

- JS bundle = plain text at binary offsets 0xc2677a8..0xea247c8 (41.7 MB). `extract/save-snippets.mjs` dumps it to
  %TEMP%\cc-bundle.js and writes cited snippets to `extract/NN-*.js.txt`. `bundle@N` = byte offset into that dump
  (binary offset = N + 0xc2677a8). `extract/ctx.mjs|defs.mjs|slice.mjs` grep it. Minified names are 2.1.288-only.
- [live] = confirmed by read-only GET with this account's token. [code] = read from bundle, not sent. [docs] = public docs.

## 1. Auth
- Creds: %USERPROFILE%\.claude\.credentials.json → claudeAiOauth.{accessToken sk-ant-oat01 (108 ch), refreshToken sk-ant-ort01,
  expiresAt ms, refreshTokenExpiresAt, scopes[], subscriptionType, rateLimitTier} [live]. macOS: Keychain "Claude Code-credentials". CLAUDE_CONFIG_DIR moves it.
- Scopes here: user:file_upload user:inference user:mcp_servers user:plugins user:profile user:sessions:claude_code [live].
  Need user:sessions:claude_code (+ user:profile for org lookup, user:file_upload for bundles). Default scope list bundle@325300.
- API keys rejected by tk(): "API key authentication is not sufficient" (06-session-crud). setup-token tokens = scope user:inference only (RT) → unusable.
- Refresh (afe(), 02-oauth-refresh): POST https://platform.claude.com/v1/oauth/token JSON
  {grant_type:"refresh_token", refresh_token, client_id:"9d1c250a-e61b-44d9-88ed-5944d1962f5e", scope:"user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins"}
  → {access_token, refresh_token?, expires_in, refresh_token_expires_in?, scope}. Refresh ROTATES the refresh token: write back or let `claude auth status` refresh.
- Org UUID (LW(), 04): env CLAUDE_CODE_ORGANIZATION_UUID → ~/.claude.json oauthAccount.organizationUuid → GET https://api.anthropic.com/api/oauth/profile → organization.uuid [live].
- Headers QR()/FGt() (bundle@2971900, 05): User-Agent: claude-code/2.1.288; Authorization: Bearer; Content-Type: application/json;
  anthropic-version: 2023-06-01; anthropic-client-platform: claude_code_cli (Fh(), from CLAUDE_CODE_ENTRYPOINT).
  + x-organization-uuid on legacy /v1/sessions, environment_providers, teleport-events, session_ingress, triggers, GitHub preflight (not on /v1/code/sessions CRUD; harmless if sent).
  + anthropic-beta: ccr-byoc-2025-07-29 (legacy /v1/sessions, env create, pools); ccr-triggers-2026-01-30 (triggers). Optional X-Trusted-Device-Token for device-bound sessions.
- Base https://api.anthropic.com (pn().BASE_API_URL).

## 2. Endpoints
Ids: /v1/code/sessions uses cse_…, legacy uses session_…; same suffix = same session (fc()/Zd()); both accepted by GET /v1/code/sessions/{id} [live].

| Purpose | Method path | Extra hdrs | Body/query → response | |
|---|---|---|---|---|
| List envs | GET /v1/environment_providers?limit=100[&after_id] | org | {environments:[{kind,environment_id,name,description,created_at,state,owner_account_uuid,config,bridge_info}],has_more?,last_id?} | live |
| Create env | POST /v1/environment_providers/cloud/create | org, ccr-byoc | {name:"Default",kind:"anthropic_cloud",description,config:{environment_type:"anthropic",cwd:"/home/user",init_script:null,environment:{},languages:[{name:"python",version:"3.11"},{name:"node",version:"20"}],network_config:{allowed_hosts:[],allow_default_hosts:true}}} | code UBe() |
| Self-hosted pools | GET /v1/code/runners/self-hosted/pools | org, ccr-byoc | {pools:[{pool_id:"ccpool_…",name,alive_runner_count}]} | code |
| Create (v1, used here) | POST /v1/sessions | org, ccr-byoc | §3 → session {id:"session_…"} | code |
| Create (v1alpha2) | POST /v1/code/sessions | org | §3 → {session:{id:"cse_…"}} | code vgn() |
| List | GET /v1/code/sessions[?limit&cursor&trigger_id] | – | {data:[session],next_cursor?} | live |
| List legacy | GET /v1/sessions | org, ccr-byoc | {data,first_id,last_id,has_more} (contains session_context.mcp_config headers: don't log) | live |
| Get | GET /v1/code/sessions/{id} | – | {session:{…}} or {response_shape:{…}}; 404 not found | live |
| Rename | PUT /v1/code/sessions/{id} | | {title} | code |
| Events poll | GET /v1/code/sessions/{id}/events?sort_order=asc&cursor=<seq>[&limit] | – | {data:[event],next_cursor} | live |
| Stream | GET …/{id}/events/stream[?from_sequence_num=N][&control_only=1] | Accept: text/event-stream, Last-Event-ID | SSE `:keepalive`, `event: session_update` {connection_status}, `event: client_event` id=seq data=event row | live |
| Send msg | POST /v1/code/sessions/{id}/events | (+trusted-device) | {events:[{payload:{uuid,session_id:"<id>",type:"user",parent_tool_use_id:null,message:{role:"user",content}}}]} → {results:[{sequence_num,duplicate?}]} | code wa()/Ffe() |
| Send legacy | POST /v1/sessions/{session_id}/events | org, ccr-byoc | {events:[payload]} | code Rgn() |
| Interrupt | same POST, payload {type:"control_request",request_id,request:{subtype:"interrupt",cancel_queued:true},uuid} | | | code |
| Archive | POST /v1/code/sessions/{id}/archive | | {} → 200 / 409 already | code ZR() |
| Mark read | POST …/{id}/mark_read | | {event_id?} | code |
| Teleport transcript | GET …/{id}/teleport-events?limit=1000[&cursor] | org | {data:[{payload:<transcript line>}],next_cursor} | live |
| Transcript fallback | GET /v1/session_ingress/session/{id} | org | {loglines:[…]} | code |
| GitHub preflight | GET /api/oauth/organizations/{org}/code/repos/{owner}/{repo} | org | {repo:{default_branch,…},status:{app_installed,workflow_enabled,reason}} (status:null = undetermined) | live |
| Triggers | GET/POST /v1/code/triggers, GET/POST /v1/code/triggers/{id}, POST …/{id}/run, POST /v1/code/webhook-triggers | org, ccr-triggers-2026-01-30 | §6 | list live |

Session object (trimmed, live): {id, title, status:"active"|"archived", worker_status:"idle"|"running"|"requires_action", status_bucket,
connection_status, environment_id, environment_kind:"bridge"|"anthropic_cloud"|"byoc"|"snap", created_at, last_event_at, updated_at,
config:{model, effort_level, permission_mode, origin, sources:[{type:"git_repository",url,sparse_checkout_paths,…}],
outcomes:[{type:"git_repository",git_info:{type:"github",repo:"owner/name",branches:["claude/…"]}}], mcp_connector_ids},
external_metadata:{container_cc_version, current_branches, permission_mode, pending_action{tool_name,request_id}, post_turn_summary, usage, last_init_error}, tags, unread}.
Web-created sources had no `revision`.

Event row (live): {event_id, event_type, sequence_num:"3" (string), source:"client"|"worker", created_at/received_at/processed_at,
device_attestation_status, payload:{type,uuid,session_id,message:{role,content},…}}. payload types seen: env_manager_log (provisioning steps),
control_request/control_response, user, assistant (full Messages API msg), system (turn_handoff_available), result, active_goal. = Claude Code SDK stream-json.

## 3. Create (SO()/teleportToRemote, 08-teleportToRemote-SO; CLI `claude --cloud "<task>"`, hidden alias --remote; follow-up `claude -p msg --cloud <id>`)
1. Gates: policy allow_remote_sessions, first-party, claude.ai OAuth, org UUID.
2. Endpoint: v1alpha2 only if githubPr==null && no env vars && GrowthBook tengu_violin_maple (or ultrareview/ultraplan + tengu_woven_harbor).
   Both false here (~/.claude.json cachedGrowthBookFeatures) → POST /v1/sessions + org + ccr-byoc (OJt()/d5r()).
3. Env (jue()): settings remote.defaultEnvironmentId (ccpool_ only from policy/flag/user settings) → first anthropic_cloud → first non-bridge → first; none → auto-create Default. Here: env_<default> [live].
4. Source (PC()): origin → https://<host>/<owner>/<name>, revision = branch or pushed ancestor (M7t()); github.com → App preflight. Outcome branch + title from small model call (elr()), fallback claude/task.
5. Events (xJt()) as {type:"event",data}: optional set_max_thinking_tokens; {type:"control_request",request_id:"set-mode-<uuid>",request:{subtype:"set_permission_mode",mode}}; optional apply_flag_settings/rename_session; then {uuid,session_id:"",type:"user",parent_tool_use_id:null,message:{role:"user",content}}.

v1 body:
```json
{"title":"…","events":[…],
 "session_context":{"sources":[{"type":"git_repository","url":"https://github.com/O/R","revision":"main"}],
  "outcomes":[{"type":"git_repository","git_info":{"type":"github","repo":"O/R","branches":["claude/x"]}}],
  "model":"claude-opus-5-5","effort_level":"high","seed_bundle_file_id":"file_…","environment_variables":{},
  "append_system_prompt":"…","custom_system_prompt":"…","max_turns":10,"max_budget_usd":5,"allowed_tools":[],"disallowed_tools":[],
  "builtin_tools":[],"output_schema":{},"correlation_id":"…","reuse_outcome_branches":true,"github_pr":{}},
 "environment_id":"env_…" /* or "self_hosted_runner_pool_id":"ccpool_…" */, "tags":[]}
```
→ 200/201, read .id/.title. Errors {error:{type,reason,message}}; reasons: github_repo_access_denied, environment_not_found, model_not_available_for_org, monorepo_*, feature_disabled.
v1alpha2 (vgn()): top-level title, environment_id|self_hosted_runner_pool_id, events:[{payload:data}], tags, environment_variables, session_grouping_id, agent_id; rest under config:{sources,outcomes,model,cwd,effort_level,seed_bundle_file_id,…,builtin_tools}.
After create the CLI polls ($fe()) or streams. URL https://claude.ai/code/<id>.

## 4. Repo → cloud
- Default: VM clones sources[].url@revision from GitHub; push first; uncommitted changes NOT sent. Pushes to claude/… via Anthropic GitHub proxy.
- Access: Claude GitHub App or /web-setup (gh token → POST /v1/code/github/import-token). Preflight said app_installed:false for kausthubh-coder/inky though a web session cloned it → false ≠ can't clone.
- Bundle seeding (BJt()/nze(), bundle@11013564..11092000): no remote / non-GitHub / preflight failed / branch unrelated / CCR_FORCE_BUNDLE=1; gate tengu_ccr_bundle_seed_enabled (true here). git stash create → refs/seed/<ts>-<hex>/{stash,root} → git bundle create (heads, tags, HEAD, stash) → fallback current branch → squashed snapshot; max 100 MB. Upload POST /v1/files (multipart, anthropic-beta files-api-2025-04-14, OAuth) → session_context.seed_bundle_file_id, sources []. Windows uploads uncommitted tracked changes regardless of name; untracked never. Not for byoc/self-hosted.

## 5. Teleport (09/10/11)
Clean tree required → GET session → origin must match sources url → GET teleport-events (fallback session_ingress) → branch = config.outcomes[0].git_info.branches[0] → git fetch origin b:b (fallback fetch origin b) → git checkout b -- / checkout -b b --track origin/b / checkout --track origin/b → set upstream.

## 6. Routines
- Internal (/schedule, RemoteTriggerTool 13/14/15): Bearer + org + anthropic-beta ccr-triggers-2026-01-30. Create body:
  {name, cron_expression|run_once_at, enabled, job_config:{ccr:{environment_id, session_context:{model, sources:[{git_repository:{url}}], allowed_tools}, events:[{data:{uuid,session_id:"",type:"user",parent_tool_use_id:null,message:{role:"user",content}}}]}}}.
  POST /v1/code/triggers/{trig_id}/run = Run now → new session; runs at GET /v1/code/sessions?trigger_id=. Cron ≥ hourly; 30/h per routine, 100/h per account. No delete via CLI.
- Public [docs, experimental]: POST https://api.anthropic.com/v1/claude_code/routines/{trig_id}/fire, Bearer per-routine token (made once in web UI), anthropic-version 2023-06-01, optional anthropic-beta experimental-cc-routine-2026-04-01; body {text?} ≤65,536 chars (wrapped as untrusted <routine-fire-payload>) → {type:"routine_fire",claude_code_session_id,claude_code_session_url}. No idempotency.
- Routine runs clone the default branch unless the prompt says otherwise; no per-run branch.

## 7. Stability
- Only documented entry: routines /fire (experimental). Everything else is undocumented internal (v1 → v1alpha2 migration in flight, device binding).
- The SDK's /v1/sessions?beta=true with managed-agents-2026-04-01 (bundle@6477868..6483297) is Claude Platform Managed Agents, not Claude Code cloud sessions.

## 8. Gotchas
- Create via v1 unless tengu_violin_maple; read/write via /v1/code/sessions.
- Fresh v4 uuid per user event; server dedupes (results[0].duplicate); a timed-out POST may already be stored.
- 403 bound_unattested/untrusted_device = device-bound session; T3 can't sign.
- requires_action + external_metadata.pending_action → reply control_response {type:"control_response",response:{subtype:"success",request_id,response:{behavior:"allow"|"deny",…}}}.
- Startup failures in external_metadata.last_init_error / status "failed", not a create error.
- Policy allow_remote_sessions, ZDR/HIPAA block all of this.

## cloud.mjs
node claude/cloud.mjs whoami|envs|list|list-legacy|show <id>|events <id> [--all]|stream <id> [--from N --seconds S]|transcript <id>|triggers|repo o/n|create "<prompt>" [--repo --branch --env --model --mode --title] [--yes]
Live-tested 2026-10-14: all read-only commands + create dry-run. create --yes NOT run. No refresh, never prints tokens.

## 9. Live streaming test (2026-10-14, krida, bundle-seeded)
- `POST /v1/sessions` with a GitHub source failed: 400 github_repo_access_denied (Claude GitHub App not on krida).
- Bundle path works: `git bundle create f HEAD main` → multipart `POST /v1/files` (fields file + purpose=user_data;
  anthropic-beta `files-api-2025-04-14,oauth-2025-04-20`) → session_context {sources:[], outcomes:[], seed_bundle_file_id}.
  `cloud.mjs create --bundle`. No outcome branch, so the session can't push to GitHub.
- SSE (tmp/stream-claude.jsonl): NO token deltas. Each assistant message (tool_use or final text) arrives whole:
  11 assistant, 9 user (tool results), final 1404-char answer in one event, result at 17.6 s after stream open.
  Other events: env_manager_log, system, ephemeral_event:system, delivery_update, rate_limit_event, active_goal, autocompact_state.
- `claude --cloud` refuses without a TTY ("--cloud requires an interactive terminal").
