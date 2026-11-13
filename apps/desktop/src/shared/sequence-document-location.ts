import type { SequenceDocumentRef } from './managed-sequence-document';

export interface ResolvedSequenceDocument {
  ref: SequenceDocumentRef;
  documentId: string;
  sourcePath: string;
  name?: string;
}

export type SequenceDocumentResolver = (
  documentId: string,
  workspaceRoots: readonly string[],
  options?: { readonly mutationToken?: string }
) => Promise<ResolvedSequenceDocument>;
