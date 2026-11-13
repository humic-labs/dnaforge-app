import { promises as fs } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { fromPackageRelative, parseSequencePackageDocument } from '../../db/sequence-package';
import { convertLooseSequenceFile, convertTreeToPlasmidPackages } from './convert-tree-to-packages';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../ipc/database', () => ({ getDb: () => db }));
vi.mock('../auth/session-store', () => ({ getActiveStoredSession: async () => null }));

let db: Database.Database;
beforeAll(() => import('../sequence-package-revision-publication'), 60_000);

const GENBANK = `LOCUS       final                     60 bp    DNA     circular SYN 03-NOV-2026
DEFINITION  final.
FEATURES             Location/Qualifiers
ORIGIN
        1 atgaccatga ttacggattc actggccgtc gttttacaac gtcgtgactg ggaaaaccct
//
`;
const run = (n: number) =>
  n === 1 ? GENBANK : GENBANK.replace('ORIGIN', `COMMENT     run ${n}\nORIGIN`);

describe('a program that saves the same sequence file again', () => {
  let root: string;
  let out: string;

  beforeEach(async () => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    root = await mkdtemp(join(tmpdir(), 'fixture-rerun-'));
    out = join(root, 'out');
    await mkdir(out, { recursive: true });
  });
  afterEach(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const marker = async () =>
    parseSequencePackageDocument(
      await readFile(join(out, 'final', '.forge', 'plasmid.json'), 'utf8')
    );

  for (const route of ['automatic', 'explicit'] as const) {
    it(`adds a version to the existing plasmid instead of a second plasmid (${route})`, async () => {
      const source = join(out, 'final.gb');
      const convert = () =>
        route === 'automatic'
          ? convertTreeToPlasmidPackages(root)
          : convertLooseSequenceFile(root, source);

      await writeFile(source, run(1));
      await convert();
      const id = (await marker()).id;
      for (const n of [2, 3]) {
        await writeFile(source, run(n));
        await convert();
      }

      expect((await readdir(out)).sort()).toEqual(['final']);
      const document = await marker();
      expect(document.id).toBe(id);
      expect(await readFile(join(out, 'final', 'final.gb'), 'utf8')).toBe(run(3));
      expect(document.versionHistory.revisions.map((revision) => revision.kind)).toEqual([
        'adopted',
        'sequence-save',
        'sequence-save',
      ]);
      const [first, second] = document.versionHistory.revisions;
      expect(
        await readFile(fromPackageRelative(first.productSnapshot.path, join(out, 'final')), 'utf8')
      ).toBe(run(1));
      expect(
        await readFile(fromPackageRelative(second.productSnapshot.path, join(out, 'final')), 'utf8')
      ).toBe(run(2));
    });
  }

  it('records no new version when the file is saved again unchanged', async () => {
    const source = join(out, 'final.gb');
    await writeFile(source, run(1));
    await convertTreeToPlasmidPackages(root);
    await writeFile(source, run(1));
    await convertTreeToPlasmidPackages(root);

    expect((await readdir(out)).sort()).toEqual(['final']);
    expect((await marker()).versionHistory.revisions).toEqual([]);
  });

  it('adds a version when a FASTA file is saved again', async () => {
    const source = join(out, 'final.fasta');
    const fasta = (bases: string) => `>final\n${bases}\n`;
    const bases = 'ATGACCATGATTACGGATTCACTGGCCGTCGTTTTACAACGTCGTGACTGGGAAAACCCTG';
    await writeFile(source, fasta(bases));
    await convertTreeToPlasmidPackages(root);
    const id = (await marker()).id;
    await writeFile(source, fasta(`${bases}GGG`));
    await convertTreeToPlasmidPackages(root);

    expect((await readdir(out)).sort()).toEqual(['final']);
    const document = await marker();
    expect(document.id).toBe(id);
    expect(document.versionHistory.revisions.map((revision) => revision.kind)).toEqual([
      'adopted',
      'sequence-save',
    ]);
    expect(await readFile(join(out, 'final', 'final.gb'), 'utf8')).toMatch(
      new RegExp(`^LOCUS\\s+final\\s+${bases.length + 3} bp`, 'm')
    );
  });
});
