import { isDeveloperImportSourcePath } from '../../shared/developer-import-sources';
export { contentFingerprint } from '../../shared/content-fingerprint';
import {
  projectionSourceKey,
  sqliteProjectionSynchronizationStore,
  type ProjectionSynchronizationStore,
} from './projection-source-state';

import type { EntityReconcileContext, WorkspaceEntityAdapter } from './adapter-contract';
export type {
  EntityProjectionState,
  EntityReconcileContext,
  WorkspaceEntityAdapter,
} from './adapter-contract';

const registry = new Map<string, WorkspaceEntityAdapter>();

export function registerEntityAdapter(adapter: WorkspaceEntityAdapter): void {
  if (registry.has(adapter.kind)) {
    throw new Error(`[entity-substrate] adapter for kind "${adapter.kind}" already registered`);
  }
  registry.set(adapter.kind, adapter);
}

export function getEntityAdapterForKind(kind: string): WorkspaceEntityAdapter | null {
  return registry.get(kind) ?? null;
}

export function getEntityAdapterForPath(path: string): WorkspaceEntityAdapter | null {
  let found: WorkspaceEntityAdapter | null = null;
  for (const adapter of registry.values()) {
    if (adapter.matchesPath(path)) {
      if (found) {
        throw new Error(
          `[entity-substrate] "${path}" matched both "${found.kind}" and "${adapter.kind}"`
        );
      }
      found = adapter;
    }
  }
  return found;
}

export function getEntityAdapterForSchema(schema: string): WorkspaceEntityAdapter | null {
  for (const adapter of registry.values()) if (adapter.schema === schema) return adapter;
  return null;
}

export function listEntityAdapters(): WorkspaceEntityAdapter[] {
  return [...registry.values()];
}

export function __resetEntityAdapterRegistryForTests(): void {
  registry.clear();
}

export type ReconcileOutcome =
  | 'created'
  | 'in-sync'
  | 'updated-from-file'
  | 'conflict'
  | 'skipped-unbound'
  | 'skipped-import-source';

export type EntityReconcileConflictReason =
  | 'unknown-base'
  | 'projection-only'
  | 'both-changed'
  | 'projection-write-diverged';

export interface EntityReconcileFileResult {
  id: string;
  outcome: ReconcileOutcome;
  conflictReason?: EntityReconcileConflictReason;
}

interface EntityReconcileOptions {
  catalogBindOk?: boolean;

  conflictResolution?: 'use-file';

  synchronizationStore?: ProjectionSynchronizationStore;
}

export async function reconcileEntityFile(
  adapter: WorkspaceEntityAdapter,
  bytes: string,
  path: string,
  fileMtimeMs: number,
  ctx: EntityReconcileContext,
  opts?: EntityReconcileOptions
): Promise<EntityReconcileFileResult> {
  if (isDeveloperImportSourcePath(path)) {
    const doc = await adapter.parse(bytes, path);
    return { id: adapter.identity(doc, ctx), outcome: 'skipped-import-source' };
  }
  const source = adapter.parseSource
    ? await adapter.parseSource(bytes, path, fileMtimeMs, ctx)
    : { document: await adapter.parse(bytes, path), fileMtimeMs };
  return reconcileEntitySnapshot(adapter, source, path, ctx, opts);
}

export async function reconcileEntitySnapshot(
  adapter: WorkspaceEntityAdapter,
  source: { document: unknown; fileMtimeMs: number },
  path: string,
  ctx: EntityReconcileContext,
  opts?: EntityReconcileOptions
): Promise<EntityReconcileFileResult> {
  const doc = source.document;
  const id = adapter.identity(doc, ctx);
  if (isDeveloperImportSourcePath(path)) return { id, outcome: 'skipped-import-source' };
  const fileFingerprint = await adapter.projectionFingerprint(doc);
  const projection = await adapter.getProjection(id, ctx, path);
  const synchronization = opts?.synchronizationStore ?? sqliteProjectionSynchronizationStore;
  const sourceKey = projectionSourceKey(adapter, id, path, ctx);
  const writeFromFile = async (
    outcome: 'created' | 'updated-from-file'
  ): Promise<EntityReconcileFileResult> => {
    const publication = await adapter.writeProjection(
      doc,
      id,
      source.fileMtimeMs,
      path,
      ctx,
      projection
    );

    const synchronizedFingerprint = publication
      ? await adapter.projectionFingerprint(publication.sourceDocument)
      : fileFingerprint;
    const written = await adapter.getProjection(id, ctx, path);

    if (
      !written ||
      written.fingerprint !== synchronizedFingerprint ||
      written.sourceBindingMatches === false
    ) {
      return { id, outcome: 'conflict', conflictReason: 'projection-write-diverged' };
    }
    await synchronization.settle(sourceKey, synchronizedFingerprint, ctx.mutationToken);
    return { id, outcome };
  };

  if (!projection) {
    if (opts?.catalogBindOk === false) {
      return { id, outcome: 'skipped-unbound' };
    }
    return writeFromFile('created');
  }
  if (projection.sourceBindingMatches === false) {
    return writeFromFile('updated-from-file');
  }
  if (projection.fingerprint === fileFingerprint) {
    await synchronization.settle(sourceKey, fileFingerprint, ctx.mutationToken);
    return { id, outcome: 'in-sync' };
  }
  const base = await synchronization.read(sourceKey);
  if (base === projection.fingerprint || opts?.conflictResolution === 'use-file') {
    return writeFromFile('updated-from-file');
  }
  return {
    id,
    outcome: 'conflict',
    conflictReason:
      base === null
        ? 'unknown-base'
        : base === fileFingerprint
          ? 'projection-only'
          : 'both-changed',
  };
}
