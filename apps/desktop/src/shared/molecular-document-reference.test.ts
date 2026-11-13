import { describe, it, expect } from 'vitest';
import {
  molecularDocumentReferenceFromHref,
  molecularDocumentReferenceHref,
  molecularDocumentReferenceLocator,
  molecularDocumentReferenceRecord,
  molecularDocumentReferenceSchema,
} from './molecular-document-reference';
import { resolveMolecularReference } from './molecular-reference';
import { notebookReferenceFromHref } from './notebook-reference-normalization';
const reference = {
  kind: 'molecular-document' as const,
  version: 1 as const,
  projectId: 'a-project',
  documentId: 'b6888cec-80bd-4133-9530-0744c7977cda',
  revisionId: 'a92a4446-d52d-48d2-9ee4-7abbd7e9b9cd',
  revisionSha256: 'a'.repeat(64),
  viewId: 'arbitrary / named view',
};
describe('typed molecular document references', () => {
  it('carries exact project, document, revision, content and named view through a chip without a database UUID lookup', () => {
    const href = molecularDocumentReferenceHref(reference);
    expect(molecularDocumentReferenceFromHref(href)).toEqual(reference);
    expect(
      molecularDocumentReferenceFromHref(molecularDocumentReferenceLocator(reference))
    ).toEqual(reference);
    expect(notebookReferenceFromHref(href, 'Pinned view')).toEqual({
      type: 'mention',
      attrs: { entityType: 'reference', referenceUri: href, label: 'Pinned view' },
    });
    expect(
      resolveMolecularReference(molecularDocumentReferenceRecord(reference, 'Pinned view'))
    ).toEqual({ kind: 'document', document: reference });
  });
  it('rejects asset identities, unsupported versions, absent fingerprints and contradictory locators', () => {
    expect(
      molecularDocumentReferenceSchema.safeParse({ ...reference, kind: 'structure' }).success
    ).toBe(false);
    expect(molecularDocumentReferenceSchema.safeParse({ ...reference, version: 2 }).success).toBe(
      false
    );
    expect(
      molecularDocumentReferenceFromHref(
        molecularDocumentReferenceHref(reference).replace('/sha256/' + reference.revisionSha256, '')
      )
    ).toBe(null);
    expect(() =>
      resolveMolecularReference({
        ...molecularDocumentReferenceRecord(reference, 'Pinned'),
        locator: 'entity://structure/raw-protein',
      })
    ).toThrow(/disagrees/);
  });
});
