import { inventoryTableCanonicalJson } from '@waypoint/domain-services';
import type { InventoryClient } from '../../shared/inventory-client';
import {
  inventoryPlatePlanObservationsReadSchema,
  inventoryPlatePlanObservationReadSchema,
  inventoryPlatePlanObservationSourceReadSchema,
  type InventoryPlatePlanObservationsRead,
  type InventoryPlatePlanObservationRead,
  type InventoryPlatePlanObservationSourceRead,
  type InventoryPlatePlanObservationsRequest,
} from '../../shared/inventory-plate-plan-observations';
import type { ProjectResourceReference } from '../../shared/project-resource-reference';
import type { PlatePlanScope } from './inventory-plate-plan-draft-session';
type Ready = Extract<InventoryPlatePlanObservationsRead, { kind: 'ready' }>;
type Detail = Extract<InventoryPlatePlanObservationRead, { kind: 'available' }>;
type Source = Extract<InventoryPlatePlanObservationSourceRead, { kind: 'available' }>;
type Pin = { observationId: string; intentSha256: `sha256:${string}` };
export class InventoryPlatePlanObservationReadSession {
  private snapshot: {
    list: InventoryPlatePlanObservationsRead | { kind: 'loading' };
    cursor: Ready['nextCursor'];
    detail: Detail | { kind: 'idle' | 'loading' } | { kind: 'unavailable'; message: string };
    source: Source | { kind: 'idle' | 'loading' } | { kind: 'unavailable'; message: string };
    navigationError: string | null;
  } = {
    list: { kind: 'loading' },
    cursor: null,
    detail: { kind: 'idle' },
    source: { kind: 'idle' },
    navigationError: null,
  };
  private active = true;
  private generation = 0;
  private detailGeneration = 0;
  private sourceGeneration = 0;
  private unsubscribe: (() => void) | null = null;
  private navigation: AbortController | null = null;
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly client: Pick<
      InventoryClient,
      'platePlanObservations' | 'platePlanObservation' | 'platePlanObservationSource' | 'onChanged'
    >,
    readonly scope: PlatePlanScope,
    readonly filters: Pick<InventoryPlatePlanObservationsRequest, 'version' | 'context'>,
    private readonly navigate: (
      reference: ProjectResourceReference,
      options: { signal: AbortSignal }
    ) => Promise<unknown>
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(next: Partial<typeof this.snapshot>) {
    if (!this.active) return;
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }
  private invalidate() {
    ++this.generation;
    ++this.detailGeneration;
    ++this.sourceGeneration;
    this.navigation?.abort();
    this.navigation = null;
    return this.generation;
  }
  async open() {
    this.active = true;
    this.unsubscribe?.();
    this.unsubscribe = this.client.onChanged((event) => {
      if (event.projectId === this.scope.project && event.inventoryId === this.scope.inventoryId)
        void this.refresh();
    });
    await this.refresh();
  }
  async refresh() {
    await this.load(null);
  }
  async next() {
    const list = this.snapshot.list;
    if (list.kind === 'ready' && list.nextCursor) await this.load(list.nextCursor);
  }
  private async load(cursor: Ready['nextCursor']) {
    const generation = this.invalidate();
    this.set({
      list: { kind: 'loading' },
      cursor,
      detail: { kind: 'idle' },
      source: { kind: 'idle' },
      navigationError: null,
    });
    try {
      const result = inventoryPlatePlanObservationsReadSchema.parse(
        await this.client.platePlanObservations({
          ...this.scope,
          ...this.filters,
          limit: 20,
          ...(cursor ? { cursor } : {}),
        })
      );
      if (!this.active || generation !== this.generation) return;
      if (result.kind === 'unavailable') {
        if (cursor && result.code === 'INVENTORY_QUERY_REVISION_CHANGED') {
          await this.load(null);
          return;
        }
        this.set({ list: result });
        return;
      }
      if (
        result.projectId !== this.scope.project ||
        result.inventoryId !== this.scope.inventoryId ||
        inventoryTableCanonicalJson(result.filters) !==
          inventoryTableCanonicalJson({
            version: this.filters.version ?? null,
            context: this.filters.context ?? null,
          }) ||
        (result.kind === 'ready' &&
          (result.observations.length > 20 || (cursor && result.revision !== cursor.revision)))
      )
        throw Error('The plan observations belong to another inventory or filter.');
      this.set({ list: result });
    } catch (cause) {
      if (this.active && generation === this.generation)
        this.set({
          list: {
            kind: 'unavailable',
            code: 'PLATE_PLAN_OBSERVATIONS_UNAVAILABLE',
            message: message(cause),
            retryable: true,
          },
        });
    }
  }
  async detail(pin: Pin) {
    const generation = this.generation,
      detailGeneration = ++this.detailGeneration;
    ++this.sourceGeneration;
    this.navigation?.abort();
    this.set({ detail: { kind: 'loading' }, source: { kind: 'idle' }, navigationError: null });
    try {
      const result = inventoryPlatePlanObservationReadSchema.parse(
        await this.client.platePlanObservation({ ...this.scope, ...pin })
      );
      if (
        !this.active ||
        generation !== this.generation ||
        detailGeneration !== this.detailGeneration
      )
        return;
      if (result.kind !== 'available') throw Error(result.message);
      if (
        result.projectId !== this.scope.project ||
        result.inventoryId !== this.scope.inventoryId ||
        result.observation.id !== pin.observationId ||
        result.observation.intentSha256 !== pin.intentSha256
      )
        throw Error('The detail does not match this exact observation.');
      this.set({ detail: result });
    } catch (cause) {
      if (
        this.active &&
        generation === this.generation &&
        detailGeneration === this.detailGeneration
      )
        this.set({ detail: { kind: 'unavailable', message: message(cause) } });
    }
  }
  async source() {
    const detail = this.snapshot.detail;
    if (detail.kind !== 'available') return;
    const observation = detail.observation,
      generation = this.generation,
      detailGeneration = this.detailGeneration,
      sourceGeneration = ++this.sourceGeneration;
    this.set({ source: { kind: 'loading' } });
    try {
      const result = inventoryPlatePlanObservationSourceReadSchema.parse(
        await this.client.platePlanObservationSource({
          ...this.scope,
          observationId: observation.id,
          intentSha256: observation.intentSha256,
        })
      );
      if (
        !this.active ||
        generation !== this.generation ||
        detailGeneration !== this.detailGeneration ||
        sourceGeneration !== this.sourceGeneration
      )
        return;
      if (result.kind !== 'available') throw Error(result.message);
      if (
        result.observationId !== observation.id ||
        result.intentSha256 !== observation.intentSha256 ||
        result.sourceSha256 !== observation.context.source.sha256 ||
        result.source.projectId !== observation.context.projectId ||
        (result.source.schema === 'dnaforge.notebook-saved-source.v1'
          ? result.source.pageId
          : result.source.runId) !== observation.context.entityId
      )
        throw Error('The saved context does not match this exact recorded occurrence.');
      this.set({ source: result });
    } catch (cause) {
      if (
        this.active &&
        generation === this.generation &&
        detailGeneration === this.detailGeneration &&
        sourceGeneration === this.sourceGeneration
      )
        this.set({ source: { kind: 'unavailable', message: message(cause) } });
    }
  }
  async openCurrent() {
    const detail = this.snapshot.detail;
    if (detail.kind !== 'available') return;
    const context = detail.observation.context;
    if (context.projectId !== this.scope.project || context.workspaceScope !== this.scope.project) {
      this.set({ navigationError: 'The original context belongs to another project scope.' });
      return;
    }
    this.navigation?.abort();
    const navigation = new AbortController();
    this.navigation = navigation;
    const generation = this.generation,
      detailGeneration = this.detailGeneration;
    try {
      await this.navigate(
        { kind: 'entity', projectId: context.projectId, entityId: context.entityId },
        { signal: navigation.signal }
      );
    } catch (cause) {
      if (
        this.active &&
        generation === this.generation &&
        detailGeneration === this.detailGeneration &&
        !navigation.signal.aborted
      )
        this.set({ navigationError: message(cause) });
    }
  }
  dispose() {
    this.active = false;
    this.invalidate();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Recorded plate-plan uses could not be read.';
}
