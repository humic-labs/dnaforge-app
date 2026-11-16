import {
  createInventoryState,
  type InventoryCommand,
  type InventoryEquipmentCatalogEntry,
  type InventoryItemCodeQuery,
  type InventoryState,
  type InventoryResolvedImportOptions,
  type InventoryArchiveSha256,
  type InventoryTableSha256,
  type InventoryResolvedTableOptions,
  type InventoryStocktakeChoices,
  type InventoryResolvedSourceRevisionOptions,
  type InventoryHierarchyChoices,
} from '@waypoint/domain-services';
import {
  inventoryExecuteRequestSchema,
  inventoryAcceptedRequestSchema,
  inventoryApplyImportRequestSchema,
  inventoryApplyTableRequestSchema,
  inventoryApplyStocktakeRequestSchema,
  inventoryAcknowledgeSourceRequestSchema,
  inventoryApplyHierarchyRequestSchema,
  inventoryReceiptSchema,
  type InventoryAcceptedRequest,
  type NativeInventoryHistoryEntry,
  type NativeInventoryReceipt,
  type NativeInventoryExecution,
} from '../../shared/inventory-command';
import type {
  InventoryAvailabilitySnapshot,
  InventoryClient,
  InventoryProject,
  InventoryItemCodeLookupSnapshot,
  InventoryPrepareLabelRequest,
  InventoryStorageConditionsSnapshot,
} from '../../shared/inventory-client';
import { InventoryLabelSession, type InventoryLabelOutputPort } from './inventory-label-session';
import { InventoryArchiveSession } from './inventory-archive-session';
import type { InventoryReadRequest } from '../../shared/inventory-command';
import type { InventoryTextOutputPort } from './inventory-text-output';

export interface InventoryData {
  project: InventoryProject;
  state: InventoryState;
  history: readonly NativeInventoryHistoryEntry[];
  availability: InventoryAvailabilitySnapshot | null;
  storageConditions: InventoryStorageConditionsSnapshot;
}

export interface InventoryAttempt {
  request: InventoryAcceptedRequest;
  summary: string;
  receipt?: NativeInventoryReceipt;
}

export type InventoryControllerState =
  | { kind: 'loading'; project: InventoryProject | null; previous?: InventoryData }
  | { kind: 'no-project' }
  | { kind: 'ready'; data: InventoryData }
  | { kind: 'submitting'; stage: 'sending'; data: InventoryData; attempt: InventoryAttempt }
  | {
      kind: 'submitting';
      stage: 'refreshing';
      data: InventoryData;
      attempt: InventoryAttempt & { receipt: NativeInventoryReceipt };
    }
  | { kind: 'outcome-unknown'; data: InventoryData; attempt: InventoryAttempt; message: string }
  | {
      kind: 'refused';
      project: InventoryProject | null;
      data?: InventoryData;
      message: string;
      code: string;
      attempt?: InventoryAttempt;
      recoveryError?: string;
    }
  | {
      kind: 'conflict';
      data: InventoryData;
      attempt: InventoryAttempt;
      message: string;
      reviewReady: boolean;
      recoveryError?: string;
    }
  | {
      kind: 'committed-refresh-failed';
      data: InventoryData;
      attempt: InventoryAttempt & { receipt: NativeInventoryReceipt };
      message: string;
    };

export interface InventoryControllerSnapshot {
  projects: readonly InventoryProject[];
  status: InventoryControllerState;
  projectsError?: string;
  catalog: InventoryCatalogState;
  itemCodeLookup: InventoryItemCodeLookupState;
}

export type InventoryItemCodeLookupState =
  | { kind: 'idle' }
  | {
      kind: 'resolving';
      projectId: string;
      inventoryId: string;
      revision: number;
      query: InventoryItemCodeQuery;
    }
  | { kind: 'ready'; query: InventoryItemCodeQuery; lookup: InventoryItemCodeLookupSnapshot }
  | { kind: 'unavailable'; message: string };

export type InventoryCatalogState =
  | { kind: 'idle' }
  | { kind: 'loading'; projectId: string }
  | { kind: 'ready'; projectId: string; entries: readonly InventoryEquipmentCatalogEntry[] }
  | { kind: 'failed'; projectId: string; message: string };

export interface InventoryAttemptStorage {
  read(): readonly InventoryAttempt[];
  write(attempts: readonly InventoryAttempt[]): void;
}

const STORAGE_KEY = 'dnaforge.inventory.pending.v1';

export function inventoryAttemptStorage(
  storage: Pick<Storage, 'getItem' | 'setItem'>
): InventoryAttemptStorage {
  return {
    read() {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value)) throw new Error('Saved inventory changes could not be read.');
      return value.map((entry: unknown) => {
        if (
          !entry ||
          typeof entry !== 'object' ||
          typeof Reflect.get(entry, 'summary') !== 'string'
        )
          throw new Error('Saved inventory changes could not be read.');
        const receipt = Reflect.get(entry, 'receipt');
        return {
          request: inventoryAcceptedRequestSchema.parse(Reflect.get(entry, 'request')),
          summary: Reflect.get(entry, 'summary') as string,
          ...(receipt ? { receipt: inventoryReceiptSchema.parse(receipt) } : {}),
        };
      });
    },
    write: (attempts) => storage.setItem(STORAGE_KEY, JSON.stringify(attempts)),
  };
}

function scopeKey(project: string, inventoryId: string): string {
  return JSON.stringify([project, inventoryId]);
}

export function inventoryData(status: InventoryControllerState): InventoryData | undefined {
  if ('data' in status) return status.data;
  return status.kind === 'loading' ? status.previous : undefined;
}

export function inventoryCanEdit(status: InventoryControllerState): boolean {
  const data = inventoryData(status);
  return Boolean(
    data &&
    !data.project.pinned &&
    (status.kind === 'ready' ||
      (status.kind === 'refused' &&
        !status.recoveryError &&
        !['INVENTORY_READ_FAILED', 'INVENTORY_UNAVAILABLE'].includes(status.code)))
  );
}

export class InventoryController {
  private snapshot: InventoryControllerSnapshot = {
    projects: [],
    status: { kind: 'loading', project: null },
    catalog: { kind: 'idle' },
    itemCodeLookup: { kind: 'idle' },
  };
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, InventoryAttempt>();
  private readonly observedRevision = new Map<string, number>();
  private generation = 0;
  private projectsGeneration = 0;
  private initialized = false;
  private catalogGeneration = 0;
  private itemCodeGeneration = 0;
  private readonly catalogCache = new Map<string, readonly InventoryEquipmentCatalogEntry[]>();
  private readonly labelSessions = new Map<string, InventoryLabelSession>();
  private readonly archiveSessions = new Map<string, InventoryArchiveSession>();
  private readonly storageFreshnessPolicies = new Map<string, number | null>();
  private opening: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly client: InventoryClient,
    private readonly storage: InventoryAttemptStorage,
    private readonly operationId: () => string = () => crypto.randomUUID()
  ) {}

  getSnapshot = (): InventoryControllerSnapshot => this.snapshot;

  archiveSession(
    source: InventoryReadRequest,
    output: InventoryTextOutputPort
  ): InventoryArchiveSession {
    const key = scopeKey(source.project, source.inventoryId);
    let session = this.archiveSessions.get(key);
    if (!session) {
      session = new InventoryArchiveSession(source, this.client, output);
      this.archiveSessions.set(key, session);
    }
    return session;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  labelSession(
    source: Omit<InventoryPrepareLabelRequest, 'mediaProfileId'>,
    output: InventoryLabelOutputPort
  ): InventoryLabelSession {
    const key = JSON.stringify([source.project, source.inventoryId, source.codeId]);
    let session = this.labelSessions.get(key);
    if (!session) {
      session = new InventoryLabelSession(source, this.client, output);
      this.labelSessions.set(key, session);
    }
    return session;
  }

  hasLabelSnapshot(source: Omit<InventoryPrepareLabelRequest, 'mediaProfileId'>): boolean {
    const key = JSON.stringify([source.project, source.inventoryId, source.codeId]);
    const snapshot = this.labelSessions.get(key)?.getSnapshot();
    return Boolean(
      snapshot && (snapshot.preparation.kind === 'rendered' || 'artifact' in snapshot.output)
    );
  }

  private set(status: InventoryControllerState): void {
    let itemCodeLookup = this.snapshot.itemCodeLookup;
    const scope =
      itemCodeLookup.kind === 'ready'
        ? itemCodeLookup.lookup
        : itemCodeLookup.kind === 'resolving'
          ? itemCodeLookup
          : null;
    if (
      scope &&
      (status.kind !== 'ready' ||
        status.data.project.projectId !== scope.projectId ||
        status.data.project.defaultInventoryId !== scope.inventoryId ||
        status.data.state.revision !== scope.revision)
    ) {
      this.itemCodeGeneration += 1;
      itemCodeLookup = { kind: 'idle' };
    }
    this.snapshot = { ...this.snapshot, status, itemCodeLookup };
    for (const listener of this.listeners) listener();
  }

  private save(attempt: InventoryAttempt, remove = false): void {
    const next = new Map(this.pending);
    const key = scopeKey(attempt.request.project, attempt.request.inventoryId);
    if (remove) next.delete(key);
    else next.set(key, attempt);
    this.storage.write([...next.values()]);
    this.pending.clear();
    for (const [id, value] of next) this.pending.set(id, value);
  }

  open(): Promise<void> {
    if (this.initialized) return this.refreshProjects();
    if (!this.opening)
      this.opening = this.initialize().finally(() => {
        this.opening = undefined;
      });
    return this.opening;
  }

  async refreshProjects(): Promise<void> {
    const generation = ++this.projectsGeneration;
    try {
      const projects = await this.client.projects();
      if (generation !== this.projectsGeneration) return;
      const status = this.snapshot.status;
      const data = inventoryData(status);
      const current = data?.project ?? ('project' in status ? status.project : null);
      this.snapshot = { ...this.snapshot, projects, projectsError: undefined };
      const project =
        current && projects.find((candidate) => candidate.projectId === current.projectId);
      if (current && !project) {
        await this.selectProject('');
        return;
      }
      if (data && project && 'data' in status) this.set({ ...status, data: { ...data, project } });
      else this.set(status);
    } catch {
      if (generation !== this.projectsGeneration) return;
      this.snapshot = {
        ...this.snapshot,
        projectsError: 'Projects could not be refreshed. Try again.',
      };
      for (const listener of this.listeners) listener();
    }
  }

  async initialize(): Promise<void> {
    const generation = ++this.generation;
    this.catalogGeneration += 1;
    this.itemCodeGeneration += 1;
    try {
      this.unsubscribe?.();
      this.pending.clear();
      for (const attempt of this.storage.read()) {
        const key = scopeKey(attempt.request.project, attempt.request.inventoryId);
        if (this.pending.has(key))
          throw new Error('More than one unfinished change was saved for this inventory.');
        this.pending.set(key, attempt);
      }
      const projects = await this.client.projects();
      if (generation !== this.generation) return;
      this.initialized = true;
      this.snapshot = {
        projects,
        status: { kind: 'no-project' },
        catalog: { kind: 'idle' },
        itemCodeLookup: { kind: 'idle' },
      };
      this.unsubscribe = this.client.onChanged((event) => {
        const key = scopeKey(event.projectId, event.inventoryId);
        this.observedRevision.set(
          key,
          Math.max(event.revision, this.observedRevision.get(key) ?? 0)
        );
        const status = this.snapshot.status;
        if (status.kind !== 'ready') return;
        if (
          status.data.project.projectId === event.projectId &&
          status.data.project.defaultInventoryId === event.inventoryId &&
          event.revision > status.data.state.revision
        )
          void this.refresh();
      });
      if (projects.length === 1) await this.selectProject(projects[0].projectId);
      else this.set({ kind: 'no-project' });
    } catch (error) {
      if (generation === this.generation)
        this.set({
          kind: 'refused',
          project: null,
          code: 'INVENTORY_UNAVAILABLE',
          message:
            'Inventory could not be opened. Check that the desktop app is ready, then try again.',
        });
    }
  }

  private async read(project: InventoryProject): Promise<InventoryData> {
    const request = { project: project.projectId, inventoryId: project.defaultInventoryId };
    const freshnessMaxAgeMs =
      this.storageFreshnessPolicies.get(scopeKey(request.project, request.inventoryId)) ?? null;
    let data: InventoryData;
    for (let attempt = 0; ; attempt += 1) {
      const inspected = await this.client.inspect(request);
      const state = inspected ?? createInventoryState();
      const [history, availability, storageConditions] = await Promise.all([
        this.client.history({
          ...request,
          afterRevision: Math.max(0, state.revision - 100),
          limit: 100,
        }),
        this.client.availability(request),
        this.client.storageConditions({ ...request, freshnessMaxAgeMs }),
      ]);
      const observed =
        this.observedRevision.get(scopeKey(request.project, request.inventoryId)) ?? 0;
      if (
        (inspected && !availability) ||
        (availability && availability.revision !== state.revision) ||
        storageConditions.revision !== state.revision ||
        storageConditions.projectId !== request.project ||
        storageConditions.inventoryId !== request.inventoryId ||
        storageConditions.freshnessMaxAgeMs !== freshnessMaxAgeMs ||
        state.revision < observed
      ) {
        if (attempt < 2) continue;
        throw new Error(
          'Inventory and its projections changed while being read. Refresh to try again.'
        );
      }
      data = {
        project:
          this.snapshot.projects.find((candidate) => candidate.projectId === project.projectId) ??
          project,
        state,
        history: history.filter((entry) => entry.receipt.revision <= state.revision),
        availability,
        storageConditions,
      };
      return data;
    }
  }

  async setStorageFreshnessPolicy(freshnessMaxAgeMs: number | null): Promise<void> {
    if (
      freshnessMaxAgeMs !== null &&
      (!Number.isSafeInteger(freshnessMaxAgeMs) || freshnessMaxAgeMs < 0)
    )
      throw new TypeError(
        'Observation age policy must be null or a nonnegative whole number of milliseconds.'
      );
    const status = this.snapshot.status;
    if (status.kind !== 'ready') return;
    const project = status.data.project;
    this.storageFreshnessPolicies.set(
      scopeKey(project.projectId, project.defaultInventoryId),
      freshnessMaxAgeMs
    );
    await this.refresh();
  }

  private ready(data: InventoryData): void {
    this.set({ kind: 'ready', data });
    if (
      data.state.revision <
      (this.observedRevision.get(
        scopeKey(data.project.projectId, data.project.defaultInventoryId)
      ) ?? 0)
    )
      queueMicrotask(() => {
        if (this.snapshot.status.kind === 'ready' && this.snapshot.status.data === data)
          void this.refresh();
      });
  }

  async selectProject(projectId: string): Promise<void> {
    const project = this.snapshot.projects.find((candidate) => candidate.projectId === projectId);
    const generation = ++this.generation;
    this.catalogGeneration += 1;
    const cached = this.catalogCache.get(projectId);
    this.snapshot = {
      ...this.snapshot,
      catalog: cached ? { kind: 'ready', projectId, entries: cached } : { kind: 'idle' },
    };
    if (!project) {
      this.set({ kind: 'no-project' });
      return;
    }
    this.set({ kind: 'loading', project });
    try {
      const data = await this.read(project);
      if (generation !== this.generation) return;
      const attempt = this.pending.get(scopeKey(project.projectId, project.defaultInventoryId));
      if (attempt?.receipt) {
        this.set({
          kind: 'committed-refresh-failed',
          data,
          attempt: { ...attempt, receipt: attempt.receipt },
          message:
            'This change was saved. Confirm the latest inventory before making another change.',
        });
        await this.refresh();
      } else if (attempt) {
        this.set({
          kind: 'outcome-unknown',
          data,
          attempt,
          message: 'A previous change needs confirmation before another change can be made.',
        });
      } else this.ready(data);
    } catch (error) {
      if (generation === this.generation)
        this.set({
          kind: 'refused',
          project,
          code: 'INVENTORY_READ_FAILED',
          message: 'This inventory could not be loaded. Refresh it or choose another project.',
        });
    }
  }

  async loadCatalog(projectId: string): Promise<void> {
    const status = this.snapshot.status;
    const current =
      status.kind === 'loading'
        ? status.project
        : (inventoryData(status)?.project ?? ('project' in status ? status.project : null));
    if (current?.projectId !== projectId) return;
    const cached = this.catalogCache.get(projectId);
    if (cached) {
      this.snapshot = { ...this.snapshot, catalog: { kind: 'ready', projectId, entries: cached } };
      this.set(this.snapshot.status);
      return;
    }
    if (this.snapshot.catalog.kind === 'loading' && this.snapshot.catalog.projectId === projectId)
      return;
    const generation = ++this.catalogGeneration;
    this.snapshot = { ...this.snapshot, catalog: { kind: 'loading', projectId } };
    this.set(this.snapshot.status);
    try {
      const entries = await this.client.catalog({ project: projectId });
      if (generation !== this.catalogGeneration) return;
      this.catalogCache.set(projectId, entries);
      this.snapshot = { ...this.snapshot, catalog: { kind: 'ready', projectId, entries } };
    } catch {
      if (generation !== this.catalogGeneration) return;
      this.snapshot = {
        ...this.snapshot,
        catalog: {
          kind: 'failed',
          projectId,
          message: 'Equipment catalog could not be loaded. Existing inventory remains available.',
        },
      };
    }
    this.set(this.snapshot.status);
  }

  clearItemCodeLookup(): void {
    this.itemCodeGeneration += 1;
    this.snapshot = { ...this.snapshot, itemCodeLookup: { kind: 'idle' } };
    this.set(this.snapshot.status);
  }

  async resolveItemCode(query: InventoryItemCodeQuery): Promise<void> {
    const status = this.snapshot.status;
    const generation = ++this.itemCodeGeneration;
    if (status.kind !== 'ready') {
      this.snapshot = {
        ...this.snapshot,
        itemCodeLookup: {
          kind: 'unavailable',
          message: 'Load the current inventory before looking up a code.',
        },
      };
      this.set(status);
      return;
    }
    const projectId = status.data.project.projectId;
    const inventoryId = status.data.project.defaultInventoryId;
    const revision = status.data.state.revision;
    this.snapshot = {
      ...this.snapshot,
      itemCodeLookup: { kind: 'resolving', projectId, inventoryId, revision, query: { ...query } },
    };
    this.set(status);
    try {
      const lookup = await this.client.resolveItemCode({ project: projectId, inventoryId, query });
      if (generation !== this.itemCodeGeneration) return;
      const current = this.snapshot.status;
      if (
        current.kind !== 'ready' ||
        current.data.project.projectId !== projectId ||
        current.data.project.defaultInventoryId !== inventoryId ||
        current.data.state.revision !== revision ||
        lookup.projectId !== projectId ||
        lookup.inventoryId !== inventoryId ||
        lookup.revision !== revision
      )
        throw new Error('Inventory changed while resolving the code.');
      this.snapshot = {
        ...this.snapshot,
        itemCodeLookup: { kind: 'ready', query: { ...query }, lookup },
      };
    } catch {
      if (generation !== this.itemCodeGeneration) return;
      this.snapshot = {
        ...this.snapshot,
        itemCodeLookup: {
          kind: 'unavailable',
          message: 'Code lookup is unavailable. Refresh inventory and look up the code again.',
        },
      };
    }
    this.set(this.snapshot.status);
  }

  async refresh(): Promise<void> {
    const status = this.snapshot.status;
    const previous = inventoryData(status);
    const project = previous?.project ?? ('project' in status ? status.project : null);
    if (!project || status.kind === 'submitting' || status.kind === 'outcome-unknown') return;
    const generation = ++this.generation;
    this.set({ kind: 'loading', project, previous });
    try {
      const data = await this.read(project);
      if (generation !== this.generation) return;
      if (status.kind === 'committed-refresh-failed') this.save(status.attempt, true);
      if (status.kind === 'refused' && status.attempt) {
        try {
          this.save(status.attempt, true);
        } catch {
          this.set({
            ...status,
            data,
            recoveryError:
              'Saved retry information could not be cleared. Restore local storage before continuing.',
          });
          return;
        }
      }
      if (status.kind === 'conflict') this.set({ ...status, data, reviewReady: true });
      else this.ready(data);
    } catch (error) {
      if (generation !== this.generation) return;
      if (status.kind === 'committed-refresh-failed')
        this.set({
          ...status,
          message:
            'The change was saved, but the latest inventory is still unavailable. Try reloading it.',
        });
      else if (status.kind === 'refused' && status.attempt) this.set(status);
      else
        this.set({
          kind: 'refused',
          project,
          data: previous,
          code: 'INVENTORY_READ_FAILED',
          message: 'Inventory could not be refreshed. Try again before making another change.',
        });
    }
  }

  async submit(
    commands: readonly InventoryCommand[],
    summary: string
  ): Promise<NativeInventoryReceipt | null> {
    const status = this.snapshot.status;
    const data = inventoryData(status);
    if (!data || !inventoryCanEdit(status)) return null;
    const key = scopeKey(data.project.projectId, data.project.defaultInventoryId);
    if (this.pending.has(key)) return null;
    let attempt: InventoryAttempt;
    try {
      attempt = {
        request: inventoryExecuteRequestSchema.parse({
          project: data.project.projectId,
          inventoryId: data.project.defaultInventoryId,
          operationId: this.operationId(),
          expectedRevision: data.state.revision,
          commands,
        }),
        summary,
      };
    } catch (error) {
      this.set({
        kind: 'refused',
        project: data.project,
        data,
        code: 'INVALID_INVENTORY_INPUT',
        message:
          error instanceof TypeError
            ? error.message
            : 'Check the values in this form before saving.',
      });
      return null;
    }
    return this.begin(data, attempt);
  }

  async adoptArchive(
    sourceText: string,
    options: InventoryResolvedImportOptions,
    expectedPlanDigest: InventoryArchiveSha256
  ): Promise<NativeInventoryReceipt | null> {
    return this.sourceAttempt(
      (data) =>
        inventoryApplyImportRequestSchema.parse({
          kind: 'adopt-archive',
          project: data.project.projectId,
          inventoryId: data.project.defaultInventoryId,
          operationId: this.operationId(),
          expectedRevision: data.state.revision,
          sourceText,
          options,
          expectedPlanDigest,
        }),
      'Adopt inventory archive',
      'Check the archive preview before applying.'
    );
  }

  async receiveTable(
    sourceText: string,
    options: InventoryResolvedTableOptions,
    expectedPlanDigest: InventoryTableSha256
  ): Promise<NativeInventoryReceipt | null> {
    return this.sourceAttempt(
      (data) =>
        inventoryApplyTableRequestSchema.parse({
          kind: 'receive-table',
          project: data.project.projectId,
          inventoryId: data.project.defaultInventoryId,
          operationId: this.operationId(),
          expectedRevision: data.state.revision,
          sourceText,
          options,
          expectedPlanDigest,
        }),
      'Receive inventory table',
      'Preview the table before receiving stock.'
    );
  }

  async applyStocktake(
    sourceText: string,
    options: InventoryStocktakeChoices,
    expectedPlanDigest: InventoryTableSha256
  ): Promise<NativeInventoryReceipt | null> {
    return this.sourceAttempt(
      (data) =>
        inventoryApplyStocktakeRequestSchema.parse({
          kind: 'apply-stocktake',
          project: data.project.projectId,
          inventoryId: data.project.defaultInventoryId,
          operationId: this.operationId(),
          expectedRevision: data.state.revision,
          sourceText,
          options,
          expectedPlanDigest,
        }),
      'Record stocktake observations',
      'Preview the stocktake before recording observations.'
    );
  }

  async acknowledgeSourceRevision(
    sourceText: string,
    options: InventoryResolvedSourceRevisionOptions,
    expectedPlanDigest: InventoryTableSha256
  ): Promise<NativeInventoryReceipt | null> {
    return this.sourceAttempt(
      (data) =>
        inventoryAcknowledgeSourceRequestSchema.parse({
          kind: 'acknowledge-table-source',
          project: data.project.projectId,
          inventoryId: data.project.defaultInventoryId,
          operationId: this.operationId(),
          expectedRevision: data.state.revision,
          sourceText,
          options,
          expectedPlanDigest,
        }),
      'Acknowledge source revision',
      'Compare the revised source before acknowledging it.'
    );
  }

  async importHierarchy(
    sourceText: string,
    options: InventoryHierarchyChoices,
    expectedPlanDigest: InventoryTableSha256
  ): Promise<NativeInventoryReceipt | null> {
    return this.sourceAttempt(
      (data) =>
        inventoryApplyHierarchyRequestSchema.parse({
          kind: 'import-hierarchy',
          project: data.project.projectId,
          inventoryId: data.project.defaultInventoryId,
          operationId: this.operationId(),
          expectedRevision: data.state.revision,
          sourceText,
          options,
          expectedPlanDigest,
        }),
      'Import inventory hierarchy',
      'Preview the hierarchy before importing locations.'
    );
  }

  private async sourceAttempt(
    request: (data: InventoryData) => InventoryAcceptedRequest,
    summary: string,
    fallbackMessage: string
  ): Promise<NativeInventoryReceipt | null> {
    const status = this.snapshot.status;
    const data = inventoryData(status);
    if (
      !data ||
      !inventoryCanEdit(status) ||
      this.pending.has(scopeKey(data.project.projectId, data.project.defaultInventoryId))
    )
      return null;
    let attempt: InventoryAttempt;
    try {
      attempt = { request: request(data), summary };
    } catch (cause) {
      this.set({
        kind: 'refused',
        project: data.project,
        data,
        code: 'INVALID_INVENTORY_INPUT',
        message: cause instanceof Error ? cause.message : fallbackMessage,
      });
      return null;
    }
    return this.begin(data, attempt);
  }

  private async begin(
    data: InventoryData,
    attempt: InventoryAttempt
  ): Promise<NativeInventoryReceipt | null> {
    try {
      this.save(attempt);
    } catch (error) {
      this.set({
        kind: 'refused',
        project: data.project,
        data,
        code: 'INVENTORY_RECOVERY_UNAVAILABLE',
        message:
          'This change could not be retained safely. Restore local storage before saving inventory changes.',
      });
      return null;
    }
    return this.execute(data, attempt);
  }

  private async committed(
    data: InventoryData,
    attempt: InventoryAttempt,
    receipt: NativeInventoryReceipt,
    generation: number
  ): Promise<NativeInventoryReceipt> {
    const confirmed = { ...attempt, receipt };
    if (generation === this.generation)
      this.set({ kind: 'submitting', stage: 'refreshing', data, attempt: confirmed });
    try {
      this.save(confirmed);
      const latest = await this.read(data.project);
      this.save(confirmed, true);
      if (generation === this.generation) this.ready(latest);
    } catch (error) {
      this.pending.set(scopeKey(attempt.request.project, attempt.request.inventoryId), confirmed);
      if (generation === this.generation)
        this.set({
          kind: 'committed-refresh-failed',
          data,
          attempt: confirmed,
          message:
            'The change was saved, but the latest inventory could not be loaded. Reload it before making another change.',
        });
    }
    return receipt;
  }

  private executeRequest(request: InventoryAcceptedRequest): Promise<NativeInventoryExecution> {
    if (!('kind' in request)) return this.client.execute(request);
    switch (request.kind) {
      case 'adopt-archive':
        return this.client.applyImport(request);
      case 'receive-table':
        return this.client.applyTable(request);
      case 'apply-stocktake':
        return this.client.applyStocktake(request);
      case 'acknowledge-table-source':
        return this.client.acknowledgeSource(request);
      case 'import-hierarchy':
        return this.client.applyHierarchy(request);
    }
  }

  private async execute(
    data: InventoryData,
    attempt: InventoryAttempt
  ): Promise<NativeInventoryReceipt | null> {
    const generation = this.generation;
    this.set({ kind: 'submitting', stage: 'sending', data, attempt });
    try {
      const result = await this.executeRequest(attempt.request);
      if (result.status === 'committed') return this.committed(data, attempt, result, generation);
      let recoveryError: string | undefined;
      try {
        this.save(attempt, true);
      } catch {
        recoveryError =
          'The change was refused, but saved retry information could not be cleared. Restore local storage before continuing.';
      }
      if (generation !== this.generation) return null;
      if (result.code === 'REVISION_CONFLICT') {
        try {
          const latest = await this.read(data.project);
          if (generation === this.generation)
            this.set({
              kind: 'conflict',
              data: latest,
              attempt,
              message:
                'Inventory changed while this form was open. Review the latest values before applying your change.',
              reviewReady: true,
              recoveryError,
            });
        } catch {
          if (generation === this.generation)
            this.set({
              kind: 'conflict',
              data,
              attempt,
              message: 'Inventory changed. Refresh it before reviewing your change.',
              reviewReady: false,
              recoveryError,
            });
        }
      } else
        this.set({
          kind: 'refused',
          project: data.project,
          data,
          code: result.code,
          message: result.message,
          attempt,
          recoveryError,
        });
    } catch (error) {
      if (generation === this.generation)
        this.set({
          kind: 'outcome-unknown',
          data,
          attempt,
          message:
            'The result of this change could not be confirmed. Check its status before making another change.',
        });
    }
    return null;
  }

  async checkPending(): Promise<void> {
    const status = this.snapshot.status;
    if (status.kind !== 'outcome-unknown') return;
    const generation = this.generation;
    try {
      const receipt = await this.client.operation({
        project: status.attempt.request.project,
        inventoryId: status.attempt.request.inventoryId,
        operationId: status.attempt.request.operationId,
      });
      if (receipt) await this.committed(status.data, status.attempt, receipt, generation);
      else if (generation === this.generation)
        this.set({
          ...status,
          message: 'No completed change was found. You can safely retry this same change.',
        });
    } catch (error) {
      if (generation === this.generation)
        this.set({
          ...status,
          message:
            'The change still needs confirmation. Check its status again when the desktop connection is available.',
        });
    }
  }

  retryPending(): Promise<NativeInventoryReceipt | null> {
    const status = this.snapshot.status;
    return status.kind === 'outcome-unknown'
      ? this.execute(status.data, status.attempt)
      : Promise.resolve(null);
  }

  dismiss(): void {
    const status = this.snapshot.status;
    if (
      (status.kind === 'refused' && status.data) ||
      (status.kind === 'conflict' && status.reviewReady)
    ) {
      if (status.attempt) {
        try {
          this.save(status.attempt, true);
        } catch {
          this.set({
            ...status,
            recoveryError:
              'Saved retry information could not be cleared. Restore local storage before continuing.',
          });
          return;
        }
      }
      this.ready(status.data!);
    }
  }

  dispose(): void {
    ++this.generation;
    ++this.catalogGeneration;
    ++this.projectsGeneration;
    ++this.itemCodeGeneration;
    this.unsubscribe?.();
    for (const session of this.labelSessions.values()) session.dispose();
    this.labelSessions.clear();
    for (const session of this.archiveSessions.values()) session.dispose();
    this.archiveSessions.clear();
    this.listeners.clear();
  }
}
