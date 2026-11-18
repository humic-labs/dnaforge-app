import {
  protocolCreateSchema,
  protocolStartRunSchema,
  protocolPackageSaveSchema,
  protocolEditDeclarationsSchema,
  protocolRecordRunValuesSchema,
  type NativeProtocolClient,
  type NativeProtocolCreationResult,
  type NativeProtocolCreateRequest,
  type NativeProtocolStartRunRequest,
  type NativeProtocolPackageSaveRequest,
  type NativeProtocolEditDeclarationsRequest,
  type NativeProtocolRecordRunValuesRequest,
} from '../../shared/protocol-packages';
export type ProtocolOperation =
  | { kind: 'create'; request: NativeProtocolCreateRequest }
  | { kind: 'start'; request: NativeProtocolStartRunRequest }
  | { kind: 'save'; request: NativeProtocolPackageSaveRequest }
  | { kind: 'edit-declarations'; request: NativeProtocolEditDeclarationsRequest }
  | { kind: 'record-values'; request: NativeProtocolRecordRunValuesRequest };
type Snapshot =
  | { phase: 'editing' }
  | { phase: 'sending' | 'unknown'; attempt: ProtocolOperation; message?: string }
  | { phase: 'result'; attempt: ProtocolOperation; result: NativeProtocolCreationResult }
  | { phase: 'failed'; message: string };
type Store = Pick<Storage, 'getItem' | 'setItem'>;
type Scope = { project: string; entityId: string };
function checked(value: unknown): ProtocolOperation {
  const item = value as ProtocolOperation;
  switch (item?.kind) {
    case 'create':
      protocolCreateSchema.parse(item.request);
      break;
    case 'start':
      protocolStartRunSchema.parse(item.request);
      break;
    case 'save':
      protocolPackageSaveSchema.parse(item.request);
      break;
    case 'edit-declarations':
      protocolEditDeclarationsSchema.parse(item.request);
      break;
    case 'record-values':
      protocolRecordRunValuesSchema.parse(item.request);
      break;
    default:
      throw Error('The retained scientific operation could not be read.');
  }
  return item;
}
export class ProtocolOperationSession {
  private current: Snapshot = { phase: 'editing' };
  private readonly listeners = new Set<() => void>();
  private readonly aliases = new Set<string>();
  constructor(
    private readonly client: NativeProtocolClient,
    private readonly storage: Store | null,
    private readonly storageKey: string,
    private readonly scope?: Scope
  ) {
    this.refresh();
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
  addStorageAlias(key: string) {
    this.aliases.add(key);
  }
  private retained() {
    const entries: { key: string; attempt: ProtocolOperation }[] = [];
    for (const key of [this.storageKey, ...this.aliases]) {
      const raw = this.storage?.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1) throw Error('The retained scientific operation could not be read.');
      const attempt = checked(parsed.attempt);
      if (
        this.scope &&
        (attempt.request.project !== this.scope.project ||
          !('entityId' in attempt.request) ||
          attempt.request.entityId !== this.scope.entityId)
      )
        throw Error('A retained save belongs to another scientific document.');
      entries.push({ key, attempt });
    }
    if (
      entries.some((entry) => JSON.stringify(entry.attempt) !== JSON.stringify(entries[0]!.attempt))
    )
      throw Error('More than one original scientific save needs confirmation.');
    return entries;
  }
  refresh() {
    if (this.current.phase === 'sending') return;
    try {
      const entries = this.retained(),
        attempt = entries[0]?.attempt;
      if (attempt) {
        if (
          !('attempt' in this.current) ||
          JSON.stringify(this.current.attempt) !== JSON.stringify(attempt)
        )
          this.publish({
            phase: 'unknown',
            attempt,
            message: 'Confirm the original scientific save before changing this document.',
          });
      } else if (this.current.phase === 'failed') this.publish({ phase: 'editing' });
    } catch (cause) {
      this.publish({ phase: 'failed', message: text(cause) });
    }
  }
  private persist(attempt: ProtocolOperation) {
    if (!this.storage) throw Error('Scientific operation recovery storage is unavailable.');
    checked(attempt);
    if (
      this.scope &&
      (attempt.request.project !== this.scope.project ||
        !('entityId' in attempt.request) ||
        attempt.request.entityId !== this.scope.entityId)
    )
      throw Error('The scientific save belongs to another document.');
    if (this.retained().some((entry) => JSON.stringify(entry.attempt) !== JSON.stringify(attempt)))
      throw Error('Confirm the previous scientific save before changing its intent.');
    this.storage.setItem(this.storageKey, JSON.stringify({ version: 1, attempt }));
  }
  async begin(attempt: ProtocolOperation) {
    this.refresh();
    if (
      this.current.phase === 'result' &&
      this.current.result.kind === 'ready' &&
      !this.retained().length
    )
      this.publish({ phase: 'editing' });
    if (this.current.phase !== 'editing') return null;
    try {
      this.persist(attempt);
    } catch (cause) {
      this.publish({
        phase: 'failed',
        message: `The operation could not be retained safely. ${text(cause)}`,
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
            : attempt.kind === 'save'
              ? await this.client.savePackage(attempt.request)
              : attempt.kind === 'edit-declarations'
                ? await this.client.editProtocolDeclarations(attempt.request)
                : await this.client.recordRunValues(attempt.request);
      return this.accept(attempt, result);
    } catch (cause) {
      this.publish({ phase: 'unknown', attempt, message: text(cause) });
      return null;
    }
  }
  private accept(attempt: ProtocolOperation, result: NativeProtocolCreationResult) {
    if (
      !result ||
      result.requestId !== attempt.request.requestId ||
      !['ready', 'pending', 'refused', 'missing'].includes(result.kind)
    )
      throw Error('The scientific operation result has another request identity.');
    if (result.kind === 'ready') {
      if (
        result.package.projectId !== attempt.request.project ||
        ('entityId' in attempt.request && result.package.entityId !== attempt.request.entityId)
      )
        throw Error('The scientific operation belongs to another document.');
      if (!this.storage) throw Error('Scientific operation recovery storage is unavailable.');
      const entries = this.retained();
      if (entries.some((entry) => JSON.stringify(entry.attempt) !== JSON.stringify(attempt)))
        throw Error('A different scientific operation is now retained.');
      for (const entry of entries) this.storage.setItem(entry.key, '');
    } else if (
      result.kind !== 'missing' &&
      'entityId' in attempt.request &&
      result.entityId !== attempt.request.entityId
    )
      throw Error('The scientific result belongs to another document.');
    this.publish({ phase: 'result', attempt, result });
    return result;
  }
  async retry() {
    this.refresh();
    if (
      !('attempt' in this.current) ||
      this.current.phase === 'sending' ||
      (this.current.phase === 'result' && this.current.result.kind === 'ready')
    )
      return null;
    return this.send(this.current.attempt);
  }
  async inspect() {
    this.refresh();
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
      this.publish({ phase: 'unknown', attempt, message: text(cause) });
      return null;
    }
  }
}
const entitySessions = new WeakMap<NativeProtocolClient, Map<string, ProtocolOperationSession>>();
export function sharedProtocolEntityOperation(
  client: NativeProtocolClient,
  storage: Store | null,
  resource: { projectId: string; entityId: string; path: string }
) {
  let sessions = entitySessions.get(client);
  if (!sessions) {
    sessions = new Map();
    entitySessions.set(client, sessions);
  }
  const key = JSON.stringify([resource.projectId, resource.entityId]);
  let session = sessions.get(key);
  if (!session) {
    session = new ProtocolOperationSession(
      client,
      storage,
      `dnaforge.protocol.entity-operation.v1:${key}`,
      { project: resource.projectId, entityId: resource.entityId }
    );
    sessions.set(key, session);
  }
  session.addStorageAlias(
    `dnaforge.protocol.compat.v1:${JSON.stringify([resource.projectId, resource.path, 'save'])}`
  );
  return session;
}
function text(cause: unknown) {
  return cause instanceof Error ? cause.message : 'The scientific operation needs confirmation.';
}
