import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildSyntheticNativeExportZip } from './__fixtures__/native-export-zip-fixture';
import { ContentArchive } from './content-archive';
import { intakeLocalBenchlingExportBundle } from './local-export-bundle';
import { selectExternalZipSource } from './external-zip-source';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local Benchling ZIP intake', () => {
  it('uses the selected path directly for a new-layout source without ContentArchive intake', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-export-intake-'));
    roots.push(root);
    const sourcePath = join(root, 'export.zip');
    await writeFile(
      sourcePath,
      buildSyntheticNativeExportZip([
        {
          path: 'Sequence (seq_INTAKE1).gb',
          bytes:
            'LOCUS       seq_INTAKE1       8 bp    DNA     linear\nORIGIN\n        1 acgtacgt\n//\n',
        },
      ]).bytes
    );
    const putFile = vi.spyOn(ContentArchive.prototype, 'putFile');

    const selected = await selectExternalZipSource({
      sourcePath,
      selectedAt: '2026-08-29T22:00:00.000Z',
    });

    expect(selected.source.originalPath).toBe(sourcePath);
    expect(putFile).not.toHaveBeenCalled();
  });

  it('does not rehash a blob immediately after the copy already hashed every byte', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-export-intake-'));
    roots.push(root);
    const workspacePath = join(root, 'workspace');
    await mkdir(workspacePath, { recursive: true });
    const sourcePath = join(root, 'export.zip');
    const fixture = buildSyntheticNativeExportZip([
      {
        path: 'Sequence (seq_INTAKE1).gb',
        bytes:
          'LOCUS       seq_INTAKE1       8 bp    DNA     linear\nDEFINITION  Intake test.\nORIGIN\n        1 acgtacgt\n//\n',
      },
    ]);
    await writeFile(sourcePath, fixture.bytes);
    const verifyBlob = vi.spyOn(ContentArchive.prototype, 'verifyBlob');
    const assertBlobPresent = vi.spyOn(ContentArchive.prototype, 'assertBlobPresent');

    await intakeLocalBenchlingExportBundle({ workspacePath, sourcePath });

    expect(verifyBlob).not.toHaveBeenCalled();
    expect(assertBlobPresent).toHaveBeenCalledOnce();
  });
});
