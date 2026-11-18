import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0' },
  dialog: { showErrorBox: vi.fn() },
}));

import { initManagedRepo, commitAllIfDirty } from './index';

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});
const genbank =
  'LOCUS       retained  12 bp    DNA     linear SYN\nORIGIN\n        1 atgacgatcgat\n//\n';
const fasta = `>first DNA plasmid\n${'ACGT'.repeat(100)}\n>second DNA plasmid\n${'GATTA'.repeat(80)}\n`;

function git(root: string, args: string[]): string {
  return execFileSync('git', ['--literal-pathspecs', ...args], { cwd: root, encoding: 'utf8' });
}

function subprocess(script: string, expectedExit: number): void {
  const result = spawnSync(
    resolve(__dirname, '../../../../../node_modules/.bin/vite-node'),
    [script],
    {
      cwd: resolve(__dirname, '../../..'),
      encoding: 'utf8',
      timeout: 15_000,
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(expectedExit);
}

describe('automatic sequence migration after real process exit', () => {
  it.each([
    { name: 'one GenBank package', filename: 'loose.gb', source: genbank, packageCount: 1 },
    { name: 'two FASTA packages', filename: 'loose.fasta', source: fasta, packageCount: 2 },
  ])(
    'settles $name without new identities or unrelated Git changes',
    async ({ filename, source, packageCount }) => {
      const temporary = mkdtempSync(join(tmpdir(), 'sequence-migration-restart-'));
      cleanup.push(temporary);
      const root = join(temporary, 'project');
      mkdirSync(root);
      await initManagedRepo(root);
      const sourcePath = join(root, filename);
      writeFileSync(sourcePath, source);
      writeFileSync(join(root, 'dirty.txt'), 'original dirty file');
      writeFileSync(join(root, 'staged.txt'), 'original staged file');
      await commitAllIfDirty(root, 'fixture baseline');
      writeFileSync(join(root, 'dirty.txt'), 'unsubmitted edit');
      writeFileSync(join(root, 'staged.txt'), 'staged edit');
      git(root, ['add', '--', 'staged.txt']);
      writeFileSync(join(root, 'staged.txt'), 'later working edit');
      const staged = git(root, ['ls-files', '--stage', '--', 'staged.txt']);
      const stagedBytes = git(root, ['show', ':staged.txt']);
      const initialHead = git(root, ['rev-parse', 'HEAD']);
      const publication = join(temporary, 'publication.json');
      const interrupt = join(temporary, 'interrupt.ts');
      writeFileSync(
        interrupt,
        `
import { promises as fs } from 'node:fs';
import { prepareSequenceMigration } from ${JSON.stringify(resolve(__dirname, 'sequence-migration-journal.ts'))};
import { materializeImportedSequencePackages } from ${JSON.stringify(resolve(__dirname, 'sequence-package-import.ts'))};
const receipt = await prepareSequenceMigration(${JSON.stringify(root)}, ${JSON.stringify(sourcePath)}, {});
const result = await materializeImportedSequencePackages(${JSON.stringify(sourcePath)}, undefined, {
  automatic: true,
  expectedSourceSha256: receipt.expectedSourceSha256,
  onPackagePlanned: receipt.onPackagePlanned,
});
if (!result.converted) throw new Error(result.skippedReason ?? 'Sequence did not convert');
const packages = await Promise.all(result.packages.map(async (pkg) => ({
  root: pkg.packageRoot,
  product: pkg.productPath,
  marker: await fs.readFile(pkg.packageRoot + '/.forge/plasmid.json', 'utf8'),
  bytes: await fs.readFile(pkg.productPath, 'utf8'),
})));
await fs.writeFile(${JSON.stringify(publication)}, JSON.stringify(packages));
process.exit(73);
`
      );
      subprocess(interrupt, 73);
      const packages = JSON.parse(readFileSync(publication, 'utf8')) as Array<{
        root: string;
        product: string;
        marker: string;
        bytes: string;
      }>;
      expect(packages).toHaveLength(packageCount);
      expect(new Set(packages.map((pkg) => JSON.parse(pkg.marker).id)).size).toBe(packageCount);
      expect(existsSync(sourcePath)).toBe(false);
      const journal = join(root, '.dnaforge-sequence-migrations');
      const attempts = readdirSync(journal).filter((name) => name.startsWith('attempt-'));
      expect(attempts).toHaveLength(1);
      expect(readFileSync(join(journal, attempts[0], 'original'), 'utf8')).toBe(source);
      expect(existsSync(join(journal, attempts[0], 'complete.json'))).toBe(false);
      expect(git(root, ['rev-parse', 'HEAD'])).toBe(initialHead);
      const recovered = join(temporary, 'recovered.json');
      const restart = join(temporary, 'restart.ts');
      writeFileSync(
        restart,
        `
import { promises as fs } from 'node:fs';
import { collectManagedCatalogHeadIndex } from ${JSON.stringify(resolve(__dirname, 'head-index.ts'))};
const result = await collectManagedCatalogHeadIndex(${JSON.stringify(root)}, [], { ownedMigrationCommit: true });
await fs.writeFile(${JSON.stringify(recovered)}, JSON.stringify(result));
`
      );
      subprocess(restart, 0);
      const index = JSON.parse(readFileSync(recovered, 'utf8')) as {
        healedFileCount: number;
        migrationIssues: unknown[];
        files: Array<{ relPath: string }>;
      };
      expect(index.migrationIssues).toEqual([]);
      expect(index.healedFileCount).toBe(1);
      for (const pkg of packages) {
        expect(readFileSync(join(pkg.root, '.forge/plasmid.json'), 'utf8')).toBe(pkg.marker);
        expect(readFileSync(pkg.product, 'utf8')).toBe(pkg.bytes);
        const path = relative(root, pkg.product).split('\\').join('/');
        expect(index.files.map((file) => file.relPath)).toContain(path);
        expect(git(root, ['show', `HEAD:${path}`])).toBe(pkg.bytes);
      }
      expect(readFileSync(join(journal, attempts[0], 'original'), 'utf8')).toBe(source);
      expect(existsSync(join(journal, attempts[0], 'complete.json'))).toBe(true);
      expect(git(root, ['ls-files', '--stage', '--', 'staged.txt'])).toBe(staged);
      expect(git(root, ['show', ':staged.txt'])).toBe(stagedBytes);
      expect(git(root, ['show', 'HEAD:staged.txt'])).toBe('original staged file');
      expect(git(root, ['show', 'HEAD:dirty.txt'])).toBe('original dirty file');
      expect(readFileSync(join(root, 'dirty.txt'), 'utf8')).toBe('unsubmitted edit');
      expect(readFileSync(join(root, 'staged.txt'), 'utf8')).toBe('later working edit');
      const migratedHead = git(root, ['rev-parse', 'HEAD']);
      subprocess(restart, 0);
      expect(JSON.parse(readFileSync(recovered, 'utf8')).healedFileCount).toBe(0);
      expect(git(root, ['rev-parse', 'HEAD'])).toBe(migratedHead);
      expect(readdirSync(journal).filter((name) => name.startsWith('attempt-'))).toEqual(attempts);
      for (const pkg of packages)
        expect(readFileSync(join(pkg.root, '.forge/plasmid.json'), 'utf8')).toBe(pkg.marker);
    },
    20_000
  );
});
