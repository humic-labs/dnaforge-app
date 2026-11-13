import type { HostedStreamEvent } from '@waypoint/hosted-ai-contract';
import type { HostedAiStreamEventEnvelope } from '../../../shared/hosted-ai-gateway-ipc';
import { hostedAiBridge, type HostedAiBridge } from '../hosted-gateway';
import type {
  HostedLanguageModelTransport,
  HostedLanguageModelTransportStartInput,
} from './language-model';

class StreamQueue {
  private readonly values: HostedAiStreamEventEnvelope[] = [];
  private readonly waiters: Array<{
    resolve: (value: HostedAiStreamEventEnvelope) => void;
    reject: (error: Error) => void;
  }> = [];
  private failure: Error | null = null;
  private drainScheduled = false;

  push(value: HostedAiStreamEventEnvelope): void {
    if (this.failure) return;
    this.values.push(value);
    this.scheduleDrain();
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.values.splice(0);
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  async next(): Promise<HostedAiStreamEventEnvelope> {
    if (this.failure) throw this.failure;
    const value = this.values.shift();
    if (value) return value;
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      if (this.failure) return;
      while (this.values.length > 0 && this.waiters.length > 0) {
        const value = this.values.shift();
        const waiter = this.waiters.shift();
        if (value && waiter) waiter.resolve(value);
      }
    });
  }
}

export function createHostedIpcTransport(bridge: HostedAiBridge): HostedLanguageModelTransport;
export function createHostedIpcTransport(): HostedLanguageModelTransport | null;
export function createHostedIpcTransport(
  bridgeOverride?: HostedAiBridge
): HostedLanguageModelTransport | null {
  const bridge = bridgeOverride ?? hostedAiBridge();
  if (!bridge) return null;
  const queues = new Map<string, StreamQueue>();
  let unsubscribe: (() => void) | null = null;

  const ensureSubscription = () => {
    if (unsubscribe) return;
    unsubscribe = bridge.onStreamEvent((envelope) => {
      const queue = queues.get(envelope.clientRequestId);
      if (!queue) return;
      if (envelope.kind === 'transport_error') queue.fail(new Error(envelope.message));
      else queue.push(envelope);
    });
  };
  const cleanupSubscription = () => {
    if (queues.size !== 0 || !unsubscribe) return;
    unsubscribe();
    unsubscribe = null;
  };

  return {
    async *start(input: HostedLanguageModelTransportStartInput): AsyncIterable<HostedStreamEvent> {
      if (queues.has(input.clientRequestId)) {
        throw new Error('A Hosted generation request with this ID is already active.');
      }
      const queue = new StreamQueue();
      queues.set(input.clientRequestId, queue);
      ensureSubscription();
      try {
        const started = await bridge.startStream(input);
        if (!started.ok) throw new Error(started.message);
        for (;;) {
          const envelope = await queue.next();
          if (envelope.kind !== 'event') throw new Error(envelope.message);
          yield envelope.event;
          if (envelope.event.event === 'finish' || envelope.event.event === 'error') return;
        }
      } finally {
        queues.delete(input.clientRequestId);
        cleanupSubscription();
      }
    },

    async cancel(clientRequestId: string): Promise<void> {
      queues.get(clientRequestId)?.fail(new Error('Hosted generation was stopped.'));
      await bridge.cancelStream(clientRequestId);
    },
  };
}
