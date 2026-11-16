// @vitest-environment node

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseTablePackageHead,
  serializeTablePackageHead,
  parseTableSnapshot,
  serializeTableSnapshot,
  tableSnapshotSha256,
  tableSnapshotForHead,
  verifyTablePackageRead,
  tablePackagePaths,
  tablePackageRevisionPath,
  tablePackageHeadWithData,
} from './table-package';
import { notebookTableReference } from './table-document-reference';

const documentId = '8b42f5f1-635e-4cda-a07b-8fc2531fc97e';
const projectId = 'e03fc253-14f2-4d66-985d-558358a0c223';
const notebookId = '2f3d0be3-efc5-41f5-b083-c9187ce25b45';

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, ordered(entry)])
    );
  return value;
}
const bytes = (value: unknown) => `${JSON.stringify(ordered(value))}\n`;
const digest = (value: unknown) => createHash('sha256').update(bytes(value), 'utf8').digest('hex');

function fixture() {
  const snapshot = {
    schema: 'dnaforge.table-snapshot.v1',
    documentId,
    title: 'Referenceable samples',
    data: {
      rows: 2,
      cols: 2,
      cells: [
        [
          {
            value: 'sample-42',
            type: 'text',
            reference: { kind: 'native-entity', entityId: 'sample-42' },
            opaqueCell: { keep: ['exact', 42] },
          },
          { value: '=2+3', type: 'formula', computed: 5, format: { bold: true } },
        ],
        [
          { value: '', type: 'text' },
          { value: '尾部', type: 'text' },
        ],
      ],
      opaqueTable: { keep: true },
    },
    optionalExtension: { preserve: ['not reconstructed from cell values'] },
  };
  const head = {
    schema: 'dnaforge.table.v1',
    id: documentId,
    snapshotSha256: digest(snapshot),
    snapshot,
    aliases: [
      {
        kind: 'notebook-inline',
        projectId,
        notebookId,
        blockId: 'old-block',
        legacyReference: notebookTableReference(`ws42::${notebookId}`, 'old-block'),
      },
    ],
    status: 'active',
    optionalHeadMetadata: { retain: [1, 2, 3] },
  };
  return { snapshot, head, snapshotText: bytes(snapshot), headText: bytes(head) };
}

describe('portable table package codec', () => {
  it('preserves cells, formulas, links and all optional JSON metadata without assigning identities', () => {
    const f = fixture();
    const original = structuredClone(f);
    expect(parseTableSnapshot(f.snapshotText)).toEqual(f.snapshot);
    expect(parseTablePackageHead(f.headText)).toEqual(f.head);
    expect(serializeTableSnapshot(parseTableSnapshot(f.snapshotText))).toBe(f.snapshotText);
    expect(serializeTablePackageHead(parseTablePackageHead(f.headText))).toBe(f.headText);
    expect(tableSnapshotForHead(parseTablePackageHead(f.headText))).toEqual(f.snapshot);
    expect(f).toEqual(original);
  });

  it('hashes the exact canonical UTF8 snapshot including its final newline', async () => {
    const f = fixture();
    expect(await tableSnapshotSha256(parseTableSnapshot(f.snapshotText))).toBe(digest(f.snapshot));
    expect(f.head.snapshotSha256).not.toBe(
      createHash('sha256').update(f.snapshotText.trimEnd()).digest('hex')
    );
    expect(serializeTableSnapshot(parseTableSnapshot(f.snapshotText))).toBe(bytes(f.snapshot));
  });

  it('updates content without dropping head, snapshot or cell metadata or altering the previous version', () => {
    const f = fixture();
    const before = structuredClone(f);
    const data = structuredClone(parseTableSnapshot(f.snapshotText).data);
    data.cells![1][0].value = 'new value';
    const next = tablePackageHeadWithData(parseTablePackageHead(f.headText), data);
    expect(next.id).toBe(documentId);
    expect(next.snapshot.data).toEqual(data);
    expect(next.snapshot.optionalExtension).toEqual(f.snapshot.optionalExtension);
    expect(next.optionalHeadMetadata).toEqual(f.head.optionalHeadMetadata);
    expect(next.aliases).toEqual(f.head.aliases);
    expect(next.snapshotSha256).toBe(digest(next.snapshot));
    expect(next.snapshotSha256).not.toBe(f.head.snapshotSha256);
    expect(f).toEqual(before);
  });

  it('verifies the current snapshot owner, complete payload and expected saved revision together', async () => {
    const f = fixture();
    const result = await verifyTablePackageRead({
      headText: f.headText,
      snapshotText: f.snapshotText,
      expectedDocumentId: documentId,
      expectedSnapshotSha256: f.head.snapshotSha256,
    });
    expect(result.head).toEqual(f.head);
    expect(result.snapshot).toEqual(f.snapshot);
  });

  it('refuses a different document even when its table cell values are identical', async () => {
    const f = fixture();
    await expect(
      verifyTablePackageRead({
        headText: f.headText,
        snapshotText: f.snapshotText,
        expectedDocumentId: '923e35de-7ecb-4613-9f85-530f271353c8',
      })
    ).rejects.toThrow();
    const other = { ...f.snapshot, documentId: '923e35de-7ecb-4613-9f85-530f271353c8' };
    await expect(
      verifyTablePackageRead({ headText: f.headText, snapshotText: bytes(other) })
    ).rejects.toThrow();
  });

  it('refuses a stale expected saved version and noncanonical or tampered snapshot bytes', async () => {
    const f = fixture();
    await expect(
      verifyTablePackageRead({
        headText: f.headText,
        snapshotText: f.snapshotText,
        expectedSnapshotSha256: '0'.repeat(64),
      })
    ).rejects.toThrow();
    await expect(
      verifyTablePackageRead({ headText: f.headText, snapshotText: ` ${f.snapshotText}` })
    ).rejects.toThrow();
    await expect(
      verifyTablePackageRead({
        headText: f.headText,
        snapshotText: f.snapshotText.replace('sample-42', 'tampered'),
      })
    ).rejects.toThrow();
  });

  it('refuses disagreement between the complete atomic head and immutable snapshot', async () => {
    const f = fixture();
    const changedHead = {
      ...f.head,
      snapshot: { ...f.snapshot, optionalExtension: { preserve: ['different'] } },
    };
    await expect(
      verifyTablePackageRead({ headText: bytes(changedHead), snapshotText: f.snapshotText })
    ).rejects.toThrow();
    expect(f.head.snapshot.optionalExtension.preserve).toEqual([
      'not reconstructed from cell values',
    ]);
  });

  it('rejects unsupported schemas and malformed owners instead of making an empty writable table', () => {
    const f = fixture();
    expect(() =>
      parseTablePackageHead(bytes({ ...f.head, schema: 'dnaforge.table.v999' }))
    ).toThrow();
    expect(() =>
      parseTableSnapshot(bytes({ ...f.snapshot, schema: 'dnaforge.table-snapshot.v999' }))
    ).toThrow();
    expect(() => parseTablePackageHead(bytes({ ...f.head, id: '../not-a-document' }))).toThrow();
    expect(() => parseTableSnapshot(bytes({ ...f.snapshot, documentId: 'ws42' }))).toThrow();
    expect(() => parseTableSnapshot('')).toThrow();
  });

  it('requires explicit dimensions and cells while allowing an intentionally empty configured table', () => {
    const f = fixture();
    expect(() => parseTableSnapshot(bytes({ ...f.snapshot, data: {} }))).toThrow();
    expect(() =>
      parseTableSnapshot(bytes({ ...f.snapshot, data: { rows: 2, cols: 2 } }))
    ).toThrow();
    const configured = { ...f.snapshot, data: { rows: 2, cols: 2, cells: [] } };
    expect(parseTableSnapshot(bytes(configured))).toEqual(configured);
  });

  it('retains legacy aliases exactly and requires durable project identity', () => {
    const f = fixture();
    expect(parseTablePackageHead(f.headText).aliases).toEqual(f.head.aliases);
    expect(() =>
      parseTablePackageHead(
        bytes({ ...f.head, aliases: [{ ...f.head.aliases[0], projectId: 'ws42' }] })
      )
    ).toThrow();
  });

  it('refuses an alias that names a different notebook from its retained original reference', () => {
    const f = fixture();
    const mismatched = {
      ...f.head,
      aliases: [{ ...f.head.aliases[0], notebookId: 'different-notebook' }],
    };
    expect(() => parseTablePackageHead(bytes(mismatched))).toThrow();
    expect(f.head.aliases[0].notebookId).toBe(notebookId);
  });

  it('requires a durable promotion identity for a pending destination', () => {
    const f = fixture();
    expect(() =>
      parseTablePackageHead(bytes({ ...f.head, status: 'pending-promotion' }))
    ).toThrow();
    const pending = {
      ...f.head,
      status: 'pending-promotion',
      promotionId: 'bedee0ae-ffde-4be5-b7c9-1ac345b63f10',
    };
    expect(parseTablePackageHead(bytes(pending))).toEqual(pending);
  });

  it('refuses nonfinite data and bounds serialized input by UTF8 bytes', () => {
    const f = fixture();
    expect(() =>
      serializeTableSnapshot({
        ...parseTableSnapshot(f.snapshotText),
        invalidExtension: Number.NaN,
      })
    ).toThrow();
    const oversized = bytes({ ...f.snapshot, extra: '界'.repeat(7 * 1024 * 1024) });
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(20 * 1024 * 1024);
    expect(() => parseTableSnapshot(oversized)).toThrow();
  });

  it('keeps snapshot paths inside the package and rejects digest traversal', () => {
    const f = fixture();
    expect(tablePackagePaths('/project/Samples').headPath).toBe(
      '/project/Samples/.forge/table.json'
    );
    expect(tablePackageRevisionPath('/project/Samples', f.head.snapshotSha256)).toBe(
      `/project/Samples/.forge/table-revisions/${f.head.snapshotSha256}.json`
    );
    for (const value of [
      '../escape',
      'F'.repeat(64),
      'sha256:' + f.head.snapshotSha256,
      'a'.repeat(63),
    ])
      expect(() => tablePackageRevisionPath('/project/Samples', value)).toThrow();
  });
});
