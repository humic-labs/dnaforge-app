import type {
  AuthenticatedCoverageCorridorFloorPayload,
  PreparedCoverageCorridorFloor,
} from './coverage-corridor-floor';
import type {
  CoverageCorridorFloorWorkerInput,
  CoverageCorridorFloorWorkerLike,
  CoverageCorridorFloorWorkerResponse,
} from './coverage-corridor-floor-worker-protocol';

export class CoverageCorridorFloorWorkerClient {
  private readonly requestId = 1;
  private settled = false;
  private rejectPending: ((error: Error) => void) | null = null;
  private abortCleanup: (() => void) | null = null;

  constructor(private readonly worker: CoverageCorridorFloorWorkerLike) {}

  prepare(
    input: CoverageCorridorFloorWorkerInput,
    payload: AuthenticatedCoverageCorridorFloorPayload,
    signal?: AbortSignal
  ): Promise<PreparedCoverageCorridorFloor | null> {
    if (signal?.aborted) {
      this.settled = true;
      this.worker.terminate?.();
      return Promise.reject(abortError());
    }
    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleWorkerError);
    this.worker.addEventListener('messageerror', this.handleWorkerMessageError);
    return new Promise((resolve, reject) => {
      this.rejectPending = reject;
      const abort = (): void => {
        if (this.settled) return;
        this.worker.postMessage({ id: 2, type: 'cancel', targetId: this.requestId });
        this.finish();
        reject(abortError());
      };
      this.abortCleanup = signal ? () => signal.removeEventListener('abort', abort) : null;
      signal?.addEventListener('abort', abort, { once: true });
      this.resolvePending = resolve;
      this.worker.postMessage({ id: this.requestId, type: 'prepare', input, payload }, [
        payload.bytes,
      ]);
      if (signal?.aborted) abort();
    });
  }

  dispose(): void {
    if (!this.settled) {
      this.worker.postMessage({ id: 2, type: 'cancel', targetId: this.requestId });
      const reject = this.rejectPending;
      this.finish();
      reject?.(new Error('Coverage corridor preparation worker was disposed.'));
    }
  }

  private resolvePending: ((value: PreparedCoverageCorridorFloor | null) => void) | null = null;

  private handleMessage = (event: MessageEvent<CoverageCorridorFloorWorkerResponse>): void => {
    const response = event.data;
    if (this.settled || response.id !== this.requestId) return;
    if (response.type === 'result') {
      const resolve = this.resolvePending;
      this.finish();
      resolve?.(response.result);
      return;
    }
    const error = new Error(response.error.message);
    error.name = response.error.name;
    const reject = this.rejectPending;
    this.finish();
    reject?.(error);
  };

  private handleWorkerError = (event: Event): void => {
    const workerEvent = event as ErrorEvent;
    const detail =
      workerEvent.error instanceof Error
        ? workerEvent.error.message
        : workerEvent.message || 'worker stopped unexpectedly';
    this.fail(new Error(`Coverage corridor preparation worker failed: ${detail}`));
  };

  private handleWorkerMessageError = (): void => {
    this.fail(new Error('Coverage corridor preparation worker returned an unreadable message.'));
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
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleWorkerError);
    this.worker.removeEventListener('messageerror', this.handleWorkerMessageError);
    this.worker.terminate?.();
  }
}

function abortError(): Error {
  const error = new Error('Coverage corridor preparation was cancelled.');
  error.name = 'AbortError';
  return error;
}
