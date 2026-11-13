import { isHostedNativeToolName } from '@waypoint/hosted-ai-contract';
import type {
  HostedAiNativeToolRequest,
  HostedAiNativeToolResult,
} from '../shared/hosted-ai-gateway-ipc';
import {
  HostedNativeToolAuthorizationError,
  HostedNativeToolDeclinedError,
  HostedNativeToolStoppedError,
} from './hosted-native-tool-broker';

function boundedString(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonSerializable(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

export function parseHostedAiNativeToolRequest(value: unknown): HostedAiNativeToolRequest | null {
  if (!plainRecord(value) || Object.keys(value).length !== 8) return null;
  if (
    !boundedString(value.turnBindingToken) ||
    !boundedString(value.workflowId) ||
    !boundedString(value.runId) ||
    !boundedString(value.turnId) ||
    !boundedString(value.operationId) ||
    !boundedString(value.toolName) ||
    !isHostedNativeToolName(value.toolName) ||
    !plainRecord(value.input) ||
    !isJsonSerializable(value.input) ||
    (value.shellSupervision !== 'auto' &&
      value.shellSupervision !== 'destructive-only' &&
      value.shellSupervision !== 'always')
  ) {
    return null;
  }
  return {
    turnBindingToken: value.turnBindingToken,
    workflowId: value.workflowId,
    runId: value.runId,
    turnId: value.turnId,
    operationId: value.operationId,
    toolName: value.toolName,
    input: value.input,
    shellSupervision: value.shellSupervision,
  };
}

export function parseHostedAiNativeOperationId(value: unknown): string | null {
  return boundedString(value) ? value : null;
}

export function toHostedAiNativeToolFailure(
  error: unknown
): Extract<HostedAiNativeToolResult, { readonly ok: false }> {
  if (error instanceof HostedNativeToolAuthorizationError) {
    return {
      ok: false,
      code: 'signed_out',
      message: 'The signed-in account changed during this DNAForge AI turn.',
    };
  }
  if (error instanceof HostedNativeToolDeclinedError) {
    return {
      ok: false,
      code: 'user_declined',
      message: 'You declined this operation. No local change was made.',
    };
  }
  if (error instanceof HostedNativeToolStoppedError) {
    return {
      ok: false,
      code: 'stopped',
      message: 'Stopped before this local operation completed.',
    };
  }
  return {
    ok: false,
    code: 'tool_failed',
    message: 'DNAForge AI could not complete this local tool.',
  };
}
