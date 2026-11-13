import type { ManagedSequenceContentSummary } from '../../shared/managed-sequence-document';
import type {
  SequenceProductSummaryRequest,
  SequenceProductSummaryResponse,
} from './sequence-product-summary-runtime';

export interface SequenceProductSummaryWorker {
  onmessage: ((event: MessageEvent<SequenceProductSummaryResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(request: SequenceProductSummaryRequest): void;
  terminate(): void;
}

export class SequenceProductSummaryClient {
  private nextId = 1;
  private failure: Error | null = null;
  private readonly pending = new Map<
    number,
    { resolve: (summary: ManagedSequenceContentSummary) => void; reject: (error: Error) => void }
  >();

  constructor(private readonly worker: SequenceProductSummaryWorker) {
    worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if ('error' in data) {
        const error = new Error(data.error.message);
        error.name = data.error.name;
        pending.reject(error);
      } else pending.resolve(data.summary);
    };
    worker.onerror = (event) =>
      this.dispose(new Error(event.message || 'Sequence summary worker failed.'));
    worker.onmessageerror = () =>
      this.dispose(new Error('Sequence summary worker returned an unreadable message.'));
  }

  get failed(): boolean {
    return this.failure !== null;
  }

  read(content: string): Promise<ManagedSequenceContentSummary> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, content });
      } catch (error) {
        this.dispose(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose(error = new Error('Sequence summary worker was disposed.')): void {
    if (this.failure) return;
    this.failure = error;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

let client: SequenceProductSummaryClient | null = null;

export async function readSequenceProductSummaryOffThread(
  content: string
): Promise<ManagedSequenceContentSummary> {
  if (typeof Worker === 'undefined') {
    const { readSequenceProductSummary } = await import('./sequence-product-summary-runtime');
    return readSequenceProductSummary(content);
  }
  if (!client || client.failed) {
    const { default: SummaryWorker } =
      await import('./sequence-product-summary.worker.ts?worker&inline');
    if (!client || client.failed) {
      client = new SequenceProductSummaryClient(new SummaryWorker());
    }
  }
  return client.read(content);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    client?.dispose();
    client = null;
  });
}
