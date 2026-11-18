import type {
  NativeProtocolClient,
  NativeProtocolCreationResult,
  NativeProtocolCreateRequest,
  NativeProtocolStartRunRequest,
  NativeProtocolPackageSaveRequest,
} from '../../shared/protocol-packages';
export type ProtocolOperation =
  | { kind: 'create'; request: NativeProtocolCreateRequest }
  | { kind: 'start'; request: NativeProtocolStartRunRequest }
  | { kind: 'save'; request: NativeProtocolPackageSaveRequest };
type Snapshot =
  | { phase: 'editing' }
  | { phase: 'sending' | 'unknown'; attempt: ProtocolOperation; message?: string }
  | { phase: 'result'; attempt: ProtocolOperation; result: NativeProtocolCreationResult }
  | { phase: 'failed'; message: string };
export class ProtocolOperationSession {
  private current: Snapshot = { phase: 'editing' };
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly client: NativeProtocolClient,
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null,
    private readonly storageKey: string
  ) {
    try {
      const saved = storage?.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (
          parsed.version !== 1 ||
          !['create', 'start', 'save'].includes(parsed.attempt?.kind) ||
          typeof parsed.attempt.request?.project !== 'string' ||
          typeof parsed.attempt.request?.requestId !== 'string'
        )
          throw Error('The retained scientific creation could not be read.');
        this.current = {
          phase: 'unknown',
          attempt: parsed.attempt,
          message: 'Confirm the previous operation before creating another artifact.',
        };
      }
    } catch (cause) {
      this.current = {
        phase: 'failed',
        message:
          cause instanceof Error ? cause.message : 'Scientific operation recovery is unavailable.',
      };
    }
  }
  getSnapshot = (): Snapshot => this.current;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(value: Snapshot) {
    this.current = value;
    for (const listener of this.listeners) listener();
  }
  private persist(attempt: ProtocolOperation) {
    if (!this.storage) throw Error('Scientific operation recovery storage is unavailable.');
    this.storage.setItem(this.storageKey, JSON.stringify({ version: 1, attempt }));
  }
  async begin(attempt: ProtocolOperation) {
    if (this.current.phase !== 'editing') return null;
    try {
      this.persist(attempt);
    } catch {
      this.publish({
        phase: 'failed',
        message:
          'The operation could not be retained safely. Restore local storage before creating or saving.',
      });
      return null;
    }
    return this.send(attempt);
  }
  private async send(attempt: ProtocolOperation) {
    this.publish({ phase: 'sending', attempt });
    try {
      const result =
        attempt.kind === 'create'
          ? await this.client.createProtocol(attempt.request)
          : attempt.kind === 'start'
            ? await this.client.startRun(attempt.request)
            : await this.client.savePackage(attempt.request);
      return this.accept(attempt, result);
    } catch (cause) {
      this.publish({
        phase: 'unknown',
        attempt,
        message:
          cause instanceof Error ? cause.message : 'The operation outcome needs confirmation.',
      });
      return null;
    }
  }
  private accept(attempt: ProtocolOperation, result: NativeProtocolCreationResult) {
    if (result.requestId !== attempt.request.requestId)
      throw Error('The scientific operation result has another request identity.');
    if (result.kind === 'ready') {
      if (result.package.projectId !== attempt.request.project)
        throw Error('The scientific operation belongs to another project.');
      if (!this.storage) throw Error('Scientific operation recovery storage is unavailable.');
      this.storage.setItem(this.storageKey, '');
    }
    this.publish({ phase: 'result', attempt, result });
    return result;
  }
  async retry() {
    if (
      !('attempt' in this.current) ||
      this.current.phase === 'sending' ||
      (this.current.phase === 'result' && this.current.result.kind === 'ready')
    )
      return null;
    return this.send(this.current.attempt);
  }
  async inspect() {
    if (!('attempt' in this.current) || this.current.phase === 'sending') return null;
    const attempt = this.current.attempt;
    this.publish({ phase: 'sending', attempt });
    try {
      return this.accept(
        attempt,
        await this.client.inspectCreation({
          project: attempt.request.project,
          requestId: attempt.request.requestId,
        })
      );
    } catch (cause) {
      this.publish({
        phase: 'unknown',
        attempt,
        message:
          cause instanceof Error ? cause.message : 'The original operation could not be confirmed.',
      });
      return null;
    }
  }
}
