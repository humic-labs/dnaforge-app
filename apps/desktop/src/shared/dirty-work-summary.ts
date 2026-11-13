import { isKnownTabType, quitWorkPhrase, TAB_TYPES, type TabType } from './tab-kind';
import type { DirtyWorkItem, DirtyWorkState } from './dirty-work-state';
import type { NativeDirtyDocument } from './native-document-drafts';

export function mergeDirtyWorkState(
  renderer: DirtyWorkState,
  native: readonly NativeDirtyDocument[],
  failure?: string
): DirtyWorkState {
  const active = native.filter(
    (item) => item.dirty || item.saving || item.recovery || item.inspectionRequired
  );
  const items: DirtyWorkItem[] = renderer.dirtyItems?.map((item) => ({ ...item })) ?? [];
  const legacyNativeIds = new Set([
    ...(renderer.dirtyPageIds ?? []),
    ...(renderer.dirtySequenceDocumentIds ?? []),
  ]);
  const legacyPaths = new Set(renderer.dirtyFilePaths ?? []);
  for (const item of active) {
    if (
      !renderer.dirtyItems &&
      (legacyNativeIds.has(item.documentId) || legacyPaths.has(item.path))
    )
      continue;
    items.push({
      kind: tabKind(item.kind),
      id: item.documentId,
      nativeDocumentId: item.documentId,
      filePath: item.path,
    });
  }
  const counts = new Map<TabType, Set<string>>();
  const byPath = new Map(
    items
      .filter((item) => item.filePath && item.nativeDocumentId)
      .map((item) => [item.filePath!, item.nativeDocumentId!])
  );
  const identities = new Set<string>();
  for (const item of items) {
    if (!isKnownTabType(item.kind)) continue;
    const identity =
      item.nativeDocumentId ??
      (item.filePath ? byPath.get(item.filePath) : undefined) ??
      `${item.kind}:${item.id}`;
    if (identities.has(identity)) continue;
    identities.add(identity);
    const ids = counts.get(item.kind) ?? new Set<string>();
    ids.add(identity);
    counts.set(item.kind, ids);
  }
  const parts = TAB_TYPES.flatMap((kind) => {
    const count = counts.get(kind)?.size ?? 0;
    return count ? [quitWorkPhrase(kind, count)] : [];
  });
  if (!renderer.dirtyItems && renderer.hasDirtyWork)
    parts.unshift(renderer.details || 'unsaved work');
  if (failure) parts.push('open documents');
  const unique = (values: readonly string[]) => [...new Set(values)];
  return {
    hasDirtyWork: renderer.hasDirtyWork || active.length > 0 || Boolean(failure),
    details: parts.join(' and '),
    dirtyPageIds: unique([
      ...(renderer.dirtyPageIds ?? []),
      ...active.filter((item) => item.kind === 'notebook').map((item) => item.documentId),
    ]),
    dirtySequenceDocumentIds: unique([
      ...(renderer.dirtySequenceDocumentIds ?? []),
      ...active.filter((item) => item.kind === 'sequence').map((item) => item.documentId),
    ]),
    dirtyTabIds: [...(renderer.dirtyTabIds ?? [])],
    dirtyFilePaths: unique([
      ...(renderer.dirtyFilePaths ?? []),
      ...active.map((item) => item.path),
    ]),
    ...(renderer.dirtyItems ? { dirtyItems: items } : {}),
  };
}

function tabKind(kind: NativeDirtyDocument['kind']): TabType {
  if (kind === 'notebook') return 'page';
  if (kind === 'csv' || kind === 'tsv') return 'table';
  if (kind === 'scientific' || kind === 'protocol') return 'scientific-document';
  return isKnownTabType(kind) ? kind : 'file';
}
