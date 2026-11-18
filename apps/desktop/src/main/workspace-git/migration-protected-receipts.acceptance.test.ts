import { afterEach, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  prepareSequenceMigration,
  collectSequenceMigrationGitContent,
} from './sequence-migration-journal';
import { materializeImportedSequencePackages } from './sequence-package-import';
import { preflightLegacySequencePackages } from './sequence-package-preflight';
import { buildSequencePackageDocument } from '../../db/sequence-package';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const genbank = 'LOCUS       Protected 12 bp DNA linear SYN\nORIGIN\n        1 acgtacgtacgt\n//\n';
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'migration-protected-receipt-'));
  roots.push(path);
  return path;
}

it.each([false, true])(
  'does not recover or publish migration receipt paths after their planned identity becomes accepted (completed=%s)',
  async (completed) => {
    const project = await root();
    const source = join(project, 'Protected.gb');
    await writeFile(source, genbank);
    const receipt = await prepareSequenceMigration(project, source, {});
    const converted = await materializeImportedSequencePackages(source, undefined, {
      automatic: true,
      expectedSourceSha256: receipt.expectedSourceSha256,
      onPackagePlanned: receipt.onPackagePlanned,
    });
    expect(converted.converted).toBe(true);
    const pkg = converted.packages[0];
    const markerPath = join(pkg.packageRoot, '.forge', 'plasmid.json');
    const marker = await readFile(markerPath, 'utf8');
    const product = await readFile(pkg.productPath, 'utf8');
    if (completed) await receipt.finish(converted.packages.map((item) => item.packageRoot));

    const collected = await collectSequenceMigrationGitContent(project, {
      protectedEntityIds: new Set([JSON.parse(marker).id]),
    });

    expect(collected.recovered).toBe(0);
    expect(collected.expectedContentSha256).toEqual({});
    if (!completed) expect(collected.failures.length).toBeGreaterThan(0);
    expect(await readFile(markerPath, 'utf8')).toBe(marker);
    expect(await readFile(pkg.productPath, 'utf8')).toBe(product);
    await expect(access(source)).rejects.toMatchObject({ code: 'ENOENT' });
  }
);

it('does not republish old upgrade receipt paths for a copied accepted identity', async () => {
  const project = await root();
  const pkg = join(project, 'Copied');
  await mkdir(join(pkg, '.forge'), { recursive: true });
  await writeFile(join(pkg, 'Protected.gb'), genbank);
  const id = 'copied-accepted-identity';
  await writeFile(
    join(pkg, '.forge', 'plasmid.json'),
    JSON.stringify({
      ...buildSequencePackageDocument({
        id,
        name: 'Protected',
        product: {
          file: 'Protected.gb',
          topology: 'linear',
          genBankChecksum: 'sha256:' + createHash('sha256').update(genbank).digest('hex'),
        },
      }),
      formatVersion: 8,
    })
  );
  const upgraded = await preflightLegacySequencePackages(project);
  expect(upgraded.failures).toEqual([]);
  expect(upgraded.upgraded).toBe(1);
  const marker = await readFile(join(pkg, '.forge', 'plasmid.json'), 'utf8');

  const protectedResult = await preflightLegacySequencePackages(project, {
    protectedEntityIds: new Set([id]),
  });

  expect(protectedResult.expectedContentSha256).toEqual({});
  expect(await readFile(join(pkg, '.forge', 'plasmid.json'), 'utf8')).toBe(marker);
  expect(await readFile(join(pkg, 'Protected.gb'), 'utf8')).toBe(genbank);
});
