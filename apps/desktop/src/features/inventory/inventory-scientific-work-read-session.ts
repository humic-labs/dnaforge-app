import type { InventoryScientificWork } from '@waypoint/domain-services';
import type { InventoryClient, InventoryScientificSourceRead } from '../../shared/inventory-client';
import {
  inventoryScientificWorksForContextRequestSchema,
  inventoryScientificWorksForContextReadSchema,
  type InventoryScientificWorkCursor,
  type InventoryScientificWorksForContextRead,
} from '../../shared/inventory-scientific-read';
import type { ProjectResourceReference } from '../../shared/project-resource-reference';

export type InventoryRunResource = {
  readonly projectId: string;
  readonly workspaceScope: string;
  readonly entityId: string;
};
type ReadClient = Pick<
  InventoryClient,
  'projects' | 'scientificWorksForContext' | 'scientificSource' | 'onChanged'
>;
type Scope = InventoryRunResource & { inventoryId: string };
type Ready = Extract<InventoryScientificWorksForContextRead, { kind: 'ready' }>;
type Status =
  | { kind: 'resolving' }
  | { kind: 'loading' }
  | { kind: 'ready'; scope: Scope; read: Ready; cursor: InventoryScientificWorkCursor | null }
  | { kind: 'inventory-absent' }
  | { kind: 'unavailable'; message: string };
type Source =
  | { kind: 'idle' }
  | { kind: 'loading'; workId: string }
  | {
      kind: 'available';
      workId: string;
      read: Extract<InventoryScientificSourceRead, { kind: 'available' }>;
    }
  | { kind: 'unavailable'; workId: string; message: string };
export type InventoryScientificWorkReadSnapshot = {
  readonly status: Status;
  readonly source: Source;
  readonly navigationError: string | null;
};

export class InventoryScientificWorkReadSession {
  private snapshot: InventoryScientificWorkReadSnapshot = {
    status: { kind: 'resolving' },
    source: { kind: 'idle' },
    navigationError: null,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private sourceGeneration = 0;
  private scope: Scope | null = null;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;
  private refreshQueued = false;
  private refreshTicket = 0;
  private observedRevisions = new Map<string, number>();
  private navigation: AbortController | null = null;

  constructor(
    private readonly client: ReadClient,
    private readonly resource: InventoryRunResource | null,
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
  private publish(next: InventoryScientificWorkReadSnapshot) {
    if (this.disposed) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  private invalidate() {
    this.generation += 1;
    this.sourceGeneration += 1;
    this.navigation?.abort();
    this.navigation = null;
    return this.generation;
  }
  private current(generation: number) {
    return !this.disposed && generation === this.generation;
  }
  private unavailable(message: string) {
    this.publish({
      status: { kind: 'unavailable', message },
      source: { kind: 'idle' },
      navigationError: null,
    });
  }
  async open() {
    this.disposed = false;
    this.refreshTicket += 1;
    this.refreshQueued = false;
    this.unsubscribe?.();
    this.unsubscribe = this.client.onChanged((event) => {
      if (event.projectId !== this.resource?.projectId) return;
      const prior = this.observedRevisions.get(event.inventoryId) ?? -1;
      if (event.revision <= prior) return;
      this.observedRevisions.set(event.inventoryId, event.revision);
      if (this.scope?.inventoryId !== event.inventoryId) return;
      const status = this.snapshot.status;
      if (status.kind === 'ready' && event.revision <= status.read.revision) return;
      this.invalidate();
      this.publish({
        status: { kind: 'loading' },
        source: { kind: 'idle' },
        navigationError: null,
      });
      if (this.refreshQueued) return;
      this.refreshQueued = true;
      const ticket = ++this.refreshTicket;
      void Promise.resolve().then(() => {
        if (ticket !== this.refreshTicket) return;
        this.refreshQueued = false;
        if (!this.disposed) void this.load(null);
      });
    });
    const generation = this.invalidate();
    this.scope = null;
    this.publish({
      status: { kind: 'resolving' },
      source: { kind: 'idle' },
      navigationError: null,
    });
    if (!this.resource) {
      this.unavailable("This Run's project identity is unavailable.");
      return;
    }
    try {
      const projects = await this.client.projects();
      if (!this.current(generation)) return;
      const project = projects.find((entry) => entry.projectId === this.resource!.projectId);
      if (!project) throw Error("This Run's project inventory is unavailable.");
      this.scope = { ...this.resource, inventoryId: project.defaultInventoryId };
      await this.load(null);
    } catch (cause) {
      if (this.current(generation)) this.unavailable(message(cause));
    }
  }
  refresh = async () => {
    if (this.scope) await this.load(null);
    else await this.open();
  };
  next = async () => {
    const status = this.snapshot.status;
    if (status.kind === 'ready' && status.read.nextCursor) await this.load(status.read.nextCursor);
  };
  private async load(cursor: InventoryScientificWorkCursor | null) {
    const scope = this.scope;
    if (!scope || this.disposed) return;
    const generation = this.invalidate();
    this.publish({ status: { kind: 'loading' }, source: { kind: 'idle' }, navigationError: null });
    try {
      const request = inventoryScientificWorksForContextRequestSchema.parse({
        project: scope.projectId,
        inventoryId: scope.inventoryId,
        context: { kind: 'protocol-run', entityId: scope.entityId },
        limit: 20,
        ...(cursor ? { cursor } : {}),
      });
      const read = inventoryScientificWorksForContextReadSchema.parse(
        await this.client.scientificWorksForContext(request)
      );
      if (!this.current(generation)) return;
      if (read.kind === 'unavailable') {
        if (cursor && read.code === 'INVENTORY_QUERY_REVISION_CHANGED') await this.load(null);
        else this.unavailable(read.message);
        return;
      }
      if (
        read.projectId !== scope.projectId ||
        read.inventoryId !== scope.inventoryId ||
        read.context.kind !== 'protocol-run' ||
        read.context.entityId !== scope.entityId
      )
        throw Error('The recorded work response belongs to another Run or inventory.');
      if (read.kind === 'inventory-absent') {
        this.publish({
          status: { kind: 'inventory-absent' },
          source: { kind: 'idle' },
          navigationError: null,
        });
        return;
      }
      if (
        !Number.isSafeInteger(read.revision) ||
        read.revision < 0 ||
        !Array.isArray(read.works) ||
        read.works.length > 20 ||
        (cursor && cursor.revision !== read.revision) ||
        read.revision < (this.observedRevisions.get(scope.inventoryId) ?? -1) ||
        read.works.some(
          (work) =>
            work.context.kind !== 'protocol-run' ||
            work.context.entityId !== scope.entityId ||
            work.context.projectId !== scope.projectId ||
            work.context.workspaceScope !== scope.workspaceScope
        ) ||
        (read.nextCursor && read.nextCursor.revision !== read.revision)
      )
        throw Error('The recorded work response does not match this inventory snapshot.');
      if (read.nextCursor)
        inventoryScientificWorksForContextRequestSchema.parse({
          ...request,
          cursor: read.nextCursor,
        });
      this.observedRevisions.set(scope.inventoryId, read.revision);
      this.publish({
        status: { kind: 'ready', scope, read, cursor },
        source: { kind: 'idle' },
        navigationError: null,
      });
    } catch (cause) {
      if (this.current(generation)) this.unavailable(message(cause));
    }
  }
  async viewSavedContext(workId: string) {
    const status = this.snapshot.status;
    if (status.kind !== 'ready') return;
    const work = status.read.works.find((entry) => entry.id === workId);
    if (!work) return;
    const generation = this.generation,
      sourceGeneration = ++this.sourceGeneration;
    this.publish({ ...this.snapshot, source: { kind: 'loading', workId } });
    try {
      const read = await this.client.scientificSource({
        project: status.scope.projectId,
        inventoryId: status.scope.inventoryId,
        workId,
      });
      if (!this.current(generation) || sourceGeneration !== this.sourceGeneration) return;
      if (read.kind === 'unavailable') {
        this.publish({
          ...this.snapshot,
          source: { kind: 'unavailable', workId, message: read.message },
        });
        return;
      }
      if (!matchesSource(work, read))
        throw Error('The saved context does not match this recorded work.');
      this.publish({ ...this.snapshot, source: { kind: 'available', workId, read } });
    } catch (cause) {
      if (this.current(generation) && sourceGeneration === this.sourceGeneration)
        this.publish({
          ...this.snapshot,
          source: { kind: 'unavailable', workId, message: message(cause) },
        });
    }
  }
  async openCurrent(workId: string) {
    const status = this.snapshot.status;
    if (status.kind !== 'ready' || !status.read.works.some((work) => work.id === workId)) return;
    const generation = this.generation;
    this.navigation?.abort();
    const controller = new AbortController();
    this.navigation = controller;
    this.publish({ ...this.snapshot, navigationError: null });
    try {
      await this.navigate(
        { kind: 'entity', projectId: status.scope.projectId, entityId: status.scope.entityId },
        { signal: controller.signal }
      );
    } catch (cause) {
      if (this.current(generation) && !controller.signal.aborted && this.navigation === controller)
        this.publish({ ...this.snapshot, navigationError: message(cause) });
    }
  }
  dispose() {
    this.disposed = true;
    this.refreshTicket += 1;
    this.refreshQueued = false;
    this.invalidate();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
function matchesSource(
  work: InventoryScientificWork,
  read: Extract<InventoryScientificSourceRead, { kind: 'available' }>
) {
  return (
    work.context.kind === 'protocol-run' &&
    read.workId === work.id &&
    read.sourceSha256 === work.context.source.sha256 &&
    read.source.schema === 'dnaforge.protocol-run-saved-source.v1' &&
    read.source.projectId === work.context.projectId &&
    read.source.workspaceScope === work.context.workspaceScope &&
    read.source.runId === work.context.entityId &&
    read.source.fileObjectUuid === work.context.source.fileObjectUuid
  );
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Recorded physical work could not be loaded.';
}
