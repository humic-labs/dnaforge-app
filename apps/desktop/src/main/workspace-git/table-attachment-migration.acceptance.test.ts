// @vitest-environment node

import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDefaultMolecularDocument } from '../../shared/default-molecular-view';
import { serializeMolecularDocument } from '../../shared/molecular-document';
import {
  parseTablePackageHead,
  parseTableSnapshot,
  serializeTableSnapshot,
  tablePackagePaths,
} from '../../shared/table-package';
import { writeTablePackageFiles, readTablePackageInMain } from '../table-package';
import {
  convertTreeToMolecularPackages,
  materializeCoordinatePackage,
  renameExtensionNamedMolecularViews,
} from './coordinate-package-import';

const PDB =
  'HEADER    TABLE EVIDENCE\nATOM      1  CA  ALA A   1      11.104  13.207   2.100  1.00 20.00           C\nEND\n';
const documentId = 'f231ddca-5a5f-4bd5-ae9a-1169d23b6d11';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function packageBytes(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files[relative(root, path)] = (await readFile(path)).toString('hex');
    }
  }
  await walk(root);
  return files;
}

async function fixture(marker: 'current' | 'malformed' | 'future') {
  const workspaceRoot = await realpath(
    await mkdtemp(join(tmpdir(), 'table-attachment-migration-'))
  );
  roots.push(workspaceRoot);
  const packageRoot = join(workspaceRoot, 'Experimental table');
  const snapshot = parseTableSnapshot(
    JSON.stringify({
      schema: 'dnaforge.table-snapshot.v1',
      documentId,
      title: 'Experimental table',
      data: { rows: 1, cols: 1, cells: [[{ value: 'Evidence retained', type: 'text' }]] },
    })
  );
  const head = parseTablePackageHead(
    JSON.stringify({
      schema: 'dnaforge.table.v1',
      id: documentId,
      snapshotSha256: createHash('sha256').update(serializeTableSnapshot(snapshot)).digest('hex'),
      snapshot,
      aliases: [],
      status: 'active',
    })
  );
  await writeTablePackageFiles(
    { workspaceRoot, packageRoot, head, mode: 'create' },
    { assertCurrent() {} }
  );
  expect((await readTablePackageInMain({ workspaceRoot, packageRoot })).head).toEqual(head);
  const assets = join(packageRoot, 'assets');
  await mkdir(assets);
  const coordinatePath = join(assets, 'evidence.pdb');
  await writeFile(coordinatePath, PDB);
  await writeFile(
    join(assets, 'old.pdb.dnaforge-molecular.json'),
    serializeMolecularDocument(
      await buildDefaultMolecularDocument({
        name: 'old.pdb',
        format: 'pdb',
        text: PDB,
        createdAt: 1_000,
        documentId: '112cfc30-0755-4715-9ca5-d18f4d382f8c',
        referenceId: 'f31c1cec-8797-44a7-ac57-faa6d4e319be',
      })
    )
  );
  if (marker !== 'current') {
    await writeFile(
      tablePackagePaths(packageRoot).headPath,
      marker === 'malformed'
        ? '{ "schema": "dnaforge.table.v1",'
        : JSON.stringify({ ...head, schema: 'dnaforge.table.v999' })
    );
  }
  return { workspaceRoot, packageRoot, coordinatePath, before: await packageBytes(packageRoot) };
}

describe.each(['current', 'malformed', 'future'] as const)(
  'coordinate attachments owned by a %s native table package',
  (marker) => {
    it('preserves the package during automatic tree conversion while converting an ordinary loose file', async () => {
      const f = await fixture(marker);
      await writeFile(join(f.workspaceRoot, 'Loose.pdb'), PDB);
      const result = await convertTreeToMolecularPackages(f.workspaceRoot, {
        removeSource: unlink,
      });
      expect.soft(result.converted).toBe(1);
      expect.soft(await packageBytes(f.packageRoot)).toEqual(f.before);
      expect(
        await readFile(join(f.workspaceRoot, 'Loose.dnaforge-molecular.json'), 'utf8')
      ).toContain('Loose');
    });

    it('preserves extension-named molecular attachments during automatic filename normalization', async () => {
      const f = await fixture(marker);
      const result = await renameExtensionNamedMolecularViews(f.workspaceRoot);
      expect.soft(result.renamed).toBe(0);
      expect(await packageBytes(f.packageRoot)).toEqual(f.before);
    });

    it('refuses direct coordinate materialization without changing any table package bytes', async () => {
      const f = await fixture(marker);
      const result = await materializeCoordinatePackage(f.coordinatePath, { removeSource: unlink });
      expect.soft(result).toMatchObject({
        converted: false,
        skippedReason: expect.stringContaining('MOLECULAR_MIGRATION_PACKAGE_MEMBER'),
      });
      expect(await packageBytes(f.packageRoot)).toEqual(f.before);
    });
  }
);
