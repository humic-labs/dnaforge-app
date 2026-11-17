import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMockData, setFileTree, setMockFileContent } from '../test/platform-mocks';
import { initializeTestSchema } from '../test/initializeTestSchema';
import { platform } from '../platform';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../db/sequence-package';
import { reconcileWorkspaceRoot } from './workspace-reconcile';

const root = '/project';
const packageRoot = `${root}/Existing sequence`;
const metaPath = `${packageRoot}/.forge/plasmid.json`;

beforeEach(async () => {
  clearMockData();
  await initializeTestSchema();
  setFileTree(root, [{ name: 'Existing sequence', isDirectory: true }]);
  setFileTree(packageRoot, [{ name: 'Existing sequence.gb', isDirectory: false }]);
  setMockFileContent(
    `${packageRoot}/Existing sequence.gb`,
    'LOCUS existing 4 bp DNA\nORIGIN\n 1 atgc\n//\n'
  );
  const document = JSON.parse(
    serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: 'retained-sequence-id',
        name: 'Existing sequence',
        product: { file: 'Existing sequence.gb' },
      })
    )
  );
  document.formatVersion = 8;
  setMockFileContent(metaPath, JSON.stringify(document));
});

afterEach(() => vi.restoreAllMocks());

describe('filesystem discovery of old native sequence packages', () => {
  it('uses the owning project root for the admitted marker upgrade', async () => {
    const fs = platform().fs;
    const atomic = fs.writeWorkspaceTextFileAtomic.bind(fs);
    const write = vi.spyOn(fs, 'writeWorkspaceTextFileAtomic').mockImplementation(async (input) => {
      if (input.workspaceRoot !== root) throw new Error('The package is not the owning project.');
      return atomic(input);
    });

    const result = await reconcileWorkspaceRoot(root);

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: root, path: metaPath, mode: 'replace' })
    );
    expect(result.errors).toEqual([]);
    const current = JSON.parse(await fs.readTextFile(metaPath));
    expect(current.id).toBe('retained-sequence-id');
    expect(current.formatVersion).toBe(9);
  });

  it('reports a failed marker migration and preserves the old source bytes', async () => {
    const fs = platform().fs;
    const original = await fs.readTextFile(metaPath);
    vi.spyOn(fs, 'writeWorkspaceTextFileAtomic').mockRejectedValue(
      new Error('A competing source version prevents marker publication.')
    );

    const result = await reconcileWorkspaceRoot(root);

    expect(result.errors).toContainEqual({
      path: metaPath,
      message: 'A competing source version prevents marker publication.',
    });
    expect(await fs.readTextFile(metaPath)).toBe(original);
  });
});
