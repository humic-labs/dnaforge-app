import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  SourceObject,
  ValidationLinkedItemRecoveryTargetEvidence,
} from '../../shared/benchling-migration';
import {
  buildSyntheticNativeExportZip,
  type SyntheticZipFixture,
} from './__fixtures__/native-export-zip-fixture';
import { ContentArchive } from './content-archive';
import {
  decodeLinkedItemRecoveryExport,
  scientificSourceObjectSha256,
} from './linked-item-recovery-decoder';
import type { VerifiedLocalBenchlingZipExport } from './local-export-bundle';
import { decodeBenchlingNativeExport } from './native-export-decoder';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('decodeLinkedItemRecoveryExport', () => {
  it('decodes only exact requested IDs and scrubs memberships and second-hop relationships', async () => {
    const fixture = buildSyntheticNativeExportZip([
      {
        path: 'Requested DNA (seq_REQ123).gb',
        bytes:
          'LOCUS       seq_REQ123       8 bp    DNA     linear\nDEFINITION  Requested DNA.\nORIGIN\n        1 acgtacgt\n//\n',
      },
      {
        path: 'Unrelated DNA (seq_OTHER9).gb',
        bytes:
          'LOCUS       seq_OTHER9       8 bp    DNA     linear\nDEFINITION  Unrelated DNA.\nORIGIN\n        1 ttttaaaa\n//\n',
      },
      {
        path: 'Protocol (prt_PROTOCOL1).html',
        bytes:
          '<html><body><h1>Recovered protocol</h1><ol><li>Mix carefully</li></ol></body></html>',
      },
      {
        path: 'Recovered protein (prtn_PROTEIN1).fasta',
        bytes: '>prtn_PROTEIN1 recovered protein\nMKWVTF\n',
      },
    ]);
    const { artifact, archive } = await artifactFor(fixture);
    const targets = [
      target('seq_REQ123', 'dna_rna_sequence'),
      target('prt_PROTOCOL1', 'protocol'),
      target('prtn_PROTEIN1', 'protein'),
    ];

    const result = await decodeLinkedItemRecoveryExport({
      artifact,
      archive,
      capturedAt: '2026-08-13T12:00:00.000Z',
      requiredTargets: targets,
    });

    expect(result.ignoredCanonicalObjectCount).toBe(1);
    expect(result.matched.map((entry) => entry.sourceObject.stableId)).toEqual([
      'prt_PROTOCOL1',
      'prtn_PROTEIN1',
      'seq_REQ123',
    ]);
    expect(
      result.matched.find((entry) => entry.sourceObject.stableId === 'prtn_PROTEIN1')?.sourceObject
    ).toMatchObject({
      name: 'recovered protein',
      sourceType: 'protein',
      content: { aminoAcids: 'MKWVTF' },
    });
    expect(
      result.matched.every(
        (entry) =>
          entry.sourceObject.memberships.length === 0 &&
          entry.sourceObject.relationships.length === 0
      )
    ).toBe(true);
    expect(
      result.matched.find((entry) => entry.sourceObject.stableId === 'seq_OTHER9')
    ).toBeFalsy();
  });

  it('ignores an unrelated canonical file with an ambiguous presentation name', async () => {
    const fixture = buildSyntheticNativeExportZip([
      {
        path: 'Requested DNA (seq_REQ123).gb',
        bytes:
          'LOCUS       seq_REQ123       8 bp    DNA     linear\nDEFINITION  Requested DNA.\nORIGIN\n        1 acgtacgt\n//\n',
      },
      {
        path: 'Unrelated seq_DECOY9 DNA (seq_OTHER9).gb',
        bytes:
          'LOCUS       seq_OTHER9       8 bp    DNA     linear\nDEFINITION  Unrelated DNA.\nORIGIN\n        1 ttttaaaa\n//\n',
      },
    ]);
    const { artifact, archive } = await artifactFor(fixture);

    const result = await decodeLinkedItemRecoveryExport({
      artifact,
      archive,
      capturedAt: '2026-08-13T12:00:00.000Z',
      requiredTargets: [target('seq_REQ123', 'dna_rna_sequence')],
    });

    expect(result.ignoredCanonicalObjectCount).toBe(1);
    expect(result.matched.map((entry) => entry.sourceObject.stableId)).toEqual(['seq_REQ123']);
  });

  it('recovers a requested notebook entry from its canonical filename suffix', async () => {
    const fixture = buildSyntheticNativeExportZip([
      { path: 'Recovered notebook (etr_NOTEBOOK1).html', bytes: notebookHtml() },
    ]);
    const { artifact, archive } = await artifactFor(fixture);

    const result = await decodeLinkedItemRecoveryExport({
      artifact,
      archive,
      capturedAt: '2026-08-20T12:00:00.000Z',
      requiredTargets: [target('etr_NOTEBOOK1', 'other')],
    });

    expect(result.ignoredCanonicalObjectCount).toBe(0);
    expect(result.matched.map((entry) => entry.sourceObject.stableId)).toEqual(['etr_NOTEBOOK1']);
    expect(result.matched[0]?.sourceObject).toMatchObject({
      id: 'etr_NOTEBOOK1',
      sourceType: 'notebook_entry',
      name: 'Recovered notebook',
    });
  });

  it('decodes only the notebook entries named on the required-target allowlist', async () => {
    const fixture = buildSyntheticNativeExportZip([
      { path: 'Requested notebook (etr_NOTEBOOK1).html', bytes: notebookHtml() },
      { path: 'Unrequested notebook (etr_NOTEBOOK2).html', bytes: notebookHtml() },
    ]);
    const { artifact, archive } = await artifactFor(fixture);

    const result = await decodeLinkedItemRecoveryExport({
      artifact,
      archive,
      capturedAt: '2026-08-20T12:00:00.000Z',
      requiredTargets: [target('etr_NOTEBOOK1', 'other')],
    });

    expect(result.ignoredCanonicalObjectCount).toBe(1);
    expect(result.matched.map((entry) => entry.sourceObject.stableId)).toEqual(['etr_NOTEBOOK1']);
  });

  it('fails closed when a requested filename carries more than one canonical ID', async () => {
    const fixture = buildSyntheticNativeExportZip([
      { path: 'Copy of etr_DECOY123 (etr_NOTEBOOK1).html', bytes: notebookHtml() },
    ]);
    const { artifact, archive } = await artifactFor(fixture);

    await expect(
      decodeLinkedItemRecoveryExport({
        artifact,
        archive,
        capturedAt: '2026-08-20T12:00:00.000Z',
        requiredTargets: [target('etr_NOTEBOOK1', 'other')],
      })
    ).rejects.toMatchObject({ code: 'linked_item_recovery_filename_identity_ambiguous' });
  });

  it('uses a scientific fingerprint that ignores acquisition-only provenance', () => {
    const base: SourceObject = {
      id: 'seq_REQ123',
      stableId: 'seq_REQ123',
      sourceType: 'dna_sequence',
      name: 'DNA',
      aliases: [],
      sourceUrl: 'https://benchling.com/org/f/lib_A/folder/seq_REQ123-dna',
      sourcePath: 'A (seq_REQ123).gb',
      attachmentHashes: [],
      memberships: [],
      metadata: {
        nativeExport: { archiveSha256: 'first' },
        linkedItemRecovery: { supplementaryExportSha256: 'first' },
        nativeRecordClassification: {
          classifierVersion: 'v1',
          rawSha256: 'same',
          rawAccess: { archivePartId: 'initial', entryPath: 'A (seq_REQ123).gb' },
        },
      },
      content: { moleculeType: 'DNA', bases: 'ACGT', topology: 'linear', annotations: [] },
      relationships: [],
    };
    const second = {
      ...base,
      sourcePath: 'renamed/A (seq_REQ123).gb',
      metadata: {
        nativeExport: { archiveSha256: 'second' },
        linkedItemRecovery: { supplementaryExportSha256: 'second' },
        nativeRecordClassification: {
          classifierVersion: 'v1',
          rawSha256: 'same',
          rawAccess: {
            archivePartId: 'supplemental',
            entryPath: 'renamed/A (seq_REQ123).gb',
          },
        },
      },
    };
    expect(scientificSourceObjectSha256(base)).toBe(scientificSourceObjectSha256(second));
  });

  it('removes query credentials and fragments from durable notebook relationship URLs', async () => {
    const fixture = buildSyntheticNativeExportZip([
      {
        path: 'Notebook (etr_QUERY1).html',
        bytes:
          '<html><body><h1>Notebook</h1><a href="https://benchling.com/org/f/lib_FOLDER-folder/seq_TARGET1-dna/edit?token=private#session">DNA</a></body></html>',
      },
    ]);
    const { artifact } = await artifactFor(fixture);

    const decoded = await decodeBenchlingNativeExport({
      source: artifact.nativeExportDecoderSource,
      controlMetadata: { source: 'none' },
      context: {
        snapshotId: 'relationship-url-sanitization',
        capturedAt: '2026-08-14T13:00:00.000Z',
        archivePartId: 'local-export:relationship-url-sanitization',
        sourceUrlPrefix: null,
        localBundleAuthority: {
          schema: 'dnaforge.benchling.local-native-export-authority.v1',
          logicalFilename: artifact.logicalFilename,
          sha256: artifact.sha256,
        },
        selectedEntryPaths: ['Notebook (etr_QUERY1).html'],
      },
    });

    expect(decoded.sourceObjects[0]?.relationships).toContainEqual(
      expect.objectContaining({
        targetUrl: 'https://benchling.com/org/f/lib_FOLDER-folder/seq_TARGET1-dna/edit',
        targetSourceId: 'seq_TARGET1',
      })
    );
    expect(JSON.stringify(decoded.sourceObjects[0]?.relationships)).not.toMatch(/token|session/iu);
  });
});

function notebookHtml(): string {
  return '<html><body><h1>Recovered notebook</h1><p>Linked entry contents.</p></body></html>';
}

function target(
  sourceId: string,
  objectType: ValidationLinkedItemRecoveryTargetEvidence['objectType']
): ValidationLinkedItemRecoveryTargetEvidence {
  return {
    sourceId,
    name: sourceId,
    sourceUrl: `https://benchling.com/org/f/lib_A-folder/${sourceId}-name`,
    objectType,
    folderId: 'lib_A',
    relationshipCount: 1,
    relationshipIds: [`rel_${sourceId}`],
    recovered: false,
  };
}

async function artifactFor(fixture: SyntheticZipFixture): Promise<{
  artifact: VerifiedLocalBenchlingZipExport;
  archive: ContentArchive;
}> {
  const root = await mkdtemp(join(tmpdir(), 'linked-item-recovery-decoder-'));
  roots.push(root);
  const zipPath = join(root, 'supplementary.zip');
  await writeFile(zipPath, fixture.bytes);
  const archive = new ContentArchive(join(root, 'archive'));
  const blob = await archive.putFile(zipPath, { expectedSize: fixture.bytes.length });
  const artifact: VerifiedLocalBenchlingZipExport = {
    schema: 'dnaforge.benchling.local-export-artifact.v1',
    format: 'zip',
    logicalFilename: 'supplementary.zip',
    sha256: `sha256:${blob.sha256}`,
    sizeBytes: blob.size,
    immutableLocalPath: blob.path,
    nativeExportDecoderSource: {
      kind: 'local_path',
      logicalFilename: 'supplementary.zip',
      localPath: blob.path,
      expectedSha256: `sha256:${blob.sha256}`,
      expectedSizeBytes: blob.size,
      duplicateSupportEntryPolicy: 'identical_root_benchling_css',
    },
    resources: [],
    archive: {
      entryCount: 3,
      totalCompressedEntryBytes: fixture.bytes.length,
      totalUncompressedEntryBytes: fixture.declaredUncompressedBytes,
    },
  };
  return { artifact, archive };
}
