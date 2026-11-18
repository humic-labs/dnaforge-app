import { inventoryTableCanonicalJson } from '@waypoint/domain-services';
import type { InventoryClient } from '../../shared/inventory-client';
import {
  inventoryScientificProductionsReadSchema,
  inventoryScientificProductionReadSchema,
  inventoryScientificProductionSourceReadSchema,
  type InventoryScientificProductionsRead,
  type InventoryScientificProductionRead,
  type InventoryScientificProductionSourceRead,
  type InventoryScientificProductionsRequest,
} from '../../shared/inventory-scientific-productions';
import type { ProjectResourceReference } from '../../shared/project-resource-reference';
import type { PlatePlanScope } from './inventory-plate-plan-draft-session';
type Ready = Extract<InventoryScientificProductionsRead, { kind: 'ready' }>;
type Detail = Extract<InventoryScientificProductionRead, { kind: 'available' }>;
type Source = Extract<InventoryScientificProductionSourceRead, { kind: 'available' }>;
type Pin = { productionId: string; intentSha256: `sha256:${string}` };
export class InventoryScientificProductionReadSession {
  private snapshot: {
    list: InventoryScientificProductionsRead | { kind: 'loading' };
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
      'scientificProductions' | 'scientificProduction' | 'scientificProductionSource' | 'onChanged'
    >,
    readonly scope: PlatePlanScope,
    readonly filters: Pick<InventoryScientificProductionsRequest, 'context'>,
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
      const result = inventoryScientificProductionsReadSchema.parse(
        await this.client.scientificProductions({
          ...this.scope,
          ...this.filters,
          limit: 20,
          ...(cursor ? { cursor } : {}),
        })
      );
      if (!this.active || generation !== this.generation) return;
      if (result.kind === 'unavailable') {
        if (cursor && result.code === 'INVENTORY_QUERY_STALE') {
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
            context: this.filters.context ?? null,
          }) ||
        (result.kind === 'ready' &&
          (result.productions.length > 20 || (cursor && result.revision !== cursor.revision)))
      )
        throw Error('The productions belong to another inventory or filter.');
      this.set({ list: result });
    } catch (cause) {
      if (this.active && generation === this.generation)
        this.set({
          list: {
            kind: 'unavailable',
            code: 'SCIENTIFIC_PRODUCTIONS_UNAVAILABLE',
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
      const result = inventoryScientificProductionReadSchema.parse(
        await this.client.scientificProduction({ ...this.scope, ...pin })
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
        result.production.id !== pin.productionId ||
        result.production.intentSha256 !== pin.intentSha256
      )
        throw Error('The detail does not match this exact production.');
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
    const production = detail.production,
      generation = this.generation,
      detailGeneration = this.detailGeneration,
      sourceGeneration = ++this.sourceGeneration;
    this.set({ source: { kind: 'loading' } });
    try {
      const result = inventoryScientificProductionSourceReadSchema.parse(
        await this.client.scientificProductionSource({
          ...this.scope,
          productionId: production.id,
          intentSha256: production.intentSha256,
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
        result.productionId !== production.id ||
        result.intentSha256 !== production.intentSha256 ||
        result.sourceSha256 !== production.context.source.sha256 ||
        result.source.projectId !== production.context.projectId ||
        result.source.runId !== production.context.entityId ||
        inventoryTableCanonicalJson(result.design.binding) !==
          inventoryTableCanonicalJson(production.design)
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
  async openCurrent(kind: 'run' | 'design' = 'run') {
    const detail = this.snapshot.detail;
    if (detail.kind !== 'available') return;
    const context =
      kind === 'run'
        ? detail.production.context
        : {
            projectId: detail.production.design.owner.projectId,
            workspaceScope: detail.production.design.owner.workspaceScope,
            entityId: detail.production.design.selection.revision.resourceId,
          };
    if (
      detail.production.by.kind === 'imported' ||
      context.projectId !== this.scope.project ||
      context.workspaceScope !== this.scope.project
    ) {
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
  return cause instanceof Error ? cause.message : 'Recorded productions could not be read.';
}
