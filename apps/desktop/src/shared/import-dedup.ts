export interface ExistingWorkspaceFile {
  relPath: string;
  name: string;
  contentHash: string;
}

export interface IncomingImportFile {
  name: string;
  contentHash: string;
}

export type ImportDedupDecision =
  | { action: 'import-new' }
  | { action: 'skip-duplicate'; existingRelPath: string; matchedByName: boolean }
  | { action: 'name-collision'; existingRelPath: string };

export interface DedupPreviewItem {
  sourcePath: string;
  decision: ImportDedupDecision;
}

export function decideImportDedup(
  incoming: IncomingImportFile,
  existing: readonly ExistingWorkspaceFile[]
): ImportDedupDecision {
  const contentTwins = existing.filter((f) => f.contentHash === incoming.contentHash);
  if (contentTwins.length > 0) {
    const sameName = contentTwins.find((f) => f.name === incoming.name);
    const twin = sameName ?? contentTwins[0];
    return {
      action: 'skip-duplicate',
      existingRelPath: twin.relPath,
      matchedByName: twin.name === incoming.name,
    };
  }

  const nameClash = existing.find((f) => f.name === incoming.name);
  if (nameClash) {
    return { action: 'name-collision', existingRelPath: nameClash.relPath };
  }

  return { action: 'import-new' };
}
