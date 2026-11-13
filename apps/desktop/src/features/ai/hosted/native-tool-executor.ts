import type { HostedAiTurnBindingRequest } from '../../../shared/hosted-ai-gateway-ipc';
import type { AgentShellSupervision } from '../../../shared/agent-runtime-ipc';
import type { HostedAiBridge } from '../hosted-gateway';
import {
  HostedNativeToolDispatchError,
  type HostedNativeToolExecutor,
} from '../orchestration/hosted-policy-tools';

interface HostedNativeToolExecutorOptions {
  readonly bridge: HostedAiBridge;
  readonly turnBinding: HostedAiTurnBindingRequest;
  readonly shellSupervision: AgentShellSupervision;
  readonly idGenerator?: () => string;
}

function stoppedError(): HostedNativeToolDispatchError {
  return new HostedNativeToolDispatchError(
    'stopped',
    'Stopped before this local operation completed.'
  );
}

export function createHostedNativeToolExecutor({
  bridge,
  turnBinding,
  shellSupervision,
  idGenerator = () => crypto.randomUUID(),
}: HostedNativeToolExecutorOptions): HostedNativeToolExecutor {
  return async (toolName, input, context) => {
    if (context.abortSignal?.aborted) throw stoppedError();

    const operationId = idGenerator();
    let cancellation: Promise<void> | null = null;
    const cancel = () => {
      cancellation ??= bridge
        .cancelNativeTool(operationId)
        .then(() => undefined)
        .catch(() => undefined);
    };
    context.abortSignal?.addEventListener('abort', cancel, { once: true });
    try {
      const result = await bridge.executeNativeTool({
        ...turnBinding,
        operationId,
        toolName,
        input,
        shellSupervision,
      });
      if (cancellation) await cancellation;
      if (!result.ok) {
        throw new HostedNativeToolDispatchError(result.code, result.message);
      }
      return {
        output: result.output,
        effectReceiptRef: result.effectReceiptRef,
      };
    } finally {
      context.abortSignal?.removeEventListener('abort', cancel);
    }
  };
}
