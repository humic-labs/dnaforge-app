import type { AnnotationViewportDetailAuthWorkerLike } from './annotation-viewport-detail-auth-worker-protocol';

export type AnnotationViewportDetailAuthenticationResult = Readonly<{
  payload: Uint8Array<ArrayBuffer>;
  sha256: string;
}>;

export class AnnotationViewportDetailAuthWorkerClient {
  private readonly requestId = 1;
  private started = false;
  private settled = false;
  private resolvePending: ((value: AnnotationViewportDetailAuthenticationResult) => void) | null =
    null;
  private rejectPending: ((error: Error) => void) | null = null;
  private abortCleanup: (() => void) | null = null;
  private expectedPayloadByteLength: number | null = null;

  constructor(private readonly worker: AnnotationViewportDetailAuthWorkerLike) {}

  authenticate(
    payload: Uint8Array<ArrayBuffer>,
    signal?: AbortSignal
  ): Promise<AnnotationViewportDetailAuthenticationResult> {
    if (this.started || this.settled) {
      return Promise.reject(new Error('Annotation viewport detail worker was already consumed.'));
    }
    this.started = true;
    if (signal?.aborted) {
      this.finish();
      return Promise.reject(abortError());
    }

    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleWorkerError);
    this.worker.addEventListener('messageerror', this.handleWorkerMessageError);
    return new Promise((resolve, reject) => {
      this.resolvePending = resolve;
      this.rejectPending = reject;
      this.expectedPayloadByteLength = payload.byteLength;
      const abort = (): void => this.fail(abortError());
      this.abortCleanup = signal ? () => signal.removeEventListener('abort', abort) : null;
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.worker.postMessage({ id: this.requestId, type: 'authenticate', payload }, [
          payload.buffer,
        ]);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (signal?.aborted) abort();
    });
  }

  private handleMessage = (event: MessageEvent<unknown>): void => {
    const response = event.data;
    if (this.settled) return;
    if (!isRecord(response) || response.id !== this.requestId) {
      this.fail(invalidResultError());
      return;
    }
    if (response.type === 'error') {
      if (
        !isRecord(response.error) ||
        typeof response.error.name !== 'string' ||
        typeof response.error.message !== 'string'
      ) {
        this.fail(invalidResultError());
        return;
      }
      const error = new Error(response.error.message);
      error.name = response.error.name;
      this.fail(error);
      return;
    }
    if (
      response.type !== 'result' ||
      !(response.payload instanceof Uint8Array) ||
      !(response.payload.buffer instanceof ArrayBuffer) ||
      response.payload.byteOffset !== 0 ||
      response.payload.byteLength !== response.payload.buffer.byteLength ||
      response.payload.byteLength !== this.expectedPayloadByteLength ||
      typeof response.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(response.sha256)
    ) {
      this.fail(invalidResultError());
      return;
    }
    const resolve = this.resolvePending;
    this.finish();
    resolve?.({ payload: response.payload, sha256: response.sha256 });
  };

  private handleWorkerError = (event: Event): void => {
    const workerEvent = event as ErrorEvent;
    const detail =
      workerEvent.error instanceof Error
        ? workerEvent.error.message
        : workerEvent.message || 'worker stopped unexpectedly';
    this.fail(new Error(`Annotation viewport detail worker failed: ${detail}`));
  };

  private handleWorkerMessageError = (): void => {
    this.fail(new Error('Annotation viewport detail worker returned an unreadable message.'));
  };

  private fail(error: Error): void {
    if (this.settled) return;
    const reject = this.rejectPending;
    this.finish();
    reject?.(error);
  }

  private finish(): void {
    if (this.settled) return;
    this.settled = true;
    this.abortCleanup?.();
    this.abortCleanup = null;
    this.resolvePending = null;
    this.rejectPending = null;
    this.expectedPayloadByteLength = null;
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleWorkerError);
    this.worker.removeEventListener('messageerror', this.handleWorkerMessageError);
    this.worker.terminate();
  }
}

function abortError(): Error {
  const error = new Error('Annotation viewport detail authentication was cancelled.');
  error.name = 'AbortError';
  return error;
}

function invalidResultError(): Error {
  return new Error('Annotation viewport detail worker returned an invalid result.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
