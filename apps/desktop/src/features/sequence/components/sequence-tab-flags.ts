import type { ManagedSequenceDocumentRef } from '../../../shared/managed-sequence-document';

export function sequenceTabManagedDocument<T extends { kind: string }>(
  documentRef: T
): Extract<T, { kind: 'managed-sequence' }> | undefined {
  return documentRef.kind === 'managed-sequence'
    ? (documentRef as Extract<T, { kind: 'managed-sequence' }>)
    : undefined;
}

export function sequenceTabPrimerSaveDir(
  managedDocument: ManagedSequenceDocumentRef | undefined,
  sourcePath: string
): string | undefined {
  const path = (managedDocument?.packageRoot ?? sourcePath).replace(/[\\/]+$/, '');
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (separator < 0) return undefined;
  const rootLength = /^[A-Za-z]:[\\/]/.test(path) ? 3 : 1;
  return path.slice(0, Math.max(rootLength, separator));
}

export function sequenceTabGitCommitFile<T>(readOnly: boolean, gitCommitFile: T): T | null {
  return readOnly ? null : gitCommitFile;
}

export function sequenceTabCoordinateSpace<T>(
  coordinateSpace: T | null | undefined,
  headDiffCoordinateSpace: T | null | undefined,
  gitDiffCoordinateSpace: T | null | undefined
): T | null | undefined {
  return coordinateSpace ?? headDiffCoordinateSpace ?? gitDiffCoordinateSpace;
}

export function sequenceTabDiffViewActive(
  isDiffViewActive: boolean,
  gitDiffCoordinateSpace: unknown
): boolean {
  return isDiffViewActive || !!gitDiffCoordinateSpace;
}

export function sequenceTabIsCircular(circular: boolean | undefined): boolean {
  return circular ?? false;
}

export function sequenceTabWorkspaceRoot(root: string | null | undefined): string | undefined {
  return root ?? undefined;
}
