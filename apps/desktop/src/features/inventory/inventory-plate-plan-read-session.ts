import {
  inventoryTableCanonicalJson,
  inventoryTableSha256,
  type InventoryPlatePlanDiagramArtifact,
  type InventoryLocalPrincipal,
} from '@waypoint/domain-services';
import type { InventoryClient } from '../../shared/inventory-client';
import {
  inventoryPlatePlanVersionsReadSchema,
  inventoryPlatePlanVersionReadSchema,
  inventoryPlatePlanBindingPreviewSnapshotSchema,
  type InventoryPlatePlanVersionsRead,
  type InventoryPlatePlanVersionRead,
  type InventoryPlatePlanVersionCursor,
  type InventoryPlatePlanBindingPreviewSnapshot,
} from '../../shared/inventory-plate-plans';
import {
  InventoryTextOutputSession,
  type InventoryTextOutput,
  type InventoryTextOutputPort,
} from './inventory-text-output';
import type { PlatePlanScope } from './inventory-plate-plan-draft-session';
type Available = Extract<InventoryPlatePlanVersionRead, { kind: 'available' }>;
type List = InventoryPlatePlanVersionsRead | { kind: 'loading' };
type Selected = Available | { kind: 'none' | 'loading' } | { kind: 'failed'; message: string };
type Feasibility =
  | { kind: 'draft' | 'checking' }
  | { kind: 'observed' | 'stale'; preview: InventoryPlatePlanBindingPreviewSnapshot }
  | { kind: 'failed'; message: string };
type ExportOwner = {
  artifact: InventoryPlatePlanDiagramArtifact;
  output: InventoryTextOutput<InventoryPlatePlanDiagramArtifact>;
  session: InventoryTextOutputSession<InventoryPlatePlanDiagramArtifact>;
};
export class InventoryPlatePlanReadSession {
  private snapshot: {
    list: List;
    selected: Selected;
    cursor: InventoryPlatePlanVersionCursor | null;
    destinationPlateId: string;
    sources: Record<string, string>;
    feasibility: Feasibility;
    output: InventoryTextOutput<InventoryPlatePlanDiagramArtifact>;
  } = {
    list: { kind: 'loading' },
    selected: { kind: 'none' },
    cursor: null,
    destinationPlateId: '',
    sources: {},
    feasibility: { kind: 'draft' },
    output: { kind: 'not-exported' },
  };
  private readonly listeners = new Set<() => void>();
  private readonly outputs = new Map<string, ExportOwner>();
  private listGeneration = 0;
  private selectedGeneration = 0;
  private bindingGeneration = 0;
  private active = false;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;
  private boundaryTimer: ReturnType<typeof setTimeout> | null = null;
  private principalKey: string | null = null;
  constructor(
    readonly scope: PlatePlanScope,
    private readonly client: Pick<
      InventoryClient,
      'platePlanVersions' | 'platePlanVersion' | 'previewPlatePlanBinding' | 'onChanged'
    >,
    private readonly port: InventoryTextOutputPort
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(update: Partial<typeof this.snapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  async open() {
    if (this.disposed) return;
    this.active = true;
    this.unsubscribe?.();
    this.unsubscribe = this.client.onChanged((event) => {
      if (event.projectId !== this.scope.project || event.inventoryId !== this.scope.inventoryId)
        return;
      this.invalidate();
      void this.refresh();
    });
    const previous = this.snapshot.selected;
    this.invalidate();
    if (previous.kind === 'available')
      this.set({ selected: { kind: 'loading' }, output: { kind: 'not-exported' } });
    await this.refresh();
    if (this.active && previous.kind === 'available')
      await this.select(previous.version.id, previous.version.definitionSha256);
  }
  async refresh() {
    return this.list(null);
  }
  async next() {
    const list = this.snapshot.list;
    if (list.kind === 'ready' && list.nextCursor) await this.list(list.nextCursor);
  }
  private async list(cursor: InventoryPlatePlanVersionCursor | null) {
    const generation = ++this.listGeneration;
    this.set({ list: { kind: 'loading' }, cursor });
    try {
      const read = inventoryPlatePlanVersionsReadSchema.parse(
        await this.client.platePlanVersions({
          ...this.scope,
          limit: 20,
          ...(cursor ? { cursor } : {}),
        })
      );
      if (!this.active || generation !== this.listGeneration) return;
      if (read.kind === 'unavailable') {
        if (cursor && read.code === 'INVENTORY_QUERY_REVISION_CHANGED') {
          await this.list(null);
          return;
        }
        this.set({ list: read });
        return;
      }
      if (
        read.projectId !== this.scope.project ||
        read.inventoryId !== this.scope.inventoryId ||
        read.identity !== null ||
        (read.kind === 'ready' &&
          (read.versions.length > 20 || (cursor && read.revision !== cursor.revision)))
      )
        throw Error('Plan versions belong to another inventory snapshot.');
      this.set({ list: read });
    } catch (cause) {
      if (this.active && generation === this.listGeneration)
        this.set({
          list: {
            kind: 'unavailable',
            code: 'PLAN_LIST_UNAVAILABLE',
            message: message(cause),
            retryable: true,
          },
        });
    }
  }
  async select(versionId: string, definitionSha256: `sha256:${string}`) {
    this.cancelChoosing();
    const generation = ++this.selectedGeneration;
    this.invalidate();
    this.set({
      selected: { kind: 'loading' },
      destinationPlateId: '',
      sources: {},
      feasibility: { kind: 'draft' },
      output: { kind: 'not-exported' },
    });
    try {
      const read = inventoryPlatePlanVersionReadSchema.parse(
        await this.client.platePlanVersion({ ...this.scope, versionId, definitionSha256 })
      );
      if (!this.active || generation !== this.selectedGeneration) return;
      if (read.kind !== 'available') throw Error(read.message);
      if (
        read.projectId !== this.scope.project ||
        read.inventoryId !== this.scope.inventoryId ||
        read.version.id !== versionId ||
        read.version.definitionSha256 !== definitionSha256
      )
        throw Error('The selected plan version or definition pin changed.');
      if (
        read.diagram.kind === 'rendered' &&
        (read.diagram.artifact.versionId !== versionId ||
          read.diagram.artifact.definitionSha256 !== definitionSha256 ||
          inventoryTableSha256(read.diagram.artifact.svg) !== read.diagram.artifact.sha256)
      )
        throw Error('The diagram does not match this exact saved version.');
      this.set({
        selected: read,
        sources: Object.fromEntries(
          read.version.definition.sourceSlots.map((slot) => [slot.key, ''])
        ),
      });
      const owner = this.outputOwner();
      this.set({ output: owner?.output ?? { kind: 'not-exported' } });
    } catch (cause) {
      if (this.active && generation === this.selectedGeneration)
        this.set({ selected: { kind: 'failed', message: message(cause) } });
    }
  }
  bind(destinationPlateId: string, sources: Record<string, string>) {
    this.invalidate();
    this.set({ destinationPlateId, sources: { ...sources }, feasibility: { kind: 'draft' } });
  }
  setPrincipal(principal: InventoryLocalPrincipal | undefined) {
    const key = principal ? JSON.stringify(principal) : null;
    if (this.principalKey !== null && key !== this.principalKey) this.invalidate();
    this.principalKey = key;
  }
  invalidate() {
    ++this.bindingGeneration;
    if (this.boundaryTimer) clearTimeout(this.boundaryTimer);
    this.boundaryTimer = null;
    const previous = this.snapshot.feasibility;
    this.set({
      feasibility:
        previous.kind === 'observed' || previous.kind === 'stale'
          ? { kind: 'stale', preview: previous.preview }
          : { kind: 'draft' },
    });
  }
  async previewBinding() {
    const selected = this.snapshot.selected;
    if (selected.kind !== 'available') return;
    const binding = {
      versionId: selected.version.id,
      definitionSha256: selected.version.definitionSha256,
      destinationPlateId: this.snapshot.destinationPlateId,
      sources: selected.version.definition.sourceSlots.map((slot) => ({
        sourceSlotKey: slot.key,
        stockId: this.snapshot.sources[slot.key] ?? '',
      })),
    };
    this.invalidate();
    const generation = this.bindingGeneration,
      selectedGeneration = this.selectedGeneration,
      started = performance.now();
    this.set({ feasibility: { kind: 'checking' } });
    try {
      const list = inventoryPlatePlanVersionsReadSchema.parse(
        await this.client.platePlanVersions({ ...this.scope, limit: 1 })
      );
      if (
        !this.active ||
        generation !== this.bindingGeneration ||
        selectedGeneration !== this.selectedGeneration
      )
        return;
      if (list.kind !== 'ready')
        throw Error(
          list.kind === 'unavailable'
            ? list.message
            : 'The inventory containing this version is unavailable.'
        );
      if (
        list.projectId !== this.scope.project ||
        list.inventoryId !== this.scope.inventoryId ||
        list.identity !== null
      )
        throw Error('The binding inventory changed.');
      const preview = inventoryPlatePlanBindingPreviewSnapshotSchema.parse(
        await this.client.previewPlatePlanBinding({
          ...this.scope,
          expectedRevision: list.revision,
          binding,
        })
      );
      if (
        !this.active ||
        generation !== this.bindingGeneration ||
        selectedGeneration !== this.selectedGeneration
      )
        return;
      if (preview.kind === 'unavailable') throw Error(preview.message);
      if (
        preview.projectId !== this.scope.project ||
        preview.inventoryId !== this.scope.inventoryId ||
        preview.versionId !== binding.versionId ||
        preview.definitionSha256 !== binding.definitionSha256 ||
        (this.principalKey !== null && JSON.stringify(preview.principal) !== this.principalKey) ||
        (preview.kind === 'ready' && preview.revision !== list.revision) ||
        (preview.binding &&
          inventoryTableCanonicalJson(preview.binding) !== inventoryTableCanonicalJson(binding))
      )
        throw Error('The feasibility response belongs to another binding or snapshot.');
      const delay =
        preview.nextBoundaryAt === null
          ? null
          : preview.nextBoundaryAt - preview.asOf - (performance.now() - started);
      this.set({
        feasibility: { kind: delay !== null && delay <= 0 ? 'stale' : 'observed', preview },
      });
      if (delay !== null && delay > 0)
        this.boundaryTimer = setTimeout(
          () => {
            if (this.active && generation === this.bindingGeneration) this.invalidate();
          },
          Math.min(delay, 2147483647)
        );
    } catch (cause) {
      if (
        this.active &&
        generation === this.bindingGeneration &&
        selectedGeneration === this.selectedGeneration
      )
        this.set({ feasibility: { kind: 'failed', message: message(cause) } });
    }
  }
  private outputKey(artifact: InventoryPlatePlanDiagramArtifact) {
    return JSON.stringify([artifact.versionId, artifact.definitionSha256, artifact.sha256]);
  }
  private outputOwner(): ExportOwner | null {
    const selected = this.snapshot.selected;
    if (selected.kind !== 'available' || selected.diagram.kind !== 'rendered') return null;
    const artifact = selected.diagram.artifact,
      key = this.outputKey(artifact);
    let owner = this.outputs.get(key);
    if (!owner) {
      const session = new InventoryTextOutputSession<InventoryPlatePlanDiagramArtifact>(
        this.port,
        (value) => value.svg,
        'The saved SVG differs from this exact plan diagram.',
        (output) => {
          const original = this.outputs.get(key);
          if (!original) return;
          original.output = output;
          const current = this.snapshot.selected;
          if (
            this.active &&
            current.kind === 'available' &&
            current.diagram.kind === 'rendered' &&
            this.outputKey(current.diagram.artifact) === key
          )
            this.set({ output });
        }
      );
      owner = { artifact, output: { kind: 'not-exported' }, session };
      this.outputs.set(key, owner);
    }
    return owner;
  }
  async exportDiagram() {
    const owner = this.outputOwner();
    if (this.active && owner) await owner.session.export(owner.artifact, owner.artifact.fileName);
  }
  async checkOutput() {
    const owner = this.outputOwner();
    if (owner) await owner.session.check();
  }
  async retryOutput() {
    const owner = this.outputOwner();
    if (owner) await owner.session.retry();
  }
  cancelChoosing() {
    for (const owner of this.outputs.values()) owner.session.cancelChoosing();
  }
  detach() {
    this.active = false;
    ++this.listGeneration;
    ++this.selectedGeneration;
    this.invalidate();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.cancelChoosing();
  }
  dispose() {
    this.detach();
    this.disposed = true;
    for (const owner of this.outputs.values()) owner.session.dispose();
    this.listeners.clear();
  }
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'The plan could not be read.';
}
