import { expect, it, vi } from 'vitest';
import { loadSequencePackageDocument, type SequencePackageIoFs } from './sequence-package-io';
import { buildSequencePackageDocument } from './sequence-package';

it('upgrades a nested version-eight assembly under its owning project authority', async () => {
  const projectRoot = '/projects/review-project';
  const packageRoot = `${projectRoot}/Cases/cumate-red-oe-pcr/Final assemblies/edited-yhim-yhin-locus`;
  const marker = `${packageRoot}/.forge/plasmid.json`;
  const content = JSON.stringify({
    ...buildSequencePackageDocument({
      id: 'assembly-id',
      name: 'Edited yhiM-yhiN locus',
      product: { file: 'edited-yhim-yhin-locus.gb', topology: 'linear' },
    }),
    formatVersion: 8,
  });
  const unused = () => {
    throw new Error('A metadata-only migration touched sequence data');
  };
  const write = vi.fn<NonNullable<SequencePackageIoFs['writeWorkspaceTextFileAtomic']>>(
    async (input) => {
      if (input.workspaceRoot !== projectRoot) throw new Error('Wrong owning project');
    }
  );
  const fs: SequencePackageIoFs = {
    exists: async (path) => path === marker,
    readTextFile: async () => content,
    writeTextFile: unused,
    writeWorkspaceTextFileAtomic: write,
    mkdir: unused,
    move: unused,
  };
  await expect(loadSequencePackageDocument(packageRoot, fs, projectRoot)).resolves.toMatchObject({
    formatVersion: 9,
    id: 'assembly-id',
  });
  expect(write).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceRoot: projectRoot,
      path: marker,
      mode: 'replace',
      artifactNoun: 'sequence package',
    })
  );
  const saved = JSON.parse(write.mock.calls[0][0].content);
  expect(saved.product.file).toBe('edited-yhim-yhin-locus.gb');
  expect(saved.product.topology).toBe('linear');
});
