import type { Tab } from './types';
import { SOFT_WARN_BYTES } from '../../shared/oversized-guard';
import { isTabularDataFile } from '../../utils/fileTypes';
import type { SequenceDocumentRef } from '../../shared/managed-sequence-document';
import { sequenceDocumentKey } from '../../shared/managed-sequence-document';

export interface OversizeStatFn {
  (path: string): Promise<{ size: number } | null>;
}

export interface ResolveSequenceSourceFn {
  (ref: SequenceDocumentRef): Promise<string>;
}

export interface LocatedFileTab {
  panelId: string;
  tab: Tab;
}

export interface FileTabRevalidationDeps {
  stat: OversizeStatFn;
  resolveSequenceSource?: ResolveSequenceSourceFn;
  locateTabById: (tabId: string) => LocatedFileTab | null;
  updateTab: (
    panelId: string,
    tabId: string,
    updates: Pick<Tab, 'loadStatus' | 'fileSizeBytes'>
  ) => void;
}

const fileTabRevalidations = new Map<string, Promise<void>>();

function fileTabRevalidationKey(tab: Tab): string {
  const indexed = tab.indexedGenome;
  const manifest = indexed?.manifest;
  return JSON.stringify([
    tab.id,
    tab.type,
    tab.entityId,
    tab.sequenceDocument ? sequenceDocumentKey(tab.sequenceDocument) : null,
    tab.sequenceDocument?.kind === 'managed-sequence' ? tab.sequenceDocument.packageRoot : null,
    tab.sequenceDocument?.kind === 'import-source-sequence'
      ? tab.sequenceDocument.sourcePath
      : null,
    fileBackedTabPath(tab),
    tab.initialStructureAttrs?.coordinateSha256 ?? null,
    tab.initialStructureAttrs?.structureArtifactRef?.coordinateDigestSha256 ?? null,
    indexed
      ? [
          indexed.sourcePath,
          indexed.workspaceRoot ?? null,
          indexed.sourceSizeBytes ?? null,
          indexed.sourceMtimeMs ?? null,
          indexed.sourceCtimeMs ?? null,
          indexed.chrom,
          manifest
            ? [
                manifest.chrom,
                manifest.fastaPath,
                manifest.faiPath,
                manifest.gziPath ?? null,
                manifest.gffPath ?? null,
                manifest.tbiPath ?? null,
                manifest.workspaceRootPaths ?? null,
              ]
            : null,
        ]
      : null,
  ]);
}

export function sameFileTabReadAuthority(left: Tab, right: Tab): boolean {
  return fileTabRevalidationKey(left) === fileTabRevalidationKey(right);
}

export function isWorkspaceCoordinateFileTab(tab: Tab): boolean {
  return (
    tab.type === 'structure' && typeof tab.initialStructureAttrs?.coordinateFilePath === 'string'
  );
}

export function fileBackedTabPath(tab: Tab): string | null {
  if (tab.sourceFileView) return null;
  if (tab.legacyMigrationRead) return tab.legacyMigrationRead.path;
  if (isWorkspaceCoordinateFileTab(tab)) {
    return tab.initialStructureAttrs?.coordinateFilePath ?? null;
  }
  if (tab.type === 'sequence' && tab.sequenceDocument) return null;
  if (tab.type === 'sequence' || tab.type === 'file') return tab.entityId;
  if (tab.type === 'table' && isTabularDataFile(tab.entityId)) return tab.entityId;
  return null;
}

export function shouldRevalidateFileTabOnReopen(tab: Tab): boolean {
  return tab.type !== 'structure' && fileBackedTabPath(tab) !== null;
}

export function isMissingFileError(err: unknown): boolean {
  if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return true;
  const message = (err as Error)?.message ?? '';
  return message.includes('ENOENT') || message.includes('no such file');
}

function usesSequenceOversizePolicy(tab: Tab): boolean {
  return tab.type !== 'table';
}

export async function scanTabForOversize(
  tab: Tab,
  stat: OversizeStatFn,
  resolveSequenceSource?: ResolveSequenceSourceFn
): Promise<Tab> {
  let filePath: string | null;
  if (tab.type === 'sequence' && tab.indexedGenome) {
    if (tab.indexedGenome.manifest) {
      return { ...tab, loadStatus: 'indexed', fileSizeBytes: tab.indexedGenome.sourceSizeBytes };
    }
    try {
      const s = await stat(tab.indexedGenome.sourcePath);
      if (!s) return { ...tab, loadStatus: 'missing', fileSizeBytes: undefined };
      return { ...tab, loadStatus: 'indexed-pending', fileSizeBytes: s.size };
    } catch {
      return { ...tab, loadStatus: 'error', fileSizeBytes: undefined };
    }
  }
  if (tab.type === 'sequence' && tab.sequenceDocument) {
    if (!resolveSequenceSource) return tab;
    try {
      filePath = await resolveSequenceSource(tab.sequenceDocument);
    } catch {
      return { ...tab, loadStatus: 'error', fileSizeBytes: undefined };
    }
  } else {
    filePath = fileBackedTabPath(tab);
  }
  if (!filePath) return tab;
  try {
    const s = await stat(filePath);
    if (!s) {
      return { ...tab, loadStatus: 'missing', fileSizeBytes: undefined };
    }
    if (usesSequenceOversizePolicy(tab) && s.size >= SOFT_WARN_BYTES) {
      return { ...tab, loadStatus: 'deferred-oversized', fileSizeBytes: s.size };
    }
    return { ...tab, loadStatus: 'loaded', fileSizeBytes: s.size };
  } catch {
    return { ...tab, loadStatus: 'error', fileSizeBytes: undefined };
  }
}

export function revalidateFileTab(tab: Tab, deps: FileTabRevalidationDeps): Promise<void> {
  const revalidationKey = fileTabRevalidationKey(tab);
  const inFlight = fileTabRevalidations.get(revalidationKey);
  if (inFlight) return inFlight;

  const task = (async () => {
    const scanned = await scanTabForOversize(tab, deps.stat, deps.resolveSequenceSource);
    const current = deps.locateTabById(tab.id);
    if (!current || !sameFileTabReadAuthority(current.tab, tab)) {
      return;
    }
    deps.updateTab(current.panelId, current.tab.id, {
      loadStatus: scanned.loadStatus,
      fileSizeBytes: scanned.fileSizeBytes,
    });
  })().finally(() => {
    fileTabRevalidations.delete(revalidationKey);
  });

  fileTabRevalidations.set(revalidationKey, task);
  return task;
}

export async function scanTabsForOversize(
  tabs: Tab[],
  stat: OversizeStatFn,
  resolveSequenceSource?: ResolveSequenceSourceFn
): Promise<Tab[]> {
  return Promise.all(tabs.map((tab) => scanTabForOversize(tab, stat, resolveSequenceSource)));
}
