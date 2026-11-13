import type { WorkspaceFolder } from '../../stores/workspaceStore';
import { getCurrentWorkspaceScope, useWorkspaceStore } from '../../stores/workspaceStore';
import { captureDomainStateSnapshot, type DomainStateSnapshot } from './domain-state-snapshot';
import {
  getAllowedRendererTool,
  executeRendererToolDefinition,
  resolveRendererToolAuthorization,
  type RendererToolDefinition,
} from './renderer-tools';
import { hasRequiredCapabilities } from './capability-policy';
import { resolveWorkspaceBinding } from './workspace-binding';

export type CoreRendererToolErrorCode =
  | 'UNKNOWN_TOOL'
  | 'BAD_SESSION'
  | 'INSUFFICIENT_SCOPE'
  | 'BAD_INPUT'
  | 'NO_WORKSPACE'
  | 'WRONG_WORKSPACE'
  | 'AUDIT_UNAVAILABLE'
  | 'HANDLER_ERROR'
  | 'STOP_REQUESTED'
  | 'CANCELED';

export type StructureMcpRendererToolErrorCode =
  | 'NO_RESOLVER_MATCH'
  | 'PROVIDER_ERROR'
  | 'STRUCTURE_RENDER_ERROR'
  | 'SIDECAR_TIMEOUT'
  | 'SIDECAR_UNAVAILABLE'
  | 'URL_NOT_ALLOWED'
  | 'PDB_NOT_FOUND'
  | 'UNIPROT_NOT_FOUND'
  | 'VIEWER_NOT_FOUND'
  | 'PLUGIN_NOT_READY'
  | 'IPC_BRIDGE_CLOSED'
  | 'SELECTION_PARSE_ERROR'
  | 'EMPTY_SELECTION'
  | 'INVALID_REPRESENTATION'
  | 'MOLSTAR_RUNTIME_ERROR'
  | 'RENDER_ERROR'
  | 'SCREENSHOT_TOO_LARGE';

export type SequenceMcpRendererToolErrorCode = 'SEQUENCE_NOT_OPEN' | 'BAD_ANNOTATION_INDEX';

export type RendererToolErrorCode =
  | CoreRendererToolErrorCode
  | StructureMcpRendererToolErrorCode
  | SequenceMcpRendererToolErrorCode
  | (string & Record<never, never>);

export type RendererToolErrorDomain = 'core' | 'structure-mcp' | 'sequence-mcp';

export interface RendererToolCallRequest {
  tool_name: string;
  args?: unknown;
  agent_identity: string;
  action_id: string;
  parent_action_id?: string;
}

export interface RendererToolCallError {
  code: RendererToolErrorCode;
  domain?: RendererToolErrorDomain;
  message: string;
  retriable: boolean;
  details?: Record<string, unknown>;
}

export class RendererToolCallException extends Error {
  readonly rendererError: RendererToolCallError;

  constructor(error: RendererToolCallError) {
    super(error.message);
    this.name = 'RendererToolCallException';
    this.rendererError = error;
  }
}

export function rendererToolCallError(error: RendererToolCallError): RendererToolCallException {
  return new RendererToolCallException(error);
}

export type RendererToolCallResponse =
  | { ok: true; result: unknown; audit_id: string }
  | { ok: false; error: RendererToolCallError; audit_id?: string };

export interface RendererAuditRecord {
  action_id: string;
  parent_action_id?: string;
  tool_name: string;
  actor_kind: 'renderer';
  actor_identity: string;
  actor_scope: string[];
  side_effects: string[];
  capability_check: {
    required: string[];

    effective_required: string[];
    satisfied: boolean;
    reason: string;
  };
  status: 'accepted' | 'completed' | 'rejected' | 'failed';
  outcome?: { ok: true; result: unknown } | { ok: false; error: RendererToolCallError };
  error?: RendererToolCallError;

  before_state?: DomainStateSnapshot;

  after_state?: DomainStateSnapshot;
}

export interface RendererAuditSink {
  write(record: RendererAuditRecord): Promise<string>;
}

type AuditFetch = typeof fetch;

export interface RendererBridgeContext {
  turnId?: string;
  expectedSessionToken?: string;
  providedSessionToken?: string;
  agentCapabilities?: string[];
  folders?: WorkspaceFolder[];
  boundWorkspaceId?: string | null;
  currentWorkspaceId?: string | null;
  auditSink?: RendererAuditSink;
  abortSignal?: AbortSignal;

  trustedContext?: unknown;
}

interface EffectiveToolAuthorization {
  requiredCapabilities: readonly string[];
  requiresWorkspace: boolean;
}

export function getCurrentRendererWorkspaceId(): string | null {
  return getCurrentWorkspaceScope();
}

export function createConsoleRendererAuditSink(): RendererAuditSink {
  return {
    async write(record) {
      const auditId = crypto.randomUUID();
      console.info('[agent-bridge] renderer audit', { auditId, ...record });
      return auditId;
    },
  };
}

export function createHttpRendererAuditSink(options: {
  apiUrl: string;
  fetchImpl?: AuditFetch;
}): RendererAuditSink {
  const baseUrl = options.apiUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async write(record) {
      const response = await fetchImpl(`${baseUrl}/mcp/renderer-audit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(record),
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok || !isRendererAuditResponse(payload)) {
        throw new Error('Renderer audit persistence failed.');
      }
      return payload.audit_id;
    },
  };
}

export async function callRendererTool(
  request: RendererToolCallRequest,
  context: RendererBridgeContext = {}
): Promise<RendererToolCallResponse> {
  if (
    context.expectedSessionToken !== undefined &&
    context.expectedSessionToken !== context.providedSessionToken
  ) {
    return {
      ok: false,
      error: {
        code: 'BAD_SESSION',
        domain: 'core',
        message: 'Renderer tool session token is missing or invalid.',
        retriable: true,
      },
    };
  }

  const tool = getAllowedRendererTool(request.tool_name);
  if (!tool) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_TOOL',
        domain: 'core',
        message: `Unknown renderer tool: ${request.tool_name}`,
        retriable: false,
      },
    };
  }

  const input = request.args ?? {};
  const authorization = resolveRendererToolAuthorization(request.tool_name, input);
  if (!authorization) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_TOOL',
        domain: 'core',
        message: `Unknown renderer tool: ${request.tool_name}`,
        retriable: false,
      },
    };
  }
  const availableFolders = context.folders ?? useWorkspaceStore.getState().folders;

  const resolveWorkspaceId = (): string | null =>
    context.currentWorkspaceId === undefined
      ? getCurrentRendererWorkspaceId()
      : context.currentWorkspaceId;
  const currentWorkspaceId = resolveWorkspaceId();
  const workspaceBinding = resolveWorkspaceBinding({
    boundWorkspaceId: context.boundWorkspaceId,
    currentWorkspaceId,
    folders: availableFolders,
  });
  const folders = workspaceBinding.folders;
  const actorScope = context.agentCapabilities ?? [];
  const workspaceError = checkWorkspace(authorization, {
    boundWorkspaceId: context.boundWorkspaceId,
    currentWorkspaceId,
    bindingMatches: workspaceBinding.ok,
    hasWorkspace:
      workspaceBinding.ok && (folders.length > 0 || workspaceBinding.workspaceId !== null),
  });
  if (workspaceError) {
    return rejectWithAudit(
      request,
      context,
      tool,
      authorization,
      workspaceError,
      false,
      resolveWorkspaceId
    );
  }

  if (!hasRequiredCapabilities(actorScope, authorization.requiredCapabilities)) {
    const error: RendererToolCallError = {
      code: 'INSUFFICIENT_SCOPE',
      domain: 'core',
      message: 'Agent identity does not have the capabilities required for this renderer tool.',
      retriable: false,
      details: {
        required: [...authorization.requiredCapabilities],
        provided: actorScope,
      },
    };
    return rejectWithAudit(request, context, tool, authorization, error, false, resolveWorkspaceId);
  }

  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    const error: RendererToolCallError = {
      code: 'BAD_INPUT',
      domain: 'core',
      message: 'Renderer tool input failed validation.',
      retriable: false,
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    };
    return rejectWithAudit(request, context, tool, authorization, error, true, resolveWorkspaceId);
  }

  const acceptedBeforeState = snapshotForWriteAction(tool, resolveWorkspaceId());
  let acceptedAuditId: string | undefined;
  if (requiresPreExecutionAudit(tool)) {
    const acceptedAudit = await tryWriteAudit(
      request,
      context,
      tool,
      authorization,
      'accepted',
      undefined,
      true,
      acceptedBeforeState ? { before: acceptedBeforeState } : undefined
    );
    if (!acceptedAudit.ok) {
      return { ok: false, error: auditUnavailableError(acceptedAudit.error) };
    }
    acceptedAuditId = acceptedAudit.auditId;
  }

  let result: unknown;
  try {
    if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
      await (
        await import('./renderer-operation-test-barrier')
      ).waitAtRendererOperationBarrier('before-handler', request.action_id);
    }
    if (context.abortSignal?.aborted) {
      throw rendererToolCallError({
        code: 'CANCELED',
        domain: 'core',
        message: 'Operation canceled before execution.',
        retriable: true,
        details: { stateMayHaveChanged: false },
      });
    }
    result = await executeRendererToolDefinition(tool, parsed.data, {
      turnId: context.turnId,
      folders,
      actionId: request.action_id,
      grantedCapabilities: actorScope,
      abortSignal: context.abortSignal,
      trustedContext: context.trustedContext,
    });

    try {
      result = JSON.parse(JSON.stringify(result));
    } catch {
      throw rendererToolCallError({
        code: 'INVALID_TOOL_OUTPUT',
        domain: 'core',
        message:
          'The tool returned a result that cannot be serialized as JSON. Recover the original action before retrying.',
        retriable: false,
        details: { stateMayHaveChanged: true },
      });
    }
    if (
      tool.outputSchema &&
      !rendererErrorFromReturnedFailure(result) &&
      !tool.outputSchema.safeParse(result).success
    ) {
      throw rendererToolCallError({
        code: 'INVALID_TOOL_OUTPUT',
        domain: 'core',
        message:
          'The tool returned a result that does not match its advertised schema. Recover the original action before retrying.',
        retriable: false,
        details: { stateMayHaveChanged: true },
      });
    }
  } catch (err) {
    const error = rendererErrorFromThrown(err, {
      code: context.abortSignal?.aborted ? 'CANCELED' : 'HANDLER_ERROR',
      domain: 'core',

      message: describeThrownError(err),
      retriable: context.abortSignal?.aborted === true && !requiresPreExecutionAudit(tool),
      details: { stateMayHaveChanged: requiresPreExecutionAudit(tool) },
    });
    const afterState = snapshotForWriteAction(tool, resolveWorkspaceId());

    const failedAudit = await tryWriteAudit(
      request,
      context,
      tool,
      authorization,
      'failed',
      error,
      true,
      acceptedBeforeState ? { before: acceptedBeforeState, after: afterState } : undefined
    );
    const auditId = failedAudit.ok ? failedAudit.auditId : acceptedAuditId;
    return { ok: false, error, audit_id: auditId };
  }

  if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
    await (
      await import('./renderer-operation-test-barrier')
    ).waitAtRendererOperationBarrier('after-handler', request.action_id);
  }
  const returnedFailure = rendererErrorFromReturnedFailure(result);
  const completedAfterState = snapshotForWriteAction(tool, resolveWorkspaceId());
  const auditResult = tool.projectAuditResult ? tool.projectAuditResult(result) : result;
  const completedAudit = await tryWriteAudit(
    request,
    context,
    tool,
    authorization,
    returnedFailure ? 'failed' : 'completed',
    returnedFailure,
    true,
    acceptedBeforeState ? { before: acceptedBeforeState, after: completedAfterState } : undefined,
    auditResult
  );
  if (!completedAudit.ok) {
    const auditError = auditUnavailableError(completedAudit.error);
    return {
      ok: false,
      error: {
        ...auditError,
        details: {
          ...(auditError.details ?? {}),
          terminalStatus: returnedFailure ? 'failed' : 'completed',
          stateMayHaveChanged: requiresPreExecutionAudit(tool),
          ...(returnedFailure ? { handlerError: returnedFailure } : {}),
        },
      },
      ...(acceptedAuditId ? { audit_id: acceptedAuditId } : {}),
    };
  }
  if (returnedFailure) {
    return { ok: false, error: returnedFailure, audit_id: completedAudit.auditId };
  }
  return { ok: true, result, audit_id: completedAudit.auditId };
}

function rendererErrorFromReturnedFailure(result: unknown): RendererToolCallError | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const candidate = result as Record<string, unknown>;
  if (candidate.ok !== false) return undefined;

  const domainCode = typeof candidate.code === 'string' ? candidate.code : undefined;
  const message =
    typeof candidate.error === 'string' && candidate.error.trim().length > 0
      ? candidate.error
      : typeof candidate.message === 'string' && candidate.message.trim().length > 0
        ? candidate.message
        : domainCode
          ? `Renderer tool returned ${domainCode}`
          : 'Renderer tool returned a domain failure';
  const returnedDetails =
    candidate.details && typeof candidate.details === 'object' && !Array.isArray(candidate.details)
      ? (candidate.details as Record<string, unknown>)
      : undefined;
  const details: Record<string, unknown> = { ...(returnedDetails ?? {}) };
  if (domainCode) details.domainCode = domainCode;
  if (typeof candidate.stateChanged === 'boolean' || candidate.stateChanged === 'unknown') {
    details.stateChanged = candidate.stateChanged;
  }
  if (candidate.stateChanged === 'unknown') details.stateMayHaveChanged = true;
  if (Array.isArray(candidate.partialEffects)) details.partialEffects = candidate.partialEffects;

  return {
    code: domainCode ?? 'HANDLER_ERROR',
    domain: 'core',
    message,
    retriable: candidate.retriable === true,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

function checkWorkspace(
  authorization: EffectiveToolAuthorization,
  context: {
    boundWorkspaceId?: string | null;
    currentWorkspaceId?: string | null;
    bindingMatches?: boolean;
    hasWorkspace: boolean;
  }
): RendererToolCallError | null {
  const currentWorkspaceId =
    context.currentWorkspaceId === undefined
      ? getCurrentRendererWorkspaceId()
      : context.currentWorkspaceId;

  const bindingMatches =
    context.bindingMatches ??
    (context.boundWorkspaceId === undefined || context.boundWorkspaceId === currentWorkspaceId);
  if (!bindingMatches) {
    return {
      code: 'WRONG_WORKSPACE',
      domain: 'core',
      message: 'Renderer tool session is bound to a different project.',
      retriable: true,
      details: {
        boundWorkspaceId: context.boundWorkspaceId,
        currentWorkspaceId,
        stateMayHaveChanged: false,
      },
    };
  }

  if (authorization.requiresWorkspace && !context.hasWorkspace) {
    return {
      code: 'NO_WORKSPACE',
      domain: 'core',
      message: 'Renderer tool requires an open project.',
      retriable: true,
    };
  }

  return null;
}

function describeThrownError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message) return err.message;
    const className = err.name || err.constructor.name || 'Error';
    const firstStackLine = err.stack?.split('\n').find((line) => line.trim().startsWith('at '));
    return firstStackLine
      ? `${className} (no message) ${firstStackLine.trim()}`
      : `${className} (no message)`;
  }
  if (typeof err === 'string') {
    return err || 'Renderer tool handler threw an empty string';
  }
  if (err === null) return 'Renderer tool handler threw null';
  if (err === undefined) return 'Renderer tool handler threw undefined';
  try {
    const serialized = JSON.stringify(err);
    return serialized && serialized !== '{}'
      ? `Non-Error thrown: ${serialized}`
      : `Non-Error thrown: ${String(err)}`;
  } catch {
    return `Non-Error thrown (unserializable): ${String(err)}`;
  }
}

function rendererErrorFromThrown(
  err: unknown,
  fallback: RendererToolCallError
): RendererToolCallError {
  if (err instanceof RendererToolCallException) {
    return err.rendererError;
  }
  if (isRendererToolCallError(err)) {
    return {
      code: err.code,
      domain: err.domain ?? fallback.domain,
      message: err.message,
      retriable: err.retriable,
      ...(err.details ? { details: err.details } : {}),
    };
  }
  return fallback;
}

function isRendererToolCallError(err: unknown): err is RendererToolCallError {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as Partial<RendererToolCallError>;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    typeof candidate.retriable === 'boolean' &&
    (candidate.details === undefined ||
      (typeof candidate.details === 'object' && candidate.details !== null))
  );
}

function requiresPreExecutionAudit(tool: RendererToolDefinition): boolean {
  return tool.effects.some((effect) => effect !== 'read-only');
}

function snapshotForWriteAction(
  tool: RendererToolDefinition,
  workspaceId: string | null
): DomainStateSnapshot | undefined {
  if (!requiresPreExecutionAudit(tool)) return undefined;
  return captureDomainStateSnapshot(workspaceId);
}

interface RendererAuditDomainState {
  before?: DomainStateSnapshot;
  after?: DomainStateSnapshot;
}

async function rejectWithAudit(
  request: RendererToolCallRequest,
  context: RendererBridgeContext,
  tool: RendererToolDefinition,
  authorization: EffectiveToolAuthorization,
  error: RendererToolCallError,
  capabilitySatisfied: boolean,
  resolveWorkspaceId: () => string | null
): Promise<RendererToolCallResponse> {
  const beforeState = snapshotForWriteAction(tool, resolveWorkspaceId());
  const auditId = await writeAudit(
    request,
    context,
    tool,
    authorization,
    'rejected',
    error,
    capabilitySatisfied,
    beforeState ? { before: beforeState } : undefined
  );
  return { ok: false, error, audit_id: auditId };
}

function auditUnavailableError(error: unknown): RendererToolCallError {
  return {
    code: 'AUDIT_UNAVAILABLE',
    domain: 'core',
    message: `Renderer audit could not be persisted before executing a side-effecting tool: ${
      error instanceof Error ? error.message : String(error)
    }`,
    retriable: true,
  };
}

async function tryWriteAudit(
  request: RendererToolCallRequest,
  context: RendererBridgeContext,
  tool: RendererToolDefinition,
  authorization: EffectiveToolAuthorization,
  status: RendererAuditRecord['status'],
  error: RendererToolCallError | undefined,
  capabilitySatisfied: boolean,
  domainState?: RendererAuditDomainState,
  result?: unknown
): Promise<{ ok: true; auditId: string } | { ok: false; error: unknown }> {
  if (status === 'accepted' && requiresPreExecutionAudit(tool) && !context.auditSink) {
    return {
      ok: false,
      error: new Error('Durable renderer audit sink is required before side-effect execution.'),
    };
  }
  try {
    return {
      ok: true,
      auditId: await writeAudit(
        request,
        context,
        tool,
        authorization,
        status,
        error,
        capabilitySatisfied,
        domainState,
        result
      ),
    };
  } catch (auditError) {
    return { ok: false, error: auditError };
  }
}

async function writeAudit(
  request: RendererToolCallRequest,
  context: RendererBridgeContext,
  tool: RendererToolDefinition,
  authorization: EffectiveToolAuthorization,
  status: RendererAuditRecord['status'],
  error: RendererToolCallError | undefined,
  capabilitySatisfied: boolean,
  domainState?: RendererAuditDomainState,
  result?: unknown
): Promise<string> {
  const sink = context.auditSink ?? createConsoleRendererAuditSink();
  const actorScope = context.agentCapabilities ?? [];

  const afterStatePayload =
    domainState?.after && error ? { ...domainState.after, error } : domainState?.after;
  return sink.write({
    action_id: request.action_id,
    ...(request.parent_action_id ? { parent_action_id: request.parent_action_id } : {}),
    tool_name: request.tool_name,
    actor_kind: 'renderer',
    actor_identity: request.agent_identity,
    actor_scope: actorScope,
    side_effects: [...tool.effects],
    capability_check: {
      required: [...tool.required_capabilities],
      effective_required: [...authorization.requiredCapabilities],
      satisfied: capabilitySatisfied,
      reason: capabilitySatisfied ? 'granted' : (error?.code.toLowerCase() ?? 'rejected'),
    },
    status,
    ...(status === 'completed'
      ? { outcome: { ok: true as const, result: result ?? null } }
      : error
        ? { outcome: { ok: false as const, error } }
        : {}),
    ...(error ? { error } : {}),
    ...(domainState?.before ? { before_state: domainState.before } : {}),
    ...(afterStatePayload ? { after_state: afterStatePayload } : {}),
  });
}

function isRendererAuditResponse(payload: unknown): payload is { ok: true; audit_id: string } {
  return (
    !!payload &&
    typeof payload === 'object' &&
    (payload as { ok?: unknown }).ok === true &&
    typeof (payload as { audit_id?: unknown }).audit_id === 'string' &&
    (payload as { audit_id: string }).audit_id.length > 0
  );
}
