import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildSyntheticNativeExportZip } from './__fixtures__/native-export-zip-fixture';
import { ContentArchive } from './content-archive';
import {
  ExternalZipSourceError,
  selectExternalZipSource,
  verifyExternalZipSource,
} from './external-zip-source';
import { decodeLocalBenchlingExportBundle } from './local-export-decoder';
import { decodeWorkspaceAppendExport } from './workspace-append-decoder';

describe('external ZIP source', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-external-zip-'));
    roots.push(root);
    const workspacePath = join(root, 'workspace');
    const appDataPath = join(root, 'app-data');
    await Promise.all([
      mkdir(workspacePath, { recursive: true }),
      mkdir(appDataPath, { recursive: true }),
    ]);
    const sourcePath = join(root, 'suntag_export_2.zip');
    const zip = buildSyntheticNativeExportZip([
      {
        path: 'Yeast/YEN1 (seq_YEN1000).gb',
        bytes: 'LOCUS       YEN1       8 bp    DNA     linear\nORIGIN\n        1 acgtacgt\n//\n',
      },
      {
        path: 'Yeast/assets/attachment.txt',
        bytes: 'attachment',
      },
    ]);
    await writeFile(sourcePath, zip.bytes);
    return { root, workspacePath, appDataPath, sourcePath, zip };
  }

  it('records the original ZIP and entry evidence without copying any bytes', async () => {
    const { workspacePath, appDataPath, sourcePath } = await fixture();

    const selected = await selectExternalZipSource({
      sourcePath,
      selectedAt: '2026-08-29T22:00:00.000Z',
    });

    expect(selected.source).toMatchObject({
      schema: 'dnaforge.benchling.external-zip-source.v1',
      originalPath: sourcePath,
      displayName: 'suntag_export_2.zip',
      selectedAt: '2026-08-29T22:00:00.000Z',
    });
    expect(selected.source.sourceId).toMatch(/^external-zip-[a-f0-9]{24}$/u);
    expect(selected.source.zipSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(selected.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schema: 'dnaforge.benchling.external-zip-entry.v1',
          sourceId: selected.source.sourceId,
          sourceObjectId: 'seq_YEN1000',
          entryPath: 'Yeast/YEN1 (seq_YEN1000).gb',
          entrySha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          mediaType: 'chemical/x-genbank',
          role: 'source-record',
        }),
      ])
    );
    expect(await readdir(workspacePath)).toEqual([]);
    expect(await readdir(appDataPath)).toEqual([]);
  });

  it('decodes from the original ZIP without creating an archive or extracted source blob', async () => {
    const { workspacePath, appDataPath, sourcePath } = await fixture();
    const selected = await selectExternalZipSource({
      sourcePath,
      selectedAt: '2026-08-29T22:00:00.000Z',
    });

    const capture = await decodeLocalBenchlingExportBundle({
      artifact: {
        schema: 'dnaforge.benchling.local-export-artifact.v1',
        format: 'zip',
        logicalFilename: selected.source.displayName,
        sha256: selected.source.zipSha256,
        sizeBytes: selected.source.sizeBytes,
        immutableLocalPath: selected.source.originalPath,
        resources: [],
        nativeExportDecoderSource: selected.nativeExportDecoderSource,
        archive: selected.archive,
      },
      archive: new ContentArchive(join(workspacePath, '.dnaforge', 'migration', 'archive')),
      externalZipSource: selected.source,
      externalZipEntries: selected.entries,
      capturedAt: selected.source.selectedAt,
      scope: {
        version: 1,
        kind: 'folder_tree',
        acquisition: 'local_bundle',
        roots: [
          {
            id: 'local-export-folder-3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
            url: 'urn:dnaforge:benchling-local-export:pending:3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
            objectType: 'folder',
          },
        ],
        includeChildren: true,
        includeArchived: false,
      },
    });

    expect(capture.sourceObjects.map((object) => object.stableId)).toContain('seq_YEN1000');
    expect(await readdir(workspacePath)).toEqual([]);
    expect(await readdir(appDataPath)).toEqual([]);
  });

  it('distinguishes a notebook source record from its flat sibling attachment', async () => {
    const { sourcePath } = await fixture();
    await writeFile(
      sourcePath,
      buildSyntheticNativeExportZip([
        { path: 'Notebook (etr_NOTEBOOK1).html', bytes: '<p>Notebook</p>' },
        { path: 'Notebook (etr_NOTEBOOK1) image.png', bytes: 'synthetic-image' },
        { path: 'Registry/Strain (bfi_STRAIN01).png', bytes: 'synthetic-binary-record' },
        { path: 'Registry/Strain (bfi_STRAIN01)/image.png', bytes: 'synthetic-attachment' },
      ]).bytes
    );
    const selected = await selectExternalZipSource({
      sourcePath,
      selectedAt: '2026-08-29T22:00:00.000Z',
    });
    expect(selected.entries.map(({ sourceObjectId, role }) => ({ sourceObjectId, role }))).toEqual([
      { sourceObjectId: 'etr_NOTEBOOK1', role: 'attachment' },
      { sourceObjectId: 'etr_NOTEBOOK1', role: 'source-record' },
      { sourceObjectId: 'bfi_STRAIN01', role: 'source-record' },
      { sourceObjectId: 'bfi_STRAIN01', role: 'attachment' },
    ]);
  });

  it('decodes a supplemental ZIP without preserving its archive or entries', async () => {
    const { workspacePath, appDataPath, sourcePath } = await fixture();
    const selected = await selectExternalZipSource({
      sourcePath,
      selectedAt: '2026-08-29T22:00:00.000Z',
    });

    const decoded = await decodeWorkspaceAppendExport({
      artifact: {
        schema: 'dnaforge.benchling.local-export-artifact.v1',
        format: 'zip',
        logicalFilename: selected.source.displayName,
        sha256: selected.source.zipSha256,
        sizeBytes: selected.source.sizeBytes,
        immutableLocalPath: selected.source.originalPath,
        resources: [],
        nativeExportDecoderSource: selected.nativeExportDecoderSource,
        archive: selected.archive,
      },
      archive: new ContentArchive(join(workspacePath, '.dnaforge', 'migration', 'archive')),
      externalZipEntries: selected.entries,
      capturedAt: selected.source.selectedAt,
      runId: 'run-external-supplemental',
      attemptId: 'attempt-external-supplemental',
      artifactId: 'artifact-external-supplemental',
      destinationFolderId: null,
    });

    expect(decoded.matched.map((item) => item.sourceObject.stableId)).toEqual(['seq_YEN1000']);
    expect(decoded.matched[0]?.attachments).toEqual([]);
    expect(await readdir(workspacePath)).toEqual([]);
    expect(await readdir(appDataPath)).toEqual([]);
  });

  it('reopens an unchanged source and distinguishes missing from changed bytes', async () => {
    const { root, sourcePath, zip } = await fixture();
    const selected = await selectExternalZipSource({
      sourcePath,
      selectedAt: '2026-08-29T22:00:00.000Z',
    });

    await expect(verifyExternalZipSource(selected.source)).resolves.toBe(sourcePath);

    const movedPath = join(root, 'moved.zip');
    await rename(sourcePath, movedPath);
    await expect(verifyExternalZipSource(selected.source)).rejects.toMatchObject({
      code: 'source_unavailable',
    });

    await rename(movedPath, sourcePath);
    await writeFile(sourcePath, Uint8Array.from([...zip.bytes, 0]));
    await expect(verifyExternalZipSource(selected.source)).rejects.toMatchObject({
      code: 'source_changed',
    });
  });
});
