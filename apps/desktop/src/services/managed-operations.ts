import {
  applyAnnotationDocumentOperationsAnnotationDocumentsApplyPost,
  inspectAnnotationDocumentOperationsAnnotationDocumentsInspectPost,
  discoverOperationsOperationsCatalogGet,
  getOperationOperationsOperationIdGet,
  getOperationResultOperationsOperationIdResultGet,
  listOperationActionsOperationsOperationIdActionsGet,
  releaseOperationResultOperationsOperationIdReleaseResultPost,
  requestOperationCancelOperationsOperationIdCancelPost,
  startAnnotationOperationOperationsAnnotationPost,
  type OperationInitial,
  type AnnotationDocumentApplyResponse,
  type AnnotationDocumentInspection,
  type AnnotationDocumentSelection,
  type AnnotationDocumentTarget,
  type AnnotationRequest,
  type AnnotationSubmission,
  type OperationCancelResponse,
  type OperationCatalog,
  type OperationActionPage,
  type OperationEvent,
  type OperationReleaseResponse,
  type OperationSnapshot,
  type OperationAcceptedWorkspaceInput,
} from '@waypoint/api-client';
import { ServiceManager } from './service-manager';
import { requireHostedCapability } from '../hosted/capabilities';

export type ManagedOperationResultEnvelope = Extract<
  Awaited<ReturnType<typeof getOperationResultOperationsOperationIdResultGet>>,
  { status: 200 }
>['data'];

export interface ManagedOperationObservation {
  readonly freshness: 'current' | 'stale';
  readonly observedAtMs: number;
  readonly reason?: string;
}

export interface ManagedOperationRecord {
  readonly snapshot: OperationSnapshot;
  readonly observation: ManagedOperationObservation;
  readonly cancelResponse?: OperationCancelResponse;
}

export interface ManagedOperationsSnapshot {
  readonly status: 'detached' | 'connecting' | 'connected' | 'stale';
  readonly scopeId: string | null;
  readonly ownerId: string | null;
  readonly ownerInstanceId: string | null;
  readonly records: readonly ManagedOperationRecord[];
  readonly historySummary: ManagedOperationsHistorySummary | null;
  readonly supportedActionsByKind: Readonly<Record<string, readonly string[]>>;
  readonly kindCatalogByKind: Readonly<Record<string, OperationCatalog['kinds'][number]>>;
  readonly reconnectAvailable: boolean;
  readonly reason?: string;
}

export interface ManagedOperationsHistorySummary {
  readonly operationCount: number;
  readonly activeCount: number;
  readonly terminalCount: number;
  readonly historyComplete: boolean;
}

export interface ManagedOperationInputFile {
  readonly key: string;
  readonly path: string;
}

export interface ManagedOperationWorkspaceResult {
  readonly operationId: string;
  readonly inputRevision: string;
  readonly path: string;
  readonly content: string;
}

export interface ManagedOperationsRuntimeSource {
  getStatus(): Promise<string>;
  getBaseUrl(): Promise<string>;
  subscribeStatus(listener: (status: string) => void): () => void;
  prepareAcceptedInput?(
    files: readonly ManagedOperationInputFile[]
  ): Promise<OperationAcceptedWorkspaceInput>;
  publishWorkspaceResult?(result: ManagedOperationWorkspaceResult): Promise<void>;
}

export interface RegisteredOperationStartContext {
  readonly scopeId: string;
  readonly submissionKey: string;
  readonly acceptedWorkspaceInput?: OperationAcceptedWorkspaceInput;
  readonly expectedAccountId?: string;
}

export interface ManagedOperationWaitOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type RegisteredOperationStarter = (
  context: RegisteredOperationStartContext
) => Promise<OperationSnapshot>;

export interface ManagedOperationsEventSource {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface ManagedOperationsApi {
  configureBaseUrl(baseUrl: string): void;
  getBaseUrl(): string;
  bindGeneratedClient(): void;
  discover(): Promise<OperationCatalog>;
  startAnnotation(input: AnnotationSubmission): Promise<OperationSnapshot>;
  getOperation(operationId: string): Promise<OperationSnapshot>;
  getActions(
    operationId: string,
    params: { readonly limit: number; readonly offset: number }
  ): Promise<OperationActionPage>;
  getResult(operationId: string): Promise<ManagedOperationResultEnvelope>;
  inspectAnnotationDocument(
    target: AnnotationDocumentTarget
  ): Promise<AnnotationDocumentInspection>;
  applyAnnotationDocument(
    selection: AnnotationDocumentSelection
  ): Promise<AnnotationDocumentApplyResponse>;
  releaseResult(operationId: string): Promise<OperationReleaseResponse>;
  requestCancel(operationId: string): Promise<OperationCancelResponse>;
}

interface ManagedOperationsDependencies {
  readonly api: ManagedOperationsApi;
  readonly createEventSource: (url: string) => ManagedOperationsEventSource;
  readonly now: () => number;
  readonly createSubmissionKey: () => string;
}

interface CollectionMetadataPayload {
  readonly operation_count?: unknown;
  readonly active_count?: unknown;
  readonly terminal_count?: unknown;
  readonly history_complete?: unknown;
}

type SnapshotEventEnvelope = OperationEvent & {
  readonly kind: 'snapshot';
  readonly snapshot: OperationSnapshot;
  readonly operation_count: number;
  readonly active_count: number;
  readonly terminal_count: number;
  readonly history_complete: boolean;
};

type Listener = () => void;

export class ManagedOperationSubmissionUncertainError extends Error {
  readonly submissionKey: string;

  constructor(submissionKey: string) {
    super(
      `The job submission completed after the execution runtime changed. Its outcome is uncertain; reconcile using submission key ${submissionKey}.`
    );
    this.name = 'ManagedOperationSubmissionUncertainError';
    this.submissionKey = submissionKey;
  }
}

export class ManagedDocumentReceiptFromPreviousRuntimeError extends Error {
  constructor(
    readonly operationId: string,
    readonly receipt: AnnotationDocumentApplyResponse
  ) {
    super(
      `The document command returned after the execution runtime changed. Check action ${receipt.actionId} in the previous runtime before repeating work.`
    );
    this.name = 'ManagedDocumentReceiptFromPreviousRuntimeError';
  }
}

const EMPTY_SNAPSHOT: ManagedOperationsSnapshot = {
  status: 'detached',
  scopeId: null,
  ownerId: null,
  ownerInstanceId: null,
  records: [],
  historySummary: null,
  supportedActionsByKind: {},
  kindCatalogByKind: {},
  reconnectAvailable: false,
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') return detail;
  }
  if (typeof error === 'object' && error !== null && 'body' in error) {
    const message = ((error as { body?: { message?: unknown } }).body ?? {}).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function parseJson<T>(data: string): T {
  return JSON.parse(data) as T;
}

const ACTIVE_OPERATION_STATES = new Set(['queued', 'running', 'stopping']);
const TERMINAL_OPERATION_STATES = new Set(['succeeded', 'failed', 'canceled', 'interrupted']);
const OPERATION_CONNECTION_WAIT_MS = 30_000;

function requireCollectionMetadata(
  payload: CollectionMetadataPayload
): ManagedOperationsHistorySummary {
  const operationCount = payload.operation_count;
  const activeCount = payload.active_count;
  const terminalCount = payload.terminal_count;
  if (
    typeof operationCount !== 'number' ||
    typeof activeCount !== 'number' ||
    typeof terminalCount !== 'number' ||
    !Number.isInteger(operationCount) ||
    !Number.isInteger(activeCount) ||
    !Number.isInteger(terminalCount) ||
    operationCount < 0 ||
    activeCount < 0 ||
    terminalCount < 0 ||
    operationCount !== activeCount + terminalCount ||
    typeof payload.history_complete !== 'boolean'
  ) {
    throw new Error('Operation stream collection metadata was invalid.');
  }
  return {
    operationCount,
    activeCount,
    terminalCount,
    historyComplete: payload.history_complete,
  };
}

function requireInitialPayload(data: string, expectedScopeId: string): OperationInitial {
  const payload = parseJson<OperationInitial>(data);
  if (!payload || !Array.isArray(payload.operations)) {
    throw new Error('Operation stream initial payload did not contain an operations list.');
  }
  const summary = requireCollectionMetadata(payload);
  for (const operation of payload.operations) {
    if (
      !operation ||
      typeof operation.id !== 'string' ||
      !Number.isInteger(operation.version) ||
      operation.version < 1 ||
      operation.subject?.scope_id !== expectedScopeId
    ) {
      throw new Error('Operation stream initial payload contained an invalid snapshot.');
    }
  }
  const returnedActiveCount = payload.operations.filter((operation) =>
    ACTIVE_OPERATION_STATES.has(operation.state)
  ).length;
  if (
    returnedActiveCount !== summary.activeCount ||
    payload.operations.length > summary.operationCount ||
    (summary.historyComplete && payload.operations.length !== summary.operationCount)
  ) {
    throw new Error('Operation stream initial payload did not match its collection metadata.');
  }
  return payload;
}

function requireSnapshotEvent(data: string, expectedScopeId: string): SnapshotEventEnvelope {
  const event = parseJson<OperationEvent>(data);
  if (
    !event ||
    event.kind !== 'snapshot' ||
    !event.snapshot ||
    typeof event.snapshot.id !== 'string' ||
    !Number.isInteger(event.snapshot.version) ||
    event.snapshot.version < 1 ||
    event.snapshot.subject?.scope_id !== expectedScopeId
  ) {
    throw new Error('Operation stream sent an invalid snapshot event.');
  }
  requireCollectionMetadata(event);
  return event as SnapshotEventEnvelope;
}

function historySummary(payload: CollectionMetadataPayload): ManagedOperationsHistorySummary {
  return requireCollectionMetadata(payload);
}

function eventStreamUrl(baseUrl: string, scopeId: string): string {
  const url = new URL('operations/events', `${baseUrl.replace(/\/+$/, '')}/`);
  url.searchParams.set('scope_id', scopeId);
  return url.toString();
}

const managedOperationsServiceManager = new ServiceManager();

const generatedOperationsApi: ManagedOperationsApi = {
  configureBaseUrl(baseUrl) {
    managedOperationsServiceManager.setBaseUrl(baseUrl);
  },
  getBaseUrl() {
    return managedOperationsServiceManager.getBaseUrl();
  },
  bindGeneratedClient() {
    managedOperationsServiceManager.bindGeneratedClient();
  },
  async discover() {
    const response = await discoverOperationsOperationsCatalogGet();
    if (response.status !== 200) throw new Error('Operation catalog request was rejected.');
    return response.data;
  },
  async startAnnotation(input) {
    const response = await startAnnotationOperationOperationsAnnotationPost(input);
    if (response.status !== 202) throw new Error('Annotation operation request was rejected.');
    return response.data;
  },
  async getOperation(operationId) {
    const response = await getOperationOperationsOperationIdGet(operationId);
    if (response.status !== 200) throw new Error('Operation request was rejected.');
    return response.data;
  },
  async getActions(operationId, params) {
    const response = await listOperationActionsOperationsOperationIdActionsGet(operationId, params);
    if (response.status !== 200) throw new Error('Operation action history request was rejected.');
    return response.data;
  },
  async getResult(operationId) {
    const response = await getOperationResultOperationsOperationIdResultGet(operationId);
    if (response.status !== 200) throw new Error('Operation result request was rejected.');
    return response.data;
  },
  async inspectAnnotationDocument(target) {
    const response =
      await inspectAnnotationDocumentOperationsAnnotationDocumentsInspectPost(target);
    if (response.status !== 200) throw new Error('Document inspection was rejected.');
    return response.data;
  },
  async applyAnnotationDocument(selection) {
    const response = await applyAnnotationDocumentOperationsAnnotationDocumentsApplyPost(selection);
    if (response.status !== 200) throw new Error('Document Apply was rejected.');
    return response.data;
  },
  async releaseResult(operationId) {
    const response =
      await releaseOperationResultOperationsOperationIdReleaseResultPost(operationId);
    if (response.status !== 200) throw new Error('Operation result release was rejected.');
    return response.data;
  },
  async requestCancel(operationId) {
    const response = await requestOperationCancelOperationsOperationIdCancelPost(operationId);
    if (response.status !== 200) throw new Error('Operation cancellation request was rejected.');
    return response.data;
  },
};

const defaultDependencies: ManagedOperationsDependencies = {
  api: generatedOperationsApi,
  createEventSource: (url) => new EventSource(url),
  now: () => Date.now(),
  createSubmissionKey: () => globalThis.crypto.randomUUID(),
};

export class ManagedOperationsStore {
  private readonly dependencies: ManagedOperationsDependencies;
  private readonly listeners = new Set<Listener>();
  private snapshot: ManagedOperationsSnapshot = EMPTY_SNAPSHOT;
  private records = new Map<string, ManagedOperationRecord>();
  private historySummary: ManagedOperationsHistorySummary | null = null;
  private runtimeSource: ManagedOperationsRuntimeSource | null = null;
  private unsubscribeRuntime: (() => void) | null = null;
  private eventSource: ManagedOperationsEventSource | null = null;
  private attachCount = 0;
  private attachGeneration = 0;
  private connectionGeneration = 0;
  private statusPushVersion = 0;
  private acceptedInitial = false;

  constructor(dependencies: ManagedOperationsDependencies = defaultDependencies) {
    this.dependencies = dependencies;
  }

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ManagedOperationsSnapshot => this.snapshot;

  attach(runtimeSource: ManagedOperationsRuntimeSource): () => void {
    if (this.runtimeSource && this.runtimeSource !== runtimeSource) {
      throw new Error('Managed operations observer is already attached to another runtime source.');
    }

    this.attachCount += 1;
    if (this.attachCount === 1 && !this.runtimeSource) {
      this.startRuntimeObservation(runtimeSource);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.attachCount = Math.max(0, this.attachCount - 1);
      if (this.attachCount === 0) this.stopRuntimeObservation();
    };
  }

  async startAnnotation(
    subjectId: string,
    request: AnnotationRequest,
    submissionKey = this.dependencies.createSubmissionKey()
  ): Promise<OperationSnapshot> {
    return this.startRegisteredOperation(({ scopeId, submissionKey: admittedKey }) => {
      const submission: AnnotationSubmission = {
        input: request,
        subject: { scope_id: scopeId, subject_id: subjectId },
        submission_key: admittedKey,
      };
      return this.dependencies.api.startAnnotation(submission);
    }, submissionKey);
  }

  async startRegisteredOperation(
    start: RegisteredOperationStarter,
    submissionKey = this.dependencies.createSubmissionKey(),
    inputFiles: readonly ManagedOperationInputFile[] = []
  ): Promise<OperationSnapshot> {
    requireHostedCapability('server-jobs');
    if (this.snapshot.status !== 'connected' || !this.snapshot.scopeId) {
      await this.waitForConnectedRuntime();
    }
    const command = this.requireConnectedRuntime();
    const ownerId = this.snapshot.ownerId;
    const acceptedWorkspaceInput = this.runtimeSource?.prepareAcceptedInput
      ? await this.runtimeSource.prepareAcceptedInput(inputFiles)
      : undefined;
    if (!this.isSameConnectedRuntime(command.connectionGeneration)) {
      throw new Error(
        'The execution owner changed before the job was submitted. Reopen the alignment and retry.'
      );
    }
    if (
      acceptedWorkspaceInput &&
      (!ownerId || acceptedWorkspaceInput.workspace_id !== command.scopeId)
    ) {
      throw new Error('The saved input files do not belong to the current execution owner.');
    }
    this.dependencies.api.bindGeneratedClient();
    const snapshot = await start({
      scopeId: command.scopeId,
      submissionKey,
      ...(acceptedWorkspaceInput ? { acceptedWorkspaceInput, expectedAccountId: ownerId! } : {}),
    });
    if (!this.isSameConnectedRuntime(command.connectionGeneration)) {
      throw new ManagedOperationSubmissionUncertainError(submissionKey);
    }
    if (snapshot.subject.scope_id !== command.scopeId) {
      throw new Error('The operation owner returned a job from a different scope.');
    }
    this.acceptSnapshot(snapshot);
    return snapshot;
  }

  async publishWorkspaceResult(result: ManagedOperationWorkspaceResult): Promise<void> {
    const command = this.requireConnectedRuntime();
    const publish = this.runtimeSource?.publishWorkspaceResult;
    if (!publish)
      throw new Error(
        'This runtime cannot safely attach the retained result. Reopen the project and retry.'
      );
    await publish(result);
    this.requireSameConnection(command.connectionGeneration, 'Result attachment');
  }

  private async waitForConnectedRuntime(timeoutMs = OPERATION_CONNECTION_WAIT_MS): Promise<void> {
    if (this.snapshot.status === 'connected' && this.snapshot.scopeId) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let unsubscribe: () => void = () => undefined;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        globalThis.clearTimeout(timeout);
        callback();
      };
      const observe = (): void => {
        if (this.snapshot.status === 'connected' && this.snapshot.scopeId) {
          finish(resolve);
        }
      };

      const timeout = globalThis.setTimeout(() => {
        finish(() => {
          const reason = this.snapshot.reason ? ` ${this.snapshot.reason}` : '';
          reject(
            new Error(
              `Managed operations did not connect to an execution owner within ${timeoutMs} ms.${reason}`
            )
          );
        });
      }, timeoutMs);
      unsubscribe = this.subscribe(observe);
      observe();
    });
  }

  async getOperation(operationId: string): Promise<OperationSnapshot> {
    const command = this.requireConnectedRuntime();
    this.dependencies.api.bindGeneratedClient();
    const snapshot = await this.dependencies.api.getOperation(operationId);
    this.requireSameConnection(command.connectionGeneration, 'Operation read');
    this.acceptSnapshot(snapshot);
    return snapshot;
  }

  async waitForTerminal(
    operationId: string,
    options: ManagedOperationWaitOptions = {}
  ): Promise<OperationSnapshot> {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      throw new Error('Operation wait timeout must be a positive number of milliseconds.');
    }
    if (this.snapshot.status !== 'connected' || !this.snapshot.scopeId) {
      await this.waitForConnectedRuntime();
    }
    const command = this.requireConnectedRuntime();

    return new Promise<OperationSnapshot>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
      let unsubscribe = (): void => undefined;
      const abort = (): void => {
        finish(() => reject(new Error(`Stopped waiting for operation ${operationId}.`)));
      };
      const finish = (settle: () => void): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        if (timeout !== undefined) globalThis.clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abort);
        settle();
      };
      const observe = (): void => {
        if (
          this.connectionGeneration !== command.connectionGeneration ||
          this.snapshot.scopeId !== command.scopeId
        ) {
          finish(() =>
            reject(
              new Error(
                `Operation ${operationId} observation was interrupted. The job remains available in Jobs.`
              )
            )
          );
          return;
        }
        const record = this.records.get(operationId);
        if (!record || record.snapshot.subject.scope_id !== command.scopeId) {
          finish(() =>
            reject(new Error(`Operation ${operationId} is not current in this execution scope.`))
          );
          return;
        }
        if (this.snapshot.status !== 'connected' || record.observation.freshness !== 'current') {
          return;
        }
        if (TERMINAL_OPERATION_STATES.has(record.snapshot.state)) {
          finish(() => resolve(record.snapshot));
        }
      };

      unsubscribe = this.subscribe(observe);
      if (options.timeoutMs !== undefined) {
        timeout = globalThis.setTimeout(() => {
          finish(() =>
            reject(
              new Error(
                `Timed out waiting for operation ${operationId}. The job continues in Jobs.`
              )
            )
          );
        }, options.timeoutMs);
      }
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener('abort', abort, { once: true });
      observe();
    });
  }

  async getActions(operationId: string, limit = 20): Promise<OperationActionPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Operation action history limit must be between 1 and 100.');
    }
    const command = this.requireConnectedRuntime();
    const record = this.records.get(operationId);
    if (
      !record ||
      record.observation.freshness !== 'current' ||
      record.snapshot.subject.scope_id !== command.scopeId
    ) {
      throw new Error(`Operation ${operationId} is not in the current operation scope.`);
    }
    const identity = {
      kind: record.snapshot.kind,
      ownerInstanceId: record.snapshot.owner_instance_id,
      subjectId: record.snapshot.subject.subject_id,
    };

    this.dependencies.api.bindGeneratedClient();
    const page = await this.dependencies.api.getActions(operationId, { limit, offset: 0 });
    this.requireSameConnection(command.connectionGeneration, 'Operation action history read');

    const current = this.records.get(operationId);
    if (
      !current ||
      current.observation.freshness !== 'current' ||
      current.snapshot.subject.scope_id !== command.scopeId ||
      current.snapshot.kind !== identity.kind ||
      current.snapshot.owner_instance_id !== identity.ownerInstanceId ||
      current.snapshot.subject.subject_id !== identity.subjectId
    ) {
      throw new Error(
        'Operation action history read completed after the operation identity changed.'
      );
    }
    return page;
  }

  async getResult(operationId: string): Promise<ManagedOperationResultEnvelope> {
    const command = this.requireConnectedRuntime();
    this.dependencies.api.bindGeneratedClient();
    const result = await this.dependencies.api.getResult(operationId);
    this.requireSameConnection(command.connectionGeneration, 'Operation result read');
    return result;
  }

  async inspectAnnotationDocument(
    target: AnnotationDocumentTarget
  ): Promise<AnnotationDocumentInspection> {
    const command = this.requireConnectedRuntime();
    this.dependencies.api.bindGeneratedClient();
    const result = await this.dependencies.api.inspectAnnotationDocument({ ...target });
    this.requireSameConnection(command.connectionGeneration, 'Document inspection');
    return result;
  }

  async applyAnnotationDocument(
    selection: AnnotationDocumentSelection
  ): Promise<AnnotationDocumentApplyResponse> {
    const command = this.requireConnectedRuntime();
    const reviewed = { ...selection, selectedCandidateIds: [...selection.selectedCandidateIds] };
    this.dependencies.api.bindGeneratedClient();
    const receipt = await this.dependencies.api.applyAnnotationDocument(reviewed);
    if (!this.isSameConnectedRuntime(command.connectionGeneration)) {
      throw new ManagedDocumentReceiptFromPreviousRuntimeError(reviewed.operationId, receipt);
    }
    return receipt;
  }

  async releaseResult(operationId: string): Promise<OperationReleaseResponse> {
    const command = this.requireConnectedRuntime();
    this.dependencies.api.bindGeneratedClient();
    const response = await this.dependencies.api.releaseResult(operationId);
    this.requireSameConnection(command.connectionGeneration, 'Operation result release');
    this.acceptSnapshot(response.snapshot);
    return response;
  }

  async requestCancel(operationId: string): Promise<OperationCancelResponse> {
    const command = this.requireConnectedRuntime();
    this.dependencies.api.bindGeneratedClient();
    const response = await this.dependencies.api.requestCancel(operationId);
    this.requireSameConnection(command.connectionGeneration, 'Cancellation request');
    this.acceptSnapshot(response.snapshot, response);
    return response;
  }

  async reconnect(): Promise<void> {
    const runtimeSource = this.runtimeSource;
    const attachGeneration = this.attachGeneration;
    if (!runtimeSource || !this.snapshot.reconnectAvailable) {
      throw new Error('Managed operation reconnection is not available.');
    }

    this.publish({ status: 'connecting', reconnectAvailable: false, reason: undefined });
    try {
      const status = await runtimeSource.getStatus();
      if (this.attachGeneration !== attachGeneration || this.runtimeSource !== runtimeSource)
        return;
      if (status !== 'ready') {
        this.invalidateConnection(`Execution owner is ${status || 'unavailable'}`);
        return;
      }
      await this.connectCurrentRuntime(runtimeSource, attachGeneration);
    } catch (error: unknown) {
      if (this.attachGeneration !== attachGeneration || this.runtimeSource !== runtimeSource)
        return;
      this.invalidateConnection(
        `Could not reconnect to the execution owner: ${errorMessage(error)}`
      );
    }
  }

  private startRuntimeObservation(runtimeSource: ManagedOperationsRuntimeSource): void {
    this.runtimeSource = runtimeSource;
    const attachGeneration = ++this.attachGeneration;
    this.statusPushVersion = 0;
    this.unsubscribeRuntime = runtimeSource.subscribeStatus((status) => {
      this.statusPushVersion += 1;
      this.applyRuntimeStatus(status, attachGeneration);
    });
    const pullVersion = this.statusPushVersion;
    void runtimeSource
      .getStatus()
      .then((status) => {
        if (this.attachGeneration === attachGeneration && this.statusPushVersion === pullVersion) {
          this.applyRuntimeStatus(status, attachGeneration);
        }
      })
      .catch((error: unknown) => {
        if (this.attachGeneration !== attachGeneration || this.statusPushVersion !== pullVersion)
          return;
        this.invalidateConnection(`Execution owner status is unavailable: ${errorMessage(error)}`);
      });
  }

  private stopRuntimeObservation(): void {
    this.attachGeneration += 1;
    this.connectionGeneration += 1;
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
    this.runtimeSource = null;
    this.closeEventSource();
    this.acceptedInitial = false;
    this.markRecordsStale('Operation observation is detached');
    this.publish({ status: 'detached', reconnectAvailable: false, reason: undefined });
  }

  private applyRuntimeStatus(status: string, attachGeneration: number): void {
    if (this.attachGeneration !== attachGeneration || !this.runtimeSource) return;
    if (status === 'ready') {
      if (
        this.snapshot.status === 'connected' ||
        this.snapshot.status === 'connecting' ||
        this.eventSource !== null
      ) {
        return;
      }
      void this.connectCurrentRuntime(this.runtimeSource, attachGeneration);
      return;
    }
    this.invalidateConnection(`Execution owner is ${status || 'unavailable'}`);
  }

  private async connectCurrentRuntime(
    runtimeSource: ManagedOperationsRuntimeSource,
    attachGeneration: number,
    staleReason = 'Reconnecting to execution owner'
  ): Promise<void> {
    const connectionGeneration = ++this.connectionGeneration;
    this.closeEventSource();
    this.acceptedInitial = false;
    this.markRecordsStale(staleReason);
    this.publish({ status: 'connecting', reconnectAvailable: false, reason: undefined });

    try {
      const baseUrl = await runtimeSource.getBaseUrl();
      if (!this.isCurrentConnection(attachGeneration, connectionGeneration)) return;
      this.dependencies.api.configureBaseUrl(baseUrl);
      this.dependencies.api.bindGeneratedClient();
      const catalog = await this.dependencies.api.discover();
      if (!this.isCurrentConnection(attachGeneration, connectionGeneration)) return;

      const source = this.dependencies.createEventSource(
        eventStreamUrl(this.dependencies.api.getBaseUrl(), catalog.scope_id)
      );
      this.eventSource = source;
      source.addEventListener('initial', (event) => {
        if (!this.isCurrentConnection(attachGeneration, connectionGeneration)) return;
        try {
          const initial = requireInitialPayload(event.data, catalog.scope_id);
          this.installInitial(initial, catalog);
        } catch (error: unknown) {
          this.invalidateConnection(
            `Operation stream initial state was invalid: ${errorMessage(error)}`
          );
        }
      });
      source.addEventListener('snapshot', (event) => {
        if (
          !this.isCurrentConnection(attachGeneration, connectionGeneration) ||
          !this.acceptedInitial
        ) {
          return;
        }
        try {
          const update = requireSnapshotEvent(event.data, catalog.scope_id);
          this.acceptSnapshot(update.snapshot, undefined, historySummary(update));
        } catch (error: unknown) {
          this.invalidateConnection(`Operation stream update was invalid: ${errorMessage(error)}`);
        }
      });
      source.addEventListener('resync_required', () => {
        if (!this.isCurrentConnection(attachGeneration, connectionGeneration)) return;
        void this.connectCurrentRuntime(
          runtimeSource,
          attachGeneration,
          'Operation owner requested a complete resynchronization'
        );
      });
      source.addEventListener('authorization_revoked', () => {
        if (!this.isCurrentConnection(attachGeneration, connectionGeneration)) return;
        this.invalidateConnection('Operation observation authorization was revoked');
      });
      source.addEventListener('error', () => {
        if (!this.isCurrentConnection(attachGeneration, connectionGeneration)) return;
        this.markTransportInterrupted('Connection to the execution owner was interrupted');
      });
    } catch (error: unknown) {
      if (!this.isCurrentConnection(attachGeneration, connectionGeneration)) return;
      this.invalidateConnection(`Could not connect to the execution owner: ${errorMessage(error)}`);
    }
  }

  private isCurrentConnection(attachGeneration: number, connectionGeneration: number): boolean {
    return (
      this.attachGeneration === attachGeneration &&
      this.connectionGeneration === connectionGeneration &&
      this.runtimeSource !== null
    );
  }

  private installInitial(initial: OperationInitial, catalog: OperationCatalog): void {
    const previous = this.records;
    const observedAtMs = this.dependencies.now();
    this.records = new Map(
      initial.operations.map((snapshot) => {
        const oldRecord = previous.get(snapshot.id);
        return [
          snapshot.id,
          {
            snapshot,
            observation: { freshness: 'current', observedAtMs },
            ...(oldRecord?.cancelResponse ? { cancelResponse: oldRecord.cancelResponse } : {}),
          } satisfies ManagedOperationRecord,
        ];
      })
    );
    this.historySummary = historySummary(initial);
    this.acceptedInitial = true;
    this.publish({
      status: 'connected',
      scopeId: catalog.scope_id,
      ownerId: catalog.owner_id,
      ownerInstanceId: catalog.owner_instance_id,
      supportedActionsByKind: Object.fromEntries(
        catalog.kinds.map((kind) => [kind.kind, [...kind.actions]])
      ),
      kindCatalogByKind: Object.fromEntries(catalog.kinds.map((kind) => [kind.kind, kind])),
      reconnectAvailable: false,
      reason: undefined,
    });
  }

  private acceptSnapshot(
    snapshot: OperationSnapshot,
    cancelResponse?: OperationCancelResponse,
    nextHistorySummary?: ManagedOperationsHistorySummary
  ): void {
    if (snapshot.subject.scope_id !== this.snapshot.scopeId) return;
    const current = this.records.get(snapshot.id);
    if (current && snapshot.version <= current.snapshot.version) {
      let changed = false;
      if (cancelResponse && cancelResponse !== current.cancelResponse) {
        this.records = new Map(this.records);
        this.records.set(snapshot.id, { ...current, cancelResponse });
        changed = true;
      }
      if (nextHistorySummary) {
        this.historySummary = nextHistorySummary;
        changed = true;
      }
      if (changed) this.publish();
      return;
    }

    if (nextHistorySummary) this.historySummary = nextHistorySummary;
    this.records = new Map(this.records);
    this.records.set(snapshot.id, {
      snapshot,
      observation: { freshness: 'current', observedAtMs: this.dependencies.now() },
      ...(cancelResponse || current?.cancelResponse
        ? { cancelResponse: cancelResponse ?? current?.cancelResponse }
        : {}),
    });
    this.publish();
  }

  private invalidateConnection(reason: string): void {
    this.connectionGeneration += 1;
    this.closeEventSource();
    this.acceptedInitial = false;
    this.markRecordsStale(reason);
    this.publish({
      status: 'stale',
      reconnectAvailable: this.runtimeSource !== null,
      reason,
    });
  }

  private markTransportInterrupted(reason: string): void {
    this.acceptedInitial = false;
    this.markRecordsStale(reason);
    this.publish({ status: 'stale', reconnectAvailable: false, reason });
  }

  private markRecordsStale(reason: string): void {
    if (this.records.size === 0) return;
    this.records = new Map(
      [...this.records].map(([id, record]) => [
        id,
        {
          ...record,
          observation: {
            freshness: 'stale',
            observedAtMs: record.observation.observedAtMs,
            reason,
          },
        },
      ])
    );
  }

  private closeEventSource(): void {
    this.eventSource?.close();
    this.eventSource = null;
  }

  private requireConnectedRuntime(): { scopeId: string; connectionGeneration: number } {
    if (this.snapshot.status !== 'connected' || !this.snapshot.scopeId) {
      throw new Error('Managed operations are not connected to an execution owner.');
    }
    return {
      scopeId: this.snapshot.scopeId,
      connectionGeneration: this.connectionGeneration,
    };
  }

  private requireSameConnection(connectionGeneration: number, command: string): void {
    if (!this.isSameConnectedRuntime(connectionGeneration)) {
      throw new Error(`${command} completed after the execution runtime changed.`);
    }
  }

  private isSameConnectedRuntime(connectionGeneration: number): boolean {
    return (
      this.connectionGeneration === connectionGeneration && this.snapshot.status === 'connected'
    );
  }

  private publish(overrides: Partial<ManagedOperationsSnapshot> = {}): void {
    this.snapshot = {
      ...this.snapshot,
      ...overrides,
      records: [...this.records.values()],
      historySummary: this.historySummary,
    };
    for (const listener of this.listeners) listener();
  }
}

export const managedOperations = new ManagedOperationsStore();
