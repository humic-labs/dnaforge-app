import { z } from 'zod';
import {
  molecularDocumentReferenceSchema,
  type MolecularDocumentReference,
} from './molecular-document-reference';

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export interface MolecularDocumentOwnerAttrs {
  molecularDocumentDraftId?: string;
  molecularDocumentId?: string;
  molecularDocumentPath?: string;
  molecularDocumentRevision?: string;
  molecularDocumentSavedReferenceId?: string;
  molecularDocumentHistoricalRevisionId?: string;
  molecularDocumentProjectId?: string;
  molecularDocumentReference?: MolecularDocumentReference;
}

export const molecularDocumentOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('draft'), documentId: uuid }).strict(),
  z
    .object({
      kind: z.literal('document'),
      documentId: uuid,
      path: z.string().min(1),
      fileRevision: digest,
      revisionId: uuid,
      historical: z.boolean(),
    })
    .strict(),
]);
export type MolecularDocumentOwner = z.infer<typeof molecularDocumentOwnerSchema>;

export function molecularDocumentOwner(attrs: MolecularDocumentOwnerAttrs): MolecularDocumentOwner {
  const bound = Boolean(
    attrs.molecularDocumentId ||
    attrs.molecularDocumentPath ||
    attrs.molecularDocumentRevision ||
    attrs.molecularDocumentSavedReferenceId ||
    attrs.molecularDocumentHistoricalRevisionId
  );
  if (!bound) return { kind: 'draft', documentId: uuid.parse(attrs.molecularDocumentDraftId) };
  const owner: MolecularDocumentOwner = {
    kind: 'document',
    documentId: uuid.parse(attrs.molecularDocumentId),
    path: z.string().min(1).parse(attrs.molecularDocumentPath),
    fileRevision: digest.parse(attrs.molecularDocumentRevision),
    revisionId: uuid.parse(
      attrs.molecularDocumentHistoricalRevisionId ?? attrs.molecularDocumentSavedReferenceId
    ),
    historical: Boolean(attrs.molecularDocumentHistoricalRevisionId),
  };
  if (attrs.molecularDocumentReference) {
    const reference = molecularDocumentReferenceSchema.parse(attrs.molecularDocumentReference);
    if (
      reference.documentId !== owner.documentId ||
      reference.revisionId !== owner.revisionId ||
      (attrs.molecularDocumentProjectId && reference.projectId !== attrs.molecularDocumentProjectId)
    )
      throw Error('The molecular document reference disagrees with its owner binding.');
  }
  return owner;
}

export function retainMolecularDocumentOwner<T extends MolecularDocumentOwnerAttrs>(
  attrs: T,
  previous?: MolecularDocumentOwnerAttrs
): T {
  let next = attrs;
  if (
    !attrs.molecularDocumentId &&
    !attrs.molecularDocumentPath &&
    !attrs.molecularDocumentRevision &&
    previous?.molecularDocumentId
  )
    next = {
      ...attrs,
      molecularDocumentId: previous.molecularDocumentId,
      molecularDocumentPath: previous.molecularDocumentPath,
      molecularDocumentRevision: previous.molecularDocumentRevision,
      molecularDocumentSavedReferenceId: previous.molecularDocumentSavedReferenceId,
      molecularDocumentProjectId: previous.molecularDocumentProjectId,
      molecularDocumentReference: previous.molecularDocumentReference,
      molecularDocumentHistoricalRevisionId: previous.molecularDocumentHistoricalRevisionId,
    };
  if (
    !next.molecularDocumentId &&
    !next.molecularDocumentPath &&
    !next.molecularDocumentRevision &&
    !next.molecularDocumentDraftId
  )
    next = {
      ...next,
      molecularDocumentDraftId: previous?.molecularDocumentDraftId ?? crypto.randomUUID(),
    };
  molecularDocumentOwner(next);
  return next;
}
