import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { mainIpc, sendRendererIpc } from '../../shared/ipc-contract';
import type {
  AgentAuthBoundaryFailureShape,
  AgentCliPathOverridesShape,
  AgentTransport,
} from '../../shared/agent-runtime-ipc';

import { detectAgentSdk, detectAgentSdkWithModels } from './detect';
import { getAgentHelperLifecycleSnapshot } from './helper-lifecycle';
import {
  externalMcpRegistrationSnapshot,
  refreshExternalMcpRegistration,
} from '../external-mcp-registration';
import { buildStaticProviderProbeMatrix, getProviderProbeVersions } from './probe';
import { queryClaudeCode, queryCodex, queryGrok } from './query';
import { authenticateAgentCli, type AgentAuthOptions, type AgentAuthFailureKind } from './auth';
import type { QueryOptions } from './query';
import { buildCliMcpServerLaunch } from './cli-mcp';
import type { CliMcpBridgeProvider } from './cli-mcp-provider';
export { createReadyCliMcpBridgeProvider } from './cli-mcp-provider';
import { cancelRendererToolCallsForTurn } from '../agent-tools-bridge';
import { trackEvent } from '../analytics';
import type { DestructiveFileConfirmRequest } from '../../shared/agent-confirm-types';
import type { RequestAgentUserInput } from './agent-user-input-adapters';

const inFlightQueries = new Map<string, AbortController>();
let cliMcpBridgeProvider: CliMcpBridgeProvider | null = null;
type ConfirmDestructiveFile = (
  request: Omit<DestructiveFileConfirmRequest, 'requestId'>
) => Promise<import('../../shared/agent-approval').AgentApprovalChoice>;
interface GuardrailContext {
  scratchRoot: string;
  userRoots: string[];
}
let confirmDestructiveFileProvider: (() => ConfirmDestructiveFile | null) | null = null;
let requestUserInputProvider: (() => RequestAgentUserInput | null) | null = null;
let guardrailContextProvider: (() => Promise<GuardrailContext>) | null = null;

export function setAgentSdkCliMcpBridgeProvider(provider: CliMcpBridgeProvider | null): void {
  cliMcpBridgeProvider = provider;
}

export function setAgentSdkConfirmDestructiveFileProvider(
  provider: (() => ConfirmDestructiveFile | null) | null
): void {
  confirmDestructiveFileProvider = provider;
}

export function setAgentSdkRequestUserInputProvider(
  provider: (() => RequestAgentUserInput | null) | null
): void {
  requestUserInputProvider = provider;
}

export function setAgentSdkGuardrailContextProvider(
  provider: (() => Promise<GuardrailContext>) | null
): void {
  guardrailContextProvider = provider;
}

async function resolveDefaultGuardrailContext(): Promise<GuardrailContext> {
  const { app } = await import('electron');
  const { join } = await import('node:path');
  const { getAllowedRoots } = await import('../ipc/path-allowlist');
  return {
    scratchRoot: join(app.getPath('userData'), 'cli-scratch'),
    userRoots: getAllowedRoots(),
  };
}

function cliMcpBridgeTestProbeEnabled(): boolean {
  return (
    process.env.WAYPOINT_TEST === '1' &&
    (process.argv.includes('--e2e') || process.argv.includes('--waypoint-test=1'))
  );
}

function sanitizeQueryOptions(value: unknown): QueryOptions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const raw = value as Record<string, unknown>;
  const options: QueryOptions = {};
  if (raw.purpose === 'probe' || raw.purpose === 'chat') {
    options.purpose = raw.purpose;
  }
  if (typeof raw.cwd === 'string' || raw.cwd === null) {
    options.cwd = raw.cwd;
  }
  if (typeof raw.queryId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(raw.queryId)) {
    options.queryId = raw.queryId;
  }
  if (
    raw.conversationId === null ||
    (typeof raw.conversationId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(raw.conversationId))
  ) {
    options.conversationId = raw.conversationId;
  }
  if (typeof raw.turnId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(raw.turnId)) {
    options.turnId = raw.turnId;
  }
  if (raw.emitTrace === true) {
    options.emitTrace = true;
  }
  if (raw.permissionMode === 'app-supervised' || raw.permissionMode === 'native-cli') {
    options.permissionMode = raw.permissionMode;
  }
  if (
    raw.shellSupervision === 'auto' ||
    raw.shellSupervision === 'destructive-only' ||
    raw.shellSupervision === 'always'
  ) {
    options.shellSupervision = raw.shellSupervision;
  }
  if (
    raw.toolExposure === 'none' ||
    raw.toolExposure === 'auto' ||
    raw.toolExposure === 'required'
  ) {
    options.toolExposure = raw.toolExposure;
  }
  if (raw.model === null) options.model = null;
  else if (typeof raw.model === 'string' && raw.model.trim().length <= 160) {
    options.model = raw.model.trim() || null;
  }
  if (
    raw.modelReasoningEffort === null ||
    raw.modelReasoningEffort === 'none' ||
    raw.modelReasoningEffort === 'minimal' ||
    raw.modelReasoningEffort === 'low' ||
    raw.modelReasoningEffort === 'medium' ||
    raw.modelReasoningEffort === 'high' ||
    raw.modelReasoningEffort === 'xhigh' ||
    raw.modelReasoningEffort === 'max' ||
    raw.modelReasoningEffort === 'ultra'
  ) {
    options.modelReasoningEffort = raw.modelReasoningEffort;
  }
  if (raw.modelServiceTier === null) options.modelServiceTier = null;
  else if (
    typeof raw.modelServiceTier === 'string' &&
    /^[A-Za-z0-9_.:-]{1,160}$/.test(raw.modelServiceTier.trim())
  ) {
    options.modelServiceTier = raw.modelServiceTier.trim();
  }
  if (raw.modelPersonality === null) options.modelPersonality = null;
  else if (
    typeof raw.modelPersonality === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(raw.modelPersonality.trim())
  ) {
    options.modelPersonality = raw.modelPersonality.trim();
  }
  return options;
}

function sanitizeAuthOptions(value: unknown): AgentAuthOptions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const raw = value as Record<string, unknown>;
  const options: AgentAuthOptions = {};
  if (typeof raw.authId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(raw.authId)) {
    options.authId = raw.authId;
  }
  if (isAbsoluteExecutablePath(raw.binaryPathOverride)) {
    options.binaryPathOverride = raw.binaryPathOverride.trim();
  }
  return options;
}

function isAbsoluteExecutablePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) return false;
  const path = value.trim();
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

function sanitizeCliPathOverrides(value: unknown): AgentCliPathOverridesShape {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const transports: AgentTransport[] = ['codex-sdk', 'claude-agent-sdk', 'grok-acp'];
  return Object.fromEntries(
    transports.flatMap((transport) => {
      const candidate = raw[transport];
      return isAbsoluteExecutablePath(candidate) ? [[transport, candidate.trim()]] : [];
    })
  );
}

function authDurationBucket(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 'unknown';
  if (durationMs < 1000) return 'lt_1s';
  if (durationMs < 5000) return '1_5s';
  if (durationMs < 30_000) return '5_30s';
  return '30s_plus';
}

function trackAgentAuthResult(
  transport: unknown,
  result: { authId?: string; ok: boolean; failureKind?: AgentAuthFailureKind; durationMs: number }
): void {
  const vendor =
    transport === 'codex-sdk'
      ? 'codex'
      : transport === 'claude-agent-sdk'
        ? 'claude'
        : transport === 'grok-acp'
          ? 'grok'
          : 'unknown';
  trackEvent('agent_auth_result', {
    feature_area: 'auth',
    auth_vendor: vendor,
    success: result.ok,
    ...(result.failureKind ? { error_class: `${vendor}_${result.failureKind}` } : {}),
    duration_bucket: authDurationBucket(result.durationMs),
  });
  trackEvent('agent_auth_state_observed', {
    feature_area: 'auth',
    operation_id:
      typeof result.authId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        result.authId
      )
        ? result.authId
        : randomUUID(),
    occurred_at_ms: Date.now(),
    auth_vendor: vendor,
    auth_stage: 'native_result',
    auth_outcome: result.ok ? 'succeeded' : 'failed',
    auth_reason: result.failureKind ?? (result.ok ? 'none' : 'unknown'),
  });
}

function cancelInFlightQuery(queryId: unknown): {
  ok: boolean;
  cancelled: boolean;
  error?: string;
} {
  if (typeof queryId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(queryId)) {
    return { ok: false, cancelled: false, error: 'agentSdk:cancelQuery requires a valid queryId.' };
  }
  const controller = inFlightQueries.get(queryId);
  const cancelledRendererToolCalls = cancelRendererToolCallsForTurn(queryId);
  if (!controller && cancelledRendererToolCalls === 0) {
    return { ok: true, cancelled: false };
  }
  controller?.abort();
  return { ok: true, cancelled: true };
}

export function registerAgentSdkHandlers(): void {
  mainIpc.handle('agentSdk:detect', (_event, pathOverrides: unknown) =>
    detectAgentSdkWithModels(sanitizeCliPathOverrides(pathOverrides))
  );
  mainIpc.handle('agentSdk:getHelperLifecycleSnapshot', async () =>
    getAgentHelperLifecycleSnapshot()
  );
  mainIpc.handle('agentSdk:getExternalMcpRegistration', async () =>
    externalMcpRegistrationSnapshot()
  );
  mainIpc.handle('agentSdk:refreshExternalMcpRegistration', () =>
    refreshExternalMcpRegistration({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    })
  );
  mainIpc.handle('agentSdk:cancelQuery', (_event, queryId: unknown) =>
    cancelInFlightQuery(queryId)
  );
  mainIpc.handle('agentSdk:probeMatrix', async () => {
    const detection = await detectAgentSdk();
    const versions = await getProviderProbeVersions(detection);
    return buildStaticProviderProbeMatrix(detection, versions);
  });
  if (cliMcpBridgeTestProbeEnabled()) {
    mainIpc.handle('agentSdk:getMcpBridgeLaunchForTest', async () => {
      const config = (await cliMcpBridgeProvider?.()) ?? null;
      if (!config) {
        throw new Error('Electron main has no active CLI MCP bridge provider.');
      }
      const { serverName, command, args, env } = buildCliMcpServerLaunch(config);
      return { serverName, command, args, env };
    });
  }
  mainIpc.handle('agentSdk:authenticate', async (event, transport: unknown, options: unknown) => {
    if (transport !== 'claude-agent-sdk' && transport !== 'codex-sdk' && transport !== 'grok-acp') {
      const invalidResult: AgentAuthBoundaryFailureShape = {
        authId: '',
        transport: String(transport),
        ok: false,
        status: 'failed' as const,
        failureKind: 'invalid_transport' as const,
        command: [] as string[],
        output: '',
        error: `Unknown agent transport: ${String(transport)}`,
        durationMs: 0,
      };
      trackAgentAuthResult(transport, invalidResult);
      return invalidResult;
    }
    const authOptions = sanitizeAuthOptions(options);
    try {
      const result = await authenticateAgentCli(transport, authOptions, (authEvent) => {
        sendRendererIpc(event.sender, 'agentSdk:authEvent', {
          authId: authEvent.authId,
          event: authEvent,
        });
      });
      trackAgentAuthResult(transport, result);
      return result;
    } catch (err) {
      trackAgentAuthResult(transport, {
        authId: authOptions.authId,
        ok: false,
        failureKind: 'handler_error',
        durationMs: 0,
      });
      throw err;
    }
  });

  mainIpc.handle(
    'agentSdk:query',
    async (event, transport: unknown, prompt: unknown, options: unknown) => {
      if (typeof prompt !== 'string' || prompt.length === 0) {
        return {
          transport: String(transport),
          ok: false,
          text: '',
          error: 'agentSdk:query requires a non-empty prompt.',
          durationMs: 0,
        };
      }
      if (
        transport !== 'claude-agent-sdk' &&
        transport !== 'codex-sdk' &&
        transport !== 'grok-acp'
      ) {
        return {
          transport: String(transport),
          ok: false,
          text: '',
          error: `Unknown agent transport: ${String(transport)}`,
          durationMs: 0,
        };
      }
      const queryOptions = sanitizeQueryOptions(options);
      const queryId = queryOptions.queryId;
      if (queryId && inFlightQueries.has(queryId)) {
        return {
          transport: String(transport),
          ok: false,
          text: '',
          error: `agentSdk:query already has an in-flight query for ${queryId}.`,
          durationMs: 0,
        };
      }

      const abortController = new AbortController();
      if (queryId) inFlightQueries.set(queryId, abortController);
      const startedAt = Date.now();
      try {
        const confirmDestructiveFile =
          queryOptions.purpose === 'chat'
            ? (confirmDestructiveFileProvider?.() ?? undefined)
            : undefined;
        const guardrailContext = confirmDestructiveFile
          ? await (guardrailContextProvider?.() ?? resolveDefaultGuardrailContext())
          : null;
        const internalOptions: QueryOptions = {
          ...queryOptions,
          abortController,
          cliMcpBridge:
            queryOptions.purpose === 'chat' && queryOptions.toolExposure !== 'none'
              ? ((await cliMcpBridgeProvider?.(abortController.signal)) ?? null)
              : null,
          shellSupervision: queryOptions.shellSupervision ?? 'always',
          userRoots: guardrailContext?.userRoots,
          scratchRoot: guardrailContext?.scratchRoot,
          confirmDestructiveFile,
          requestUserInput:
            queryOptions.purpose === 'chat'
              ? (requestUserInputProvider?.() ?? undefined)
              : undefined,
          traceSink:
            queryOptions.emitTrace && queryId
              ? (traceEvent) => {
                  sendRendererIpc(event.sender, 'agentSdk:traceEvent', {
                    queryId,
                    event: traceEvent,
                  });
                }
              : undefined,
        };

        abortController.signal.throwIfAborted();
        internalOptions.cliMcpBridge?.assertCurrent?.();
        if (transport === 'claude-agent-sdk') {
          return await queryClaudeCode(prompt, internalOptions);
        }
        if (transport === 'codex-sdk') {
          return await queryCodex(prompt, internalOptions);
        }
        return await queryGrok(prompt, internalOptions);
      } catch (error) {
        const stopped = abortController.signal.aborted;
        return {
          transport,
          ok: false,
          text: '',
          error: stopped
            ? 'Stop requested.'
            : error instanceof Error
              ? error.message
              : String(error),
          durationMs: Date.now() - startedAt,
          stopState: stopped ? 'stop_requested' : 'failed',
        };
      } finally {
        if (queryId) inFlightQueries.delete(queryId);
      }
    }
  );
}

export type {
  AgentSdkDetection,
  ClaudeCodeDetection,
  CodexDetection,
  GrokDetection,
} from './detect';
export type {
  ProviderProbeInput,
  ProviderProbeResult,
  ProviderProbeVersions,
  ProbePermissionMode,
  ProbeReleaseMode,
  ProbeStopState,
  ProbeSupport,
  ProbeToolAccess,
  ProbeTransport,
} from './probe';
export type { QueryOptions, QueryResult } from './query';
export type {
  AgentAuthEvent,
  AgentAuthFailureKind,
  AgentAuthOptions,
  AgentAuthResult,
  AgentAuthStatus,
  AgentAuthStream,
  AgentAuthTransport,
} from './auth';
export { ClaudeTraceAdapter, CodexTraceAdapter, redactProviderSecrets } from './trace-adapter';
export type {
  ProviderTraceAdapter,
  ProviderTraceDisplay,
  ProviderTraceDisplayKind,
  ProviderTraceEvent,
  ProviderTraceTransport,
  ProviderTraceVersionStamp,
} from './trace-adapter';
