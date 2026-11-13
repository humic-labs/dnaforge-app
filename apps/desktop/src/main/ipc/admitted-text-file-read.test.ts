import { mkdir, mkdtemp, realpath, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HARD_CAP_BYTES } from '../../shared/oversized-guard';

const { admit, selectedFile } = vi.hoisted(() => ({ admit: vi.fn(), selectedFile: vi.fn() }));
vi.mock('./path-allowlist', () => ({ assertAdmittedReadPath: admit }));
vi.mock('../local-indexed-track-authority', () => ({
  resolveSelectedLocalFilePath: selectedFile,
}));

import { readAdmittedTextFile } from './admitted-text-file-read';

describe('admitted text file reads', () => {
  let root = '';
  let source = '';

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'admitted-text-read-')));
    source = join(root, 'selected.json');
    await writeFile(source, 'λ');
    admit.mockReset();
    admit.mockResolvedValue(source);
    selectedFile.mockReset();
    selectedFile.mockImplementation(() => {
      throw new Error('The file was not selected through the native file picker.');
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads a selected external file within a UTF-8 byte limit using its exact grant', async () => {
    await expect(
      readAdmittedTextFile({
        path: source,
        projectRoots: ['/workspace'],
        grantedFiles: [source],
        maxBytes: 2,
      })
    ).resolves.toBe('λ');
    expect(admit).toHaveBeenCalledWith(source, {
      projectRoots: ['/workspace'],
      grantedFiles: [source],
    });
    await expect(
      readAdmittedTextFile({ path: source, projectRoots: [], grantedFiles: [source], maxBytes: 1 })
    ).rejects.toMatchObject({ name: 'BoundedFileReadLimitError', sizeBytes: 2, maxBytes: 1 });
  });

  it('preserves admission refusal before reading the external source', async () => {
    admit.mockRejectedValueOnce(new Error('Not an admitted file'));
    await expect(
      readAdmittedTextFile({
        path: source,
        projectRoots: ['/workspace'],
        grantedFiles: [],
        maxBytes: 2,
      })
    ).rejects.toThrow('Not an admitted file');
  });

  it('honors an exact native-picker selection outside the ordinary location allowlist', async () => {
    admit.mockRejectedValue(new Error('Path access denied'));
    selectedFile.mockReturnValue(source);
    await expect(
      readAdmittedTextFile({ path: source, projectRoots: [], grantedFiles: [source], maxBytes: 2 })
    ).resolves.toBe('λ');
    expect(selectedFile).toHaveBeenCalledWith(source);
  });

  it('refuses a renderer claim for an external file that main has not recorded as selected', async () => {
    admit.mockRejectedValue(new Error('Path access denied'));
    await expect(
      readAdmittedTextFile({ path: source, projectRoots: [], grantedFiles: [source], maxBytes: 2 })
    ).rejects.toThrow('Path access denied');
  });

  it('does not extend a native-picker selection to another file or a project root', async () => {
    admit.mockRejectedValue(new Error('Path access denied'));
    selectedFile.mockReturnValue(source);
    await expect(
      readAdmittedTextFile({
        path: source,
        projectRoots: [root],
        grantedFiles: [join(root, 'other.json')],
        maxBytes: 2,
      })
    ).rejects.toThrow('Path access denied');
    expect(selectedFile).not.toHaveBeenCalled();
  });

  it('preserves the default hard cap for callers without a smaller limit', async () => {
    await expect(
      readAdmittedTextFile({ path: source, projectRoots: [], grantedFiles: [source] })
    ).resolves.toBe('λ');
    await truncate(source, HARD_CAP_BYTES + 1);
    await expect(
      readAdmittedTextFile({ path: source, projectRoots: [], grantedFiles: [source] })
    ).rejects.toMatchObject({ name: 'OversizedFileError' });
  });

  it('rejects invalid limits and directories through the existing bounded reader', async () => {
    for (const maxBytes of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, HARD_CAP_BYTES + 1]) {
      await expect(
        readAdmittedTextFile({ path: source, projectRoots: [], grantedFiles: [source], maxBytes })
      ).rejects.toThrow('maxBytes must be between');
    }
    const directory = join(root, 'directory.json');
    await mkdir(directory);
    admit.mockResolvedValueOnce(directory);
    await expect(
      readAdmittedTextFile({
        path: directory,
        projectRoots: [],
        grantedFiles: [directory],
        maxBytes: 2,
      })
    ).rejects.toThrow('regular file');
  });
});
