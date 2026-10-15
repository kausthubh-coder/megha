# T3 Code internals for "cloud threads" (agent-facing notes)

Researched 2026-10-14. Paths are relative to `t3/upstream/` (pingdotgg/t3code @ a01c48f8) unless absolute.

## Versions and sources
- Installed Nightly: 0.0.46-nightly.20261013.3080, t3codeCommitHash a01c48f86245 (`t3/extract/app/package.json`). Upstream cloned to `t3/upstream`, checked out at a01c48f8 (exact match; origin/main was 348f217a on 2026-10-14). Windows clone: `git config core.longpaths true` + `git reset --hard`.
- `t3/extract/server`: server.asar. Entry `apps/server/dist/bin.mjs`; the code lives in `binCli-BtbPxxsB.mjs` (13.5 MB, no sourcemaps). Web UI at `apps/server/dist/client/`. `t3/extract/app`: Electron shell only.
- Bundle matches source. Spot-checked strings: acpRegistry, T3_ACP_MCP_ENDPOINT, acp-mcp-bridge, app_thread.created, turn_item.updated, backend-api/wham.
- Other checkout: `dev/sandbox/t3-mobile-comparison/source` (f570294d, 2026-10-12; belongs to another experiment). `~/.t3/worktrees/studi-2/t3code-ddf260b2` is a Studi worktree, not t3code.
- Read first: docs/internals/adding-a-provider.md, docs/user/providers-acp.md, docs/orchestration-v2/provider-capability-system.md, docs/orchestration-v2/core-graph-and-data-model.md, docs/internals/remote.md.

## 1. Provider abstraction
- A thread stores modelSelection {instanceId, model, options?}. instanceId is a key in ServerSettings.providerInstances (contracts/src/settings.ts:1317).
- ProviderInstanceConfig (contracts/src/providerInstance.ts:124): {driver, displayName?, accentColor?, environment?: [{name,value,sensitive}], enabled?, config?: unknown}. Envelopes with unknown drivers round-trip and show as "unavailable".
- Live file C:\Users\kaust\.t3\userdata\settings.json has: codex, codex_8facfabe-… (setupMode managed), claudeAgent, plus disabled opencode/cursor/grok/antigravity. No acpRegistry instance yet.
- Driver SPI (packages/provider-core/src/server/driver.ts):
    ProviderDriver<Config,R> { driverKind; metadata{displayName, supportsMultipleInstances?, hasDefaultInstance?}; configSchema; defaultConfig(); create(input{instanceId, displayName, environment, enabled, config}) → Effect<ProviderInstance>; usage? }
    ProviderInstance { instanceId, driverKind, continuationIdentity, snapshot: ManagedServerProvider, orchestrationAdapter: ProviderAdapterV2, textGeneration, auth?, acpSessionManagement?{listSessions, deleteSession, logout, …} }
- Adapter (packages/provider-core/src/server/ProviderAdapter.ts):
    ProviderAdapterV2 { instanceId; driver; getCapabilities(); planSelectionTransition(); openSession({threadId, providerSessionId, modelSelection, runtimePolicy, resumeFromSession?}) → SessionRuntime }
    SessionRuntime {
      events: Stream<ProviderAdapterV2Event>;
      ensureThread; resumeThread; startTurn(TurnInput); steerTurn; interruptTurn({providerThread, providerTurnId});
      respondToRuntimeRequest({requestId, decision?, answers?}); readThreadSnapshot; rollbackThread; forkThread;
      optional: injectHistory, compactThread, stopTask, stopSubagent, unloadThread, mcpApps, hasPendingBackgroundWork, … }
    RuntimePolicy {runtimeMode, interactionMode, cwd: string|null, approvalPolicy?, sandboxPolicy?, reasoningEffort?}
    TurnInput {appThread, threadId, runId, runOrdinal, attemptId, rootNodeId, providerThread, message{messageId, text, attachments}, modelSelection, runtimePolicy}
- Adapter driver (provider-core/src/server/adapterDriver.ts): {driverKind, configSchema, defaultConfig, create}.
- Registration is static. Drivers: apps/server/src/provider/builtInDrivers.ts (Codex, Claude, Cursor, Grok, OpenCode, Antigravity, Pi, Muse, AcpRegistry). Adapters: apps/server/src/orchestration-v2/builtInProviderAdapterDrivers.ts.
- Runtime: ProviderInstanceRegistry.ts hot-reloads from settings. orchestration-v2/ProviderAdapterRegistry.ts is the lookup the orchestrator uses.
- No plugin or dynamic driver loading exists (grepped). A native provider means a fork: packages/provider-<name> with ./settings ./client ./server ./testing exports (reference: packages/provider-pi), registered in both lists plus status order, model-manifest.json and the web/mobile client registries.
- Adapter sources:
  - orchestration-v2/Adapters/CodexAdapterV2.ts (about 7.4k lines)
  - orchestration-v2/Adapters/ClaudeAdapterV2.ts (about 9.4k lines)
  - orchestration-v2/Adapters/AntigravityAdapterV2.ts (a flavor of the shared ACP adapter)
  - packages/provider-{cursor,grok,opencode,pi,muse,acp-registry}

## 2. Codex and Claude
- Codex
  - Spawns `codex app-server [launchArgs]` and speaks JSON-RPC over stdio. Client: packages/effect-codex-app-server (generated schema; thread/*, turn/*, item/*, account/*). See CodexAdapterV2.ts ~L1520 layerAppServerClientFactory and provider/codexLaunchArgs.ts.
  - Settings: setupMode managed|existing, binaryPath, homePath (→ CODEX_HOME), shadowHomePath, launchArgs (env T3CODE_CODEX_LAUNCH_ARGS overrides).
  - Auth, existing mode: CODEX_HOME/auth.json.
  - Auth, managed mode: T3's own OAuth (provider/CodexChatGptAuth.ts; resource api.openai.com/v1, scope chatgpt.tokens.use.direct). Codex is launched with `-c model_provider=openai_token_sharing … env_key=ACCESS_TOKEN` (CodexManagedRuntime.ts). Homes: ~/.t3/userdata/providers/codex/codex_<uuid>/.
  - The managed token is not a chatgpt.com/backend-api token. For Codex Cloud (wham), reuse ~/.codex/auth.json as the `codex cloud` CLI does.
  - T3 calls https://chatgpt.com/backend-api/wham only for usage and reset credits (usage/cliproxyApi.ts:99; headers OpenAI-Beta: codex-1, Originator: Codex Desktop, Chatgpt-Account-Id).
  - The generated app-server schema also has unused thread/environment/connected and remoteControl/* methods.
- Claude
  - @anthropic-ai/claude-agent-sdk ^0.3.276 query() in ClaudeAdapterV2.ts. pathToClaudeCodeExecutable comes from settings.binaryPath.
  - Auth is Claude Code's own login. homePath → CLAUDE_CONFIG_DIR, else inherited CLAUDE_CONFIG_DIR, else ~/.claude (Drivers/ClaudeHome.ts).
  - provider/claudeResetCredits.ts calls api.anthropic.com with claudeAiOauth.accessToken from the CLI config dir. This is the precedent for calling claude.ai APIs with CLI credentials.
- ACP
  - packages/provider-acp/src/server/{AcpSessionRuntime,adapter}.ts over packages/effect-acp. Prefers ACP v2 (protocolVersion 2) and negotiates v1.
  - Methods: initialize, authenticate, session/new|load|resume|prompt|cancel|set_model|set_mode|set_config_option|list|fork|delete|close; client side session/request_permission.

## 3. Event model (orchestration v2 only; the ProviderRuntimeEvent union in contracts/src/providerRuntime.ts is legacy and not ingested)
- ProviderAdapterV2Event carries full-entity upserts, each with `driver`:
  - app_thread.created
  - provider_session.updated {status, cwd (required, non-empty), model, capabilities}
  - provider_thread.updated {nativeThreadRef, status, contextUsage}
  - provider_turn.updated {nativeTurnRef, status, tokenUsage}
  - node.updated {kind: root_turn|assistant_message|reasoning|plan|todo_list|tool_call|approval_request|user_input_request|subagent|…}
  - message.updated {role, text, streaming}
  - turn_item.updated
  - runtime_request.updated {kind: command|file-read|file-change|permission|user_input|…, status, responseCapability: live|message|not_resumable}
  - plan.updated (proposed_plan | todo_list)
  - subagent.updated
  - turn.terminal {status completed|interrupted|cancelled|failed, failure, threadDisposition reusable|broken}
- TurnItem types (contracts/src/orchestrationV2.ts ~L1463):
  - assistant_message, reasoning
  - command_execution{input, output, exitCode}
  - file_change{fileName, additions, deletions, diffStr, changes[]}
  - file_search, web_search, dynamic_tool
  - approval_request, user_input_request
  - todo_list, proposed_plan
  - error, system_notice, compaction, handoff, fork, subagent
  - checkpoint (written by the server only)
- Streaming: re-emit the entity with the accumulated text and streaming:true, then false (Adapters/ProviderTextDeltaCoalescer.ts). Compact reference adapter: packages/provider-muse/src/server/adapter.ts (publishItem, resolvePending, finish).
- Ingestion and persistence: orchestration-v2/ProviderEventIngestor.ts, called from RunExecutionService.ts ~L1230; EventSink.ts + ProjectionStore.ts write statev2.sqlite.
- Client: packages/client-runtime/src/state/orchestrationV2Projection.ts folds the stream; apps/web/src/components/ChatView.tsx renders visibleTurnItems.
- Approvals:
  1. The adapter emits runtime_request.updated + node.updated + turn_item.updated{approval_request|user_input_request}.
  2. The client sends `runtime-request.respond {requestId, decision: accept|acceptForSession|acceptAlways|decline|cancel, answers?}`.
  3. Path: Orchestrator → EffectOutbox → RuntimeRequestService → session.respondToRuntimeRequest.
- Checkpoints and diffs are T3's own hidden git refs of the local cwd (checkpointing/CheckpointStore.ts, orchestration-v2/CheckpointService.ts, CheckpointCaptureService.ts, CheckpointDiffQuery.ts).
  - Scope cwd = runtimePolicy.cwd ?? thread.worktreePath ?? process.cwd().
  - A run only reaches `completed` through the capture effect. A non-git cwd gives status "missing" and the run still completes.
  - Cloud consequence: the diff panel stays empty for remote edits unless the diff is applied locally. Only per-item file_change diffs render.

## 4. Remote / cloud / environment concepts
- An environment is one T3 server. "A project and its threads belong to one environment" (docs/internals/remote.md). Routes: direct, Tailscale (packages/tailscale), SSH (packages/ssh, which launches a whole remote T3 server), T3 Connect (apps/server/src/cloud/*, infra/relay: Cloudflare tunnel plus relay; relay never proxies app traffic).
- Contracts (contracts/src/environment.ts): ExecutionEnvironmentDescriptor, ExecutionEnvironmentCapabilities (~45 flags), ThreadEnvMode "local"|"worktree", RepositoryIdentity {canonicalKey, locator{remoteUrl}, owner, name}. RepositoryIdentity is how a project maps to a GitHub repo for a cloud task.
- No managed sandboxes and no thread-on-another-machine concept. "cloud" in ENVIRONMENT_MACHINE_KINDS is only an icon kind.
- workspaceStrategy (contracts/src/orchestrationV2.ts:520): {type:"root", branch?} | {type:"existing_worktree", worktreePath} | {type:"worktree", baseRef, branch?, startFromOrigin?}. Used by ThreadLaunchService, ScheduledTask and t3_thread_launch.
- AppThread has projectId, branch, worktreePath; there is no host/environment field.
- Worktree handoff (mcp/WorktreeMcpService.ts, t3_worktree_handoff): thread.metadata.update re-points the workspace, detaches the live session and queues a continuation prompt. This is the pattern for "move thread to cloud and back".
- Native session import (apps/server/src/ws.ts ~L1419-1525): threadLaunch.launch({workspaceStrategy:{type:"root"}, importedNativeThread:{ref:{driver, nativeId, strength:"strong"}, metadata}}) gives a deterministic thread id bound to a native session. Also project/AgentSessionScanner.ts + AgentSessionImporter.ts import local Claude/Codex transcripts.
- delegate_task (mcp/OrchestratorMcpService.ts:1953) dispatches delegated_task.request. Child threads inherit the parent's project, branch and worktreePath (provider-core/src/server/subagentProjection.ts). Tracked as OrchestrationV2Subagent {origin: provider_native|app_owned, nativeTaskRef, status, result}. Related tools: task_status, task_cancel, create_threads, t3_thread_launch/send/wait/read. A cloud task fits origin:"provider_native".
- Cursor (packages/provider-cursor, @cursor/sdk 1.0.35) is hard-wired to runtime:"local". docs/user/cursor.md: "Cursor cloud agents need repository and cloud-environment configuration that T3 Code does not expose yet."
- No hits for teleport, codex cloud, cloud task, remote session, background agent or claude.ai/code.
- docs/user/outside-agents.md: hosted agents can drive T3 over /mcp through the T3 Connect address (reverse direction).

## 5. Extension points without forking: the ACP Registry "Local ACP command"
- Driver kind `acpRegistry` (packages/provider-acp-registry/src/server/{driver,adapter,AcpRegistrySupport}.ts). supportsMultipleInstances:true, hasDefaultInstance:false.
- UI: Settings → Providers → Add provider → Local ACP command.
- AcpRegistrySettings (src/settings.ts), the `config` blob:
    { source: "registry"|"local" = "registry"; enabled = true; agentId = ""; commandPath = ""; commandArgs: string[] = [];
      authMethodId = "" (only type:"agent" methods work headless); distribution: auto|binary|npx|uvx; customModels: string[] = [] }
- Spawn (AcpRegistrySupport.ts ~L1773): {command: resolveExecutable(commandPath), args: commandArgs, cwd: thread cwd, env: host env + instance environment, shell:false}. Windows rejects .cmd/.bat: point commandPath at node.exe and put the script in commandArgs.
- Example entry:
    "codexCloud": {"driver":"acpRegistry","displayName":"Codex Cloud",
      "environment":[{"name":"CLOUD_BACKEND","value":"codex-cloud"}],
      "config":{"source":"local","commandPath":"C:/…/node.exe","commandArgs":["C:/…/cloud-acp/index.js","--backend","codex-cloud"]}}
- What T3 gives the agent:
  - cwd, so the agent can read the git remote and branch to pick the cloud repo
  - its MCP server in session/new.mcpServers (stdio `t3 acp-mcp-bridge` with env T3_ACP_MCP_ENDPOINT / T3_ACP_MCP_AUTHORIZATION; provider-acp adapter.ts ~L690)
  - client fs/terminal capabilities: off
- What T3 renders from ACP:
  - agent_message_chunk, agent_thought_chunk
  - tool_call / tool_call_update (kind execute|read|edit|delete|move)
  - diff content becomes a file_change with patch text: ACP v2 {type:"diff", changes:[{operation,path}], patch:{text}}, v1 {path, oldText, newText} (adapter.ts ~L900-960)
  - plan → todo list; usage_update → context meter and cost; session_info_update → title
  - available_commands_update → `/` and `$` menus; config_option_update / current_mode_update → composer option menus
  - session/request_permission → approval answered by the thread's permission mode
  - URL elicitation → browser sign-in
- Capabilities T3 assumes for ACP (AcpProviderCapabilitiesV2, adapter.ts:540): interrupt yes; steering by interrupt+restart; queued messages yes; no snapshot read; no fork; rollback restores files and starts a fresh session.
- Native sessions: if initialize advertises sessionCapabilities.list plus loadSession or sessionCapabilities.resume, the provider card offers List sessions → Import (session/load replays history). This is how to attach existing Codex Cloud tasks or claude.ai sessions.
- Probe: status refresh opens a disposable session/new (successful probes cached 15 min, driver.ts PROBE_SUCCESS_TTL_MS). Keep session/new lazy and create the cloud task on the first session/prompt.
- Limits: no T3 text generation (titles, commit messages, PR text) from ACP instances; local-cwd checkpoints only.
- Dedicated ACP flavor precedent (needs a fork): Antigravity (provider/AntigravityProvider.ts, Drivers/AntigravityDriver.ts, provider/acp/*). The user already has the registry antigravity-acp agent under ~/.t3/tools.

## Recommendation
1. Build `cloud-acp`, a Node ACP agent. Implement initialize; session/new (lazy); session/prompt (create the task or send a follow-up, then poll and stream as session/update); session/cancel; session/list and session/load (cloud task list and replay); and session/set_config_option for environment, branch and apply-diff-locally.
   - Register one acpRegistry instance per backend (source "local").
   - Emit the final diff as an `edit` tool_call with diff content.
   - Optionally `git apply` it into the cwd so T3's checkpoint, diff panel and PR flow work.
2. Fork only for first-class remote diffs, task or PR badges, or a new workspaceStrategy {type:"cloud"}. Use provider-pi or provider-muse as the template. Report capabilities honestly (appCanCheckpointFilesystem:false). ProviderSession.cwd must be non-empty.
