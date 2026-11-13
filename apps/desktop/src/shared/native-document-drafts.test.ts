import { describe, expect, it } from 'vitest';
import { pageNativeDirtyDocuments, type NativeDirtyDocument } from './native-document-drafts';
import { fileDocumentAgentRequestSchema, fileDocumentToolRequestSchema } from './file-document';

function draft(documentId: string, workspaceRoot: string): NativeDirtyDocument {
  return {
    documentId,
    target: { documentId },
    workspaceRoot,
    path: `${workspaceRoot}/same-label.txt`,
    kind: 'text',
    revision: `draft:${documentId}`,
    dirty: true,
    saving: false,
    readOnly: false,
    recovery: false,
    inspectionRequired: false,
  };
}
const projects = [
  { name: 'Alpha', path: '/alpha' },
  { name: 'Beta', path: '/beta' },
];
describe('bounded native dirty metadata', () => {
  it('refuses ambiguous identities instead of hiding a conflicting owner behind pagination', async () => {
    await expect(
      pageNativeDirtyDocuments(
        { operation: { kind: 'list-dirty', limit: 1 } },
        { projects, documents: [draft('same', '/alpha'), draft('same', '/beta')] }
      )
    ).rejects.toThrow('OWNERSHIP_AMBIGUOUS');
  });
  it('admits target-free scoped discovery and refuses mutation-shaped listing', () => {
    const input = { project: 'Alpha', operation: { kind: 'list-dirty', limit: 1 } };
    expect(fileDocumentAgentRequestSchema.parse(input)).toEqual(input);
    expect(fileDocumentToolRequestSchema.parse(input)).toEqual(input);
    expect(
      fileDocumentAgentRequestSchema.safeParse({ ...input, target: { documentId: 'a' } }).success
    ).toBe(false);
  });
  it('pages exact stable identities across current admitted roots, excluding a retired root', async () => {
    const documents = [draft('b', '/beta'), draft('a', '/alpha'), draft('hidden', '/retired')];
    const first = await pageNativeDirtyDocuments(
      { operation: { kind: 'list-dirty', limit: 1 } },
      { projects, documents }
    );
    expect(first.documents.map((item) => item.documentId)).toEqual(['a']);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await pageNativeDirtyDocuments(
      { operation: { kind: 'list-dirty', limit: 1, cursor: first.nextCursor! } },
      { projects, documents }
    );
    expect(second.documents.map((item) => item.documentId)).toEqual(['b']);
    expect(second.nextCursor).toBeNull();
    expect(first.documents[0]).not.toHaveProperty('content');
  });
  it('rejects a cursor after native revisions or enrolled project scope changes', async () => {
    const documents = [draft('a', '/alpha'), draft('b', '/alpha')];
    const first = await pageNativeDirtyDocuments(
      { project: 'Alpha', operation: { kind: 'list-dirty', limit: 1 } },
      { projects, documents }
    );
    await expect(
      pageNativeDirtyDocuments(
        { project: 'Alpha', operation: { kind: 'list-dirty', cursor: first.nextCursor! } },
        { projects, documents: [{ ...documents[0], revision: 'newer' }, documents[1]] }
      )
    ).rejects.toThrow('SCOPE_CHANGED');
    await expect(
      pageNativeDirtyDocuments(
        { project: 'Alpha', operation: { kind: 'list-dirty', cursor: first.nextCursor! } },
        { projects: projects.slice(0, 1), documents }
      )
    ).rejects.toThrow('SCOPE_CHANGED');
  });
  it('uses an exact enrolled project rather than a caller-selected arbitrary path', async () => {
    const documents = [draft('a', '/alpha'), draft('b', '/beta')];
    expect(
      (
        await pageNativeDirtyDocuments(
          { project: 'Beta', operation: { kind: 'list-dirty' } },
          { projects, documents }
        )
      ).documents.map((item) => item.documentId)
    ).toEqual(['b']);
    await expect(
      pageNativeDirtyDocuments(
        { project: '/outside', operation: { kind: 'list-dirty' } },
        { projects, documents }
      )
    ).rejects.toThrow('PROJECT_UNAVAILABLE');
  });
});
