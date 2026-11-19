import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));
import type Database from 'better-sqlite3';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { importFileIntoWorkspaceRoot, importIntoManagedWorkspaceRepo } from './import';
import { materializeCoordinatePackage } from './coordinate-package-import';
import {
  getCurrentMolecularSnapshot,
  parseMolecularDocument,
} from '../../shared/molecular-document';
import { binaryCoordinateBytes } from '../../shared/binary-coordinates';
import { isDefaultMolecularScene } from '../../shared/default-molecular-view';

const PDB =
  'HEADER    TEST PROTEIN\nATOM      1  CA  ALA A   1      11.104  13.207   2.100  1.00 20.00           C\nEND\n';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wp-coordinate-package-'));
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('coordinate files become molecular view packages ', () => {
  it('writes a default view beside the coordinate file and removes the loose file', async () => {
    const source = join(tmp, '1ABC.pdb');
    writeFileSync(source, PDB);
    const result = await materializeCoordinatePackage(source, {
      removeSource: (path) => unlink(path),
      now: () => 1_000,
    });
    expect(result).toEqual({
      converted: true,
      productPath: join(tmp, '1ABC.dnaforge-molecular.json'),
    });
    expect(existsSync(source)).toBe(false);
    const document = parseMolecularDocument(
      readFileSync(join(tmp, '1ABC.dnaforge-molecular.json'), 'utf8')
    );
    expect(document.name).toBe('1ABC');
    expect(document.history).toHaveLength(1);
    const [{ snapshot }] = document.history;
    expect(snapshot.coordinates).toMatchObject({ format: 'pdb', text: PDB });
    expect(isDefaultMolecularScene(snapshot.scene)).toBe(true);
  });

  it.each(['cif', 'mmcif', 'mcif'])(
    'keeps an existing view and picks the next free name for .%s',
    async (extension) => {
      writeFileSync(join(tmp, '1ABC.dnaforge-molecular.json'), 'existing view');
      const source = join(tmp, `1ABC.${extension}`);
      writeFileSync(source, 'data_1ABC\n_atom_site.id 1\n');
      const result = await materializeCoordinatePackage(source, {
        removeSource: (path) => unlink(path),
      });
      expect(result).toEqual({
        converted: true,
        productPath: join(tmp, '1ABC 2.dnaforge-molecular.json'),
      });
      expect(readFileSync(join(tmp, '1ABC.dnaforge-molecular.json'), 'utf8')).toBe('existing view');
    }
  );

  it('leaves non-coordinate files alone', async () => {
    const path = join(tmp, 'notes.txt');
    writeFileSync(path, 'content');
    const removeSource = vi.fn();
    expect(await materializeCoordinatePackage(path, { removeSource })).toEqual({
      converted: false,
    });
    expect(removeSource).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(true);
  });

  it('turns a binary CIF into a view that keeps its exact bytes ', async () => {
    const bytes = readFileSync(
      join(__dirname, '../../../../../test-fixtures/structure-complexes/rcsb/1FS0.bcif')
    );
    const source = join(tmp, '1FS0.bcif');
    writeFileSync(source, bytes);
    const result = await materializeCoordinatePackage(source, {
      removeSource: (path) => unlink(path),
      now: () => 1_000,
    });
    expect(result).toEqual({
      converted: true,
      productPath: join(tmp, '1FS0.dnaforge-molecular.json'),
    });
    expect(existsSync(source)).toBe(false);
    const document = parseMolecularDocument(
      readFileSync(join(tmp, '1FS0.dnaforge-molecular.json'), 'utf8')
    );
    const snapshot = getCurrentMolecularSnapshot(document);
    expect(snapshot.coordinates.format).toBe('bcif');
    expect(Buffer.from(binaryCoordinateBytes(snapshot.coordinates.text))).toEqual(bytes);
    expect(isDefaultMolecularScene(snapshot.scene)).toBe(true);
    expect(JSON.parse(snapshot.scene).root.children[0]).toMatchObject({
      params: { url: 'structure.bcif' },
      children: [{ kind: 'parse', params: { format: 'bcif' } }],
    });
  });

  it('keeps a coordinate file too large for a view and reports why', async () => {
    const path = join(tmp, 'huge.pdb');
    writeFileSync(path, 'A'.repeat(8_000_001));
    const removeSource = vi.fn();
    const result = await materializeCoordinatePackage(path, { removeSource });
    expect(result.converted).toBe(false);
    expect(result).toHaveProperty('skippedReason', expect.stringMatching(/larger/i));
    expect(removeSource).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(true);
  });
});

describe('importing a coordinate file into a project ', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
  });

  it('imports a .pdb as a molecular view package and returns the view path', async () => {
    const managedRoot = join(tmp, 'managed');
    const workspace = join(tmp, 'ws');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'README.txt'), 'project\n');
    const { repoPath } = await importIntoManagedWorkspaceRepo(workspace, {
      db,
      managedRootDir: managedRoot,
    });
    const incoming = join(mkdtempSync(join(tmp, 'src-')), '1FS0.pdb');
    writeFileSync(incoming, PDB);
    const result = await importFileIntoWorkspaceRoot(
      { targetRoot: repoPath, sourcePath: incoming },
      { db, managedRootDir: managedRoot }
    );
    expect(result.relPath).toBe('1FS0.dnaforge-molecular.json');
    expect(result.destPath).toBe(join(repoPath, '1FS0.dnaforge-molecular.json'));
    expect(existsSync(join(repoPath, '1FS0.pdb'))).toBe(false);
    expect(existsSync(incoming)).toBe(true);
    expect(
      parseMolecularDocument(readFileSync(result.destPath, 'utf8')).history[0].snapshot.coordinates
        .text
    ).toBe(PDB);
  });
});
