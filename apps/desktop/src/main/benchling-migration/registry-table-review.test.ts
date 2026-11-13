import { describe, expect, it } from 'vitest';
import { buildSyntheticNativeExportZip } from './__fixtures__/native-export-zip-fixture';
import { inspectNativeExportArchive } from './native-export-archive';
import { readReviewedRegistryTableRows, surveyRegistryTableReviews } from './registry-table-review';
import { parseRegistryDelimitedTable } from './registry-table-input';
import type {
  RegistryTableColumnChoice,
  RegistryTableMappingDecision,
} from '../../shared/benchling-registry-table-review';
import { isExactProviderStableId } from '../../shared/provider-object-reference';
import { nativeRegistryRecordInput } from './native-registry-record';
import { scientificSourceObjectSha256 } from './linked-item-recovery-decoder';
import {
  reviewedTableSourceRef,
  assertReviewedTableArchiveSelection,
} from './reviewed-table-source';

async function archive(text = 'Name,Amount,Amount,\nSame name,0,12.5,α\nSame name,1,2,β\n') {
  const fixture = buildSyntheticNativeExportZip([
    { path: 'Registry/Records.csv', bytes: text, compression: 'stored' },
  ]);
  return inspectNativeExportArchive({
    kind: 'bytes',
    logicalFilename: 'records.zip',
    bytes: fixture.bytes,
    expectedSha256: fixture.sha256,
    expectedSizeBytes: fixture.sizeBytes,
  });
}
async function mapped(
  input: Awaited<ReturnType<typeof archive>>,
  columns: readonly RegistryTableColumnChoice[] = [
    { kind: 'name' },
    { kind: 'field', label: 'Amount', type: 'number' },
    { kind: 'field', label: 'Raw amount', type: 'text' },
    { kind: 'source_only', reason: 'Keep original note' },
  ]
): Promise<RegistryTableMappingDecision> {
  const candidate = (await surveyRegistryTableReviews(input))[0];
  if (candidate.status !== 'ready') throw new Error('Expected readable fixture.');
  const { archiveSha256, entryPath, entrySha256, entrySizeBytes } = candidate;
  return {
    kind: 'registry_table_mapping',
    version: 1,
    source: { archiveSha256, entryPath, entrySha256, entrySizeBytes },
    outcome: {
      kind: 'records',
      headersSha256: candidate.headersSha256,
      rowCount: candidate.rowCount,
      columns,
    },
  };
}

describe('reviewed registry table intake', () => {
  it('rejects choices for an unselected ZIP while accepting several selected archives', async () => {
    const input = await archive();
    const decision = await mapped(input);
    expect(() =>
      assertReviewedTableArchiveSelection([decision], [`sha256:${'f'.repeat(64)}`])
    ).toThrow(/selected ZIP/i);
    expect(() =>
      assertReviewedTableArchiveSelection([decision], [input.sha256, `sha256:${'f'.repeat(64)}`])
    ).not.toThrow();
  });
  it('keeps acquisition choices out of scientific equality while retaining typed field changes', async () => {
    const input = await archive();
    const decision = await mapped(input);
    const first = await readReviewedRegistryTableRows({
      archive: input,
      decisions: [decision],
      actionId: 'first',
    });
    const again = await readReviewedRegistryTableRows({
      archive: input,
      decisions: [decision],
      actionId: 'second',
    });
    expect(first.map((row) => scientificSourceObjectSha256(row.sourceObject))).toEqual(
      again.map((row) => scientificSourceObjectSha256(row.sourceObject))
    );
    const changed = await readReviewedRegistryTableRows({
      archive: input,
      decisions: [
        await mapped(input, [
          { kind: 'name' },
          { kind: 'field', label: 'Amount', type: 'text' },
          { kind: 'field', label: 'Raw amount', type: 'text' },
          { kind: 'source_only', reason: 'Keep original note' },
        ]),
      ],
      actionId: 'third',
    });
    expect(scientificSourceObjectSha256(first[0].sourceObject)).not.toBe(
      scientificSourceObjectSha256(changed[0].sourceObject)
    );
  });

  it('normalizes an explicitly selected padded provider ID while preserving the original cell', async () => {
    const input = await archive('Name,ID\nRecord, bfi_EXPLICIT01 \n');
    const rows = await readReviewedRegistryTableRows({
      archive: input,
      decisions: [await mapped(input, [{ kind: 'name' }, { kind: 'provider_id' }])],
      actionId: 'padded',
    });
    expect(rows[0].sourceObject.stableId).toBe('bfi_EXPLICIT01');
    expect(() => reviewedTableSourceRef(rows[0].sourceObject)).not.toThrow();
    expect(rows[0].sourceObject.content).toMatchObject({
      originalRow: { cells: ['Record', ' bfi_EXPLICIT01 '] },
    });
  });
  it('lets an oversized unrelated table remain source-only with a full verified digest', async () => {
    const input = await archive(`Name,Note\nLarge,${'x'.repeat(16 * 1024 * 1024)}\n`);
    const [candidate] = await surveyRegistryTableReviews(input);
    expect(candidate).toMatchObject({
      status: 'unavailable',
      entrySizeBytes: 16 * 1024 * 1024 + 17,
    });
    const { archiveSha256, entryPath, entrySha256, entrySizeBytes } = candidate;
    expect(
      await readReviewedRegistryTableRows({
        archive: input,
        actionId: 'source-only',
        decisions: [
          {
            kind: 'registry_table_mapping',
            version: 1,
            source: { archiveSha256, entryPath, entrySha256, entrySizeBytes },
            outcome: { kind: 'source_only', reason: 'Keep original large table' },
          },
        ],
      })
    ).toEqual([]);
  });
  it('materializes a reviewed Name-only record without inventing a custom field', async () => {
    const input = await archive('Name\nOnly a name\n');
    const rows = await readReviewedRegistryTableRows({
      archive: input,
      decisions: [await mapped(input, [{ kind: 'name' }])],
      actionId: 'name-only',
    });
    const native = nativeRegistryRecordInput({
      source: rows[0].sourceObject,
      scopeId: 'local-table',
      createdAt: 1,
      resolveTarget: () => null,
    });
    expect(native).toMatchObject({
      name: 'Only a name',
      fields: {},
      schemaSnapshot: { fields: [] },
      registrationStatus: 'registered',
    });
  });
  it('keeps explicitly empty rows and duplicate or empty headers by ordinal', () => {
    expect(parseRegistryDelimitedTable('Name,,Name\n,,\n"",,""\n', ',')).toEqual({
      headers: ['Name', '', 'Name'],
      rows: [
        ['', '', ''],
        ['', '', ''],
      ],
    });
  });
  it('imports two same-name local rows with explicit types and all source cells preserved', async () => {
    const input = await archive();
    const decision = await mapped(input);
    const rows = await readReviewedRegistryTableRows({
      archive: input,
      decisions: [decision],
      actionId: 'import-1',
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.sourceObject.id)).size).toBe(2);
    for (const row of rows) {
      expect(isExactProviderStableId(row.sourceObject.stableId)).toBe(false);
      expect(row.sourceObject.name).toBe('Same name');
    }
    expect(rows[0].sourceObject.metadata.benchlingRegistry).toMatchObject({
      inputAuthority: 'reviewed_local_table',
      fieldValues: { column_2: 0, column_3: '12.5' },
      reviewedTable: {
        actionId: 'import-1',
        rowOrdinal: 1,
        headers: ['Name', 'Amount', 'Amount', ''],
        cells: ['Same name', '0', '12.5', 'α'],
        decision,
      },
    });
  });
  it('does not change local row identities when field labels or action IDs change', async () => {
    const input = await archive();
    const first = await mapped(input);
    const second = await mapped(input, [
      { kind: 'name' },
      { kind: 'field', label: 'New label', type: 'text' },
      { kind: 'source_only', reason: 'Keep' },
      { kind: 'source_only', reason: 'Keep' },
    ]);
    const a = await readReviewedRegistryTableRows({
      archive: input,
      decisions: [first],
      actionId: 'first',
    });
    const b = await readReviewedRegistryTableRows({
      archive: input,
      decisions: [second],
      actionId: 'second',
    });
    expect(a.map((row) => row.sourceObject.id)).toEqual(b.map((row) => row.sourceObject.id));
  });
  it('requires a decision for each table instead of silently skipping it', async () => {
    await expect(
      readReviewedRegistryTableRows({
        archive: await archive(),
        decisions: [],
        actionId: 'import-1',
      })
    ).rejects.toThrow(/review/i);
  });
  it('keeps a deliberately source-only table out of native records', async () => {
    const input = await archive();
    const decision = await mapped(input);
    expect(
      await readReviewedRegistryTableRows({
        archive: input,
        decisions: [{ ...decision, outcome: { kind: 'source_only', reason: 'Not a record list' } }],
        actionId: 'import-1',
      })
    ).toEqual([]);
  });
  it('rejects an answer bound to an older ZIP even when the row labels match', async () => {
    const input = await archive();
    const changed = await archive('Name,Amount,Amount,\nSame name,99,12.5,α\nSame name,1,2,β\n');
    await expect(
      readReviewedRegistryTableRows({
        archive: changed,
        decisions: [await mapped(input)],
        actionId: 'import-1',
      })
    ).rejects.toThrow(/changed|match/i);
  });
  it('uses provider identity only from an explicitly selected valid Benchling ID column', async () => {
    const input = await archive('Name,ID\nLocal record,bfi_EXPLICIT01\n');
    const asText = await mapped(input, [
      { kind: 'name' },
      { kind: 'field', label: 'ID', type: 'text' },
    ]);
    const asId = await mapped(input, [{ kind: 'name' }, { kind: 'provider_id' }]);
    const local = await readReviewedRegistryTableRows({
      archive: input,
      decisions: [asText],
      actionId: 'local',
    });
    const provider = await readReviewedRegistryTableRows({
      archive: input,
      decisions: [asId],
      actionId: 'provider',
    });
    expect(isExactProviderStableId(local[0].sourceObject.stableId)).toBe(false);
    expect(provider[0].sourceObject.stableId).toBe('bfi_EXPLICIT01');
  });
});
