import { describe, expect, it, vi } from 'vitest';
import type { HostedAiBridge } from '../hosted-gateway';
import { HostedNativeToolDispatchError } from '../orchestration/hosted-policy-tools';
import { createHostedNativeToolExecutor } from './native-tool-executor';

const binding = {
  turnBindingToken: 'binding-token',
  workflowId: 'conversation-1',
  runId: 'turn-1',
  turnId: 'turn-1',
} as const;

function bridge(overrides: Partial<HostedAiBridge> = {}): HostedAiBridge {
  return {
    prepareContribution: vi.fn(),
    validateTurnBinding: vi.fn(),
    releaseTurnBinding: vi.fn(),
    startStream: vi.fn(),
    cancelStream: vi.fn(),
    onStreamEvent: vi.fn(),
    recordToolObservation: vi.fn(),
    claimTool: vi.fn(),
    completeToolClaim: vi.fn(),
    cancelToolClaim: vi.fn(),
    cancelWorkflow: vi.fn(),
    executeNativeTool: vi.fn(),
    cancelNativeTool: vi.fn(),
    getWorkflowAuthority: vi.fn(),
    getRouteAvailability: vi.fn(),
    ...overrides,
  } as HostedAiBridge;
}

describe('createHostedNativeToolExecutor', () => {
  it('executes through the main-owned bridge with the exact turn binding', async () => {
    const executeNativeTool = vi.fn(async () => ({
      ok: true as const,
      output: { content: 'hello' },
      effectReceiptRef: 'native:receipt-1',
    }));
    const hostedBridge = bridge({ executeNativeTool });
    const execute = createHostedNativeToolExecutor({
      bridge: hostedBridge,
      turnBinding: binding,
      shellSupervision: 'destructive-only',
      idGenerator: () => 'operation-1',
    });

    await expect(execute('Read', { file_path: 'notes.txt' }, {})).resolves.toEqual({
      output: { content: 'hello' },
      effectReceiptRef: 'native:receipt-1',
    });
    expect(executeNativeTool).toHaveBeenCalledWith({
      ...binding,
      operationId: 'operation-1',
      toolName: 'Read',
      input: { file_path: 'notes.txt' },
      shellSupervision: 'destructive-only',
    });
  });

  it('does not start an operation after Stop', async () => {
    const hostedBridge = bridge();
    const controller = new AbortController();
    controller.abort();
    const execute = createHostedNativeToolExecutor({
      bridge: hostedBridge,
      turnBinding: binding,
      shellSupervision: 'destructive-only',
      idGenerator: () => 'operation-1',
    });

    await expect(
      execute(
        'Write',
        { file_path: 'notes.txt', content: 'new' },
        {
          abortSignal: controller.signal,
        }
      )
    ).rejects.toMatchObject({ code: 'stopped' });
    expect(hostedBridge.executeNativeTool).not.toHaveBeenCalled();
  });

  it('cancels the exact in-flight operation when Stop is requested', async () => {
    let settle!: (result: { ok: false; code: 'stopped'; message: string }) => void;
    const executeNativeTool = vi.fn(
      () =>
        new Promise<{
          ok: false;
          code: 'stopped';
          message: string;
        }>((resolve) => {
          settle = resolve;
        })
    );
    const cancelNativeTool = vi.fn(async () => {
      settle({ ok: false, code: 'stopped', message: 'Stopped.' });
      return { ok: true };
    });
    const controller = new AbortController();
    const execute = createHostedNativeToolExecutor({
      bridge: bridge({ executeNativeTool, cancelNativeTool }),
      turnBinding: binding,
      shellSupervision: 'destructive-only',
      idGenerator: () => 'operation-stop',
    });

    const pending = execute('Bash', { command: 'sleep 30' }, { abortSignal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'stopped' });
    expect(cancelNativeTool).toHaveBeenCalledWith('operation-stop');
  });

  it('preserves a completed effect receipt when Stop races after the local effect', async () => {
    let settle!: (result: {
      ok: true;
      output: { path: string; bytes_written: number };
      effectReceiptRef: string;
    }) => void;
    const executeNativeTool = vi.fn(
      () =>
        new Promise<{
          ok: true;
          output: { path: string; bytes_written: number };
          effectReceiptRef: string;
        }>((resolve) => {
          settle = resolve;
        })
    );
    const cancelNativeTool = vi.fn(async () => ({ ok: true as const }));
    const controller = new AbortController();
    const execute = createHostedNativeToolExecutor({
      bridge: bridge({ executeNativeTool, cancelNativeTool }),
      turnBinding: binding,
      shellSupervision: 'destructive-only',
      idGenerator: () => 'operation-effect-won',
    });

    const pending = execute(
      'Write',
      { file_path: 'notes.txt', content: 'written' },
      { abortSignal: controller.signal }
    );
    controller.abort();
    settle({
      ok: true,
      output: { path: '/workspace/notes.txt', bytes_written: 7 },
      effectReceiptRef: 'native:effect-won',
    });

    await expect(pending).resolves.toEqual({
      output: { path: '/workspace/notes.txt', bytes_written: 7 },
      effectReceiptRef: 'native:effect-won',
    });
    expect(cancelNativeTool).toHaveBeenCalledWith('operation-effect-won');
  });

  it('preserves the bounded user-declined failure for signed observation handling', async () => {
    const execute = createHostedNativeToolExecutor({
      bridge: bridge({
        executeNativeTool: vi.fn(async () => ({
          ok: false as const,
          code: 'user_declined' as const,
          message: 'You declined this operation. No local change was made.',
        })),
      }),
      turnBinding: binding,
      shellSupervision: 'destructive-only',
      idGenerator: () => 'operation-decline',
    });

    await expect(execute('Delete', { path: 'notes.txt' }, {})).rejects.toBeInstanceOf(
      HostedNativeToolDispatchError
    );
    await expect(execute('Delete', { path: 'notes.txt' }, {})).rejects.toMatchObject({
      code: 'user_declined',
      message: 'You declined this operation. No local change was made.',
    });
  });

  it('removes its abort listener after completion', async () => {
    const cancelNativeTool = vi.fn();
    const controller = new AbortController();
    const execute = createHostedNativeToolExecutor({
      bridge: bridge({
        executeNativeTool: vi.fn(async () => ({
          ok: true as const,
          output: { files: [] },
          effectReceiptRef: 'native:receipt-2',
        })),
        cancelNativeTool,
      }),
      turnBinding: binding,
      shellSupervision: 'destructive-only',
      idGenerator: () => 'operation-done',
    });

    await execute('LS', {}, { abortSignal: controller.signal });
    controller.abort();
    expect(cancelNativeTool).not.toHaveBeenCalled();
  });
});
