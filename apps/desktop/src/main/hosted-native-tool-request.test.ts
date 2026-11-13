import { describe, expect, it } from 'vitest';
import {
  parseHostedAiNativeOperationId,
  parseHostedAiNativeToolRequest,
  toHostedAiNativeToolFailure,
} from './hosted-native-tool-request';
import {
  HostedNativeToolAuthorizationError,
  HostedNativeToolDeclinedError,
  HostedNativeToolStoppedError,
} from './hosted-native-tool-broker';

const request = {
  turnBindingToken: 'binding-token',
  workflowId: 'conversation-1',
  runId: 'turn-1',
  turnId: 'turn-1',
  operationId: 'operation-1',
  toolName: 'Write',
  input: { file_path: '/workspace/result.txt', content: 'result' },
  shellSupervision: 'destructive-only',
};

describe('Hosted native tool IPC request validation', () => {
  it('accepts only the exact bounded request shape and a known tool', () => {
    expect(parseHostedAiNativeToolRequest(request)).toEqual(request);
    expect(parseHostedAiNativeToolRequest({ ...request, extra: true })).toBeNull();
    expect(parseHostedAiNativeToolRequest({ ...request, toolName: 'UnknownTool' })).toBeNull();
    expect(parseHostedAiNativeToolRequest({ ...request, input: [] })).toBeNull();
    expect(parseHostedAiNativeToolRequest({ ...request, operationId: 'x'.repeat(257) })).toBeNull();
    expect(
      parseHostedAiNativeToolRequest({ ...request, shellSupervision: 'sometimes' })
    ).toBeNull();
  });

  it('accepts only a bounded opaque operation id for cancellation', () => {
    expect(parseHostedAiNativeOperationId('operation-1')).toBe('operation-1');
    expect(parseHostedAiNativeOperationId('')).toBeNull();
    expect(parseHostedAiNativeOperationId('x'.repeat(257))).toBeNull();
    expect(parseHostedAiNativeOperationId({ operationId: 'operation-1' })).toBeNull();
  });

  it('maps authority, decline, and Stop without leaking local failures', () => {
    expect(toHostedAiNativeToolFailure(new HostedNativeToolAuthorizationError())).toEqual({
      ok: false,
      code: 'signed_out',
      message: 'The signed-in account changed during this DNAForge AI turn.',
    });
    expect(toHostedAiNativeToolFailure(new HostedNativeToolDeclinedError())).toEqual({
      ok: false,
      code: 'user_declined',
      message: 'You declined this operation. No local change was made.',
    });
    expect(toHostedAiNativeToolFailure(new HostedNativeToolStoppedError())).toEqual({
      ok: false,
      code: 'stopped',
      message: 'Stopped before this local operation completed.',
    });
    expect(toHostedAiNativeToolFailure(new Error('/private/path leaked'))).toEqual({
      ok: false,
      code: 'tool_failed',
      message: 'DNAForge AI could not complete this local tool.',
    });
  });
});
