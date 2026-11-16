import {
  detectClaudeCode,
  detectCodex,
  detectGrok,
  readCodexConfiguredReasoningEffort,
  readCodexConfiguredMcpServerNames,
} from './detect';
import { CLAUDE_NATIVE_CHAT_ALLOWED_TOOLS } from './native-tool-capabilities';
import { codexCliEnv, grokCliEnv, subprocessEnv } from './subprocess-env';
import {
  prepareManagedAgentProcessConfinement,
  type AgentProcessConfinement,
} from './agent-process-confinement';
import { spawn } from 'node:child_process';
import { proteinExperimentRendererForTurn } from '../protein-experiment-workers';
import {
  buildClaudeMcpServers,
  buildCliMcpServerLaunch,
  buildCodexMcpConfig,
  buildCodexMcpIsolationConfig,
  CODEX_APP_MCP_FEATURES,
  buildGrokMcpServer,
  DNAFORGE_MCP_TOOL_PREFIX,
  type CliMcpServerLaunch,
  isDnaForgeMcpTool,
  listDnaForgeMcpToolNames,
  type CliMcpBridgeConfig,
} from './cli-mcp';
import { livenessFailureMessage, proveCliMcpToolsReachable } from './cli-mcp-liveness';
import { requiredWorkspaceToolNames } from './required-workspace-tools';
import {
  ClaudeTraceAdapter,
  CodexTraceAdapter,
  type ProviderTraceAdapter,
  type ProviderTraceEvent,
} from './trace-adapter';
import { createDestructiveFilePreToolUseHook } from './destructive-file-guard';
import {
  createCodexPermissionHookBridge,
  type CodexPermissionHookBridge,
} from './codex-permission-hook-bridge';
import type { DestructiveFileConfirmRequest } from '../../shared/agent-confirm-types';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { RequestAgentUserInput } from './agent-user-input-adapters';
import { answerClaudeAskUserQuestion, answerClaudePlanDecision } from './agent-user-input-adapters';
import type { AgentShellSupervision } from '../../shared/agent-runtime-ipc';
import {
  claudeSessionPermissionMode,
  codexProfile,
  dnaforgeSupervision,
  type ResolvedAgentPermissions,
} from '../../shared/agent-permissions';
import type { AgentToolExposure } from '../../shared/agent-runtime-ipc';
import { DNAFORGE_CLI_SYSTEM_PROMPT } from '../../shared/ai-reference-system-prompt';
import type { AgentCapabilityControl } from '../../shared/agent-capability-controls';
import {
  resolveClaudePluginInstallPath,
  resolveGrokPluginInstallPath,
  resolveGrokSkillSourcePath,
  resolveGrokSkillSourcePaths,
} from '../agent-capabilities/provider-operations';
import { isCodexModelSupportedForAuth, type CodexAuthMode } from '../../shared/codex-model-support';
import {
  appServerNotificationAsCodexSdkEvent,
  launchLocalCodexAppServer,
  runLocalCodexAppServerTurn,
} from './local-codex-app-server';
import { collectCodexModelCatalog, validateModelSelection } from './model-catalog';
import { createGrokSessionTraceProjector, openGrokAcpClient, runGrokAcpTurn } from './grok-acp';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export { DNAFORGE_CLI_SYSTEM_PROMPT } from '../../shared/ai-reference-system-prompt';

const MCP_TOOL_PROOF_TIMEOUT_MS = 20_000;
const MIN_MCP_LIVENESS_WINDOW_MS = 1_000;

function remainingMcpProofMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

export type CliPermissionMode = 'app-supervised' | 'native-cli';
export type CliModelReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';

export interface QueryResult {
  transport: 'claude-agent-sdk' | 'codex-sdk' | 'grok-acp';
  ok: boolean;
  text: string;
  error?: string;
  failureReason?: 'admission_rejected';
  durationMs: number;
  stopState?: 'completed' | 'failed' | 'cancelled' | 'stop_requested';
  providerConversationId?: string;
}

export interface QueryOptions {
  purpose?: 'probe' | 'chat';
  binaryPathOverride?: string;
  cwd?: string | null;
  queryId?: string;
  conversationId?: string | null;
  turnId?: string;
  providerConversationId?: string;
  molecularTrialAuthor?: true;
  emitTrace?: boolean;
  permissionMode?: CliPermissionMode;
  shellSupervision?: AgentShellSupervision;
  permissions?: ResolvedAgentPermissions;
  additionalAgentInstructions?: string;
  runtimeAgentInstructions?: string;
  model?: string | null;
  modelReasoningEffort?: CliModelReasoningEffort | null;
  modelServiceTier?: string | null;
  modelPersonality?: string | null;
  selectedCapability?: AgentCapabilityControl | null;
  enabledNativeSkillIds?: readonly string[];
  disabledNativeSkillIds?: readonly string[];
  portableSkills?: readonly { name: string; sourcePath: string }[];
  toolExposure?: AgentToolExposure;
  abortController?: AbortController;
  cliMcpBridge?: CliMcpBridgeConfig | null;
  workspaceGrounding?: 'required' | 'not-required';
  traceSink?: (event: ProviderTraceEvent) => void;
  userRoots?: readonly string[];
  scratchRoot?: string;
  writableRoots?: readonly string[];
  confirmDestructiveFile?: (
    request: Omit<DestructiveFileConfirmRequest, 'requestId'>,
    signal?: AbortSignal
  ) => Promise<import('../../shared/agent-approval').AgentApprovalChoice>;
  approvalMemory?: import('./approval-memory').ApprovalMemory | null;
  approvalRoots?: readonly import('./approval-rules').ApprovalRoot[];
  requestUserInput?: RequestAgentUserInput;
}

function isAbortLikeError(err: unknown): boolean {
  if (err instanceof Error) {
    return (
      err.name === 'AbortError' ||
      err.message.toLowerCase().includes('abort') ||
      err.message.toLowerCase().includes('operation was aborted')
    );
  }
  return false;
}

function stoppedResult(
  transport: QueryResult['transport'],
  startedAt: number,
  providerConversationId?: string
): QueryResult {
  return {
    transport,
    ok: false,
    text: '',
    error: 'Stop requested.',
    durationMs: Date.now() - startedAt,
    stopState: 'stop_requested',
    ...(providerConversationId ? { providerConversationId } : {}),
  };
}

function missingCliBridgeResult(
  transport: QueryResult['transport'],
  startedAt: number
): QueryResult {
  return {
    transport,
    ok: false,
    text: '',
    error:
      'DNAForge CLI tool bridge is not available yet. Restart the app and wait for the analysis engine to finish starting.',
    durationMs: Date.now() - startedAt,
  };
}

async function proveChatToolsOrFail(
  transport: QueryResult['transport'],
  mcpLaunch: CliMcpServerLaunch,
  startedAt: number,
  expectedToolNames: readonly string[],
  abortController: AbortController | undefined,
  deadlineMs: number
): Promise<QueryResult | null> {
  if (abortController?.signal.aborted) {
    return stoppedResult(transport, startedAt);
  }
  const remainingMs = remainingMcpProofMs(deadlineMs);
  if (remainingMs < MIN_MCP_LIVENESS_WINDOW_MS) {
    console.error(
      `[agent-sdk] DNAForge tool preflight deadline exhausted before stdio liveness for ${transport}`
    );
    return {
      transport,
      ok: false,
      text: '',
      error:
        'I could not reach this project, so I cannot answer questions about what is in it. The DNAForge tool check timed out while reading the authorized catalog, before the app could test the tool server. Retry the message; if it keeps happening, restart the app and report the bug.',
      durationMs: Date.now() - startedAt,
    };
  }
  const proof = await proveCliMcpToolsReachable(mcpLaunch, {
    requiredToolNames: requiredWorkspaceToolNames(),
    expectedToolNames,
    abortSignal: abortController?.signal,
    timeoutMs: remainingMs,
  });
  if (abortController?.signal.aborted || (!proof.ok && proof.reason === 'aborted')) {
    return stoppedResult(transport, startedAt);
  }
  if (proof.ok) {
    console.info(
      `[agent-sdk] DNAForge MCP catalog parity PASS for ${transport}: tools=${proof.toolNames.length}`
    );
    return null;
  }

  console.error(
    `[agent-sdk] DNAForge tool liveness proof FAILED (${proof.reason}) for ${transport}: ${proof.detail}` +
      (proof.missingToolNames?.length ? ` missing=${proof.missingToolNames.join(',')}` : '') +
      (proof.unexpectedToolNames?.length
        ? ` unexpected=${proof.unexpectedToolNames.join(',')}`
        : '')
  );
  return {
    transport,
    ok: false,
    text: '',
    error: livenessFailureMessage(proof),
    durationMs: Date.now() - startedAt,
  };
}

function emitTraceEvent(
  adapter: ProviderTraceAdapter,
  raw: unknown,
  sequence: number,
  events: ProviderTraceEvent[],
  sink: QueryOptions['traceSink']
): number {
  const event = adapter.adapt(raw, sequence);
  events.push(event);
  sink?.(event);
  return sequence + 1;
}

function failedTraceEvent(events: ProviderTraceEvent[]): ProviderTraceEvent | null {
  const turnTerminals = events.filter(
    (event) =>
      event.terminal !== undefined &&
      (event.providerEventType === 'turn.completed' ||
        event.providerEventType === 'turn.failed' ||
        event.providerEventType === 'result' ||
        event.providerEventType.startsWith('result.'))
  );
  const terminal = turnTerminals.at(-1);
  if (terminal?.terminal === 'completed') return null;
  if (terminal?.terminal === 'failed') return terminal;

  return events.find((event) => event.display.kind === 'error') ?? null;
}

function mcpBridgeForQuery(options: QueryOptions): CliMcpBridgeConfig | null {
  if (options.toolExposure === 'none') return null;
  if (!options.cliMcpBridge) return null;
  return {
    ...options.cliMcpBridge,
    ...((options.turnId ?? options.queryId) ? { turnId: options.turnId ?? options.queryId } : {}),
  };
}

function toolExposureForQuery(options: QueryOptions): AgentToolExposure {
  return options.toolExposure ?? 'auto';
}

function requiresToolPreflight(options: QueryOptions): boolean {
  return toolExposureForQuery(options) === 'required';
}

function cleanModelOverride(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed || undefined;
}

const SAFE_NATIVE_SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,159}$/;

function uniqueNativeSkillIds(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])]
    .filter((value) => SAFE_NATIVE_SKILL_ID.test(value) && !value.includes('..'))
    .sort((left, right) => left.localeCompare(right));
}

function uniquePortableSkills(
  values: readonly { name: string; sourcePath: string }[] | undefined
): Array<{ name: string; sourcePath: string }> {
  const byName = new Map<string, { name: string; sourcePath: string }>();
  for (const value of values ?? []) {
    if (!byName.has(value.name)) byName.set(value.name, value);
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function resolveCodexModelOverride(
  model: string | null | undefined,
  authMode: CodexAuthMode | undefined
): { model: string | undefined; ignored: string | undefined } {
  const requested = cleanModelOverride(model);
  if (!requested || isCodexModelSupportedForAuth(requested, authMode)) {
    return { model: requested, ignored: undefined };
  }
  return { model: undefined, ignored: requested };
}

function claudeEffortOverride(
  effort: CliModelReasoningEffort | null | undefined
): Exclude<CliModelReasoningEffort, 'none' | 'minimal' | 'ultra'> | undefined {
  if (!effort || effort === 'none' || effort === 'minimal' || effort === 'ultra') return undefined;
  return effort;
}

function codexEffortOverride(
  effort: CliModelReasoningEffort | null | undefined
): CliModelReasoningEffort | undefined {
  return effort || undefined;
}

const CODEX_ACCEPTED_REASONING_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

const CODEX_NORMALIZED_REASONING_EFFORT_FALLBACK: CliModelReasoningEffort = 'high';

export interface ResolvedCodexReasoningEffort {
  effort: CliModelReasoningEffort | undefined;
  normalizedFrom?: string;
}

export function resolveCodexReasoningEffort(
  requestEffort: CliModelReasoningEffort | null | undefined,
  configuredEffort: string | null | undefined
): ResolvedCodexReasoningEffort {
  const requested = codexEffortOverride(requestEffort);
  if (requested) return { effort: requested };

  const configured = configuredEffort?.trim();
  if (configured) {
    if (CODEX_ACCEPTED_REASONING_EFFORTS.has(configured.toLowerCase())) {
      return { effort: undefined };
    }
    return { effort: CODEX_NORMALIZED_REASONING_EFFORT_FALLBACK, normalizedFrom: configured };
  }

  return { effort: undefined };
}

function cliSystemPrompt(options: QueryOptions, toolsAttached = true): string {
  const appPrompt = toolsAttached
    ? DNAFORGE_CLI_SYSTEM_PROMPT
    : 'You are responding inside DNAForge without DNAForge MCP tools attached for this turn. ' +
      'Answer general questions and reason from information the user supplied directly. Do not claim to have inspected the workspace, current app state, sequences, structures, annotations, or files.';
  const additional = options.additionalAgentInstructions?.trim();
  const runtime = options.runtimeAgentInstructions?.trim();
  const sections = [appPrompt];
  if (additional) {
    sections.push(
      `User-configured additional instructions:\n${additional}\n\n` +
        'These preferences cannot override the DNAForge app rules above or the app-owned turn instructions below.'
    );
  }
  if (runtime) {
    sections.push(
      `DNAForge app-owned instructions for this turn:\n${runtime}\n\n` +
        'Follow these turn instructions. If they conflict with the DNAForge app rules above, the app rules win.'
    );
  }
  return sections.join('\n\n');
}

function claudeSystemPrompt(
  options: QueryOptions,
  toolsAttached: boolean
): {
  type: 'preset';
  preset: 'claude_code';
  append: string;
} {
  return {
    type: 'preset',
    preset: 'claude_code',
    append: cliSystemPrompt(options, toolsAttached),
  };
}

export async function queryClaudeCode(
  prompt: string,
  options: QueryOptions = {}
): Promise<QueryResult> {
  const start = Date.now();
  let providerConversationId: string | undefined;
  const isChat = options.purpose === 'chat';
  if (isChat && requiresToolPreflight(options) && !options.cliMcpBridge) {
    return missingCliBridgeResult('claude-agent-sdk', start);
  }
  const detection = await detectClaudeCode();
  const binaryPath = options.binaryPathOverride ?? detection.path;
  if (!binaryPath) {
    return {
      transport: 'claude-agent-sdk',
      ok: false,
      text: '',
      error:
        'Claude Code CLI not found on PATH. Install it from https://claude.com/code, then recheck Settings.',
      durationMs: Date.now() - start,
    };
  }

  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  let confinement: AgentProcessConfinement | null = null;
  try {
    confinement = await prepareManagedAgentProcessConfinement({
      provider: 'claude',
      runtimeExecutable: binaryPath,
      cwd: options.cwd,
      writableRoots: options.writableRoots,
      purpose: options.purpose,
      env: subprocessEnv('claude'),
      authorityReadPaths: options.cliMcpBridge?.sessionAuthority
        ? [options.cliMcpBridge.sessionAuthority.path]
        : [],
    });
    options = { ...options, cwd: confinement.cwd, scratchRoot: confinement.scratchRoot };
    const assistantText: string[] = [];
    const resultText: string[] = [];
    const traceEvents: ProviderTraceEvent[] = [];
    const traceAdapter = new ClaudeTraceAdapter({ sdkVersion: null, cliVersion: null });
    let traceSequence = 0;
    const mcpBridge = isChat ? mcpBridgeForQuery(options) : null;
    const mcpLaunch = mcpBridge ? buildCliMcpServerLaunch(mcpBridge) : null;
    const mcpProofDeadline = Date.now() + MCP_TOOL_PROOF_TIMEOUT_MS;
    const discoveredMcpTools =
      mcpLaunch && requiresToolPreflight(options)
        ? await listDnaForgeMcpToolNames(mcpBridge!, {
            signal: options.abortController?.signal,
            timeoutMs: remainingMcpProofMs(mcpProofDeadline),
          })
        : [];
    const allowedMcpTools = requiresToolPreflight(options)
      ? discoveredMcpTools.map((name) => `${DNAFORGE_MCP_TOOL_PREFIX}${name}`)
      : mcpLaunch
        ? [`${DNAFORGE_MCP_TOOL_PREFIX}*`]
        : [];
    if (mcpLaunch && requiresToolPreflight(options) && discoveredMcpTools.length === 0) {
      throw new Error('DNAForge CLI tool bridge did not advertise any MCP tools.');
    }
    if (mcpLaunch && requiresToolPreflight(options)) {
      const failed = await proveChatToolsOrFail(
        'claude-agent-sdk',
        mcpLaunch,
        start,
        discoveredMcpTools,
        options.abortController,
        mcpProofDeadline
      );
      if (failed) return failed;
    }
    const permissionMode = options.permissionMode ?? 'native-cli';
    const modelOverride = cleanModelOverride(options.model);
    const effortOverride = claudeEffortOverride(options.modelReasoningEffort);
    const selectedClaudeCapability =
      options.selectedCapability?.provider === 'claude-agent-sdk'
        ? options.selectedCapability
        : null;
    const selectedPluginPath =
      selectedClaudeCapability?.kind === 'plugin'
        ? await resolveClaudePluginInstallPath(
            selectedClaudeCapability.nativeId,
            options.cwd ?? null
          )
        : null;
    const selectedNativeSkill =
      selectedClaudeCapability?.kind === 'skill' &&
      !selectedClaudeCapability.source?.startsWith('dnaforge-skill:')
        ? selectedClaudeCapability.nativeId
        : null;
    const enabledClaudeSkills = uniqueNativeSkillIds([
      ...(options.enabledNativeSkillIds ?? []),
      ...(selectedNativeSkill ? [selectedNativeSkill] : []),
    ]);
    const loadSelectedClaudeSettings =
      selectedClaudeCapability?.kind === 'command' || enabledClaudeSkills.length > 0;
    const claudeMode = options.permissions?.claude ?? 'default';
    const fullAccess = permissionMode === 'native-cli' && claudeMode === 'bypassPermissions';
    const destructiveGuardHook =
      !fullAccess && options.confirmDestructiveFile && options.scratchRoot
        ? createDestructiveFilePreToolUseHook({
            cwd: options.cwd ?? null,
            userRoots: options.userRoots ?? [],
            scratchRoot: options.scratchRoot,
            shellSupervision: options.shellSupervision ?? 'always',
            askBeforeWrites: options.permissions
              ? dnaforgeSupervision('claude', options.permissions).askBeforeWrites
              : false,
            conversationId: options.conversationId ?? null,
            approvalMemory: options.approvalMemory ?? null,
            approvalRoots: options.approvalRoots ?? [],
            onStop: () => options.abortController?.abort(),
            confirmDestructiveFile: options.confirmDestructiveFile,
          })
        : null;
    const chatOptions =
      permissionMode === 'native-cli'
        ? {
            cwd: options.cwd ?? undefined,
            abortController: options.abortController,
            permissionMode: claudeSessionPermissionMode(
              claudeMode,
              Boolean(options.requestUserInput)
            ) as PermissionMode,
            ...(fullAccess ? { allowDangerouslySkipPermissions: true } : {}),
            settingSources: loadSelectedClaudeSettings
              ? (['user', 'project', 'local'] as Array<'user' | 'project' | 'local'>)
              : ([] as []),
            ...(enabledClaudeSkills.length > 0 ? { skills: enabledClaudeSkills } : {}),
            ...(selectedPluginPath
              ? { plugins: [{ type: 'local' as const, path: selectedPluginPath }] }
              : {}),
            allowedTools: [
              ...CLAUDE_NATIVE_CHAT_ALLOWED_TOOLS,
              ...(mcpLaunch ? allowedMcpTools : []),
            ],
            ...(options.writableRoots?.length
              ? { additionalDirectories: [...options.writableRoots] }
              : {}),
            ...(modelOverride ? { model: modelOverride } : {}),
            ...(effortOverride ? { effort: effortOverride } : {}),
            ...(options.modelServiceTier === 'fast' || options.modelPersonality
              ? {
                  settings: {
                    ...(options.modelServiceTier === 'fast' ? { fastMode: true } : {}),
                    ...(options.modelPersonality ? { outputStyle: options.modelPersonality } : {}),
                  },
                }
              : {}),
            ...(mcpLaunch ? { mcpServers: buildClaudeMcpServers(mcpLaunch) } : {}),
            ...(options.requestUserInput
              ? {
                  canUseTool: async (
                    toolName: string,
                    input: Record<string, unknown>,
                    permissionOptions: { signal: AbortSignal }
                  ) =>
                    toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode'
                      ? (toolName === 'AskUserQuestion'
                          ? answerClaudeAskUserQuestion
                          : answerClaudePlanDecision)({
                          input,
                          conversationId: options.conversationId ?? null,
                          signal: permissionOptions.signal,
                          requestUserInput: options.requestUserInput as RequestAgentUserInput,
                        })
                      : {
                          behavior: 'deny' as const,
                          message: `DNAForge has no interactive adapter for ${toolName}.`,
                        },
                }
              : {}),
            ...(destructiveGuardHook
              ? { hooks: { PreToolUse: [{ hooks: [destructiveGuardHook] }] } }
              : {}),
          }
        : {
            cwd: options.cwd ?? undefined,
            abortController: options.abortController,
            permissionMode: options.requestUserInput ? ('default' as const) : ('dontAsk' as const),
            settingSources: loadSelectedClaudeSettings
              ? (['user', 'project', 'local'] as Array<'user' | 'project' | 'local'>)
              : ([] as []),
            ...(enabledClaudeSkills.length > 0 ? { skills: enabledClaudeSkills } : {}),
            ...(selectedPluginPath
              ? { plugins: [{ type: 'local' as const, path: selectedPluginPath }] }
              : {}),
            ...(modelOverride ? { model: modelOverride } : {}),
            ...(effortOverride ? { effort: effortOverride } : {}),
            ...(options.modelServiceTier === 'fast' || options.modelPersonality
              ? {
                  settings: {
                    ...(options.modelServiceTier === 'fast' ? { fastMode: true } : {}),
                    ...(options.modelPersonality ? { outputStyle: options.modelPersonality } : {}),
                  },
                }
              : {}),
            ...(mcpLaunch
              ? {
                  allowedTools: allowedMcpTools,
                  mcpServers: buildClaudeMcpServers(mcpLaunch),
                  canUseTool: async (
                    toolName: string,
                    input: Record<string, unknown>,
                    permissionOptions: { signal: AbortSignal }
                  ) =>
                    (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') &&
                    options.requestUserInput
                      ? (toolName === 'AskUserQuestion'
                          ? answerClaudeAskUserQuestion
                          : answerClaudePlanDecision)({
                          input,
                          conversationId: options.conversationId ?? null,
                          signal: permissionOptions.signal,
                          requestUserInput: options.requestUserInput,
                        })
                      : isDnaForgeMcpTool(toolName)
                        ? { behavior: 'allow' as const }
                        : {
                            behavior: 'deny' as const,
                            message:
                              'Only DNAForge app-supervised MCP tools are available in CLI mode.',
                          },
                }
              : {}),
          };
    mcpLaunch?.assertCurrent?.();
    for await (const message of query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: binaryPath,
        spawnClaudeCodeProcess: confinement.spawn,
        ...(isChat
          ? chatOptions
          : {
              settingSources: [],
              tools: [],
              cwd: confinement.cwd,
            }),
        ...(isChat ? { systemPrompt: claudeSystemPrompt(options, Boolean(mcpLaunch)) } : {}),
        ...(options.providerConversationId ? { resume: options.providerConversationId } : {}),
        env: subprocessEnv('claude'),
      },
    })) {
      if (options.emitTrace) {
        traceSequence = emitTraceEvent(
          traceAdapter,
          message,
          traceSequence,
          traceEvents,
          options.traceSink
        );
      }
      const m = message as {
        type?: string;
        message?: { content?: unknown };
        result?: string;
        session_id?: string;
      };
      if (typeof m.session_id === 'string' && m.session_id.trim().length > 0) {
        providerConversationId = m.session_id.trim();
      }
      if (m.type === 'assistant' && m.message?.content) {
        const content = m.message.content as Array<{ type?: string; text?: string }>;
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            assistantText.push(block.text);
          }
        }
      }
      if (m.type === 'result' && typeof m.result === 'string' && m.result.trim().length > 0) {
        resultText.push(m.result);
      }
    }

    if (options.abortController?.signal.aborted) {
      return stoppedResult(
        'claude-agent-sdk',
        start,
        providerConversationId ?? options.providerConversationId
      );
    }
    const failed = failedTraceEvent(traceEvents);
    if (failed) {
      return {
        transport: 'claude-agent-sdk',
        ok: false,
        text: '',
        error: failed.display.text ?? failed.display.title,
        durationMs: Date.now() - start,
        stopState: 'failed',
        ...(providerConversationId ? { providerConversationId } : {}),
      };
    }
    const text =
      options.emitTrace && traceEvents.length > 0
        ? traceAdapter.extractFinalText(traceEvents)
        : resultText.length > 0
          ? resultText.join('\n')
          : assistantText.join('\n');
    return {
      transport: 'claude-agent-sdk',
      ok: true,
      text: text.trim() || '(no text)',
      durationMs: Date.now() - start,
      stopState: 'completed',
      ...(providerConversationId ? { providerConversationId } : {}),
    };
  } catch (err) {
    if (options.abortController?.signal.aborted || isAbortLikeError(err)) {
      return stoppedResult(
        'claude-agent-sdk',
        start,
        providerConversationId ?? options.providerConversationId
      );
    }
    return {
      transport: 'claude-agent-sdk',
      ok: false,
      text: '',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
      stopState: 'failed',
      ...(providerConversationId ? { providerConversationId } : {}),
    };
  } finally {
    confinement?.dispose();
  }
}

export async function queryCodex(prompt: string, options: QueryOptions = {}): Promise<QueryResult> {
  const start = Date.now();
  let providerConversationId: string | undefined = options.providerConversationId;
  const isChat = options.purpose === 'chat';
  const privateRenderer = proteinExperimentRendererForTurn(options.turnId);
  const molecularTrialAuthor =
    options.molecularTrialAuthor === true || privateRenderer !== undefined;
  if (
    molecularTrialAuthor &&
    (!isChat ||
      !privateRenderer ||
      options.providerConversationId ||
      !options.requestUserInput ||
      !options.cliMcpBridge)
  ) {
    return {
      transport: 'codex-sdk',
      ok: false,
      text: '',
      error:
        'Fresh protein authors require a live private job, a new interactive Codex thread and the scoped DNAForge bridge. SDK fallback and prior threads are unavailable.',
      durationMs: Date.now() - start,
    };
  }
  if (isChat && requiresToolPreflight(options) && !options.cliMcpBridge) {
    return missingCliBridgeResult('codex-sdk', start);
  }
  const detection = await detectCodex();
  const binaryPath = options.binaryPathOverride ?? detection.path;
  if (!binaryPath) {
    return {
      transport: 'codex-sdk',
      ok: false,
      text: '',
      error:
        'Codex CLI not found on PATH. Install with `npm i -g @openai/codex` or `brew install --cask codex`, then recheck Settings.',
      durationMs: Date.now() - start,
    };
  }
  if (!options.binaryPathOverride && detection.auth === 'unauthenticated') {
    return {
      transport: 'codex-sdk',
      ok: false,
      text: '',
      error:
        'Codex is installed but not signed in. Sign in from Settings or run `codex login` in a terminal. Note: an OPENAI_API_KEY in your shell is not used for Codex — auth comes from your codex sign-in (or a key stored in the app).',
      durationMs: Date.now() - start,
    };
  }

  let codexPermissionBridge: CodexPermissionHookBridge | null = null;
  let confinement: AgentProcessConfinement | null = null;
  try {
    confinement = await prepareManagedAgentProcessConfinement({
      provider: 'codex',
      runtimeExecutable: binaryPath,
      cwd: options.cwd,
      writableRoots: options.writableRoots,
      purpose: options.purpose,
      env: codexCliEnv(),
      authorityReadPaths: options.cliMcpBridge?.sessionAuthority
        ? [options.cliMcpBridge.sessionAuthority.path]
        : [],
    });
    options = { ...options, cwd: confinement.cwd, scratchRoot: confinement.scratchRoot };
    const mcpBridge = isChat ? mcpBridgeForQuery(options) : null;
    const mcpLaunch = mcpBridge ? buildCliMcpServerLaunch(mcpBridge) : null;
    const mcpProofDeadline = Date.now() + MCP_TOOL_PROOF_TIMEOUT_MS;
    const discoveredMcpTools =
      mcpLaunch && requiresToolPreflight(options)
        ? await listDnaForgeMcpToolNames(mcpBridge!, {
            signal: options.abortController?.signal,
            timeoutMs: remainingMcpProofMs(mcpProofDeadline),
          })
        : [];
    if (mcpLaunch && requiresToolPreflight(options) && discoveredMcpTools.length === 0) {
      throw new Error('DNAForge CLI tool bridge did not advertise any MCP tools.');
    }
    if (mcpLaunch && requiresToolPreflight(options)) {
      const failed = await proveChatToolsOrFail(
        'codex-sdk',
        mcpLaunch,
        start,
        discoveredMcpTools,
        options.abortController,
        mcpProofDeadline
      );
      if (failed) return failed;
    }
    const { model: modelOverride, ignored: ignoredModelOverride } =
      isChat && options.requestUserInput
        ? { model: cleanModelOverride(options.model), ignored: undefined }
        : resolveCodexModelOverride(options.model, detection.authMode);
    if (ignoredModelOverride) {
      return {
        transport: 'codex-sdk',
        ok: false,
        text: '',
        error: `The selected Codex model "${ignoredModelOverride}" is not available with ChatGPT-account authentication. Choose an available model or the provider default, then try again.`,
        durationMs: Date.now() - start,
        failureReason: 'admission_rejected',
      };
    }
    const { effort: effortOverride, normalizedFrom } = resolveCodexReasoningEffort(
      options.modelReasoningEffort,
      await readCodexConfiguredReasoningEffort()
    );
    if (normalizedFrom) {
      console.warn(
        `[agent-sdk] ~/.codex/config.toml has model_reasoning_effort="${normalizedFrom}", which this codex CLI rejects. ` +
          `Overriding with "${effortOverride}" for this turn so it can start.`
      );
    }
    const codexPersonality =
      options.modelPersonality === 'none' ||
      options.modelPersonality === 'friendly' ||
      options.modelPersonality === 'pragmatic'
        ? options.modelPersonality
        : undefined;

    const inheritedMcpServerNames = isChat
      ? await readCodexConfiguredMcpServerNames(binaryPath, {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.abortController ? { signal: options.abortController.signal } : {}),
        })
      : [];
    const codexMcpConfig = isChat
      ? mcpLaunch
        ? buildCodexMcpConfig(mcpLaunch, inheritedMcpServerNames)
        : buildCodexMcpIsolationConfig(inheritedMcpServerNames)
      : {};

    if (isChat && options.requestUserInput) {
      const appServer = await launchLocalCodexAppServer({
        binaryPath,
        rootDir: options.scratchRoot ?? process.cwd(),
        spawn: (command, args, launchOptions) => {
          const invocation = confinement!.wrap(command, args, launchOptions.env);
          return spawn(invocation.command, invocation.args, {
            ...launchOptions,
            env: invocation.env,
          });
        },
        ...(molecularTrialAuthor ? { molecularTrialAuthor: true as const } : {}),
      });
      try {
        let liveModels: Awaited<ReturnType<typeof collectCodexModelCatalog>>;
        try {
          liveModels = appServer.protocol.client.includes('model/list')
            ? await collectCodexModelCatalog((method, params) =>
                appServer.supervisor.request(method, params)
              )
            : [];
        } catch (error) {
          console.warn(
            '[agent-sdk] Codex account model discovery failed before turn admission:',
            error
          );
          return {
            transport: 'codex-sdk',
            ok: false,
            text: '',
            error:
              'Models are unavailable for this account. Retry model discovery in the chat controls before sending.',
            durationMs: Date.now() - start,
            stopState: 'failed',
            failureReason: 'admission_rejected',
          };
        }
        mcpLaunch?.assertCurrent?.();
        const selectionError = validateModelSelection(
          liveModels,
          modelOverride,
          effortOverride,
          options.modelServiceTier,
          codexPersonality
        );
        if (selectionError) {
          return {
            transport: 'codex-sdk',
            ok: false,
            text: '',
            error: selectionError,
            failureReason: 'admission_rejected',
            durationMs: Date.now() - start,
            stopState: 'failed',
          };
        }
        const traceAdapter = new CodexTraceAdapter({ sdkVersion: null, cliVersion: null });
        const traceEvents: ProviderTraceEvent[] = [];
        let traceSequence = 0;
        const result = await runLocalCodexAppServerTurn({
          transport: {
            request: (method, params) => {
              if (
                method === 'thread/start' ||
                method === 'thread/resume' ||
                method === 'turn/start'
              ) {
                mcpLaunch?.assertCurrent?.();
              }
              return appServer.supervisor.request(method, params);
            },
            onNotification: (listener) => appServer.supervisor.setNotificationListener(listener),
            onServerRequest: (listener) => appServer.supervisor.setServerRequestHandler(listener),
            onExit: (listener) =>
              appServer.supervisor.onExit(() => listener(appServer.supervisor.terminationReason)),
            interrupt: () => appServer.supervisor.interrupt(),
          },
          message: prompt,
          cwd: options.cwd ?? process.cwd(),
          ...(options.writableRoots?.length ? { writableRoots: [...options.writableRoots] } : {}),
          conversationId: options.conversationId ?? null,
          ...((options.permissionMode ?? 'native-cli') === 'native-cli' && options.permissions
            ? { permissions: options.permissions }
            : {}),
          approvalMemory: options.approvalMemory ?? null,
          approvalRoots: options.approvalRoots ?? [],
          ...(options.providerConversationId
            ? { providerConversationId: options.providerConversationId }
            : {}),
          ...(modelOverride ? { model: modelOverride } : {}),
          ...(effortOverride ? { effort: effortOverride } : {}),
          ...(options.modelServiceTier ? { serviceTier: options.modelServiceTier } : {}),
          ...(codexPersonality ? { personality: codexPersonality } : {}),
          config: {
            ...codexMcpConfig,
            ...(uniqueNativeSkillIds(options.disabledNativeSkillIds).length > 0
              ? {
                  skills: {
                    config: uniqueNativeSkillIds(options.disabledNativeSkillIds).map((name) => ({
                      name,
                      enabled: false,
                    })),
                  },
                }
              : {}),
            features: {
              default_mode_request_user_input: true,
              exec_permission_approvals: true,
              apps: false,
              enable_mcp_apps: false,
              hooks: false,
              memories: false,
              external_agent_memory_import: false,
              plugins: false,
              recommended_plugins: false,
              remote_plugin: false,
              plugin_sharing: false,
              computer_use: false,
              browser_use: false,
              in_app_browser: false,
            },
          },
          developerInstructions: cliSystemPrompt(options, Boolean(mcpLaunch)),
          requiredMcpTools: discoveredMcpTools,
          requestUserInput: options.requestUserInput,
          ...(molecularTrialAuthor ? { molecularTrialAuthor: true as const } : {}),
          signal: options.abortController?.signal ?? new AbortController().signal,
          ...(options.emitTrace
            ? {
                onNotification: (notification: { method: string; params: unknown }) => {
                  traceSequence = emitTraceEvent(
                    traceAdapter,
                    appServerNotificationAsCodexSdkEvent(notification),
                    traceSequence,
                    traceEvents,
                    options.traceSink
                  );
                },
              }
            : {}),
        });
        providerConversationId = result.threadId;
        if (result.stopState === 'cancelled') {
          return {
            transport: 'codex-sdk',
            ok: false,
            text: result.text,
            error: result.error,
            durationMs: Date.now() - start,
            stopState: 'cancelled',
            providerConversationId,
          };
        }
        if (options.abortController?.signal.aborted || result.error === 'Stop requested.') {
          return stoppedResult('codex-sdk', start, providerConversationId);
        }
        if (!result.ok) {
          return {
            transport: 'codex-sdk',
            ok: false,
            text: '',
            error: result.error ?? 'The Codex turn failed.',
            durationMs: Date.now() - start,
            stopState: 'failed',
            providerConversationId,
          };
        }
        return {
          transport: 'codex-sdk',
          ok: true,
          text: result.text || '(no text)',
          durationMs: Date.now() - start,
          stopState: 'completed',
          providerConversationId,
        };
      } finally {
        await appServer.dispose();
      }
    }

    const { Codex } = await import('@openai/codex-sdk');
    const permissionMode = options.permissionMode ?? 'native-cli';
    const shellGuardHook =
      permissionMode === 'native-cli' &&
      (options.shellSupervision ?? 'always') !== 'auto' &&
      options.confirmDestructiveFile &&
      options.scratchRoot
        ? createDestructiveFilePreToolUseHook({
            cwd: options.cwd ?? null,
            userRoots: options.userRoots ?? [],
            scratchRoot: options.scratchRoot,
            shellSupervision: options.shellSupervision ?? 'always',
            conversationId: options.conversationId ?? null,
            approvalMemory: options.approvalMemory ?? null,
            approvalRoots: options.approvalRoots ?? [],
            onStop: () => options.abortController?.abort(),
            confirmDestructiveFile: options.confirmDestructiveFile,
          })
        : null;
    if (shellGuardHook) {
      codexPermissionBridge = await createCodexPermissionHookBridge({
        codexPath: binaryPath,
        baseEnv: codexCliEnv(),
        preToolUse: (input) => shellGuardHook(input),
      });
    }

    const codexConfig = {
      ...codexMcpConfig,
      ...(isChat ? { developer_instructions: cliSystemPrompt(options, Boolean(mcpLaunch)) } : {}),
      ...(codexPermissionBridge?.config ?? {}),
      ...(isChat
        ? { features: { ...codexPermissionBridge?.config.features, ...CODEX_APP_MCP_FEATURES } }
        : {}),
      ...(isChat && permissionMode === 'native-cli' && options.permissions
        ? { default_permissions: codexProfile(options.permissions.codex) }
        : {}),
    };
    const sdkEffortOverride =
      effortOverride === 'minimal' ||
      effortOverride === 'low' ||
      effortOverride === 'medium' ||
      effortOverride === 'high' ||
      effortOverride === 'xhigh'
        ? effortOverride
        : undefined;

    const confinedExecutable = confinement.executable(
      codexPermissionBridge?.codexPath ?? binaryPath,
      codexPermissionBridge?.env ?? codexCliEnv()
    );
    const codex = new Codex({
      codexPathOverride: confinedExecutable.path,
      env: confinedExecutable.env as Record<string, string>,
      ...(Object.keys(codexConfig).length > 0 ? { config: codexConfig } : {}),
    });
    const threadOptions =
      isChat && options.cwd
        ? permissionMode === 'native-cli'
          ? {
              workingDirectory: options.cwd,
              skipGitRepoCheck: true,
              ...(options.permissions ? {} : { sandboxMode: 'workspace-write' as const }),
              approvalPolicy: 'never' as const,
              ...(options.writableRoots?.length
                ? { additionalDirectories: [...options.writableRoots] }
                : {}),
              ...(modelOverride ? { model: modelOverride } : {}),
              ...(sdkEffortOverride ? { modelReasoningEffort: sdkEffortOverride } : {}),
            }
          : {
              workingDirectory: options.cwd,
              skipGitRepoCheck: true,
              sandboxMode: 'read-only' as const,
              approvalPolicy: 'never' as const,
              networkAccessEnabled: false,
              webSearchMode: 'disabled' as const,
              ...(modelOverride ? { model: modelOverride } : {}),
              ...(sdkEffortOverride ? { modelReasoningEffort: sdkEffortOverride } : {}),
            }
        : undefined;
    const thread = options.providerConversationId
      ? codex.resumeThread(options.providerConversationId, threadOptions)
      : codex.startThread(threadOptions);
    const turnOptions = options.abortController
      ? { signal: options.abortController.signal }
      : undefined;
    const traceEvents: ProviderTraceEvent[] = [];
    let result: unknown;
    mcpLaunch?.assertCurrent?.();
    if (options.emitTrace) {
      const traceAdapter = new CodexTraceAdapter({ sdkVersion: null, cliVersion: null });
      let traceSequence = 0;
      const streamed = await thread.runStreamed(prompt, turnOptions);
      for await (const event of streamed.events) {
        traceSequence = emitTraceEvent(
          traceAdapter,
          event,
          traceSequence,
          traceEvents,
          options.traceSink
        );
      }
      providerConversationId = thread.id ?? providerConversationId;
      const failed = failedTraceEvent(traceEvents);
      if (failed) {
        return {
          transport: 'codex-sdk',
          ok: false,
          text: '',
          error: failed.display.text ?? failed.display.title,
          durationMs: Date.now() - start,
          stopState: 'failed',
          ...(providerConversationId ? { providerConversationId } : {}),
        };
      }
      result = { finalResponse: traceAdapter.extractFinalText(traceEvents) };
    } else {
      result = await thread.run(prompt, turnOptions);
      providerConversationId = thread.id ?? providerConversationId;
    }
    if (options.abortController?.signal.aborted) {
      return stoppedResult('codex-sdk', start, providerConversationId);
    }
    const text =
      typeof result === 'string'
        ? result
        : typeof (result as { finalResponse?: unknown }).finalResponse === 'string'
          ? (result as { finalResponse: string }).finalResponse
          : JSON.stringify(result);
    return {
      transport: 'codex-sdk',
      ok: true,
      text: text.trim() || '(no text)',
      durationMs: Date.now() - start,
      stopState: 'completed',
      ...(providerConversationId ? { providerConversationId } : {}),
    };
  } catch (err) {
    if (options.abortController?.signal.aborted || isAbortLikeError(err)) {
      return stoppedResult('codex-sdk', start, providerConversationId);
    }
    return {
      transport: 'codex-sdk',
      ok: false,
      text: '',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
      stopState: 'failed',
      ...(providerConversationId ? { providerConversationId } : {}),
    };
  } finally {
    try {
      await codexPermissionBridge?.close();
    } finally {
      confinement?.dispose();
    }
  }
}

export async function queryGrok(prompt: string, options: QueryOptions = {}): Promise<QueryResult> {
  const start = Date.now();
  const isChat = options.purpose === 'chat';
  let providerConversationId = options.providerConversationId;
  if (isChat && requiresToolPreflight(options) && !options.cliMcpBridge) {
    return missingCliBridgeResult('grok-acp', start);
  }

  const detection = await detectGrok();
  const binaryPath = options.binaryPathOverride ?? detection.path;
  if (!binaryPath) {
    return {
      transport: 'grok-acp',
      ok: false,
      text: '',
      error:
        'Grok Build not found on PATH. Install it, then recheck Settings or set DNAFORGE_GROK_PATH to its absolute path.',
      durationMs: Date.now() - start,
    };
  }
  if (!options.binaryPathOverride && detection.auth === 'unauthenticated') {
    return {
      transport: 'grok-acp',
      ok: false,
      text: '',
      error:
        'Grok Build is installed but not signed in. Sign in from Settings or run `grok login --oauth`. An XAI_API_KEY in your shell is not used for Grok Build turns.',
      durationMs: Date.now() - start,
    };
  }

  let opened: ReturnType<typeof openGrokAcpClient> | null = null;
  let confinement: AgentProcessConfinement | null = null;
  try {
    confinement = await prepareManagedAgentProcessConfinement({
      provider: 'grok',
      runtimeExecutable: binaryPath,
      cwd: options.cwd,
      writableRoots: options.writableRoots,
      purpose: options.purpose,
      env: grokCliEnv(),
      authorityReadPaths: options.cliMcpBridge?.sessionAuthority
        ? [options.cliMcpBridge.sessionAuthority.path]
        : [],
    });
    options = { ...options, cwd: confinement.cwd, scratchRoot: confinement.scratchRoot };
    const mcpBridge = isChat ? mcpBridgeForQuery(options) : null;
    const mcpLaunch = mcpBridge ? buildCliMcpServerLaunch(mcpBridge) : null;
    const mcpProofDeadline = Date.now() + MCP_TOOL_PROOF_TIMEOUT_MS;
    const discoveredMcpTools =
      mcpLaunch && requiresToolPreflight(options)
        ? await listDnaForgeMcpToolNames(mcpBridge!, {
            signal: options.abortController?.signal,
            timeoutMs: remainingMcpProofMs(mcpProofDeadline),
          })
        : [];
    if (mcpLaunch && requiresToolPreflight(options) && discoveredMcpTools.length === 0) {
      throw new Error('DNAForge CLI tool bridge did not advertise any MCP tools.');
    }
    if (mcpLaunch && requiresToolPreflight(options)) {
      const failed = await proveChatToolsOrFail(
        'grok-acp',
        mcpLaunch,
        start,
        discoveredMcpTools,
        options.abortController,
        mcpProofDeadline
      );
      if (failed) return failed;
    }

    const selectedGrokCapability =
      options.selectedCapability?.provider === 'grok-acp' ? options.selectedCapability : null;
    const selectedPluginPath =
      selectedGrokCapability?.kind === 'plugin'
        ? await resolveGrokPluginInstallPath(selectedGrokCapability.nativeId, options.cwd ?? null)
        : null;
    const selectedSkillPath =
      selectedGrokCapability?.kind === 'skill' &&
      selectedGrokCapability.source === 'grok-inspect-skills'
        ? await resolveGrokSkillSourcePath(selectedGrokCapability.nativeId, options.cwd ?? null)
        : null;
    const portableGrokSkills = uniquePortableSkills(options.portableSkills).filter(
      (skill) => skill.name !== selectedGrokCapability?.nativeId
    );
    const portableGrokSkillNames = new Set(portableGrokSkills.map((skill) => skill.name));
    const automaticGrokSkillIds = uniqueNativeSkillIds(options.enabledNativeSkillIds).filter(
      (nativeId) =>
        nativeId !== selectedGrokCapability?.nativeId && !portableGrokSkillNames.has(nativeId)
    );
    const automaticGrokSkills =
      automaticGrokSkillIds.length > 0
        ? await resolveGrokSkillSourcePaths(automaticGrokSkillIds, options.cwd ?? null)
        : [];
    const selectedSkills = [
      ...portableGrokSkills.map((skill) => ({
        nativeId: skill.name,
        sourcePath: skill.sourcePath,
      })),
      ...automaticGrokSkills,
      ...(selectedSkillPath
        ? [
            {
              nativeId: selectedGrokCapability!.nativeId,
              sourcePath: selectedSkillPath,
            },
          ]
        : []),
    ];

    let sequence = 0;
    const grokTrace = createGrokSessionTraceProjector({
      sdkVersion: '1.4.0',
      cliVersion: null,
    });
    mcpLaunch?.assertCurrent?.();
    opened = openGrokAcpClient({
      binaryPath,
      processConfinement: confinement,
      cwd: options.cwd ?? process.cwd(),
      permissionMode: options.permissionMode ?? 'native-cli',
      ...(options.permissions ? { grokMode: options.permissions.grok } : {}),
      ...(cleanModelOverride(options.model) ? { model: cleanModelOverride(options.model) } : {}),
      ...(options.modelReasoningEffort ? { reasoningEffort: options.modelReasoningEffort } : {}),
      systemPrompt: cliSystemPrompt(options, Boolean(mcpLaunch)),
      mcpUserInputBridge: Boolean(mcpLaunch),
      runtimeRoot: join(options.scratchRoot ?? tmpdir(), 'dnaforge-grok-runtime'),
      ...(selectedPluginPath ? { pluginDirectories: [selectedPluginPath] } : {}),
      ...(selectedSkills.length > 0 ? { selectedSkills } : {}),
      conversationId: options.conversationId ?? null,
      approvalMemory: options.approvalMemory ?? null,
      approvalRoots: options.approvalRoots ?? [],
      signal: options.abortController?.signal ?? new AbortController().signal,
      requestUserInput:
        options.requestUserInput ?? (async () => ({ outcome: 'cancelled' as const, answers: {} })),
    });
    const result = await runGrokAcpTurn({
      rpc: opened.rpc,
      registerUpdateSink: opened.registerUpdateSink,
      cwd: options.cwd ?? process.cwd(),
      prompt,
      ...(mcpLaunch
        ? {
            mcpServer: buildGrokMcpServer(mcpLaunch, opened.mcpUserInputHandoff),
            assertMcpCurrent: mcpLaunch.assertCurrent,
          }
        : {}),
      permissionMode: options.permissionMode ?? 'native-cli',
      ...(options.permissions ? { grokMode: options.permissions.grok } : {}),
      ...(cleanModelOverride(options.model) ? { model: cleanModelOverride(options.model) } : {}),
      ...(options.modelReasoningEffort ? { reasoningEffort: options.modelReasoningEffort } : {}),
      ...(options.providerConversationId
        ? { providerConversationId: options.providerConversationId }
        : {}),
      signal: options.abortController?.signal ?? new AbortController().signal,
      ...(options.emitTrace
        ? {
            onUpdate: (notification) => {
              options.traceSink?.(grokTrace.project(notification, sequence));
              sequence += 1;
            },
          }
        : {}),
    });
    providerConversationId = result.sessionId;
    if (options.abortController?.signal.aborted || result.stopReason === 'cancelled') {
      return stoppedResult('grok-acp', start, providerConversationId);
    }
    if (!result.ok) {
      return {
        transport: 'grok-acp',
        ok: false,
        text: result.text,
        error: `Grok stopped the turn: ${result.stopReason}.`,
        durationMs: Date.now() - start,
        stopState: 'failed',
        providerConversationId,
      };
    }
    return {
      transport: 'grok-acp',
      ok: true,
      text: result.text || '(no text)',
      durationMs: Date.now() - start,
      stopState: 'completed',
      providerConversationId,
    };
  } catch (error) {
    if (options.abortController?.signal.aborted || isAbortLikeError(error)) {
      return stoppedResult('grok-acp', start, providerConversationId);
    }
    const detail = opened?.stderr();
    return {
      transport: 'grok-acp',
      ok: false,
      text: '',
      error:
        error instanceof Error
          ? detail
            ? `${error.message}\n${detail}`
            : error.message
          : String(error),
      durationMs: Date.now() - start,
      stopState: 'failed',
      ...(providerConversationId ? { providerConversationId } : {}),
    };
  } finally {
    const policy = confinement;
    try {
      opened?.rpc.close();
    } finally {
      if (opened) {
        void opened.processExited
          .then(() => policy?.dispose())
          .catch((error: unknown) =>
            console.error('[agent-sdk] Could not release the Grok process policy:', error)
          );
      } else {
        policy?.dispose();
      }
    }
  }
}
