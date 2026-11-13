import type {
  AgentUserInputRequest,
  AgentUserInputResponse,
  DestructiveFileConfirmRequest,
  DestructiveFileConfirmResponse,
} from '../shared/agent-confirm-types';
import type { PlatformBridge } from '../platform/types';

type Listener<T> = (payload: T) => void;

function createBus<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    subscribe(listener: Listener<T>): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(payload: T): void {
      for (const listener of [...listeners]) listener(payload);
    },
  };
}

export function createHostedAgentConfirm(): PlatformBridge['agentConfirm'] {
  const requests = createBus<DestructiveFileConfirmRequest>();
  const cancels = createBus<string>();
  const userInputRequests = createBus<AgentUserInputRequest>();
  const userInputCancels = createBus<string>();
  const pending = new Map<string, (response: DestructiveFileConfirmResponse) => void>();
  const pendingUserInput = new Map<string, (response: AgentUserInputResponse) => void>();

  return {
    onRequest: (callback) => requests.subscribe(callback),
    onCancel: (callback) => cancels.subscribe(callback),
    respond: (requestId, response) => {
      const settle = pending.get(requestId);
      pending.delete(requestId);
      settle?.(response);
    },
    onUserInputRequest: (callback) => userInputRequests.subscribe(callback),
    onUserInputCancel: (callback) => userInputCancels.subscribe(callback),
    respondUserInput: (requestId, response) => {
      const settle = pendingUserInput.get(requestId);
      pendingUserInput.delete(requestId);
      settle?.(response);
    },
    request(payload: DestructiveFileConfirmRequest): Promise<DestructiveFileConfirmResponse> {
      return new Promise((resolve) => {
        pending.set(payload.requestId, resolve);
        requests.emit(payload);
      });
    },
  } as PlatformBridge['agentConfirm'] & {
    request(payload: DestructiveFileConfirmRequest): Promise<DestructiveFileConfirmResponse>;
  };
}
