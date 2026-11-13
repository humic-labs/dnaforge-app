import { isHostedNativeToolName, type HostedNativeToolName } from '@waypoint/hosted-ai-contract';

import type { RendererToolCallResponseShape } from '../../shared/agent-tools-ipc';
import type { HostedAiNativeToolResult } from '../../shared/hosted-ai-gateway-ipc';
import type {
  HostedCodexLocalToolCall,
  HostedCodexLocalToolResponse,
} from './hosted-gateway-workflow';

export interface HostedCodexLocalToolExecutorDependencies {
  readonly callNativeTool: (
    request: HostedCodexLocalToolCall & { readonly toolName: HostedNativeToolName }
  ) => Promise<HostedAiNativeToolResult>;
  readonly callRendererTool: (
    request: HostedCodexLocalToolCall
  ) => Promise<RendererToolCallResponseShape>;
}

export class HostedCodexNativeMutationOutcomeUnknownError extends Error {
  constructor(readonly toolName: string) {
    super(`The native mutation ${toolName} failed after entering its guarded execution boundary.`);
    this.name = 'HostedCodexNativeMutationOutcomeUnknownError';
  }
}

export async function executeHostedCodexLocalTool(
  request: HostedCodexLocalToolCall,
  dependencies: HostedCodexLocalToolExecutorDependencies
): Promise<HostedCodexLocalToolResponse> {
  if (isHostedNativeToolName(request.toolName)) {
    const result = await dependencies.callNativeTool({ ...request, toolName: request.toolName });
    if (result.ok) {
      return {
        ok: true,
        result: result.output,
        effectReceiptRef: result.effectReceiptRef,
      };
    }
    if (result.code === 'tool_failed' && request.effects.includes('mutating')) {
      throw new HostedCodexNativeMutationOutcomeUnknownError(request.toolName);
    }
    return {
      ok: false,
      error: {
        code: result.code.toUpperCase(),
        message: result.message,
        retriable: false,
      },
    };
  }

  const result = await dependencies.callRendererTool(request);
  return result.ok
    ? {
        ok: true,
        result: result.result,
        effectReceiptRef: result.audit_id,
      }
    : { ok: false, error: result.error };
}
