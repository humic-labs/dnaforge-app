import { describe, expect, it } from 'vitest';

import {
  buildSyntheticNativeExportZip,
  type SyntheticZipEntry,
} from './__fixtures__/native-export-zip-fixture';
import {
  SYNTHETIC_EMPTY_DNA_ID,
  SYNTHETIC_INVALID_STRAIN_TEXT,
  SYNTHETIC_STRAIN_A_ID,
  SYNTHETIC_STRAIN_B_ID,
  SYNTHETIC_STRAIN_TEXT,
  SYNTHETIC_STRAIN_TEXT_SIBLING,
  SYNTHETIC_UNKNOWN_ID,
  SYNTHETIC_ZERO_BASE_GENBANK,
} from './__fixtures__/native-record-fixtures';
import { decodeBenchlingNativeExport } from './native-export-decoder';

describe('Benchling native record classification', () => {
  it('classifies registry text records in arbitrary exported folders as native strains without using display name as identity', async () => {
    const decoded = await decodeEntries([
      {
        path: 'screening assemblies/Shared synthetic strain (' + SYNTHETIC_STRAIN_A_ID + ').txt',
        bytes: SYNTHETIC_STRAIN_TEXT,
      },
      {
        path: 'Registry/Shared synthetic strain (' + SYNTHETIC_STRAIN_B_ID + ').txt',
        bytes: SYNTHETIC_STRAIN_TEXT_SIBLING,
      },
    ]);

    const first = decoded.sourceObjects.find(({ stableId }) => stableId === SYNTHETIC_STRAIN_A_ID);
    const second = decoded.sourceObjects.find(({ stableId }) => stableId === SYNTHETIC_STRAIN_B_ID);

    expect(first).toMatchObject({
      id: SYNTHETIC_STRAIN_A_ID,
      stableId: SYNTHETIC_STRAIN_A_ID,
      sourceType: 'strain',
      name: 'Shared synthetic strain',
      content: {
        kind: 'benchling_strain',
        displayName: 'Shared synthetic strain',
        fields: [
          { label: 'Genotype', value: 'deltaX', position: 0 },
          { label: 'Tag', value: 'first', position: 1 },
          { label: 'Tag', value: 'second', position: 2 },
          { label: 'Blank', value: '', position: 3 },
        ],
      },
    });
    expect(second).toMatchObject({
      id: SYNTHETIC_STRAIN_B_ID,
      stableId: SYNTHETIC_STRAIN_B_ID,
      sourceType: 'strain',
      name: 'Shared synthetic strain',
    });
    expect(first?.stableId).not.toBe(second?.stableId);
  });

  it('classifies zero-base GenBank as native DNA that needs sequence without inventing metadata', async () => {
    const decoded = await decodeEntries([
      {
        path: 'Registry/Empty DNA (' + SYNTHETIC_EMPTY_DNA_ID + ').gb',
        bytes: SYNTHETIC_ZERO_BASE_GENBANK,
      },
    ]);

    expect(decoded.sourceObjects).toHaveLength(1);
    expect(decoded.sourceObjects[0]).toMatchObject({
      id: SYNTHETIC_EMPTY_DNA_ID,
      stableId: SYNTHETIC_EMPTY_DNA_ID,
      sourceType: 'dna_sequence',
      content: {
        kind: 'dna_sequence_needs_sequence',
        moleculeType: 'DNA',
        bases: '',
        annotations: [],
        genbankMetadata: {
          definition: 'Synthetic unresolved DNA.',
          keywords: [],
          comments: ['Synthetic comment only.'],
        },
      },
    });
  });

  it('does not discard a feature body from zero-base GenBank', async () => {
    const decoded = await decodeEntries([
      {
        path: 'Registry/Empty DNA (' + SYNTHETIC_EMPTY_DNA_ID + ').gb',
        bytes: SYNTHETIC_ZERO_BASE_GENBANK.replace(
          'ORIGIN',
          '     misc_feature    1..1\n                     /label="Unexpected feature"\nORIGIN'
        ),
      },
    ]);

    expect(decoded.sourceObjects[0]).toMatchObject({
      stableId: SYNTHETIC_EMPTY_DNA_ID,
      sourceType: 'unsupported_object',
    });
  });

  it('fails closed for a bfi text file outside the verified strain grammar', async () => {
    const decoded = await decodeEntries([
      {
        path: 'Registry/Unknown (' + SYNTHETIC_UNKNOWN_ID + ').txt',
        bytes: SYNTHETIC_INVALID_STRAIN_TEXT,
      },
    ]);

    expect(decoded.sourceObjects[0]).toMatchObject({
      stableId: SYNTHETIC_UNKNOWN_ID,
      sourceType: 'unsupported_object',
    });
  });
});

async function decodeEntries(entries: readonly SyntheticZipEntry[]) {
  const fixture = buildSyntheticNativeExportZip(entries);
  return decodeBenchlingNativeExport({
    source: {
      kind: 'bytes',
      logicalFilename: 'native-records.zip',
      bytes: fixture.bytes,
      expectedSha256: fixture.sha256,
      expectedSizeBytes: fixture.sizeBytes,
      duplicateSupportEntryPolicy: 'identical_root_benchling_css',
    },
    controlMetadata: { source: 'none' },
    context: {
      snapshotId: 'native-record-classifier',
      capturedAt: '2026-08-26T00:00:00.000Z',
      archivePartId: 'local-export:native-record-classifier',
      sourceUrlPrefix: null,
      localBundleAuthority: {
        schema: 'dnaforge.benchling.local-native-export-authority.v1',
        logicalFilename: 'native-records.zip',
        sha256: fixture.sha256,
      },
    },
  });
}
