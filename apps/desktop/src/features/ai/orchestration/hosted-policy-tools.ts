import {
  userMessageWithValues,
  userMessageValue,
  userToolLabel,
  userMessage,
} from '@waypoint/user-messages';
import { jsonSchema, type ToolSet } from 'ai';
import { hasRequiredCapabilities } from '@waypoint/agent-tools';
import type { JSONValue, LanguageModelV3ToolResultOutput } from '@ai-sdk/provider';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { confirmDialog } from '../../../components/confirm-dialog-store';
import {
  callRendererTool,
  createConsoleRendererAuditSink,
  type RendererAuditRecord,
  type RendererToolCallError,
  type RendererToolCallRequest,
} from '../../agent-bridge/public/renderer-bridge';
import {
  ALLOWED_RENDERER_TOOLS,
  getAllowedRendererTool,
  hostedToolNameForRenderer,
  rendererToolNameForHosted,
  rendererToolSdkInputSchema,
  type RendererToolName,
} from '../../agent-bridge/public/renderer-tools';
import { configureSidecarApiClient } from '../tools/sidecar-client';
import { callMcpToolMcpCallPost, isApiError } from '@waypoint/api-client';
import { resolveCurrentAgentCaller } from '../../../services/agent-caller';
import type { AgentCaller } from '../../../shared/agent-caller';
import type { HostedToolApprovalAuthority } from '../hosted/tool-approval-authority';
import {
  HOSTED_NATIVE_TOOL_DEFINITIONS,
  type HostedNativeToolName,
} from '@waypoint/hosted-ai-contract';
import {
  isHostedToolExecutionDenied,
  isHostedToolExecutionFailure,
  type HostedToolExecutionDenied,
  type HostedToolExecutionFailureResult,
} from './hosted-tool-execution-results';

interface HostedPolicyToolOptions {
  turnId: string;
  serverApprovalAuthority?: HostedToolApprovalAuthority;
  nativeToolExecutor?: HostedNativeToolExecutor;
  toolNameFormat?: 'canonical' | 'provider-safe';
}

const PROVIDER_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export function toHostedProviderToolName(canonicalName: string): string {
  if (getAllowedRendererTool(canonicalName)) {
    return hostedToolNameForRenderer(canonicalName as RendererToolName);
  }
  if (PROVIDER_TOOL_NAME_PATTERN.test(canonicalName)) return canonicalName;
  const providerName = canonicalName.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!PROVIDER_TOOL_NAME_PATTERN.test(providerName)) {
    throw new Error(
      `Canonical tool name cannot be represented for a Hosted provider: ${canonicalName}`
    );
  }
  return providerName;
}

const CANONICAL_HOSTED_TOOL_NAMES: readonly string[] = [
  ...Object.values(ALLOWED_RENDERER_TOOLS)
    .filter((definition) => definition.exposure.kind === 'shared')
    .map((definition) => definition.name),
  ...HOSTED_NATIVE_TOOL_DEFINITIONS.map((definition) => definition.name),
];
const PROVIDER_TO_CANONICAL_TOOL_NAME = new Map<string, string>();
for (const canonicalName of CANONICAL_HOSTED_TOOL_NAMES) {
  const providerName = toHostedProviderToolName(canonicalName);
  const collision = PROVIDER_TO_CANONICAL_TOOL_NAME.get(providerName);
  if (collision && collision !== canonicalName) {
    throw new Error(
      `Hosted provider tool alias collision: ${collision} and ${canonicalName} both map to ${providerName}`
    );
  }
  PROVIDER_TO_CANONICAL_TOOL_NAME.set(providerName, canonicalName);
}

export function toCanonicalHostedToolName(providerOrCanonicalName: string): string {
  if (CANONICAL_HOSTED_TOOL_NAMES.includes(providerOrCanonicalName)) {
    return providerOrCanonicalName;
  }
  const rendererName = rendererToolNameForHosted(providerOrCanonicalName);
  if (rendererName) return rendererName;
  return PROVIDER_TO_CANONICAL_TOOL_NAME.get(providerOrCanonicalName) ?? providerOrCanonicalName;
}

export interface HostedToolExecutionContext {
  toolCallId?: string;
  abortSignal?: AbortSignal;
}

export type HostedNativeToolExecutor = (
  toolName: HostedNativeToolName,
  args: Record<string, unknown>,
  context: HostedToolExecutionContext
) => Promise<{ readonly output: unknown; readonly effectReceiptRef: string }>;

export function normalizeHostedRendererToolInput(toolName: string, input: unknown): unknown {
  const tool = getAllowedRendererTool(rendererToolNameForHosted(toolName) ?? toolName);
  if (!tool) return input;
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Renderer tool input failed canonical schema validation: ${toolName}.`);
  }
  return parsed.data;
}

export type HostedNativeToolDispatchErrorCode =
  | 'invalid_request'
  | 'signed_out'
  | 'user_declined'
  | 'stopped'
  | 'tool_failed';

export class HostedNativeToolDispatchError extends Error {
  constructor(
    readonly code: HostedNativeToolDispatchErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'HostedNativeToolDispatchError';
  }
}

interface NormalizedToolFailure {
  code: string;
  message: string;
  retriable: boolean;
  details: Record<string, unknown> | null;
  actionId: string | null;
  auditId: string | null;
}

const USER_DECLINED_REASON = 'The user declined this project change.';
const STOPPED_BEFORE_TOOL_REASON = 'Stopped before this tool ran.';

function deniedToolExecution(reason = USER_DECLINED_REASON): HostedToolExecutionDenied {
  return {
    __dnaforgeHostedExecutionDenied: true,
    code: 'USER_DECLINED',
    reason,
  };
}

function stoppedToolExecution(): HostedToolExecutionFailureResult {
  return {
    __dnaforgeHostedExecutionFailure: true,
    code: 'STOPPED',
    message: STOPPED_BEFORE_TOOL_REASON,
  };
}

function failedToolExecution(error: unknown): HostedToolExecutionFailureResult {
  return {
    __dnaforgeHostedExecutionFailure: true,
    code: 'TOOL_FAILED',
    message: error instanceof Error ? error.message : 'The DNAForge tool failed.',
  };
}

function observationForModelOutput(
  output: LanguageModelV3ToolResultOutput
): Record<string, unknown> {
  switch (output.type) {
    case 'text':
    case 'json':
      return { ok: true, result: output.value };
    case 'error-text':
    case 'error-json':
      return { ok: false, error: { code: 'TOOL_FAILED', message: output.value } };
    case 'execution-denied':
      return {
        ok: false,
        error: {
          code: 'USER_DECLINED',
          message: output.reason ?? USER_DECLINED_REASON,
        },
      };
    case 'content':
      throw new Error('Rich Hosted tool observations are not supported.');
  }
}

function observationForExecutionResult(
  executionResult: unknown,
  modelOutput: LanguageModelV3ToolResultOutput,
  rendererStateDiff?: readonly RendererStateDiffEntry[]
): Record<string, unknown> {
  if (isHostedToolExecutionFailure(executionResult) && executionResult.code === 'STOPPED') {
    return {
      ok: false,
      error: { code: 'STOPPED', message: executionResult.message },
    };
  }
  return {
    ...observationForModelOutput(modelOutput),
    ...(rendererStateDiff && rendererStateDiff.length > 0
      ? { renderer_state_diff: rendererStateDiff }
      : {}),
  };
}

interface RendererStateDiffEntry {
  readonly store: 'sequence' | 'design' | 'page' | 'structureDrawer';
  readonly before: number;
  readonly after: number;
}

function rendererStateDiff(record: RendererAuditRecord | undefined): RendererStateDiffEntry[] {
  if (!record?.before_state || !record.after_state) return [];
  const allowedStores = ['sequence', 'design', 'page', 'structureDrawer'] as const;
  return allowedStores.flatMap((store) => {
    const before = record.before_state?.store_revisions[store];
    const after = record.after_state?.store_revisions[store];
    return Number.isSafeInteger(before) && Number.isSafeInteger(after) && before !== after
      ? [{ store, before: before as number, after: after as number }]
      : [];
  });
}

export class HostedToolExecutionError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly details: Record<string, unknown> | null;
  readonly actionId: string | null;
  readonly auditId: string | null;

  constructor(failure: NormalizedToolFailure) {
    const modelVisibleFailure = {
      code: failure.code,
      message: failure.message,
      retriable: failure.retriable,
      ...(failure.details ? { details: failure.details } : {}),
      ...(failure.actionId ? { actionId: failure.actionId } : {}),
      ...(failure.auditId ? { auditId: failure.auditId } : {}),
    };
    super(
      `${failure.code}: ${failure.message}\nDNAFORGE_TOOL_FAILURE=${JSON.stringify(modelVisibleFailure)}`
    );
    this.name = 'HostedToolExecutionError';
    this.code = failure.code;
    this.retriable = failure.retriable;
    this.details = failure.details;
    this.actionId = failure.actionId;
    this.auditId = failure.auditId;
  }
}

function logHostedToolFailure(
  transport: 'local' | 'sidecar',
  toolName: string,
  failure: NormalizedToolFailure
): void {
  console.error('[hosted-policy-tools] tool dispatch failed', {
    transport,
    toolName,
    code: failure.code,
    retriable: failure.retriable,
    actionId: failure.actionId,
    auditId: failure.auditId,
  });
}

interface SidecarToolResponse {
  ok?: boolean;
  status?: string;
  jobId?: unknown;
  result?: unknown;
  error?: {
    code?: unknown;
    domain?: unknown;
    message?: unknown;
    retriable?: unknown;
    details?: unknown;
  };
}

function normalizeSidecarFailure(
  payload: SidecarToolResponse,
  status: number
): NormalizedToolFailure {
  const code = typeof payload.error?.code === 'string' ? payload.error.code : 'TOOL_FAILED';
  const message =
    typeof payload.error?.message === 'string'
      ? payload.error.message
      : `Shared agent dispatcher returned HTTP ${status}.`;
  const details =
    payload.error?.details &&
    typeof payload.error.details === 'object' &&
    !Array.isArray(payload.error.details)
      ? (payload.error.details as Record<string, unknown>)
      : null;
  const actionId = typeof payload.jobId === 'string' ? payload.jobId : null;
  const rendererAuditId = details?.renderer_audit_id;
  const auditId = typeof rendererAuditId === 'string' ? rendererAuditId : null;
  return {
    code,
    message,
    retriable: payload.error?.retriable === true,
    details,
    actionId,
    auditId,
  };
}

function unwrapRendererResult(payload: SidecarToolResponse, toolName: string): unknown {
  if (!payload.ok || payload.status !== 'completed') {
    const failure = normalizeSidecarFailure(payload, 200);
    logHostedToolFailure('sidecar', toolName, failure);
    throw new HostedToolExecutionError(failure);
  }
  const jobResult = payload.result;
  if (
    jobResult &&
    typeof jobResult === 'object' &&
    (jobResult as { ok?: unknown }).ok === true &&
    'result' in jobResult
  ) {
    return (jobResult as { result: unknown }).result;
  }
  return jobResult;
}

export const SIDECAR_ROUTED_TOOLS = new Set<RendererToolName>(
  (
    Object.entries(ALLOWED_RENDERER_TOOLS) as Array<
      [RendererToolName, (typeof ALLOWED_RENDERER_TOOLS)[RendererToolName]]
    >
  )
    .filter(
      ([, definition]) =>
        'sidecarOrchestrated' in definition && definition.sidecarOrchestrated === true
    )
    .map(([name]) => name)
);

export async function dispatchViaSidecar(
  toolName: string,
  args: unknown,
  options: HostedPolicyToolOptions,
  context: HostedToolExecutionContext
): Promise<unknown> {
  const caller = await resolveCurrentAgentCaller(context.abortSignal);
  if (context.abortSignal?.aborted) {
    throw new DOMException('The AI turn was stopped.', 'AbortError');
  }
  await configureSidecarApiClient(toolName);
  const headers: Record<string, string> = {
    'X-DNAForge-Agent-Identity': caller.agentIdentityId,
    'X-DNAForge-Agent-Capabilities': JSON.stringify(caller.effectiveCapabilities),
    'X-DNAForge-Turn-Id': options.turnId,
  };
  if (context.toolCallId) {
    headers['Idempotency-Key'] = `hosted:${options.turnId}:${toolName}:${context.toolCallId}`;
  }
  let payload: SidecarToolResponse;
  let responseStatus: number;
  try {
    const response = await callMcpToolMcpCallPost(
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: toolName, arguments: args ?? {} },
      },
      { headers, signal: context.abortSignal }
    );
    payload = response.data as SidecarToolResponse;
    responseStatus = response.status;
  } catch (error) {
    if (isApiError(error)) {
      payload = (error.body ?? {}) as SidecarToolResponse;
      const failure = normalizeSidecarFailure(payload, error.status);
      logHostedToolFailure('sidecar', toolName, failure);
      throw new HostedToolExecutionError(failure);
    }
    throw error;
  }
  if (!payload.ok || payload.status !== 'completed') {
    const failure = normalizeSidecarFailure(payload, responseStatus);
    logHostedToolFailure('sidecar', toolName, failure);
    throw new HostedToolExecutionError(failure);
  }
  return unwrapRendererResult(payload, toolName);
}

export function hostedToolRequiresUserApproval(toolName: string): boolean {
  const tool = getAllowedRendererTool(toolName);
  if (tool === null) return true;
  return tool.required_capabilities.some(
    (capability) => capability === 'finalize-protocol' || capability === 'finalize-assembly'
  );
}

function hostedToolIsMutation(toolName: string): boolean {
  return getAllowedRendererTool(toolName)?.effects.includes('mutating') ?? false;
}

function normalizeRendererFailure(
  error: RendererToolCallError,
  auditId: string | null
): NormalizedToolFailure {
  return {
    code: error.code,
    message: error.message,
    retriable: error.retriable,
    details: error.details ?? null,
    actionId: null,
    auditId,
  };
}

export async function dispatchLocally(
  toolName: string,
  args: unknown,
  context: HostedToolExecutionContext
): Promise<unknown> {
  return (await dispatchLocallyWithReceipt(toolName, args, context)).output;
}

async function dispatchLocallyWithReceipt(
  toolName: string,
  args: unknown,
  context: HostedToolExecutionContext,
  verifiedCaller?: AgentCaller
): Promise<{
  readonly output: unknown;
  readonly effectReceiptRef: string;
  readonly rendererStateDiff?: readonly RendererStateDiffEntry[];
}> {
  const caller = verifiedCaller ?? (await resolveCurrentAgentCaller(context.abortSignal));
  if (context.abortSignal?.aborted) {
    throw new DOMException('The AI turn was stopped.', 'AbortError');
  }
  const request: RendererToolCallRequest = {
    tool_name: toolName,
    args,
    agent_identity: caller.agentIdentityId,
    action_id: context.toolCallId ?? crypto.randomUUID(),
  };
  const auditRecords: RendererAuditRecord[] = [];
  const consoleAuditSink = createConsoleRendererAuditSink();
  const response = await callRendererTool(request, {
    agentCapabilities: [...caller.effectiveCapabilities],
    folders: useWorkspaceStore.getState().folders,
    auditSink: {
      async write(record) {
        auditRecords.push(record);
        return consoleAuditSink.write(record);
      },
    },
    abortSignal: context.abortSignal,
  });
  if (!response.ok) {
    const failure = normalizeRendererFailure(response.error, response.audit_id ?? null);
    logHostedToolFailure('local', toolName, failure);
    throw new HostedToolExecutionError(failure);
  }
  const terminalAudit = [...auditRecords]
    .reverse()
    .find((record) => record.status === 'completed' || record.status === 'failed');
  const stateDiff = rendererStateDiff(terminalAudit);
  return {
    output: response.result,
    effectReceiptRef: response.audit_id,
    ...(stateDiff.length > 0 ? { rendererStateDiff: stateDiff } : {}),
  };
}

function isProvablyNoEffectCancellation(error: unknown): boolean {
  if (!(error instanceof HostedToolExecutionError) || error.code !== 'CANCELED') return false;
  const partialEffects = error.details?.partialEffects;
  return (
    error.details?.stateChanged === false &&
    error.details?.stateMayHaveChanged !== true &&
    (partialEffects === undefined || (Array.isArray(partialEffects) && partialEffects.length === 0))
  );
}

function isProvablyPreEffectFailure(error: unknown): boolean {
  if (!(error instanceof HostedToolExecutionError)) return false;
  if (
    !['BAD_INPUT', 'NO_WORKSPACE', 'WRONG_WORKSPACE', 'INSUFFICIENT_SCOPE'].includes(error.code)
  ) {
    return false;
  }
  return (
    error.details?.stateChanged !== true &&
    error.details?.stateMayHaveChanged !== true &&
    !Array.isArray(error.details?.partialEffects)
  );
}

export function createHostedPolicyTools(
  folders: WorkspaceFolder[],
  options: HostedPolicyToolOptions
): ToolSet {
  const hostedTools: ToolSet = {};
  let localApprovalTail: Promise<void> = Promise.resolve();
  let localMutationTail: Promise<void> = Promise.resolve();
  const requestLocalMutationApproval = async (
    toolName: string,
    signal: AbortSignal | undefined
  ): Promise<boolean> => {
    const previousApproval = localApprovalTail;
    let releaseApproval: () => void = () => undefined;
    localApprovalTail = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });

    await previousApproval;
    try {
      if (signal?.aborted) return false;
      return await confirmDialog({
        title: userMessage('dialog.allow-this-change'),
        message: userMessageWithValues(
          'dialog.the-assistant-wants-to-run-value-this-can-change-files-or-designs-in-t',
          { value0: userMessageValue(userToolLabel(toolName)) }
        ),
        confirmLabel: userMessage('dialog.allow'),
        cancelLabel: userMessage('dialog.deny'),
        tone: 'danger',
        safeDefault: true,
        signal,
      });
    } finally {
      releaseApproval();
    }
  };
  const completedServerOutputs = new Map<
    string,
    | { readonly ok: true; readonly modelOutput: LanguageModelV3ToolResultOutput }
    | { readonly ok: false; readonly error: unknown }
  >();
  const registrations: Array<{
    readonly toolName: string;
    readonly description: string;
    readonly inputSchema: unknown;
    readonly localMutation: boolean;
    readonly localApprovalRequired: boolean;
    readonly approvalReceiptPrefix: 'policy-auto-approved' | 'shared-native-policy';
    readonly dispatch: (
      args: unknown,
      context: HostedToolExecutionContext
    ) => Promise<{
      readonly output: unknown;
      readonly effectReceiptRef: string;
      readonly rendererStateDiff?: readonly RendererStateDiffEntry[];
    }>;
  }> = Object.entries(ALLOWED_RENDERER_TOOLS)
    .filter(([, definition]) => definition.exposure.kind === 'shared')
    .map(([rendererToolName, definition]) => {
      const canonicalRendererToolName = rendererToolName as RendererToolName;
      return {
        toolName: canonicalRendererToolName,
        description: definition.description,
        inputSchema: rendererToolSdkInputSchema(definition),
        localMutation: hostedToolIsMutation(canonicalRendererToolName),
        localApprovalRequired: options.serverApprovalAuthority
          ? false
          : hostedToolRequiresUserApproval(canonicalRendererToolName),
        approvalReceiptPrefix: 'policy-auto-approved',
        dispatch: SIDECAR_ROUTED_TOOLS.has(canonicalRendererToolName)
          ? (args, context) =>
              dispatchViaSidecar(canonicalRendererToolName, args, options, context).then(
                (output) => ({
                  output,
                  effectReceiptRef: context.toolCallId ?? crypto.randomUUID(),
                })
              )
          : (args, context) => dispatchLocallyWithReceipt(canonicalRendererToolName, args, context),
      };
    });
  const registeredToolNames = new Set(registrations.map(({ toolName }) => toolName));
  if (options.nativeToolExecutor) {
    for (const definition of HOSTED_NATIVE_TOOL_DEFINITIONS) {
      const toolName = definition.name;
      if (registeredToolNames.has(toolName)) {
        throw new Error(`Duplicate Hosted tool registration: ${toolName}`);
      }
      registeredToolNames.add(toolName);
      registrations.push({
        toolName,
        description: definition.description,
        inputSchema: jsonSchema(definition.inputSchema),
        localMutation: (definition.effects as readonly string[]).includes('mutating'),
        localApprovalRequired: false,
        approvalReceiptPrefix: 'shared-native-policy',
        dispatch: (args, context) => {
          if (!args || typeof args !== 'object' || Array.isArray(args)) {
            throw new HostedNativeToolDispatchError(
              'invalid_request',
              'DNAForge AI returned invalid local tool arguments.'
            );
          }
          return options.nativeToolExecutor!(toolName, args as Record<string, unknown>, context);
        },
      });
    }
  }
  for (const registration of registrations) {
    const {
      toolName,
      description,
      inputSchema,
      localMutation,
      localApprovalRequired,
      approvalReceiptPrefix,
      dispatch,
    } = registration;
    const modelOutputFor = async (input: {
      toolCallId: string;
      input: unknown;
      output: unknown;
    }): Promise<LanguageModelV3ToolResultOutput> => {
      if (isHostedToolExecutionDenied(input.output)) {
        return { type: 'execution-denied', reason: input.output.reason };
      }
      if (isHostedToolExecutionFailure(input.output)) {
        return { type: 'error-text', value: input.output.message };
      }
      return typeof input.output === 'string'
        ? { type: 'text', value: input.output }
        : { type: 'json', value: input.output as JSONValue };
    };
    const execute = async (args: unknown, context: HostedToolExecutionContext) => {
      const earlierMutation = localMutation ? localMutationTail : undefined;
      let releaseMutation: () => void = () => undefined;
      if (localMutation)
        localMutationTail = new Promise<void>((resolve) => {
          releaseMutation = resolve;
        });
      try {
        return await executeAfter(earlierMutation, args, context);
      } finally {
        releaseMutation();
      }
    };
    const executeAfter = async (
      earlierMutation: Promise<void> | undefined,
      args: unknown,
      context: HostedToolExecutionContext
    ) => {
      if (context.abortSignal?.aborted && !options.serverApprovalAuthority) {
        return stoppedToolExecution();
      }
      if (options.serverApprovalAuthority && !context.toolCallId) {
        throw new Error('Missing Hosted tool call id for gateway approval.');
      }
      const serverApproval = options.serverApprovalAuthority
        ? options.serverApprovalAuthority.consume(context.toolCallId!, toolName, args)
        : undefined;
      const settleServerOutput = async (
        output: unknown,
        rendererStateDiff?: readonly RendererStateDiffEntry[]
      ): Promise<unknown> => {
        if (!serverApproval) return output;
        try {
          const modelOutput = await modelOutputFor({
            toolCallId: context.toolCallId!,
            input: args,
            output,
          });
          await serverApproval.recordObservation(
            observationForExecutionResult(output, modelOutput, rendererStateDiff)
          );
          completedServerOutputs.set(context.toolCallId!, { ok: true, modelOutput });
        } catch (error) {
          completedServerOutputs.set(context.toolCallId!, { ok: false, error });
        }
        return output;
      };
      try {
        await serverApproval?.assertUsable(args);
      } catch (error) {
        if (!serverApproval) throw error;
        return settleServerOutput(failedToolExecution(error));
      }
      if (serverApproval && serverApproval.requiresUserApproval !== localApprovalRequired) {
        return settleServerOutput(
          failedToolExecution(new Error(`Hosted tool approval policy mismatch for ${toolName}.`))
        );
      }
      if (context.abortSignal?.aborted) {
        return settleServerOutput(stoppedToolExecution());
      }
      await serverApproval?.assertUsable(args);
      if (!serverApproval && localApprovalRequired) {
        const caller = await resolveCurrentAgentCaller(context.abortSignal);
        const definition = getAllowedRendererTool(toolName);
        if (
          !definition ||
          !hasRequiredCapabilities(caller.effectiveCapabilities, definition.required_capabilities)
        ) {
          return (await dispatchLocallyWithReceipt(toolName, args, context, caller)).output;
        }
        const confirmed = await requestLocalMutationApproval(toolName, context.abortSignal);
        if (!confirmed) {
          return deniedToolExecution('You declined this operation. No local change was made.');
        }
      }
      await earlierMutation;
      if (context.abortSignal?.aborted && !options.serverApprovalAuthority) {
        return stoppedToolExecution();
      }
      if (serverApproval && localMutation) {
        const approvalReceiptRef = `${approvalReceiptPrefix}:${crypto.randomUUID()}`;
        await serverApproval.claimMutation(approvalReceiptRef);
        if (context.abortSignal?.aborted) {
          await serverApproval.cancelMutation('stopped_before_effect');
          throw new DOMException('The AI turn was stopped.', 'AbortError');
        }
        try {
          await serverApproval.assertUsable(args);
        } catch (error) {
          await serverApproval.cancelMutation('pre_effect_failure');
          return settleServerOutput(failedToolExecution(error));
        }
        try {
          const applied = await dispatch(args, context);
          await serverApproval.completeMutation(applied.effectReceiptRef);
          return settleServerOutput(applied.output, applied.rendererStateDiff);
        } catch (error) {
          if (
            error instanceof HostedNativeToolDispatchError &&
            ['invalid_request', 'signed_out', 'user_declined', 'stopped'].includes(error.code)
          ) {
            await serverApproval.cancelMutation(
              error.code === 'stopped'
                ? 'stopped_before_effect'
                : error.code === 'user_declined'
                  ? 'user_declined_before_effect'
                  : 'pre_effect_failure'
            );
            if (error.code === 'user_declined') {
              return settleServerOutput(deniedToolExecution(error.message));
            }
            if (error.code === 'stopped') {
              return settleServerOutput(stoppedToolExecution());
            }
            return settleServerOutput(failedToolExecution(error));
          }
          if (isProvablyNoEffectCancellation(error)) {
            await serverApproval.cancelMutation('stopped_before_effect');
            return settleServerOutput(stoppedToolExecution());
          }
          if (isProvablyPreEffectFailure(error)) {
            await serverApproval.cancelMutation('pre_effect_failure');
            return settleServerOutput(failedToolExecution(error));
          }
          throw error;
        }
      }
      try {
        const applied = await dispatch(args, context);
        return settleServerOutput(applied.output, applied.rendererStateDiff);
      } catch (error) {
        if (!serverApproval) throw error;
        if (error instanceof HostedNativeToolDispatchError && error.code === 'stopped') {
          return settleServerOutput(stoppedToolExecution());
        }
        return settleServerOutput(failedToolExecution(error));
      }
    };
    const toModelOutput = async (input: {
      toolCallId: string;
      input: unknown;
      output: unknown;
    }): Promise<LanguageModelV3ToolResultOutput> => {
      const completed = completedServerOutputs.get(input.toolCallId);
      if (completed) {
        completedServerOutputs.delete(input.toolCallId);
        if (!completed.ok) throw completed.error;
        return completed.modelOutput;
      }
      return modelOutputFor(input);
    };
    const providerToolName =
      options.toolNameFormat === 'canonical' ? toolName : toHostedProviderToolName(toolName);
    hostedTools[providerToolName] = {
      description:
        providerToolName === toolName
          ? description
          : `${description} Canonical DNAForge tool: ${toolName}.`,
      inputSchema,
      execute,
      toModelOutput,
    } as ToolSet[string];
  }
  return hostedTools;
}
