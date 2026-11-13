import { describe, expect, it, vi } from 'vitest';

import {
  executeHostedCodexLocalTool,
  HostedCodexNativeMutationOutcomeUnknownError,
} from './local-tool-executor';

const nativeWrite = {
  turnId: 'turn-1',
  toolName: 'Write',
  input: { file_path: 'dna2001-sealed-case.txt', content: 'sealed-case sealed case\n' },
  actionId: 'call-write',
  effects: ['mutating'] as const,
};

describe('executeHostedCodexLocalTool', () => {
  it('routes app-owned native Write to the native broker and preserves its effect receipt', async () => {
    const callNativeTool = vi.fn().mockResolvedValue({
      ok: true,
      output: { created: true, observed_byte_count: 21 },
      effectReceiptRef: 'native-write-receipt',
    });
    const callRendererTool = vi.fn();

    await expect(
      executeHostedCodexLocalTool(nativeWrite, { callNativeTool, callRendererTool })
    ).resolves.toEqual({
      ok: true,
      result: { created: true, observed_byte_count: 21 },
      effectReceiptRef: 'native-write-receipt',
    });
    expect(callNativeTool).toHaveBeenCalledWith(nativeWrite);
    expect(callRendererTool).not.toHaveBeenCalled();
  });

  it('keeps renderer tools on the renderer bridge and adapts the audit receipt', async () => {
    const rendererCall = {
      turnId: 'turn-1',
      toolName: 'get_workspace',
      input: {},
      actionId: 'call-read',
      effects: ['read-only'] as const,
    };
    const callNativeTool = vi.fn();
    const callRendererTool = vi.fn().mockResolvedValue({
      ok: true,
      result: { workspace: 'open' },
      audit_id: 'renderer-audit',
    });

    await expect(
      executeHostedCodexLocalTool(rendererCall, { callNativeTool, callRendererTool })
    ).resolves.toEqual({
      ok: true,
      result: { workspace: 'open' },
      effectReceiptRef: 'renderer-audit',
    });
    expect(callNativeTool).not.toHaveBeenCalled();
    expect(callRendererTool).toHaveBeenCalledWith(rendererCall);
  });

  it('fails a native mutation as outcome-unknown instead of canceling its claim', async () => {
    await expect(
      executeHostedCodexLocalTool(nativeWrite, {
        callNativeTool: vi.fn().mockResolvedValue({
          ok: false,
          code: 'tool_failed',
          message: 'DNAForge AI could not complete this local tool.',
        }),
        callRendererTool: vi.fn(),
      })
    ).rejects.toBeInstanceOf(HostedCodexNativeMutationOutcomeUnknownError);
  });
});
