import { inventoryTableCanonicalJson } from '@waypoint/domain-services';
import type { InventoryClient } from '../../shared/inventory-client';
import {
  inventoryRunValueCandidatesReadSchema,
  inventoryRunValueAttributionsReadSchema,
  inventoryRunValueAttributionReadSchema,
  inventoryRunValueAttributionSourceReadSchema,
  type InventoryRunValueCandidatesRead,
  type InventoryRunValueAttributionsRead,
  type InventoryRunValueAttributionRead,
  type InventoryRunValueAttributionSourceRead,
} from '../../shared/inventory-run-value-attributions';
import type { NativeProtocolPlatformClient } from '../../shared/protocol-packages';
import type { ProjectResourceReference } from '../../shared/project-resource-reference';
import type { PlatePlanScope } from './inventory-plate-plan-draft-session';
type CandidateReady = Extract<InventoryRunValueCandidatesRead, { kind: 'ready' }>;
type ListReady = Extract<InventoryRunValueAttributionsRead, { kind: 'ready' }>;
type Detail = Extract<InventoryRunValueAttributionRead, { kind: 'available' }>;
type Source = Extract<InventoryRunValueAttributionSourceRead, { kind: 'available' }>;
export type AttributionPin = { attributionId: string; intentSha256: `sha256:${string}` };
export class InventoryRunValueAttributionReadSession {
  private snapshot: {
    candidates: InventoryRunValueCandidatesRead | { kind: 'idle' | 'loading' };
    candidateCursor: CandidateReady['nextCursor'];
    list: InventoryRunValueAttributionsRead | { kind: 'loading' };
    cursor: ListReady['nextCursor'];
    detail: Detail | { kind: 'idle' | 'loading' } | { kind: 'unavailable'; message: string };
    comparisonLoading: boolean;
    source: Source | { kind: 'idle' | 'loading' } | { kind: 'unavailable'; message: string };
    navigationError: string | null;
  } = {
    candidates: { kind: 'idle' },
    candidateCursor: null,
    list: { kind: 'loading' },
    cursor: null,
    detail: { kind: 'idle' },
    comparisonLoading: false,
    source: { kind: 'idle' },
    navigationError: null,
  };
  private active = true;
  private listGeneration = 0;
  private candidateGeneration = 0;
  private detailGeneration = 0;
  private sourceGeneration = 0;
  private selected: AttributionPin | null = null;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private unsubscribeRun: (() => void) | null = null;
  private navigation: AbortController | null = null;
  constructor(
    readonly scope: PlatePlanScope,
    readonly runId: string | undefined,
    private readonly client: Pick<
      InventoryClient,
      | 'runValueCandidates'
      | 'runValueAttributions'
      | 'runValueAttribution'
      | 'runValueAttributionSource'
      | 'onChanged'
    >,
    private readonly protocols: Pick<NativeProtocolPlatformClient, 'onChanged'>,
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
  async open() {
    this.active = true;
    this.unsubscribe?.();
    this.unsubscribeRun?.();
    this.unsubscribe = this.client.onChanged((event) => {
      if (event.projectId !== this.scope.project || event.inventoryId !== this.scope.inventoryId)
        return;
      void this.refresh();
      if (this.runId) void this.refreshCandidates();
    });
    this.unsubscribeRun = this.protocols.onChanged((event) => {
      if (event.projectId !== this.scope.project) return;
      const detail = this.snapshot.detail;
      if (this.runId === event.entityId) void this.refreshCandidates();
      if (
        this.selected &&
        (detail.kind === 'loading' ||
          (detail.kind === 'available' &&
            detail.attribution.source.projectId === event.projectId &&
            detail.attribution.runValue.entityId === event.entityId))
      )
        void this.detail(this.selected, true);
    });
    await this.refresh();
    if (this.runId) await this.refreshCandidates();
  }
  async refresh() {
    await this.list(null);
  }
  async next() {
    const list = this.snapshot.list;
    if (list.kind === 'ready' && list.nextCursor) await this.list(list.nextCursor);
  }
  private async list(cursor: ListReady['nextCursor']) {
    const generation = ++this.listGeneration;
    this.set({ list: { kind: 'loading' }, cursor });
    try {
      const result = inventoryRunValueAttributionsReadSchema.parse(
        await this.client.runValueAttributions({
          ...this.scope,
          ...(this.runId ? { run: { entityId: this.runId } } : {}),
          limit: 20,
          ...(cursor ? { cursor } : {}),
        })
      );
      if (!this.active || generation !== this.listGeneration) return;
      if (result.kind === 'unavailable') {
        if (cursor && result.code === 'INVENTORY_QUERY_STALE') {
          await this.list(null);
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
            run: this.runId ? { entityId: this.runId } : null,
            slot: null,
          }) ||
        (result.kind === 'ready' &&
          (result.entries.length > 20 || (cursor && result.revision !== cursor.revision)))
      )
        throw Error('Associations belong to another inventory or Run.');
      this.set({ list: result });
      if (this.selected) await this.detail(this.selected, true);
    } catch (cause) {
      if (this.active && generation === this.listGeneration)
        this.set({
          list: {
            kind: 'unavailable',
            code: 'RUN_VALUE_HISTORY_UNAVAILABLE',
            message: message(cause),
            retryable: true,
          },
        });
    }
  }
  async refreshCandidates() {
    await this.candidates(null);
  }
  async nextCandidates() {
    const current = this.snapshot.candidates;
    if (current.kind === 'ready' && current.nextCursor) await this.candidates(current.nextCursor);
  }
  private async candidates(cursor: CandidateReady['nextCursor']) {
    if (!this.runId) return;
    const generation = ++this.candidateGeneration;
    this.set({ candidates: { kind: 'loading' }, candidateCursor: cursor });
    try {
      const result = inventoryRunValueCandidatesReadSchema.parse(
        await this.client.runValueCandidates({
          ...this.scope,
          runId: this.runId,
          limit: 20,
          ...(cursor ? { cursor } : {}),
        })
      );
      if (!this.active || generation !== this.candidateGeneration) return;
      if (result.kind === 'unavailable') {
        this.set({ candidates: result });
        return;
      }
      if (
        result.projectId !== this.scope.project ||
        result.inventoryId !== this.scope.inventoryId ||
        (result.kind === 'ready' &&
          (result.run.entityId !== this.runId ||
            result.run.projectId !== this.scope.project ||
            result.run.workspaceScope !== this.scope.project ||
            result.filter.collection !== null ||
            result.rows.length > 20))
      )
        throw Error('Saved value candidates belong to another source.');
      this.set({ candidates: result });
    } catch (cause) {
      if (this.active && generation === this.candidateGeneration)
        this.set({
          candidates: {
            kind: 'unavailable',
            code: 'RUN_VALUE_CANDIDATES_UNAVAILABLE',
            message: message(cause),
            retryable: true,
          },
        });
    }
  }
  async detail(pin: AttributionPin, comparisonOnly = false) {
    this.selected = pin;
    const generation = ++this.detailGeneration;
    if (!comparisonOnly) {
      ++this.sourceGeneration;
      this.navigation?.abort();
      this.set({ detail: { kind: 'loading' }, source: { kind: 'idle' }, navigationError: null });
    } else this.set({ comparisonLoading: true });
    try {
      const result = inventoryRunValueAttributionReadSchema.parse(
        await this.client.runValueAttribution({ ...this.scope, ...pin })
      );
      if (!this.active || generation !== this.detailGeneration) return;
      if (result.kind !== 'available') throw Error(result.message);
      if (
        result.projectId !== this.scope.project ||
        result.inventoryId !== this.scope.inventoryId ||
        result.attribution.id !== pin.attributionId ||
        result.attribution.intentSha256 !== pin.intentSha256
      )
        throw Error('The association detail pins changed.');
      this.set({ detail: result, comparisonLoading: false });
    } catch (cause) {
      if (this.active && generation === this.detailGeneration) {
        if (comparisonOnly && this.snapshot.detail.kind === 'available')
          this.set({
            detail: {
              ...this.snapshot.detail,
              currentComparison: {
                kind: 'unavailable',
                code: 'CURRENT_VALUE_UNAVAILABLE',
                message: message(cause),
                retryable: true,
              },
            },
            comparisonLoading: false,
          });
        else
          this.set({
            detail: { kind: 'unavailable', message: message(cause) },
            comparisonLoading: false,
          });
      }
    }
  }
  invalidateCurrent() {
    ++this.candidateGeneration;
    this.set({ candidates: this.runId ? { kind: 'idle' } : this.snapshot.candidates });
    if (this.selected) void this.detail(this.selected, true);
  }
  async original() {
    const detail = this.snapshot.detail;
    if (detail.kind !== 'available') return;
    const original = detail.attribution,
      generation = ++this.sourceGeneration;
    this.set({ source: { kind: 'loading' } });
    try {
      const result = inventoryRunValueAttributionSourceReadSchema.parse(
        await this.client.runValueAttributionSource({
          ...this.scope,
          attributionId: original.id,
          intentSha256: original.intentSha256,
        })
      );
      if (!this.active || generation !== this.sourceGeneration) return;
      if (result.kind !== 'available') throw Error(result.message);
      if (
        result.projectId !== this.scope.project ||
        result.inventoryId !== this.scope.inventoryId ||
        result.attributionId !== original.id ||
        result.intentSha256 !== original.intentSha256 ||
        result.sourceSha256 !== original.runValue.sourceSha256 ||
        result.source.runId !== original.runValue.entityId ||
        result.source.projectId !== original.source.projectId ||
        result.source.workspaceScope !== original.source.workspaceScope ||
        result.source.fileObjectUuid !== original.source.fileObjectUuid
      )
        throw Error('The retained source does not match this association.');
      this.set({ source: result });
    } catch (cause) {
      if (this.active && generation === this.sourceGeneration)
        this.set({ source: { kind: 'unavailable', message: message(cause) } });
    }
  }
  async openCurrent() {
    const detail = this.snapshot.detail;
    if (detail.kind !== 'available') return;
    const original = detail.attribution;
    if (
      original.source.projectId !== this.scope.project ||
      original.source.workspaceScope !== this.scope.project
    ) {
      this.set({
        navigationError:
          'This original Run belongs to another project scope. Its saved evidence remains available.',
      });
      return;
    }
    this.navigation?.abort();
    const controller = new AbortController();
    this.navigation = controller;
    const generation = this.detailGeneration;
    try {
      await this.navigate(
        {
          kind: 'entity',
          projectId: original.source.projectId,
          entityId: original.runValue.entityId,
        },
        { signal: controller.signal }
      );
    } catch (cause) {
      if (this.active && generation === this.detailGeneration && !controller.signal.aborted)
        this.set({ navigationError: message(cause) });
    }
  }
  dispose() {
    this.active = false;
    ++this.listGeneration;
    ++this.candidateGeneration;
    ++this.detailGeneration;
    ++this.sourceGeneration;
    this.navigation?.abort();
    this.unsubscribe?.();
    this.unsubscribeRun?.();
  }
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Saved value associations are unavailable.';
}
