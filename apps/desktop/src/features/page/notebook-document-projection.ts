import type { NotebookDocumentSnapshot } from '../../shared/notebook-document';

const projections = new Set<(snapshot: NotebookDocumentSnapshot) => void>();

export function subscribeNotebookDocumentProjection(
  projection: (snapshot: NotebookDocumentSnapshot) => void
): () => void {
  projections.add(projection);
  return () => {
    projections.delete(projection);
  };
}

export function projectNotebookDocumentSnapshot(snapshot: NotebookDocumentSnapshot): void {
  for (const projection of projections) projection(snapshot);
}
