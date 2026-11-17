import { describe, expect, it } from 'vitest';
import {
  notebookTableData,
  notebookTableReference,
  richTableReference,
  tableDocumentKey,
  tableDocumentReferenceFromKey,
} from './table-document-reference';

describe('table document identity', () => {
  it('keeps portable table identity independent of profile and path hints', () => {
    const project = 'e03fc253-14f2-4d66-985d-558358a0c223';
    const table = '8b42f5f1-635e-4cda-a07b-8fc2531fc97e';
    const first = richTableReference(
      project,
      table,
      { kind: 'current' },
      { fileDocumentId: 'old-profile-file', pathHint: 'old/Samples' }
    );
    const moved = richTableReference(
      project,
      table,
      { kind: 'current' },
      { fileDocumentId: 'new-profile-file', pathHint: 'renamed/Samples' }
    );
    const bare = richTableReference(project, table);
    expect(tableDocumentKey(first)).toBe(tableDocumentKey(moved));
    expect(tableDocumentReferenceFromKey(tableDocumentKey(first))).toEqual(bare);
    expect(tableDocumentKey(bare)).not.toBe(
      tableDocumentKey(richTableReference('923e35de-7ecb-4613-9f85-530f271353c8', table))
    );
  });

  it('keeps a pinned saved version distinct and rejects mismatched digest or table ownership', () => {
    const project = 'e03fc253-14f2-4d66-985d-558358a0c223';
    const table = '8b42f5f1-635e-4cda-a07b-8fc2531fc97e';
    const digest = 'a'.repeat(64);
    const pin = richTableReference(project, table, {
      kind: 'saved-version',
      savedVersionId: digest,
      sha256: `sha256:${digest}`,
    });
    expect(tableDocumentReferenceFromKey(tableDocumentKey(pin))).toEqual(pin);
    expect(tableDocumentKey(pin)).not.toBe(tableDocumentKey(richTableReference(project, table)));
    expect(() =>
      richTableReference(project, table, {
        kind: 'saved-version',
        savedVersionId: digest,
        sha256: `sha256:${'b'.repeat(64)}`,
      })
    ).toThrow();
    expect(() =>
      tableDocumentKey({ ...pin, documentId: '923e35de-7ecb-4613-9f85-530f271353c8' })
    ).toThrow();
  });

  it('keeps equal legacy block identities in separate notebooks distinct', () => {
    const first = notebookTableReference('project-one/notebook', 'copied-block');
    const second = notebookTableReference('project-two/notebook', 'copied-block');
    expect(first.documentId).not.toBe(second.documentId);
    expect(tableDocumentKey(first)).not.toBe(tableDocumentKey(second));
    expect(tableDocumentReferenceFromKey(tableDocumentKey(first))).toEqual(first);
    expect(tableDocumentReferenceFromKey(tableDocumentKey(second))).toEqual(second);
  });

  it('round trips opaque identities without delimiter collisions', () => {
    const refs = [
      notebookTableReference('a:b', 'c'),
      notebookTableReference('a', 'b:c'),
      notebookTableReference('样本 notebook/%?', 'block/one:#%'),
    ];
    expect(new Set(refs.map(tableDocumentKey)).size).toBe(refs.length);
    for (const ref of refs)
      expect(tableDocumentReferenceFromKey(tableDocumentKey(ref))).toEqual(ref);
    expect(tableDocumentReferenceFromKey('notebook-table:%:broken')).toBeNull();
    expect(tableDocumentReferenceFromKey('unscoped-legacy-id')).toBeNull();
  });

  it('refuses a target whose document identity names a different notebook', () => {
    const ref = notebookTableReference('notebook-one', 'block');
    expect(() =>
      tableDocumentKey({
        ...ref,
        backing: { kind: 'notebook-inline', notebookDocumentId: 'notebook-two', blockId: 'block' },
      })
    ).toThrow();
  });

  it('preserves a future table payload and refuses editing it as the current format', () => {
    const source = {
      type: 'doc',
      content: [
        {
          type: 'embed',
          attrs: {
            type: 'table',
            version: 999,
            refId: 'future',
            data: { cells: { opaque: ['keep', 1] } },
          },
        },
      ],
    };
    const original = structuredClone(source);
    expect(() => notebookTableData(source, 'future')).toThrow(/unsupported/);
    expect(source).toEqual(original);
  });
});
