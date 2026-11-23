import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { parseNotebookMarkdown, serializeNotebookMarkdown } from '../db/notebook-markdown-codec';
import {
  extractNotebookReferenceOccurrences,
  inspectNotebookReferenceOccurrences,
  normalizeNotebookReferenceOccurrences,
} from './notebook-reference-occurrences';

const target = 'project-b::same-local-id';
const uri = 'dnaforge-chat://reference/30000000-0000-4000-8000-000000000001';
const mention = (occurrenceId?: string): JSONContent => ({
  type: 'mention',
  attrs: {
    id: target,
    entityId: target,
    entityType: 'sequence',
    label: 'Repeated target',
    ...(occurrenceId ? { occurrenceId } : {}),
  },
});
const doc = (...children: JSONContent[]): JSONContent => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: children }],
});

describe('canonical notebook reference occurrences', () => {
  it('assigns separate deterministic legacy identities without changing target identities or input', () => {
    const original = doc(mention(), { type: 'text', text: ' and ' }, mention());
    const before = structuredClone(original);
    const one = normalizeNotebookReferenceOccurrences(original, { documentId: 'notebook-a' });
    const two = normalizeNotebookReferenceOccurrences(original, { documentId: 'notebook-a' });
    const other = normalizeNotebookReferenceOccurrences(original, { documentId: 'notebook-b' });
    const rows = extractNotebookReferenceOccurrences(one);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.occurrenceId)).size).toBe(2);
    expect(rows.every((row) => row.targetEntityId === target)).toBe(true);
    expect(one).toEqual(two);
    expect(extractNotebookReferenceOccurrences(other).map((row) => row.occurrenceId)).not.toEqual(
      rows.map((row) => row.occurrenceId)
    );
    expect(original).toEqual(before);
  });

  it('preserves occurrence identity through unrelated edits, reorder and retarget', () => {
    const a = mention('10000000-0000-4000-8000-000000000001');
    const b = mention('10000000-0000-4000-8000-000000000002');
    b.attrs = { ...b.attrs, entityId: 'new-target', id: 'new-target' };
    const changed = normalizeNotebookReferenceOccurrences(
      doc(b, { type: 'text', text: 'new' }, a),
      {
        documentId: 'notebook-a',
      }
    );
    expect(
      extractNotebookReferenceOccurrences(changed).map((row) => [
        row.occurrenceId,
        row.targetEntityId,
      ])
    ).toEqual([
      [b.attrs.occurrenceId, 'new-target'],
      [a.attrs?.occurrenceId, target],
    ]);
  });

  it('gives copied mentions fresh occurrences while preserving their exact targets', () => {
    const original = doc(mention('10000000-0000-4000-8000-000000000001'));
    const copy = normalizeNotebookReferenceOccurrences(original, {
      documentId: 'notebook-a',
      reassign: true,
      createId: () => '20000000-0000-4000-8000-000000000001',
    });
    expect(extractNotebookReferenceOccurrences(copy)).toEqual([
      expect.objectContaining({
        occurrenceId: '20000000-0000-4000-8000-000000000001',
        targetEntityId: target,
      }),
    ]);
    expect(original.content?.[0].content?.[0].attrs?.occurrenceId).toBe(
      '10000000-0000-4000-8000-000000000001'
    );
  });

  it('reports unmigrated coverage without rewriting the source', () => {
    const original = doc(mention(), mention('10000000-0000-4000-8000-000000000001'));
    const before = structuredClone(original);
    const inspected = inspectNotebookReferenceOccurrences(original);
    expect(inspected.missingOccurrenceCount).toBe(1);
    expect(inspected.occurrences).toHaveLength(1);
    expect(original).toEqual(before);
  });

  it('rejects duplicate explicit identities and repairs them only through the write normalizer', () => {
    const original = doc(
      mention('10000000-0000-4000-8000-000000000001'),
      mention('10000000-0000-4000-8000-000000000001')
    );
    expect(() => extractNotebookReferenceOccurrences(original)).toThrow();
    const rows = extractNotebookReferenceOccurrences(
      normalizeNotebookReferenceOccurrences(original, { documentId: 'notebook-a' })
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.occurrenceId)).size).toBe(2);
    expect(rows[0].occurrenceId).toBe('10000000-0000-4000-8000-000000000001');
  });

  it('follows declared inline table cell content but ignores arbitrary attribute lookalikes', () => {
    const saved: JSONContent = {
      type: 'mention',
      attrs: {
        entityType: 'reference',
        label: 'Saved range',
        referenceUri: uri,
        occurrenceId: '10000000-0000-4000-8000-000000000003',
      },
    };
    const input: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [mention('10000000-0000-4000-8000-000000000001')],
          attrs: { opaque: mention('10000000-0000-4000-8000-000000000099') },
        },
        {
          type: 'embed',
          attrs: {
            type: 'table',
            refId: 'inline-table',
            data: {
              cells: [[{ value: 'Saved range', type: 'text', content: [saved] }]],
              arbitrary: mention('10000000-0000-4000-8000-000000000098'),
            },
          },
        },
        {
          type: 'embed',
          attrs: {
            type: 'image',
            data: { content: [mention('10000000-0000-4000-8000-000000000097')] },
          },
        },
      ],
    };
    const rows = extractNotebookReferenceOccurrences(input);
    expect(rows.map((row) => row.occurrenceId)).toEqual([
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000003',
    ]);
    expect(rows[1]).toMatchObject({ targetKind: 'saved-reference', targetReference: uri });
  });

  it('round-trips occurrence identities and repeated targets through the real file codec', () => {
    const content = normalizeNotebookReferenceOccurrences(doc(mention(), mention()), {
      documentId: 'notebook-a',
    });
    const serialized = serializeNotebookMarkdown({
      identity: { id: 'notebook-a', title: 'Reference round trip', formatVersion: 2 },
      content,
    });
    const parsed = parseNotebookMarkdown({
      markdown: serialized.markdown,
      payloads: new Map(
        serialized.payloads.map((payload) => [payload.relativePath, payload.content])
      ),
    });
    expect(parsed.content).toEqual(content);
    expect(extractNotebookReferenceOccurrences(parsed.content)).toEqual(
      extractNotebookReferenceOccurrences(content)
    );
  });

  it('records inline native cell links while preserving their original reference shape', () => {
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'embed',
          attrs: {
            type: 'table',
            refId: 'inline-table',
            data: {
              cells: [
                [
                  {
                    value: 'First',
                    type: 'text',
                    reference: {
                      kind: 'native-entity',
                      entityId: target,
                      providerMetadata: { keep: true },
                    },
                  },
                  {
                    value: 'Second',
                    type: 'text',
                    reference: { kind: 'native-entity', entityId: target },
                  },
                  {
                    value: 'External',
                    type: 'text',
                    reference: { kind: 'external-url', href: 'https://example.com' },
                  },
                ],
              ],
            },
          },
        },
      ],
    };
    const before = structuredClone(content);
    expect(inspectNotebookReferenceOccurrences(content).missingOccurrenceCount).toBe(2);
    const normalized = normalizeNotebookReferenceOccurrences(content, { documentId: 'notebook-a' });
    const rows = extractNotebookReferenceOccurrences(normalized);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.occurrenceId)).size).toBe(2);
    expect(rows.every((row) => row.targetEntityId === target && row.targetKind === 'entity')).toBe(
      true
    );
    const cells = normalized.content![0].attrs!.data.cells;
    expect(cells[0][0].reference).toMatchObject({
      kind: 'native-entity',
      entityId: target,
      providerMetadata: { keep: true },
      occurrenceId: rows[0].occurrenceId,
    });
    expect(cells[0][2].reference).toEqual({ kind: 'external-url', href: 'https://example.com' });
    expect(content).toEqual(before);
    const serialized = serializeNotebookMarkdown({
      identity: { id: 'notebook-a', title: 'Inline cell targets', formatVersion: 2 },
      content: normalized,
    });
    expect(
      parseNotebookMarkdown({
        markdown: serialized.markdown,
        payloads: new Map(serialized.payloads.map((p) => [p.relativePath, p.content])),
      }).content
    ).toEqual(normalized);
  });
});
