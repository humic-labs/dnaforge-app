import type { DirtyWorkState } from './dirty-work-state';
import { findContainingPathBoundary, normalizePathForBoundary } from './path-boundary';
import { sha256Hex } from './sha256';

export interface LegacyUnsavedDiscardScope {
  admittedRoots: readonly string[];
  dirtyPageIds: readonly string[];
  dirtySequenceDocumentIds: readonly string[];
  dirtyTabIds: readonly string[];
  dirtyFilePaths: readonly string[];
}
export interface LegacyUnsavedDiscardSnapshot {
  version: 1;
  copies: Array<{
    store: 'draft' | 'sequence';
    key: string;
    workspaceRoot: string;
    sha256: string;
  }>;
}
export function legacyUnsavedDiscardScope(
  state: DirtyWorkState,
  admittedRoots: readonly string[]
): LegacyUnsavedDiscardScope {
  return {
    admittedRoots: [...admittedRoots],
    dirtyPageIds: [...(state.dirtyPageIds ?? [])],
    dirtySequenceDocumentIds: [...(state.dirtySequenceDocumentIds ?? [])],
    dirtyTabIds: [...(state.dirtyTabIds ?? [])],
    dirtyFilePaths: [...(state.dirtyFilePaths ?? [])],
  };
}
export function createLegacyUnsavedDiscard(deps: {
  currentRoots(): readonly string[];
  draftSessionId: string;
  sequenceSessionId: string;
  readDraft(key: string): Promise<unknown>;
  readSequence(key: string): Promise<unknown>;
  deleteDraftIfUnchanged(key: string, serialized: string): Promise<boolean>;
  deleteSequenceIfUnchanged(key: string, serialized: string): Promise<boolean>;
  flushDrafts(keys: readonly string[]): Promise<void>;
  canDiscardFile(path: string): Promise<boolean>;
  resolveDocument(
    id: string,
    kind: 'notebook' | 'sequence'
  ): Promise<{ workspaceRoot: string; path: string; kind: string }>;
}) {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const admitted = (root: string) =>
    deps
      .currentRoots()
      .some((current) => normalizePathForBoundary(current) === normalizePathForBoundary(root));
  const owner = (roots: readonly string[], path: string) =>
    findContainingPathBoundary(
      roots.filter(admitted).map((path) => ({ path })),
      path
    )?.path;
  return {
    async capture(scope: LegacyUnsavedDiscardScope): Promise<LegacyUnsavedDiscardSnapshot> {
      if (
        !scope ||
        !Array.isArray(scope.admittedRoots) ||
        !Array.isArray(scope.dirtyFilePaths) ||
        !Array.isArray(scope.dirtyPageIds) ||
        !Array.isArray(scope.dirtySequenceDocumentIds) ||
        !Array.isArray(scope.dirtyTabIds)
      )
        throw new Error('An exact dirty-work scope is required for legacy recovery cleanup.');
      const draftKeys = [
        ...new Set([
          ...scope.dirtyFilePaths.flatMap((path) => [`text:${path}`, `table:${path}`]),
          ...scope.dirtyPageIds.map((id) => `page:${id}`),
          ...scope.dirtyTabIds.map((id) => `new:${id}`),
        ]),
      ];
      await deps.flushDrafts(draftKeys);
      const snapshot: LegacyUnsavedDiscardSnapshot = { version: 1, copies: [] };
      for (const key of draftKeys) {
        const entry = await deps.readDraft(key);
        if (!isRecord(entry) || entry.sessionId !== deps.draftSessionId) continue;
        let root: string | undefined;
        if (key.startsWith('text:') || key.startsWith('table:')) {
          const path = key.slice(key.startsWith('text:') ? 5 : 6);
          root = owner(scope.admittedRoots, path);
          if (root && !(await deps.canDiscardFile(path))) root = undefined;
        } else if (key.startsWith('page:')) {
          const target = await deps.resolveDocument(key.slice(5), 'notebook');
          if (target.kind === 'notebook') root = owner(scope.admittedRoots, target.path);
        } else if (
          key.startsWith('new:') &&
          isRecord(entry.payload) &&
          isRecord(entry.payload.artifactDocument)
        ) {
          const context = entry.payload.artifactDocument;
          if (context.persistence === 'draft' && typeof context.workspaceRoot === 'string')
            root = scope.admittedRoots.find(
              (root) =>
                admitted(root) &&
                normalizePathForBoundary(root) ===
                  normalizePathForBoundary(context.workspaceRoot as string)
            );
        }
        if (root)
          snapshot.copies.push({
            store: 'draft',
            key,
            workspaceRoot: root,
            sha256: await sha256Hex(JSON.stringify(entry)),
          });
      }
      for (const key of new Set(scope.dirtySequenceDocumentIds)) {
        const entry = await deps.readSequence(key);
        if (!isRecord(entry) || entry.sessionId !== deps.sequenceSessionId) continue;
        const target = await deps.resolveDocument(key, 'sequence');
        const root =
          target.kind === 'sequence' ? owner(scope.admittedRoots, target.path) : undefined;
        if (root)
          snapshot.copies.push({
            store: 'sequence',
            key,
            workspaceRoot: root,
            sha256: await sha256Hex(JSON.stringify(entry)),
          });
      }
      for (const copy of snapshot.copies)
        if (!admitted(copy.workspaceRoot))
          throw new Error('The legacy recovery project was unmounted during capture.');
      return snapshot;
    },
    async discard(snapshot: LegacyUnsavedDiscardSnapshot): Promise<void> {
      if (snapshot?.version !== 1 || !Array.isArray(snapshot.copies))
        throw new Error('An exact legacy recovery snapshot is required.');
      await deps.flushDrafts(
        snapshot.copies.filter((copy) => copy.store === 'draft').map((copy) => copy.key)
      );
      const results = await Promise.allSettled(
        snapshot.copies.map(async (copy) => {
          if (!admitted(copy.workspaceRoot))
            throw new Error('A legacy recovery project is no longer admitted.');
          if (copy.store !== 'draft' && copy.store !== 'sequence')
            throw new Error('Unknown legacy recovery store.');
          const entry = await (copy.store === 'draft'
            ? deps.readDraft(copy.key)
            : deps.readSequence(copy.key));
          if (entry === undefined) return;
          const serialized = JSON.stringify(entry);
          if (
            !isRecord(entry) ||
            entry.sessionId !==
              (copy.store === 'draft' ? deps.draftSessionId : deps.sequenceSessionId) ||
            (await sha256Hex(serialized)) !== copy.sha256
          )
            throw new Error(`A newer recovery copy was kept: ${copy.key}`);
          if (!admitted(copy.workspaceRoot))
            throw new Error('A legacy recovery project changed during cleanup.');
          const removed = await (copy.store === 'draft'
            ? deps.deleteDraftIfUnchanged(copy.key, serialized)
            : deps.deleteSequenceIfUnchanged(copy.key, serialized));
          if (!removed) throw new Error(`A newer recovery copy was kept: ${copy.key}`);
        })
      );
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length)
        throw Object.assign(
          new Error('Some exact legacy recovery copies could not be discarded.'),
          { name: 'AggregateError', errors: failures }
        );
    },
  };
}

declare global {
  interface Window {
    __dnaforgeCaptureUnsavedCopies?: (
      scope: LegacyUnsavedDiscardScope
    ) => Promise<LegacyUnsavedDiscardSnapshot>;
    __dnaforgeDiscardUnsavedCopies?: (snapshot: LegacyUnsavedDiscardSnapshot) => Promise<void>;
  }
}
