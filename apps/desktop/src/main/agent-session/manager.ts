import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION,
  putAnalyticsOutboxEvent,
} from '../analytics-outbox';
import { cancelRendererToolCallsForTurn } from '../agent-tools-bridge';
import type { CliMcpBridgeProvider } from '../agent-sdk/cli-mcp-provider';
import { proteinExperimentRendererForTurn } from '../protein-experiment-workers';
import type { ProviderTraceEvent } from '../agent-sdk/trace-adapter';
import {
  clearWorkspaceProvenanceForTurn,
  completedToolCallsForTurn,
  consumeWorkspaceProvenanceForTurn,
  openWorkspaceProvenanceForTurn,
} from '../agent-sdk/turn-workspace-provenance';
import {
  queryClaudeCode,
  queryCodex,
  queryGrok,
  type CliPermissionMode,
  type QueryOptions,
} from '../agent-sdk/query';
import { getDb } from '../ipc/database';
import type { DestructiveFileConfirmRequest } from '../../shared/agent-confirm-types';
import type { RequestAgentUserInput } from '../agent-sdk/agent-user-input-adapters';
import type {
  AgentScheduleCancelResultShape,
  AgentScheduleRecordShape,
  AgentSessionCancelResultShape,
} from '../../shared/agent-runtime-ipc';
import {
  createClaudeProviderDescriptor,
  createCodexProviderDescriptor,
  createGrokProviderDescriptor,
} from './provider-descriptor';
import { findProviderContinuation } from './provider-continuation';
import {
  buildLocalAiTurnFinished,
  localAiTurnFinishedEventId,
  type LocalAiTurnTerminalInput,
} from './terminal-telemetry';
import { AgentScheduleRegistry, ScheduleCancellation } from './agent-schedule-registry';
import {
  chatReachApprovalRoots,
  chatReachInstructions,
  prepareChatReach,
  type PreparedChatReach,
} from './chat-reach';
import { defaultApprovalMemory } from '../agent-sdk/approval-memory';
import {
  agentChatFilesRoot,
  isAgentChatFolderId,
  type AgentReachRoot,
} from '../../shared/agent-chat-files';
import {
  resolveRuntimeAutomaticSkillInstructions,
  resolveRuntimeCapabilityInstructions,
} from '../agent-capabilities/runtime-service';
import type { AgentCapabilitySelection } from '../../shared/agent-capability-controls';
import type { AgentAttachmentManifest } from '../../shared/agent-attachments';
import { AGENT_GENERIC_OBJECT_SCHEMA } from '../../shared/agent-structured-output';
import { persistStructuredOutput } from '../agent-capabilities/structured-output';

export type ConfirmDestructiveFileFn = (
  request: Omit<DestructiveFileConfirmRequest, 'requestId'>,
  signal?: AbortSignal
) => Promise<import('../../shared/agent-approval').AgentApprovalChoice>;

export interface GuardrailContext {
  scratchRoot: string;
  userRoots: string[];
}
import { validateProviderSessionStartSpec } from './authority-profile-policy';
import { describeAppliedApproval } from './applied-approval';
import {
  dnaforgeSupervision,
  permissionFamilyForTransport,
  launchAgentPermissions,
} from '../../shared/agent-permissions';
import { readAgentPermissionCatalog } from '../agent-sdk/agent-permission-catalog';
import {
  logAgentSessionFailure,
  pickUserFacingCliError,
  extractTraceFailureDetail,
  extractTraceFailureMessage,
  type AgentSessionFailureRecord,
} from './failure-log';
import {
  appendConversationLedgerShadowEvent,
  type ConversationLedgerAppendInput,
  type ConversationLedgerSource,
} from '../conversation-ledger';
import type {
  AgentProvider,
  AgentSessionActiveStatus,
  AgentSessionRecord,
  AgentSessionRunResult,
  AgentSessionStartRequest,
  AgentSessionStatus,
  AgentSessionTerminalStatus,
  AgentSessionTraceEnvelope,
  ProviderAuthorityProfile,
  ProviderCapabilityReport,
  ProviderTerminalState,
  RuntimeReleaseChannel,
} from './types';

export const AGENT_SESSION_PROMPT_BYTE_CAP = 64 * 1024;

type QueryExecutor = (
  prompt: string,
  options: QueryOptions
) => Promise<{
  ok: boolean;
  text: string;
  error?: string;
  failureReason?: 'admission_rejected';
  durationMs: number;
  stopState?: ProviderTerminalState;
  providerConversationId?: string;
}>;

type ShadowLedgerAppend = (input: ConversationLedgerAppendInput) => void | Promise<unknown>;

interface ActiveSession {
  abortController: AbortController;
  turnId: string | null;
  cancelledRendererToolCalls: number;
}

export interface AgentSessionManagerDependencies {
  db?: Database.Database;
  releaseChannel?: RuntimeReleaseChannel;
  cliMcpBridgeProvider?: CliMcpBridgeProvider;
  confirmDestructiveFileProvider?: () => ConfirmDestructiveFileFn | null;
  requestUserInputProvider?: () => RequestAgentUserInput | null;
  resolveGuardrailContext?: () => Promise<GuardrailContext>;
  queryCodex?: QueryExecutor;
  queryClaudeCode?: QueryExecutor;
  queryGrok?: QueryExecutor;
  resolveCapabilityInstructions?: (input: {
    selection: AgentCapabilitySelection;
    provider: AgentProvider;
    workspacePath: string | null;
    conversationId: string | null;
  }) => Promise<{
    additionalInstructions: string | null;
    control: import('../../shared/agent-capability-controls').AgentCapabilityControl;
  }>;
  resolveAutomaticSkillInstructions?: (input: {
    provider: AgentProvider;
    workspacePath: string | null;
  }) => Promise<{
    additionalInstructions: string | null;
    enabledNativeSkillIds: string[];
    disabledNativeSkillIds: string[];
    portableSkills?: Array<{ name: string; sourcePath: string }>;
  }>;
  resolveAttachmentText?: (attachments: readonly AgentAttachmentManifest[]) => Promise<string>;
  cancelRendererToolCallsForTurn?: (turnId: string) => number;
  describeCapabilities?: (provider: AgentProvider) => Promise<ProviderCapabilityReport>;
  now?: () => number;
  idGenerator?: () => string;
  eventSink?: (envelope: AgentSessionTraceEnvelope) => void;
  resolveScratchCwd?: (sessionId: string) => Promise<string>;
  resolveChatReach?: (input: {
    conversationId: string;
    roots: readonly AgentReachRoot[];
  }) => Promise<PreparedChatReach>;
  logFailure?: (record: AgentSessionFailureRecord) => void | Promise<void>;
  appendShadowLedgerEvent?: ShadowLedgerAppend;
  scheduleRegistry?: AgentScheduleRegistry;
}

async function defaultResolveScratchCwd(sessionId: string): Promise<string> {
  const { app } = await import('electron');
  const { mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = join(app.getPath('userData'), 'cli-scratch', sessionId);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function defaultResolveChatReach(input: {
  conversationId: string;
  roots: readonly AgentReachRoot[];
}): Promise<PreparedChatReach> {
  const { app } = await import('electron');
  const { join } = await import('node:path');
  const { getAllowedRoots } = await import('../ipc/path-allowlist');
  const appDataDir = app.getPath('userData');
  return prepareChatReach({
    chatFilesRoot: agentChatFilesRoot(appDataDir),
    conversationId: input.conversationId,
    roots: input.roots,
    allowedRoots: getAllowedRoots(),
    appDataDir,
    scratchRoot: join(appDataDir, 'cli-scratch'),
  });
}

async function defaultResolveGuardrailContext(): Promise<GuardrailContext> {
  const { app } = await import('electron');
  const { join } = await import('node:path');
  const { getAllowedRoots } = await import('../ipc/path-allowlist');
  return {
    scratchRoot: join(app.getPath('userData'), 'cli-scratch'),
    userRoots: getAllowedRoots(),
  };
}

async function defaultResolveAttachmentText(
  attachments: readonly AgentAttachmentManifest[]
): Promise<string> {
  const { getRuntimeAgentAttachmentStore } = await import('../agent-capabilities/attachment-ipc');
  return getRuntimeAgentAttachmentStore().projectText(attachments);
}

function isAgentProvider(value: unknown): value is AgentProvider {
  return value === 'codex-sdk' || value === 'claude-agent-sdk' || value === 'grok-acp';
}

function providerDescriptor(provider: AgentProvider) {
  if (provider === 'codex-sdk') return createCodexProviderDescriptor();
  if (provider === 'grok-acp') return createGrokProviderDescriptor();
  return createClaudeProviderDescriptor();
}

function defaultReleaseChannel(): RuntimeReleaseChannel {
  return process.env.NODE_ENV === 'production' ? 'production' : 'development';
}

function permissionModeForProfile(profile: ProviderAuthorityProfile): CliPermissionMode {
  if (profile.authorityClass === 'app-supervised') return 'app-supervised';
  if (profile.authorityClass === 'native-workspace-write') return 'native-cli';
  throw new Error(
    `${profile.id} cannot start yet because its runtime permission mapping is not implemented.`
  );
}

function permissionModeLabel(profile: ProviderAuthorityProfile): string {
  if (profile.authorityClass === 'app-supervised') return 'app-supervised';
  if (profile.authorityClass === 'native-workspace-write') return 'native-cli';
  return profile.authorityClass;
}

function statusForTerminal(terminal: ProviderTerminalState): AgentSessionTerminalStatus {
  if (terminal === 'completed') return 'completed';
  if (terminal === 'cancelled') return 'cancelled';
  if (terminal === 'stop_requested') return 'stop_unconfirmed';
  return 'failed';
}

function traceEventType(value: unknown): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const event = value as { providerEventType?: unknown };
    return typeof event.providerEventType === 'string' ? event.providerEventType : 'unknown';
  }
  return 'unknown';
}

function traceTerminal(value: unknown): string | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const event = value as { terminal?: unknown };
    return typeof event.terminal === 'string' ? event.terminal : null;
  }
  return null;
}

function traceSequence(value: unknown): number {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const event = value as { sequence?: unknown };
    return typeof event.sequence === 'number' && Number.isInteger(event.sequence)
      ? event.sequence
      : 0;
  }
  return 0;
}

function ledgerSourceForAgentProvider(provider: AgentProvider): ConversationLedgerSource {
  if (provider === 'codex-sdk') return 'cli:codex';
  if (provider === 'grok-acp') return 'cli:grok';
  return 'cli:claude-agent';
}

function normalizeProviderConversationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  const containsControlCharacter = Array.from(normalized).some((character) => {
    const characterCode = character.charCodeAt(0);
    return characterCode <= 31 || characterCode === 127;
  });
  if (!normalized || normalized.length > 512 || containsControlCharacter) {
    return null;
  }
  return normalized;
}

function readSession(row: Record<string, unknown>): AgentSessionRecord {
  return {
    id: row.id as string,
    conversationId: (row.conversation_id as string | null) ?? null,
    turnId: (row.turn_id as string | null) ?? null,
    provider: row.provider as AgentProvider,
    authorityProfileId: row.authority_profile_id as string,
    authorityClass: row.authority_class as AgentSessionRecord['authorityClass'],
    releaseMode: row.release_mode as AgentSessionRecord['releaseMode'],
    permissionModeLabel: (row.permission_mode_label as string | null) ?? null,
    status: row.status as AgentSessionStatus,
    cwd: row.cwd as string,
    outputRoot: (row.output_root as string | null) ?? null,
    providerConversationId: (row.provider_conversation_id as string | null) ?? null,
    providerVersionsJson: row.provider_versions_json as string,
    authorityJson: row.authority_json as string,
    terminalReason: (row.terminal_reason as string | null) ?? null,
    telemetryHadWorkspaceContext: row.telemetry_had_workspace_context === 1,
    telemetryContinuation: row.telemetry_continuation === 1,
    startedAt: row.started_at as number,
    updatedAt: row.updated_at as number,
    completedAt: (row.completed_at as number | null) ?? null,
  };
}

function resolveAgentSessionTerminalOutcome(args: {
  resultOk: boolean;
  providerTerminal: ProviderTerminalState;
  resultError: string | undefined;
}): {
  terminal: ProviderTerminalState;
  rawError: string;
  ok: boolean;
  isGenuineFailure: boolean;
} {
  const terminal = args.providerTerminal;
  const rawError = args.resultError ?? terminal;
  const ok = args.resultOk && terminal === 'completed';
  const isGenuineFailure = !ok && terminal !== 'stop_requested' && terminal !== 'cancelled';
  return { terminal, rawError, ok, isGenuineFailure };
}

export class AgentSessionManager {
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly startingSessions = new Set<string>();
  private readonly pendingStopRequests = new Set<string>();
  private readonly db: Database.Database;
  private readonly releaseChannel: RuntimeReleaseChannel;
  private readonly cliMcpBridgeProvider: CliMcpBridgeProvider | null;
  private readonly confirmDestructiveFileProvider: (() => ConfirmDestructiveFileFn | null) | null;
  private readonly requestUserInputProvider: (() => RequestAgentUserInput | null) | null;
  private readonly resolveGuardrailContext: () => Promise<GuardrailContext>;
  private readonly codexQuery: QueryExecutor;
  private readonly claudeQuery: QueryExecutor;
  private readonly grokQuery: QueryExecutor;
  private readonly resolveCapabilityInstructions: NonNullable<
    AgentSessionManagerDependencies['resolveCapabilityInstructions']
  >;
  private readonly resolveAutomaticSkillInstructions: NonNullable<
    AgentSessionManagerDependencies['resolveAutomaticSkillInstructions']
  >;
  private readonly resolveAttachmentText: NonNullable<
    AgentSessionManagerDependencies['resolveAttachmentText']
  >;
  private readonly cancelRendererToolCalls: (turnId: string) => number;
  private readonly describeProviderCapabilities: (
    provider: AgentProvider
  ) => Promise<ProviderCapabilityReport>;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly eventSink: ((envelope: AgentSessionTraceEnvelope) => void) | null;
  private readonly resolveScratchCwd: (sessionId: string) => Promise<string>;
  private readonly resolveChatReach: NonNullable<
    AgentSessionManagerDependencies['resolveChatReach']
  >;
  private readonly logFailure: (record: AgentSessionFailureRecord) => void | Promise<void>;
  private readonly appendShadowLedgerEvent: ShadowLedgerAppend;
  private readonly scheduleRegistry: AgentScheduleRegistry | null;

  constructor(deps: AgentSessionManagerDependencies = {}) {
    this.db = deps.db ?? getDb();
    this.releaseChannel = deps.releaseChannel ?? defaultReleaseChannel();
    this.cliMcpBridgeProvider = deps.cliMcpBridgeProvider ?? null;
    this.confirmDestructiveFileProvider = deps.confirmDestructiveFileProvider ?? null;
    this.requestUserInputProvider = deps.requestUserInputProvider ?? null;
    this.resolveGuardrailContext = deps.resolveGuardrailContext ?? defaultResolveGuardrailContext;
    this.codexQuery = deps.queryCodex ?? ((prompt, options) => queryCodex(prompt, options));
    this.claudeQuery =
      deps.queryClaudeCode ?? ((prompt, options) => queryClaudeCode(prompt, options));
    this.grokQuery = deps.queryGrok ?? ((prompt, options) => queryGrok(prompt, options));
    this.resolveCapabilityInstructions =
      deps.resolveCapabilityInstructions ?? resolveRuntimeCapabilityInstructions;
    this.resolveAutomaticSkillInstructions =
      deps.resolveAutomaticSkillInstructions ?? resolveRuntimeAutomaticSkillInstructions;
    this.resolveAttachmentText = deps.resolveAttachmentText ?? defaultResolveAttachmentText;
    this.cancelRendererToolCalls =
      deps.cancelRendererToolCallsForTurn ?? cancelRendererToolCallsForTurn;
    this.describeProviderCapabilities =
      deps.describeCapabilities ??
      ((provider) => providerDescriptor(provider).describeCapabilities());
    this.now = deps.now ?? Date.now;
    this.idGenerator = deps.idGenerator ?? randomUUID;
    this.eventSink = deps.eventSink ?? null;
    this.resolveScratchCwd = deps.resolveScratchCwd ?? defaultResolveScratchCwd;
    this.resolveChatReach = deps.resolveChatReach ?? defaultResolveChatReach;
    this.logFailure = deps.logFailure ?? logAgentSessionFailure;
    this.appendShadowLedgerEvent =
      deps.appendShadowLedgerEvent ?? appendConversationLedgerShadowEvent;
    this.scheduleRegistry = deps.scheduleRegistry ?? null;
    this.recoverInterruptedSessions();
  }

  recoverInterruptedSessions(): number {
    const now = this.now();
    this.db
      .prepare(
        `
          UPDATE chat_turns
          SET status = 'interrupted',
              terminal_reason = 'App restarted before the turn completed.',
              completed_at = COALESCE(completed_at, ?)
          WHERE status = 'running'
        `
      )
      .run(now);
    const staleSessions = this.db
      .prepare(
        `SELECT id, provider, status, provider_conversation_id, started_at,
                telemetry_had_workspace_context, telemetry_continuation
           FROM agent_sessions
          WHERE status IN ('starting', 'running', 'stopping')
            AND completed_at IS NULL
          ORDER BY started_at, id`
      )
      .all() as Array<{
      id: string;
      provider: AgentProvider;
      status: AgentSessionActiveStatus;
      provider_conversation_id: string | null;
      started_at: number;
      telemetry_had_workspace_context: 0 | 1;
      telemetry_continuation: 0 | 1;
    }>;
    for (const stale of staleSessions) {
      this.completeSession(
        stale.id,
        stale.status === 'stopping' ? 'stop_unconfirmed' : 'interrupted',
        stale.status === 'stopping'
          ? 'App restarted before Stop was acknowledged.'
          : 'App restarted before the provider session completed.',
        stale.provider_conversation_id,
        {
          provider: stale.provider,
          durationMs: Math.max(0, now - stale.started_at),
          visibleAssistantText: '',
          toolCallCount: this.countRecoveredToolCalls(stale.id),
          completedWorkspaceToolCount: 'unknown',
          hadWorkspaceContext: stale.telemetry_had_workspace_context === 1,
          continuation: stale.telemetry_continuation === 1,
          recovered: true,
        }
      );
    }
    return staleSessions.length;
  }

  private countRecoveredToolCalls(sessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT json_extract(tool.value, '$.id')) AS count
           FROM agent_trace_events AS event,
                json_each(event.render_snapshot_json, '$.toolCalls') AS tool
          WHERE event.session_id = ?
            AND json_type(tool.value, '$.id') = 'text'`
      )
      .get(sessionId) as { count: number };
    return row.count;
  }

  getSession(sessionId: string): AgentSessionRecord | null {
    const row = this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(sessionId) as
      | Record<string, unknown>
      | undefined;
    return row ? readSession(row) : null;
  }

  private assertValidAgentSessionStart(request: AgentSessionStartRequest): string {
    if (!isAgentProvider(request.provider)) {
      throw new Error(`Unknown agent provider: ${String(request.provider)}`);
    }
    if (typeof request.prompt !== 'string' || request.prompt.length === 0) {
      throw new Error('agentSession:start requires a non-empty prompt.');
    }
    if (Buffer.byteLength(request.prompt, 'utf8') > AGENT_SESSION_PROMPT_BYTE_CAP) {
      throw new Error(
        `agentSession:start prompt exceeds ${AGENT_SESSION_PROMPT_BYTE_CAP}-byte cap.`
      );
    }
    if (
      request.continuationPrompt &&
      Buffer.byteLength(request.continuationPrompt, 'utf8') > AGENT_SESSION_PROMPT_BYTE_CAP
    ) {
      throw new Error(
        `agentSession:start continuationPrompt exceeds ${AGENT_SESSION_PROMPT_BYTE_CAP}-byte cap.`
      );
    }
    if (
      request.workspaceGrounding !== 'required' &&
      request.workspaceGrounding !== 'not-required'
    ) {
      throw new Error('agentSession:start requires a workspaceGrounding policy.');
    }
    const sessionId = request.sessionId ?? this.idGenerator();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      throw new Error('agentSession:start requires a valid sessionId.');
    }
    if (this.activeSessions.has(sessionId) || this.startingSessions.has(sessionId)) {
      throw new Error(`agentSession:start already has an in-flight session for ${sessionId}.`);
    }
    if (request.turnId) {
      const turn = this.db
        .prepare(
          `SELECT conversation_id, route_kind, transport, status
           FROM chat_turns
           WHERE id = ?`
        )
        .get(request.turnId) as
        | {
            conversation_id: string;
            route_kind: string;
            transport: string | null;
            status: string;
          }
        | undefined;
      if (!turn) {
        throw new Error(`agentSession:start turn ${request.turnId} does not exist.`);
      }
      if (request.conversationId && turn.conversation_id !== request.conversationId) {
        throw new Error(
          `agentSession:start turn ${request.turnId} does not belong to conversation ${request.conversationId}.`
        );
      }
      if (
        turn.status !== 'running' ||
        turn.route_kind !== 'cli' ||
        turn.transport !== request.provider
      ) {
        throw new Error(
          `agentSession:start turn ${request.turnId} is not a running ${request.provider} CLI turn.`
        );
      }
    }
    return sessionId;
  }

  async startSession(
    request: AgentSessionStartRequest,
    eventSink?: (envelope: AgentSessionTraceEnvelope) => void
  ): Promise<AgentSessionRunResult> {
    const sessionId = this.assertValidAgentSessionStart(request);
    const provenanceTurnId = sessionId;
    const privateRenderer = proteinExperimentRendererForTurn(provenanceTurnId);
    const molecularTrialAuthor = privateRenderer !== undefined;
    if (molecularTrialAuthor && (!privateRenderer || request.provider !== 'codex-sdk'))
      throw new Error('Fresh protein authors require their live bound Codex job.');
    if (
      molecularTrialAuthor &&
      (request.attachments?.length || request.capabilitySelection || request.cwd)
    )
      throw new Error(
        'Fresh protein authors cannot inherit workspace, attachment or capability context.'
      );

    this.startingSessions.add(sessionId);
    const prepared = await (async () => {
      try {
        const chatReach =
          !molecularTrialAuthor &&
          request.conversationId &&
          isAgentChatFolderId(request.conversationId)
            ? await this.resolveChatReach({
                conversationId: request.conversationId,
                roots: [
                  ...(request.reachRoots ?? []),
                  ...(request.cwd && request.cwd.trim().length > 0
                    ? [{ path: request.cwd, name: request.cwd.split(/[\\/]/).pop() || 'Project' }]
                    : []),
                ],
              })
            : null;
        const cwd =
          chatReach?.cwd ??
          (request.cwd && request.cwd.trim().length > 0
            ? request.cwd
            : await this.resolveScratchCwd(sessionId));

        const confirmDestructiveFile = this.confirmDestructiveFileProvider?.() ?? undefined;
        const guardrailContext = confirmDestructiveFile
          ? await this.resolveGuardrailContext()
          : null;

        const profile = validateProviderSessionStartSpec({
          provider: request.provider,
          authorityProfileId: request.authorityProfileId,
          cwd,
          releaseChannel: this.releaseChannel,
        });
        const permissionMode = permissionModeForProfile(profile);
        const attachmentText = request.attachments?.length
          ? await this.resolveAttachmentText(request.attachments)
          : null;
        const capabilities = await this.describeProviderCapabilities(request.provider);
        if (
          !request.binaryPathOverride &&
          (capabilities.auth === 'missing' || capabilities.auth === 'unauthenticated')
        ) {
          throw new Error(`${request.provider} is not authenticated (${capabilities.auth}).`);
        }
        const capabilityInstructions = request.capabilitySelection
          ? await this.resolveCapabilityInstructions({
              selection: request.capabilitySelection,
              provider: request.provider,
              workspacePath: request.cwd,
              conversationId: request.conversationId ?? null,
            })
          : null;
        const automaticSkillInstructions = molecularTrialAuthor
          ? {
              additionalInstructions: null,
              enabledNativeSkillIds: [],
              disabledNativeSkillIds: [],
              portableSkills: [],
            }
          : await this.resolveAutomaticSkillInstructions({
              provider: request.provider,
              workspacePath: request.cwd,
            });
        const providerConversationId =
          !molecularTrialAuthor && request.continuationPrompt
            ? findProviderContinuation(this.db, {
                conversationId: request.conversationId ?? null,
                turnId: request.turnId ?? null,
                provider: request.provider,
              })
            : null;
        return {
          cwd,
          chatReach,
          confirmDestructiveFile,
          guardrailContext,
          profile,
          permissionMode,
          capabilities,
          capabilityInstructions,
          automaticSkillInstructions,
          attachmentText,
          providerConversationId,
        };
      } catch (error) {
        this.startingSessions.delete(sessionId);
        this.pendingStopRequests.delete(sessionId);
        throw error;
      }
    })();
    const {
      cwd,
      chatReach,
      confirmDestructiveFile,
      guardrailContext,
      profile,
      permissionMode,
      capabilities,
      capabilityInstructions,
      automaticSkillInstructions,
      attachmentText,
      providerConversationId,
    } = prepared;
    const requestUserInput = this.requestUserInputProvider?.() ?? undefined;
    const permissions = launchAgentPermissions(
      await readAgentPermissionCatalog(),
      request.permissions
    );

    const startedAt = this.now();
    const abortController = new AbortController();
    try {
      this.db.transaction(() => {
        this.insertSession({
          id: sessionId,
          conversationId: request.conversationId ?? null,
          turnId: request.turnId ?? null,
          provider: request.provider,
          authorityProfileId: profile.id,
          authorityClass: profile.authorityClass,
          releaseMode: profile.releaseMode,
          permissionModeLabel: permissionModeLabel(profile),
          status: 'running',
          cwd,
          outputRoot: null,
          providerConversationId: null,
          providerVersionsJson: JSON.stringify(capabilities.versions),
          authorityJson: JSON.stringify({
            ...profile,
            applied: describeAppliedApproval({
              provider: request.provider,
              permissionMode,
              permissions,
              cwd,
              writableRoots: chatReach?.writableRoots ?? [],
              interactive: requestUserInput !== undefined,
              molecularTrialAuthor,
            }),
          }),
          terminalReason: null,
          telemetryHadWorkspaceContext: Boolean(request.cwd?.trim()),
          telemetryContinuation: Boolean(request.continuationPrompt),
          startedAt,
          updatedAt: startedAt,
          completedAt: null,
        });
        if (request.capabilitySelection && request.turnId && capabilityInstructions) {
          this.db
            .prepare(
              `INSERT INTO agent_capability_invocations (
                 turn_id, conversation_id, snapshot_id, capability_id, provider,
                 kind, label, source, applied_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              request.turnId,
              request.conversationId ?? null,
              request.capabilitySelection.snapshotId,
              request.capabilitySelection.capabilityId,
              request.provider,
              capabilityInstructions.control.kind,
              capabilityInstructions.control.label,
              capabilityInstructions.control.source ?? null,
              startedAt
            );
        }
      })();

      this.activeSessions.set(sessionId, {
        abortController,
        turnId: provenanceTurnId,
        cancelledRendererToolCalls: 0,
      });
      this.startingSessions.delete(sessionId);
      if (this.pendingStopRequests.delete(sessionId)) {
        abortController.abort();
        this.markStopping(sessionId);
      }
    } catch (error) {
      this.startingSessions.delete(sessionId);
      this.pendingStopRequests.delete(sessionId);
      this.activeSessions.delete(sessionId);
      throw error;
    }

    let lastFailureDetail: string | null = null;
    let lastTraceSequence = -1;
    let lastFailureMessage: string | null = null;
    const sessionEventSink = eventSink ?? this.eventSink;
    const observedToolCallIds = new Set<string>();
    const publishTraceEvent = (event: ProviderTraceEvent): void => {
      sessionEventSink?.({
        sessionId,
        provider: request.provider,
        type: 'trace',
        event,
      });
    };
    const queryOptions: QueryOptions = {
      purpose: 'chat',
      ...(molecularTrialAuthor ? { molecularTrialAuthor: true as const } : {}),
      ...(request.binaryPathOverride ? { binaryPathOverride: request.binaryPathOverride } : {}),
      cwd,
      queryId: sessionId,
      conversationId: request.conversationId ?? null,
      turnId: provenanceTurnId,
      emitTrace: true,
      permissionMode,
      permissions,
      shellSupervision:
        permissionMode === 'native-cli'
          ? dnaforgeSupervision(permissionFamilyForTransport(request.provider), permissions)
              .shellSupervision
          : (request.shellSupervision ?? 'always'),
      additionalAgentInstructions: request.additionalAgentInstructions?.trim() || undefined,
      ...(chatReach
        ? {
            writableRoots: chatReach.writableRoots,
            approvalRoots: chatReachApprovalRoots(chatReach),
          }
        : {}),
      approvalMemory: defaultApprovalMemory(),
      runtimeAgentInstructions:
        [
          chatReach ? chatReachInstructions(chatReach) : null,
          automaticSkillInstructions.additionalInstructions,
          capabilityInstructions?.additionalInstructions,
        ]
          .filter((value): value is string => Boolean(value))
          .join('\n\n') || undefined,
      enabledNativeSkillIds: automaticSkillInstructions.enabledNativeSkillIds,
      disabledNativeSkillIds: automaticSkillInstructions.disabledNativeSkillIds,
      portableSkills: automaticSkillInstructions.portableSkills ?? [],
      model: request.model ?? null,
      modelReasoningEffort: request.modelReasoningEffort ?? null,
      modelServiceTier: request.modelServiceTier ?? null,
      modelPersonality: request.modelPersonality ?? null,
      selectedCapability: capabilityInstructions?.control ?? null,
      ...(providerConversationId ? { providerConversationId } : {}),
      workspaceGrounding: request.workspaceGrounding,
      toolExposure: request.toolExposure ?? 'auto',
      abortController,
      userRoots: guardrailContext?.userRoots,
      scratchRoot: guardrailContext?.scratchRoot,
      confirmDestructiveFile,
      requestUserInput,
      traceSink: (event) => {
        for (const toolCall of event.toolCalls ?? []) {
          observedToolCallIds.add(toolCall.id);
        }
        const failureDetail = extractTraceFailureDetail(event);
        if (failureDetail) lastFailureDetail = failureDetail;
        const failureMessage = extractTraceFailureMessage(event);
        if (failureMessage) lastFailureMessage = failureMessage;
        this.scheduleRegistry?.observeTrace(
          {
            sessionId,
            conversationId: request.conversationId ?? null,
            providerConversationId,
            cwd,
          },
          event
        );
        this.appendTraceEvent({
          sessionId,
          conversationId: request.conversationId ?? null,
          turnId: request.turnId ?? null,
          provider: request.provider,
          model: request.model ?? null,
          event,
        });
        publishTraceEvent(event);
        lastTraceSequence = Math.max(lastTraceSequence, event.sequence);
      },
    };
    const recordCliFailure = (
      rawError: string,
      durationMs: number,
      stopState: ProviderTerminalState
    ): string => {
      void this.logFailure({
        at: this.now(),
        sessionId,
        provider: request.provider,
        authorityProfileId: profile.id,
        cwd,
        model: request.model ?? null,
        versions: capabilities.versions,
        error: rawError,
        traceDetail: lastFailureDetail,
        durationMs,
        stopState,
      });
      return pickUserFacingCliError(rawError, lastFailureMessage);
    };

    openWorkspaceProvenanceForTurn(provenanceTurnId);
    try {
      abortController.signal.throwIfAborted();
      queryOptions.cliMcpBridge =
        queryOptions.toolExposure === 'none'
          ? null
          : ((await this.cliMcpBridgeProvider?.(abortController.signal)) ?? null);
      abortController.signal.throwIfAborted();
      queryOptions.cliMcpBridge?.assertCurrent?.();
      const executor =
        request.provider === 'codex-sdk'
          ? this.codexQuery
          : request.provider === 'grok-acp'
            ? this.grokQuery
            : this.claudeQuery;
      const baseQueryPrompt = providerConversationId
        ? (request.continuationPrompt as string)
        : request.prompt;
      const queryPrompt = attachmentText
        ? `${baseQueryPrompt}\n\n${attachmentText}`
        : baseQueryPrompt;
      const result = await executor(queryPrompt, queryOptions);
      const active = this.activeSessions.get(sessionId);
      const providerTerminal = providerDescriptor(request.provider).classifyTerminalState({
        abortRequested: abortController.signal.aborted,
        providerStopState: result.stopState ?? (result.ok ? 'completed' : 'failed'),
        activeToolRunning: (active?.cancelledRendererToolCalls ?? 0) > 0,
        childReaping: capabilities.cancellation.childReaping,
      });
      const completedToolCalls = completedToolCallsForTurn(provenanceTurnId);
      const observedProvenance = consumeWorkspaceProvenanceForTurn(provenanceTurnId);
      const workspaceProvenance = {
        policy: request.workspaceGrounding,
        ...observedProvenance,
      };
      const requiredToolMissing =
        request.toolExposure === 'required' && result.ok && completedToolCalls.length === 0;
      const { terminal, rawError, ok, isGenuineFailure } = resolveAgentSessionTerminalOutcome({
        resultOk: result.ok && !requiredToolMissing,
        providerTerminal: requiredToolMissing ? 'failed' : providerTerminal,
        resultError: requiredToolMissing
          ? 'The required tool did not complete during this turn.'
          : result.error,
      });
      const completedProviderConversationId =
        normalizeProviderConversationId(result.providerConversationId) ?? providerConversationId;
      const structuredOutput =
        ok && request.turnId && capabilityInstructions?.control.kind === 'structured-output'
          ? persistStructuredOutput(this.db, {
              turnId: request.turnId,
              schema: AGENT_GENERIC_OBJECT_SCHEMA,
              rawResult: result.text,
              createdAt: this.now(),
            })
          : undefined;
      if (completedProviderConversationId) {
        this.scheduleRegistry?.attachProviderConversationId(
          sessionId,
          completedProviderConversationId
        );
      }
      this.completeSession(
        sessionId,
        statusForTerminal(terminal),
        rawError,
        completedProviderConversationId,
        {
          provider: request.provider,
          durationMs: result.durationMs,
          actionId: request.turnId,
          reasonHint: result.failureReason,
          ...(terminal === 'cancelled' &&
          abortController.signal.aborted &&
          result.userStopAcknowledged
            ? { userStopAcknowledged: true as const }
            : {}),
          visibleAssistantText: result.text,
          toolCallCount: observedToolCallIds.size,
          completedWorkspaceToolCount: new Set(workspaceProvenance.completedWorkspaceTools).size,
          hadWorkspaceContext: Boolean(request.cwd?.trim()),
          continuation: Boolean(request.continuationPrompt),
        }
      );
      const userError = ok
        ? undefined
        : isGenuineFailure
          ? recordCliFailure(rawError, result.durationMs, terminal)
          : rawError;
      return {
        sessionId,
        provider: request.provider,
        authorityProfileId: profile.id,
        ok,
        text: result.text,
        error: userError,
        durationMs: result.durationMs,
        stopState: terminal,
        lastTraceSequence,
        ...(completedProviderConversationId
          ? { providerConversationId: completedProviderConversationId }
          : {}),
        workspaceProvenance,
        ...(structuredOutput ? { structuredOutput } : {}),
      };
    } catch (err) {
      const terminal: ProviderTerminalState = abortController.signal.aborted
        ? 'stop_requested'
        : 'failed';
      const rawError =
        terminal === 'stop_requested'
          ? 'Stop requested.'
          : err instanceof Error
            ? err.message
            : String(err);
      const durationMs = this.now() - startedAt;
      const workspaceProvenance = {
        policy: request.workspaceGrounding,
        ...consumeWorkspaceProvenanceForTurn(provenanceTurnId),
      };
      this.completeSession(
        sessionId,
        statusForTerminal(terminal),
        rawError,
        providerConversationId,
        {
          provider: request.provider,
          durationMs,
          actionId: request.turnId,
          visibleAssistantText: '',
          toolCallCount: observedToolCallIds.size,
          completedWorkspaceToolCount: new Set(workspaceProvenance.completedWorkspaceTools).size,
          hadWorkspaceContext: Boolean(request.cwd?.trim()),
          continuation: Boolean(request.continuationPrompt),
        }
      );
      const userError =
        terminal === 'stop_requested' ? rawError : recordCliFailure(rawError, durationMs, terminal);
      return {
        sessionId,
        provider: request.provider,
        authorityProfileId: profile.id,
        ok: false,
        text: '',
        error: userError,
        durationMs,
        stopState: terminal,
        lastTraceSequence,
        ...(providerConversationId ? { providerConversationId } : {}),
        workspaceProvenance,
      };
    } finally {
      clearWorkspaceProvenanceForTurn(provenanceTurnId);
      this.activeSessions.delete(sessionId);
      this.startingSessions.delete(sessionId);
      this.pendingStopRequests.delete(sessionId);
    }
  }

  requestStop(sessionId: string): AgentSessionCancelResultShape {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      return {
        ok: false,
        cancelled: false,
        state: 'not_found',
        error: 'agentSession:cancel requires a valid sessionId.',
      };
    }

    const active = this.activeSessions.get(sessionId);
    if (!active && this.startingSessions.has(sessionId)) {
      this.pendingStopRequests.add(sessionId);
      return { ok: true, cancelled: true, state: 'stop_requested' };
    }
    const turnId = active?.turnId ?? sessionId;
    const cancelledRendererToolCalls = this.cancelRendererToolCalls(turnId);
    if (!active && cancelledRendererToolCalls === 0) {
      return { ok: true, cancelled: false, state: 'not_found' };
    }

    if (active) {
      active.cancelledRendererToolCalls += cancelledRendererToolCalls;
      active.abortController.abort();
    }
    this.markStopping(sessionId);
    return { ok: true, cancelled: true, state: 'stop_requested' };
  }

  listSchedules(): AgentScheduleRecordShape[] {
    return this.scheduleRegistry?.list() ?? [];
  }

  async cancelSchedule(scheduleId: string): Promise<AgentScheduleCancelResultShape> {
    const schedule = this.scheduleRegistry?.beginCancel(scheduleId) ?? null;
    if (!schedule) return { ok: false, schedule: null, error: 'Scheduled task was not found.' };
    if (!schedule.providerConversationId) {
      this.scheduleRegistry?.failCancel(scheduleId);
      return {
        ok: false,
        schedule: this.scheduleRegistry?.get(scheduleId) ?? schedule,
        error: 'The native Claude session is not available to cancel this scheduled task.',
      };
    }

    const abortController = new AbortController();
    const cancellation = new ScheduleCancellation(schedule);
    const prompt =
      schedule.kind === 'cron'
        ? `The user clicked Cancel for scheduled task ${schedule.nativeId}. Call CronDelete with exactly that ID now. Do no other work.`
        : `The user clicked Cancel for the scheduled wake-up whose prompt is ${JSON.stringify(schedule.prompt)} and scheduledFor is ${JSON.stringify(schedule.scheduledFor)}. Call CronList, require one unique non-recurring match for both fields, then call CronDelete for that native ID. If no unique match exists, report failure without deleting anything. Do no other work.`;
    try {
      const result = await this.claudeQuery(prompt, {
        purpose: 'chat',
        cwd: schedule.cwd,
        queryId: this.idGenerator(),
        conversationId: schedule.conversationId,
        providerConversationId: schedule.providerConversationId,
        permissionMode: 'native-cli',
        workspaceGrounding: 'not-required',
        abortController,
        requestUserInput: this.requestUserInputProvider?.() ?? undefined,
        traceSink: (event) => {
          this.scheduleRegistry?.observeTrace(
            {
              sessionId: schedule.sessionId,
              conversationId: schedule.conversationId,
              providerConversationId: schedule.providerConversationId,
              cwd: schedule.cwd,
            },
            event
          );
          cancellation.observe(event);
        },
      });
      if (!result.ok || !cancellation.confirmed) {
        this.scheduleRegistry?.failCancel(scheduleId);
        return {
          ok: false,
          schedule: this.scheduleRegistry?.get(scheduleId) ?? schedule,
          error: result.error ?? 'Claude did not confirm native schedule deletion.',
        };
      }
      this.scheduleRegistry?.completeCancellation(scheduleId);
      return { ok: true, schedule: this.scheduleRegistry?.get(scheduleId) ?? schedule };
    } catch (cause) {
      this.scheduleRegistry?.failCancel(scheduleId);
      return {
        ok: false,
        schedule: this.scheduleRegistry?.get(scheduleId) ?? schedule,
        error: cause instanceof Error ? cause.message : 'Native schedule cancellation failed.',
      };
    }
  }

  private insertSession(record: AgentSessionRecord): void {
    this.db
      .prepare(
        `
          INSERT INTO agent_sessions (
            id, conversation_id, turn_id, provider, authority_profile_id, authority_class,
            release_mode, permission_mode_label, status, cwd, output_root,
            provider_conversation_id, provider_versions_json, authority_json,
            terminal_reason, telemetry_had_workspace_context, telemetry_continuation,
            started_at, updated_at, completed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        record.id,
        record.conversationId,
        record.turnId,
        record.provider,
        record.authorityProfileId,
        record.authorityClass,
        record.releaseMode,
        record.permissionModeLabel,
        record.status,
        record.cwd,
        record.outputRoot,
        record.providerConversationId,
        record.providerVersionsJson,
        record.authorityJson,
        record.terminalReason,
        record.telemetryHadWorkspaceContext ? 1 : 0,
        record.telemetryContinuation ? 1 : 0,
        record.startedAt,
        record.updatedAt,
        record.completedAt
      );
  }

  private markStopping(sessionId: string): void {
    this.db
      .prepare(
        `
          UPDATE agent_sessions
          SET status = 'stopping',
              terminal_reason = 'Stop requested.',
              updated_at = ?
          WHERE id = ?
            AND status IN ('starting', 'running')
            AND completed_at IS NULL
        `
      )
      .run(this.now(), sessionId);
  }

  private completeSession(
    sessionId: string,
    status: AgentSessionTerminalStatus,
    terminalReason: string | null,
    providerConversationId: string | null,
    telemetry: Omit<LocalAiTurnTerminalInput, 'sessionId' | 'status'>
  ): void {
    const now = this.now();
    const properties = buildLocalAiTurnFinished({ sessionId, status, ...telemetry });
    const eventId = localAiTurnFinishedEventId(sessionId);
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          `
            UPDATE agent_sessions
            SET status = ?,
                terminal_reason = ?,
                provider_conversation_id = ?,
                updated_at = ?,
                completed_at = ?
            WHERE id = ? AND completed_at IS NULL
              AND status IN ('starting', 'running', 'stopping')
          `
        )
        .run(status, terminalReason, providerConversationId, now, now, sessionId);
      if (result.changes !== 1) {
        throw new Error(`Agent session ${sessionId} was already terminal or did not exist.`);
      }
      putAnalyticsOutboxEvent(this.db, {
        eventId,
        eventName: 'ai_turn_finished',
        payloadSchemaVersion: ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION,
        referenceKind: 'ai_turn_terminal',
        referenceId: sessionId,
        properties,
        createdAtMs: now,
      });
    })();
  }

  private appendTraceEvent(input: {
    sessionId: string;
    conversationId: string | null;
    turnId: string | null;
    provider: AgentProvider;
    model: string | null;
    event: unknown;
  }): void {
    const eventType = traceEventType(input.event);
    const terminal = traceTerminal(input.event);
    const sequence = traceSequence(input.event);
    const createdAt = this.now();
    this.db
      .prepare(
        `
          INSERT OR REPLACE INTO agent_trace_events (
            id, session_id, sequence, provider, event_type,
            render_snapshot_json, terminal, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        `${input.sessionId}:${sequence}`,
        input.sessionId,
        sequence,
        input.provider,
        eventType,
        JSON.stringify(input.event),
        terminal,
        createdAt
      );

    if (!input.conversationId) return;
    try {
      const pending = this.appendShadowLedgerEvent({
        conversation_id: input.conversationId,
        turn_id: input.turnId,
        source: ledgerSourceForAgentProvider(input.provider),
        provider: input.provider,
        model: input.model,
        stream_event_type: eventType,
        payload: input.event,
        created_at: new Date(createdAt).toISOString(),
      });
      void Promise.resolve(pending).catch((error) => {
        console.warn('[AgentSession] Conversation ledger shadow append failed:', error);
      });
    } catch (error) {
      console.warn('[AgentSession] Conversation ledger shadow append failed:', error);
    }
  }
}
