import { handleGroup, sendRendererIpc } from '../../shared/ipc-contract';
import { app } from 'electron';
import { isAbsolute, join } from 'node:path';
import type { CliMcpBridgeProvider } from '../agent-sdk/cli-mcp-provider';
import { AgentScheduleRegistry } from './agent-schedule-registry';
import { AgentSessionManager, type ConfirmDestructiveFileFn } from './manager';
import type { RequestAgentUserInput } from '../agent-sdk/agent-user-input-adapters';
import type {
  AgentModelReasoningEffort,
  AgentProvider,
  AgentSessionRunResult,
  AgentSessionStartRequest,
  RuntimeReleaseChannel,
} from './types';
import {
  AGENT_ATTACHMENT_MAX_COUNT,
  AGENT_ATTACHMENT_MAX_TOTAL_BYTES,
  isAgentAttachmentManifest,
  type AgentAttachmentManifest,
} from '../../shared/agent-attachments';
import { agentSessionContract } from '../../shared/ipc/agent-session.contract';
import { parseAgentPermissions, type AgentPermissions } from '../../shared/agent-permissions';
import { defaultApprovalMemory } from '../agent-sdk/approval-memory';
import { readAgentPermissionCatalog } from '../agent-sdk/agent-permission-catalog';
import { MAX_AGENT_EXECUTION_INSTRUCTIONS_LENGTH } from '../../shared/agent-presentation-instructions';

let cliMcpBridgeProvider: CliMcpBridgeProvider | null = null;
let confirmDestructiveFileProvider: (() => ConfirmDestructiveFileFn | null) | null = null;
let requestUserInputProvider: (() => RequestAgentUserInput | null) | null = null;
let managerOverride: AgentSessionManager | null = null;

export function setAgentSessionCliMcpBridgeProvider(provider: CliMcpBridgeProvider | null): void {
  cliMcpBridgeProvider = provider;
  managerOverride = null;
}

export function setAgentSessionConfirmDestructiveFileProvider(
  provider: (() => ConfirmDestructiveFileFn | null) | null
): void {
  confirmDestructiveFileProvider = provider;
  managerOverride = null;
}

export function setAgentSessionRequestUserInputProvider(
  provider: (() => RequestAgentUserInput | null) | null
): void {
  requestUserInputProvider = provider;
  managerOverride = null;
}

function releaseChannel(): RuntimeReleaseChannel {
  return app.isPackaged ? 'packaged' : 'development';
}

function getManager(): AgentSessionManager {
  if (!managerOverride) {
    managerOverride = new AgentSessionManager({
      releaseChannel: releaseChannel(),
      cliMcpBridgeProvider: (signal) => cliMcpBridgeProvider?.(signal) ?? null,
      confirmDestructiveFileProvider: () => confirmDestructiveFileProvider?.() ?? null,
      requestUserInputProvider: () => requestUserInputProvider?.() ?? null,
      scheduleRegistry: new AgentScheduleRegistry(
        join(app.getPath('userData'), 'agent-schedules.json')
      ),
    });
  }
  return managerOverride;
}

function isAgentProvider(value: unknown): value is AgentProvider {
  return value === 'codex-sdk' || value === 'claude-agent-sdk' || value === 'grok-acp';
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validScheduleId(value: string): boolean {
  return /^[A-Za-z0-9_:.-]{1,512}$/.test(value);
}

function sanitizeOptionalModel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error('agentSession:start requires model to be a string when provided.');
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 160) {
    throw new Error('agentSession:start model is too long.');
  }
  return trimmed;
}

function sanitizeOptionalEffort(value: unknown): AgentModelReasoningEffort | null {
  if (value === undefined || value === null || value === '') return null;
  if (
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'ultra'
  ) {
    return value;
  }
  throw new Error('agentSession:start modelReasoningEffort is not supported.');
}

function sanitizeOptionalServiceTier(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error('agentSession:start requires modelServiceTier to be a string when provided.');
  }
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(trimmed)) {
    throw new Error('agentSession:start modelServiceTier is invalid.');
  }
  return trimmed;
}

function sanitizeOptionalPersonality(value: unknown, provider: AgentProvider): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (provider === 'codex-sdk') {
    if (value === 'none' || value === 'friendly' || value === 'pragmatic') return value;
  } else if (
    provider === 'claude-agent-sdk' &&
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(value.trim())
  ) {
    return value.trim();
  }
  throw new Error('agentSession:start modelPersonality is invalid.');
}

function sanitizeShellSupervision(value: unknown): 'auto' | 'destructive-only' | 'always' {
  if (value === undefined || value === 'auto') return 'auto';
  if (value === 'destructive-only' || value === 'always') return value;
  throw new Error('agentSession:start shellSupervision is not supported.');
}

function sanitizePermissions(value: unknown): AgentPermissions {
  if (value === undefined) return {};
  const permissions = parseAgentPermissions(value);
  if (permissions) return permissions;
  throw new Error('agentSession:start permissions are not supported.');
}

const MAX_REACH_ROOTS = 512;

function sanitizeReachRoots(value: unknown): Array<{ path: string; name: string }> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_REACH_ROOTS) {
    throw new Error('agentSession:start reachRoots must be a bounded array.');
  }
  return value.map((entry) => {
    const root = entry as { path?: unknown; name?: unknown } | null;
    if (
      !root ||
      typeof root.path !== 'string' ||
      !isAbsolute(root.path) ||
      root.path.length > 4096 ||
      typeof root.name !== 'string' ||
      root.name.length > 512
    ) {
      throw new Error('agentSession:start reachRoots entries need an absolute path and a name.');
    }
    return { path: root.path, name: root.name };
  });
}

function sanitizeAdditionalAgentInstructions(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new Error('agentSession:start additionalAgentInstructions must be a string.');
  }
  if (value.length > MAX_AGENT_EXECUTION_INSTRUCTIONS_LENGTH) {
    throw new Error(
      `agentSession:start additionalAgentInstructions exceeds ${MAX_AGENT_EXECUTION_INSTRUCTIONS_LENGTH} characters.`
    );
  }
  return value;
}

function sanitizeContinuationPrompt(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('agentSession:start continuationPrompt must be a non-empty string.');
  }
  return value;
}

function sanitizeCapabilitySelection(
  value: unknown,
  provider: AgentProvider
): AgentSessionStartRequest['capabilitySelection'] {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('agentSession:start capabilitySelection is invalid.');
  }
  const input = value as Record<string, unknown>;
  const safeId = /^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,255}$/;
  if (
    input.provider !== provider ||
    typeof input.snapshotId !== 'string' ||
    !safeId.test(input.snapshotId) ||
    typeof input.capabilityId !== 'string' ||
    !safeId.test(input.capabilityId)
  ) {
    throw new Error('agentSession:start capabilitySelection is invalid.');
  }
  return {
    provider,
    snapshotId: input.snapshotId,
    capabilityId: input.capabilityId,
  };
}

function sanitizeAttachments(value: unknown): AgentAttachmentManifest[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > AGENT_ATTACHMENT_MAX_COUNT) {
    throw new Error(
      `agentSession:start accepts at most ${AGENT_ATTACHMENT_MAX_COUNT} attachments.`
    );
  }
  const attachments = value.map((attachment) => {
    if (!isAgentAttachmentManifest(attachment)) {
      throw new Error('agentSession:start received an invalid attachment manifest.');
    }
    return { ...attachment };
  });
  if (new Set(attachments.map((attachment) => attachment.id)).size !== attachments.length) {
    throw new Error('agentSession:start attachments must be unique.');
  }
  const totalBytes = attachments.reduce((total, attachment) => total + attachment.size, 0);
  if (totalBytes > AGENT_ATTACHMENT_MAX_TOTAL_BYTES) {
    throw new Error('agentSession:start attachments exceed the 4 MiB combined limit.');
  }
  return attachments.length > 0 ? attachments : undefined;
}

function sanitizeStartRequest(value: unknown): AgentSessionStartRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('agentSession:start requires a request object.');
  }
  const raw = value as Record<string, unknown>;
  if ('permissionMode' in raw && !raw.authorityProfileId) {
    throw new Error(
      'agentSession:start requires a concrete authorityProfileId, not a legacy permissionMode.'
    );
  }
  if (!isAgentProvider(raw.provider)) {
    throw new Error(`Unknown agent provider: ${String(raw.provider)}`);
  }
  let binaryPathOverride: string | undefined;
  if (raw.binaryPathOverride !== undefined) {
    if (typeof raw.binaryPathOverride !== 'string') {
      throw new Error('agentSession:start custom harness executable must be a string.');
    }
    const normalizedPath = raw.binaryPathOverride.trim();
    if (
      normalizedPath.length === 0 ||
      normalizedPath.length > 4096 ||
      normalizedPath.includes('\0') ||
      !isAbsolute(normalizedPath)
    ) {
      throw new Error('agentSession:start custom harness executable must be an absolute path.');
    }
    binaryPathOverride = normalizedPath;
  }
  if (typeof raw.authorityProfileId !== 'string' || raw.authorityProfileId.length === 0) {
    throw new Error('agentSession:start requires authorityProfileId.');
  }
  if (typeof raw.prompt !== 'string' || raw.prompt.length === 0) {
    throw new Error('agentSession:start requires a non-empty prompt.');
  }
  if (raw.cwd !== undefined && raw.cwd !== null && typeof raw.cwd !== 'string') {
    throw new Error('agentSession:start cwd must be a string when provided.');
  }
  if (
    raw.sessionId !== undefined &&
    (typeof raw.sessionId !== 'string' || !validId(raw.sessionId))
  ) {
    throw new Error('agentSession:start requires a valid sessionId.');
  }
  if (
    raw.conversationId !== undefined &&
    raw.conversationId !== null &&
    typeof raw.conversationId !== 'string'
  ) {
    throw new Error('agentSession:start requires a string conversationId when provided.');
  }
  if (raw.turnId !== undefined && raw.turnId !== null && typeof raw.turnId !== 'string') {
    throw new Error('agentSession:start requires a string turnId when provided.');
  }
  if (typeof raw.turnId === 'string' && !validId(raw.turnId)) {
    throw new Error('agentSession:start requires a valid turnId when provided.');
  }
  if (raw.workspaceGrounding !== 'required' && raw.workspaceGrounding !== 'not-required') {
    throw new Error('agentSession:start requires a workspaceGrounding policy.');
  }
  if (
    raw.toolExposure !== undefined &&
    raw.toolExposure !== 'none' &&
    raw.toolExposure !== 'auto' &&
    raw.toolExposure !== 'required'
  ) {
    throw new Error('agentSession:start toolExposure is not supported.');
  }
  const cwd = typeof raw.cwd === 'string' && raw.cwd.trim().length > 0 ? raw.cwd : null;
  const modelPersonality = sanitizeOptionalPersonality(raw.modelPersonality, raw.provider);
  return {
    sessionId: raw.sessionId,
    conversationId: raw.conversationId ?? null,
    turnId: raw.turnId ?? null,
    provider: raw.provider,
    ...(binaryPathOverride ? { binaryPathOverride } : {}),
    authorityProfileId: raw.authorityProfileId,
    prompt: raw.prompt,
    continuationPrompt: sanitizeContinuationPrompt(raw.continuationPrompt),
    cwd,
    reachRoots: sanitizeReachRoots(raw.reachRoots),
    workspaceGrounding: raw.workspaceGrounding,
    toolExposure: raw.toolExposure ?? 'auto',
    shellSupervision: sanitizeShellSupervision(raw.shellSupervision),
    permissions: sanitizePermissions(raw.permissions),
    additionalAgentInstructions: sanitizeAdditionalAgentInstructions(
      raw.additionalAgentInstructions
    ),
    model: sanitizeOptionalModel(raw.model),
    modelReasoningEffort: sanitizeOptionalEffort(raw.modelReasoningEffort),
    modelServiceTier: sanitizeOptionalServiceTier(raw.modelServiceTier),
    modelPersonality,
    capabilitySelection: sanitizeCapabilitySelection(raw.capabilitySelection, raw.provider),
    attachments: sanitizeAttachments(raw.attachments),
  };
}

function failedStartResult(error: unknown, request: unknown): AgentSessionRunResult {
  const raw = request && typeof request === 'object' ? (request as Record<string, unknown>) : {};
  const provider = isAgentProvider(raw.provider) ? raw.provider : 'codex-sdk';
  const sessionId =
    typeof raw.sessionId === 'string' && validId(raw.sessionId) ? raw.sessionId : '';
  const authorityProfileId =
    typeof raw.authorityProfileId === 'string' ? raw.authorityProfileId : '';
  return {
    sessionId,
    provider,
    authorityProfileId,
    ok: false,
    text: '',
    error: error instanceof Error ? error.message : String(error),
    durationMs: 0,
    stopState: 'failed',
    workspaceProvenance: {
      policy: raw.workspaceGrounding === 'required' ? 'required' : 'not-required',
      grounded: false,
      completedWorkspaceTools: [],
      completedWorkspaceResources: [],
    },
  };
}

export function registerAgentSessionHandlers(manager = getManager()): void {
  handleGroup(agentSessionContract, {
    start: async (event, request: unknown) => {
      try {
        const sanitized = sanitizeStartRequest(request);
        return await manager.startSession(sanitized, (envelope) => {
          sendRendererIpc(event.sender, 'agentSession:event', envelope);
        });
      } catch (err) {
        return failedStartResult(err, request);
      }
    },
    cancel: (_event, sessionId: unknown) =>
      manager.requestStop(typeof sessionId === 'string' ? sessionId : ''),
    get: (_event, sessionId: unknown) => {
      if (typeof sessionId !== 'string' || !validId(sessionId)) return null;
      return manager.getSession(sessionId);
    },
    listSchedules: () => manager.listSchedules(),
    listAlwaysAllowRules: () => defaultApprovalMemory()?.alwaysRules() ?? [],
    permissionCatalog: () => readAgentPermissionCatalog(),
    setAlwaysAllowRuleEnabled: (_event, key: unknown, enabled: unknown) => {
      if (typeof key !== 'string' || typeof enabled !== 'boolean') {
        throw new Error('agentSession:setAlwaysAllowRuleEnabled needs a rule key and a boolean.');
      }
      return defaultApprovalMemory()?.setAlwaysRuleEnabled(key, enabled) ?? [];
    },
    removeAlwaysAllowRule: (_event, key: unknown) => {
      if (typeof key !== 'string') {
        throw new Error('agentSession:removeAlwaysAllowRule needs a rule key.');
      }
      return defaultApprovalMemory()?.removeAlwaysRule(key) ?? [];
    },
    cancelSchedule: (_event, scheduleId: unknown) => {
      if (typeof scheduleId !== 'string' || !validScheduleId(scheduleId)) {
        return Promise.resolve({
          ok: false,
          schedule: null,
          error: 'agentSession:cancelSchedule requires a valid scheduleId.',
        });
      }
      return manager.cancelSchedule(scheduleId);
    },
  });
}
