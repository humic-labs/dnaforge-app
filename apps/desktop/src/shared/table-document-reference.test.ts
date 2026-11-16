import { describe, expect, it } from 'vitest';
import {
  notebookTableData,
  notebookTableReference,
  tableDocumentKey,
  tableDocumentReferenceFromKey,
} from './table-document-reference';

describe('table document identity', () => {
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
