import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { link, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import type Database from 'better-sqlite3';
import { restoreSavedFileSource } from '../saved-file-sources';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import {
  importContentIntoWorkspaceRoot,
  importSequenceContentIntoWorkspaceRoot,
  MANAGED_WORKSPACE_MARKER,
} from './import';
import { parseSequencePackageDocument, sequencePackagePaths } from '../../db/sequence-package';
import { materializeImportedSequencePackages } from './sequence-package-import';

const VALID_SEQUENCE = [
  'LOCUS       incoming       0 bp    DNA     linear   SYN 01-JAN-2000',
  'ORIGIN',
  '//',
  '',
].join('\n');

describe('importSequenceContentIntoWorkspaceRoot ', () => {
  let db: Database.Database;
  let scratchRoot: string;
  let workspaceRoot: string;
  let managedRoot: string;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    scratchRoot = mkdtempSync(join(tmpdir(), 'native-sequence-import-'));
    workspaceRoot = join(scratchRoot, 'workspace');
    managedRoot = join(scratchRoot, 'managed-workspaces');
    mkdirSync(workspaceRoot, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'workspace',
      workspaceRoot,
      Date.now()
    );
  });

  afterEach(() => {
    db.close();
    rmSync(scratchRoot, { recursive: true, force: true });
  });

  it('recovers the first import from its saved identity after the project folder is lost', async () => {
    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      { db, managedRootDir: managedRoot }
    );
    expect(result.kind).toBe('imported');
    if (result.kind !== 'imported') throw new Error(JSON.stringify(result));
    const packageRoot = result.packageRoots[0];
    const marker = await readFile(sequencePackagePaths(packageRoot).metaPath, 'utf8');
    const doc = parseSequencePackageDocument(marker);
    const members = [doc.product.file, ...doc.members.map((member) => member.path)];
    const originals = await Promise.all(
      members.map((member) => readFile(join(packageRoot, member)))
    );
    const { id } = db.prepare('SELECT id FROM workspaces WHERE path=?').get(workspaceRoot) as {
      id: number;
    };
    await rename(workspaceRoot, join(scratchRoot, 'unavailable'));
    const destination = join(scratchRoot, 'restored');
    await restoreSavedFileSource(db, { workspaceId: id, entityId: doc.id, destination });
    expect(await readFile(sequencePackagePaths(destination).metaPath, 'utf8')).toBe(marker);
    expect(await Promise.all(members.map((member) => readFile(join(destination, member))))).toEqual(
      originals
    );
  });

  it('refuses a destination created after preparation and preserves its bytes', async () => {
    const looseTarget = join(workspaceRoot, 'imports', 'incoming.gb');
    const externalBytes = 'owned by another process\n';
    let injected = false;
    mkdirSync(join(workspaceRoot, 'imports'), { recursive: true });

    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      {
        db,
        managedRootDir: managedRoot,
        sequenceImportFileOps: {
          mkdir: async (destinationPath) => {
            if (!injected && destinationPath === looseTarget) {
              injected = true;
              writeFileSync(looseTarget, externalBytes);
            }
            await mkdir(destinationPath);
          },
        },
      }
    );

    expect(result).toMatchObject({
      kind: 'refused',
      code: 'IMPORT_TARGET_EXISTS',
      stateChanged: false,
      partialEffects: [],
    });
    expect(await readFile(looseTarget, 'utf8')).toBe(externalBytes);
    expect(existsSync(join(workspaceRoot, 'imports', 'incoming'))).toBe(false);
    expect(await readdir(join(workspaceRoot, 'imports'))).toEqual(['incoming.gb']);
  });

  it('refuses an already-present exact destination without changing it', async () => {
    const looseTarget = join(workspaceRoot, 'imports', 'incoming.gb');
    const externalBytes = 'pre-existing bytes\n';
    mkdirSync(join(workspaceRoot, 'imports'), { recursive: true });
    writeFileSync(looseTarget, externalBytes);

    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      { db, managedRootDir: managedRoot }
    );

    expect(result.kind).toBe('refused');
    expect(await readFile(looseTarget, 'utf8')).toBe(externalBytes);
    expect(existsSync(join(workspaceRoot, 'imports', 'incoming'))).toBe(false);
  });

  it('refuses a package root created after the loose destination is claimed', async () => {
    const packageRoot = join(workspaceRoot, 'imports', 'incoming');
    const outsidePath = join(packageRoot, 'outside.txt');

    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      {
        db,
        managedRootDir: managedRoot,
        sequencePackageMaterializer: async (sourcePath, ops, options) => {
          mkdirSync(packageRoot);
          writeFileSync(outsidePath, 'outside package claim\n');
          return materializeImportedSequencePackages(sourcePath, ops, options);
        },
      }
    );

    expect(result).toMatchObject({
      kind: 'refused',
      code: 'IMPORT_TARGET_EXISTS',
      stateChanged: false,
      partialEffects: [],
    });
    expect(await readFile(outsidePath, 'utf8')).toBe('outside package claim\n');
    expect(existsSync(join(workspaceRoot, 'imports', 'incoming.gb'))).toBe(false);
    expect(await readdir(join(workspaceRoot, 'imports'))).toEqual(['incoming']);
  });

  it('refuses an existing package and preserves its product and marker', async () => {
    const created = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      { db, managedRootDir: managedRoot }
    );
    if (created.kind !== 'imported') throw new Error(created.error);
    const packageRoot = created.packageRoots[0];
    if (!packageRoot) throw new Error('Expected a managed package.');
    const markerPath = sequencePackagePaths(packageRoot).metaPath;
    const productPath = created.packageProductPaths[0];
    if (!productPath) throw new Error('Expected a managed product.');
    const markerBytes = await readFile(markerPath);
    const productBytes = await readFile(productPath);

    const refused = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE.replace('incoming', 'second'),
        collisionPolicy: 'refuse',
      },
      { db, managedRootDir: managedRoot }
    );

    expect(refused).toMatchObject({
      kind: 'refused',
      code: 'IMPORT_TARGET_EXISTS',
      stateChanged: false,
    });
    expect(await readFile(markerPath)).toEqual(markerBytes);
    expect(await readFile(productPath)).toEqual(productBytes);
  });

  it('refuses replace when both a package and loose representation exist', async () => {
    const created = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      { db, managedRootDir: managedRoot }
    );
    if (created.kind !== 'imported') throw new Error(created.error);
    const packageRoot = created.packageRoots[0];
    if (!packageRoot) throw new Error('Expected a managed package.');
    const loosePath = join(workspaceRoot, 'imports', 'incoming.gb');
    writeFileSync(loosePath, 'outside loose representation\n');

    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE.replace('incoming', 'replacement'),
        collisionPolicy: 'replace',
      },
      { db, managedRootDir: managedRoot }
    );

    expect(result).toMatchObject({
      kind: 'refused',
      code: 'IMPORT_DUPLICATE_TARGET',
      stateChanged: false,
    });
    expect(await readFile(loosePath, 'utf8')).toBe('outside loose representation\n');
    expect(existsSync(packageRoot)).toBe(true);
  });

  it('publishes the requested package when the exact destination stays absent', async () => {
    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      { db, managedRootDir: managedRoot }
    );

    expect(result).toMatchObject({
      kind: 'imported',
      relPath: join('imports', 'incoming', 'incoming.gb'),
      committed: false,
      replaced: false,
      stateChanged: true,
    });
    expect(existsSync(join(workspaceRoot, 'imports', 'incoming', 'incoming.gb'))).toBe(true);
    expect(existsSync(join(workspaceRoot, 'imports', 'incoming', '.forge', 'plasmid.json'))).toBe(
      true
    );
    expect(existsSync(join(workspaceRoot, 'imports', 'incoming.gb'))).toBe(false);
    expect((await readdir(join(workspaceRoot, 'imports'))).sort()).toEqual(['incoming']);
  });

  it('keeps staged sequence bytes private while the logical destination is reserved', async () => {
    const looseTarget = join(workspaceRoot, 'imports', 'incoming.gb');
    let outsideWriteWasBlocked = false;

    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      {
        db,
        managedRootDir: managedRoot,
        sequencePackageMaterializer: async (stagePath, ops, options) => {
          try {
            await writeFile(looseTarget, 'outside in-place edit\n');
          } catch {
            outsideWriteWasBlocked = true;
          }
          expect(await readFile(stagePath, 'utf8')).toBe(VALID_SEQUENCE);
          return materializeImportedSequencePackages(stagePath, ops, options);
        },
      }
    );

    expect(outsideWriteWasBlocked).toBe(true);
    expect(result).toMatchObject({ kind: 'imported', stateChanged: true });
    expect(await readFile(join(workspaceRoot, 'imports', 'incoming', 'incoming.gb'), 'utf8')).toBe(
      VALID_SEQUENCE
    );
  });

  it('settles with explicit effects when an outside writer populates the reservation', async () => {
    const looseTarget = join(workspaceRoot, 'imports', 'incoming.gb');
    const outsidePath = join(looseTarget, 'outside.txt');

    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      {
        db,
        managedRootDir: managedRoot,
        sequencePackageMaterializer: async (stagePath, ops, options) => {
          await writeFile(outsidePath, 'outside reservation contents\n');
          return materializeImportedSequencePackages(stagePath, ops, options);
        },
      }
    );

    expect(result).toMatchObject({
      kind: 'failed',
      code: 'IMPORT_FAILED',
      stateChanged: true,
      partialEffects: [
        { kind: 'sequence-packages-created', count: 1 },
        { kind: 'sequence-import-recovery-retained' },
      ],
    });
    expect(await readFile(outsidePath, 'utf8')).toBe('outside reservation contents\n');
    expect(await readFile(join(workspaceRoot, 'imports', 'incoming', 'incoming.gb'), 'utf8')).toBe(
      VALID_SEQUENCE
    );
  });

  it('keeps exact no-clobber behavior when the filesystem cannot create hard links', async () => {
    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      {
        db,
        managedRootDir: managedRoot,
        sequencePackageFileOps: {
          writeMeta: async (path, content) => {
            await writeFile(path, content, { flag: 'wx' });
          },
          link: async () => {
            throw Object.assign(new Error('hard links unsupported'), { code: 'EPERM' });
          },
        },
      }
    );

    expect(result).toMatchObject({ kind: 'imported', stateChanged: true });
    expect(existsSync(join(workspaceRoot, 'imports', 'incoming', 'incoming.gb'))).toBe(true);
    expect(existsSync(join(workspaceRoot, 'imports', 'incoming.gb'))).toBe(false);
  });

  it('admits only one of two concurrent exact imports', async () => {
    const outcomes = await Promise.all([
      importSequenceContentIntoWorkspaceRoot(
        {
          targetRoot: workspaceRoot,
          relativePath: 'imports/incoming.gb',
          content: VALID_SEQUENCE,
          collisionPolicy: 'refuse',
        },
        { db, managedRootDir: managedRoot }
      ),
      importSequenceContentIntoWorkspaceRoot(
        {
          targetRoot: workspaceRoot,
          relativePath: 'imports/incoming.gb',
          content: VALID_SEQUENCE,
          collisionPolicy: 'refuse',
        },
        { db, managedRootDir: managedRoot }
      ),
    ]);

    expect(outcomes.map((result) => result.kind).sort()).toEqual(['imported', 'refused']);
    expect(existsSync(join(workspaceRoot, 'imports', 'incoming', 'incoming.gb'))).toBe(true);
    expect((await readdir(join(workspaceRoot, 'imports'))).sort()).toEqual(['incoming']);
  });

  it('keeps UI collision suffixing while using the same exclusive claim core', async () => {
    const mkdirSpy = vi.fn(async (path: string) => {
      await mkdir(path);
    });
    const deps = {
      db,
      managedRootDir: managedRoot,
      sequenceImportFileOps: { mkdir: mkdirSpy },
    };

    const first = await importContentIntoWorkspaceRoot(
      { targetRoot: workspaceRoot, fileName: 'incoming.gb', content: VALID_SEQUENCE },
      deps
    );
    const second = await importContentIntoWorkspaceRoot(
      { targetRoot: workspaceRoot, fileName: 'incoming.gb', content: VALID_SEQUENCE },
      deps
    );

    expect(first.relPath).toBe(join('incoming', 'incoming.gb'));
    expect(second.relPath).toBe(join('incoming (1)', 'incoming.gb'));
    expect(mkdirSpy).toHaveBeenCalled();
  });

  it('preserves the UI original-byte fallback when conversion is unavailable', async () => {
    const unsupported = '>protein record\nMEEPQSDPSV\n';

    const result = await importContentIntoWorkspaceRoot(
      { targetRoot: workspaceRoot, fileName: 'unknown.fasta', content: unsupported },
      { db, managedRootDir: managedRoot }
    );

    expect(result).toEqual({
      destPath: join(workspaceRoot, 'unknown.fasta'),
      relPath: 'unknown.fasta',
      committed: false,
    });
    expect(await readFile(result.destPath, 'utf8')).toBe(unsupported);
  });

  it('preserves the UI original bytes when package creation fails before consuming them', async () => {
    const original = 'original sequence container bytes\n';

    const result = await importContentIntoWorkspaceRoot(
      { targetRoot: workspaceRoot, fileName: 'unpackaged.gb', content: original },
      {
        db,
        managedRootDir: managedRoot,
        sequencePackageMaterializer: async () => {
          throw new Error('simulated package creation failure');
        },
      }
    );

    expect(result).toEqual({
      destPath: join(workspaceRoot, 'unpackaged.gb'),
      relPath: 'unpackaged.gb',
      committed: false,
    });
    expect(await readFile(result.destPath, 'utf8')).toBe(original);
    expect((await readdir(workspaceRoot)).sort()).toEqual(['unpackaged.gb']);
  });

  it('does not publish private staging bytes modified during loose fallback publication', async () => {
    const modified = VALID_SEQUENCE.replace('incoming', 'modified');

    await expect(
      importContentIntoWorkspaceRoot(
        { targetRoot: workspaceRoot, fileName: 'incoming.gb', content: VALID_SEQUENCE },
        {
          db,
          managedRootDir: managedRoot,
          sequencePackageMaterializer: async (stagePath) => ({
            packages: [],
            converted: false,
            untouchedPath: stagePath,
            skippedReason: 'simulated conversion refusal',
          }),
          sequenceImportFileOps: {
            link: async (sourcePath, destinationPath) => {
              await writeFile(sourcePath, modified);
              await link(sourcePath, destinationPath);
            },
          },
        }
      )
    ).rejects.toThrow(/IMPORT_TARGET_EXISTS/u);

    expect(existsSync(join(workspaceRoot, 'incoming.gb'))).toBe(false);
    expect(await readdir(workspaceRoot)).toEqual([]);
  });

  it('does not publish private staging bytes modified in place before packaging', async () => {
    await expect(
      importContentIntoWorkspaceRoot(
        { targetRoot: workspaceRoot, fileName: 'incoming.gb', content: VALID_SEQUENCE },
        {
          db,
          managedRootDir: managedRoot,
          sequencePackageMaterializer: async (stagePath) => {
            await writeFile(stagePath, VALID_SEQUENCE.replace('incoming', 'modified'));
            return {
              packages: [],
              converted: false,
              untouchedPath: stagePath,
              skippedReason: 'simulated conversion refusal',
            };
          },
        }
      )
    ).rejects.toThrow(/IMPORT_FAILED/u);

    expect(existsSync(join(workspaceRoot, 'incoming.gb'))).toBe(false);
    expect(existsSync(join(workspaceRoot, 'incoming'))).toBe(false);
    expect(await readdir(workspaceRoot)).toEqual([]);
  });

  it('preserves an existing UI package when its requested replacement cannot convert', async () => {
    const created = await importContentIntoWorkspaceRoot(
      { targetRoot: workspaceRoot, fileName: 'incoming.gb', content: VALID_SEQUENCE },
      { db, managedRootDir: managedRoot }
    );
    const markerPath = join(workspaceRoot, 'incoming', '.forge', 'plasmid.json');
    const markerBytes = await readFile(markerPath);
    const productBytes = await readFile(created.destPath);

    await expect(
      importContentIntoWorkspaceRoot(
        {
          targetRoot: workspaceRoot,
          fileName: 'incoming.fasta',
          content: '>protein record\nMEEPQSDPSV\n',
          dedup: { mode: 'replace', expectedRelPath: 'incoming/incoming.gb' },
        },
        { db, managedRootDir: managedRoot }
      )
    ).rejects.toThrow(/IMPORT_CONVERSION_REQUIRED/u);

    expect(await readFile(markerPath)).toEqual(markerBytes);
    expect(await readFile(created.destPath)).toEqual(productBytes);
    expect((await readdir(workspaceRoot)).sort()).toEqual(['incoming']);
  });

  it('refuses a UI replacement when the existing package product is missing', async () => {
    const created = await importContentIntoWorkspaceRoot(
      { targetRoot: workspaceRoot, fileName: 'incoming.gb', content: VALID_SEQUENCE },
      { db, managedRootDir: managedRoot }
    );
    const packageRoot = dirname(created.destPath);
    const markerPath = sequencePackagePaths(packageRoot).metaPath;
    const markerBytes = await readFile(markerPath);
    await unlink(created.destPath);

    await expect(
      importContentIntoWorkspaceRoot(
        {
          targetRoot: workspaceRoot,
          fileName: 'incoming.gb',
          content: VALID_SEQUENCE.replace('incoming', 'requested'),
          dedup: { mode: 'replace', expectedRelPath: 'incoming/incoming.gb' },
        },
        { db, managedRootDir: managedRoot }
      )
    ).rejects.toThrow(/IMPORT_PRODUCT_MISSING/u);

    expect(await readFile(markerPath)).toEqual(markerBytes);
    expect(existsSync(created.destPath)).toBe(false);
    expect((await readdir(packageRoot)).sort()).toEqual(['.forge']);
  });

  it('preserves an in-place marker edit during UI package replacement', async () => {
    const created = await importContentIntoWorkspaceRoot(
      { targetRoot: workspaceRoot, fileName: 'incoming.gb', content: VALID_SEQUENCE },
      { db, managedRootDir: managedRoot }
    );
    const packageRoot = dirname(created.destPath);
    const markerPath = sequencePackagePaths(packageRoot).metaPath;
    const markerIdentity = await lstat(markerPath);
    const outsideMarker = JSON.parse(await readFile(markerPath, 'utf8')) as { name: string };
    outsideMarker.name = 'outside UI marker edit';
    const outsideMarkerBytes = `${JSON.stringify(outsideMarker, null, 2)}\n`;
    let edited = false;

    await expect(
      importContentIntoWorkspaceRoot(
        {
          targetRoot: workspaceRoot,
          fileName: 'incoming.gb',
          content: VALID_SEQUENCE.replace('incoming', 'requested'),
          dedup: { mode: 'replace', expectedRelPath: 'incoming/incoming.gb' },
        },
        {
          db,
          managedRootDir: managedRoot,
          sequencePackageFileOps: {
            writeMeta: async (path, content) => {
              if (!edited) {
                edited = true;
                await writeFile(markerPath, outsideMarkerBytes);
                const editedIdentity = await lstat(markerPath);
                expect(editedIdentity.dev).toBe(markerIdentity.dev);
                expect(editedIdentity.ino).toBe(markerIdentity.ino);
              }
              await writeFile(path, content, { flag: 'wx' });
            },
          },
        }
      )
    ).rejects.toThrow(/IMPORT_TARGET_EXISTS/u);

    expect(edited).toBe(true);
    expect(await readFile(markerPath, 'utf8')).toBe(outsideMarkerBytes);
    expect((await readdir(workspaceRoot)).sort()).toEqual(['incoming']);
  });

  it('preserves an in-place product edit during UI package replacement', async () => {
    const created = await importContentIntoWorkspaceRoot(
      { targetRoot: workspaceRoot, fileName: 'incoming.gb', content: VALID_SEQUENCE },
      { db, managedRootDir: managedRoot }
    );
    const productIdentity = await lstat(created.destPath);
    const outsideBytes = VALID_SEQUENCE.replace('incoming', 'outside UI product edit');

    await expect(
      importContentIntoWorkspaceRoot(
        {
          targetRoot: workspaceRoot,
          fileName: 'incoming.gb',
          content: VALID_SEQUENCE.replace('incoming', 'requested'),
          dedup: { mode: 'replace', expectedRelPath: 'incoming/incoming.gb' },
        },
        {
          db,
          managedRootDir: managedRoot,
          sequencePackageMaterializer: async (stagePath, ops, options) => {
            await writeFile(created.destPath, outsideBytes);
            const editedIdentity = await lstat(created.destPath);
            expect(editedIdentity.dev).toBe(productIdentity.dev);
            expect(editedIdentity.ino).toBe(productIdentity.ino);
            return materializeImportedSequencePackages(stagePath, ops, options);
          },
        }
      )
    ).rejects.toThrow(/IMPORT_TARGET_EXISTS/u);

    expect(await readFile(created.destPath, 'utf8')).toBe(outsideBytes);
    expect((await readdir(workspaceRoot)).sort()).toEqual(['incoming']);
  });

  it('removes its staging and loose claim when strict conversion is refused', async () => {
    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/unknown.fasta',
        content: '>protein record\nMEEPQSDPSV\n',
        collisionPolicy: 'refuse',
      },
      { db, managedRootDir: managedRoot }
    );

    expect(result).toMatchObject({
      kind: 'refused',
      code: 'IMPORT_CONVERSION_REQUIRED',
      stateChanged: false,
    });
    expect(existsSync(join(workspaceRoot, 'imports'))).toBe(false);
  });

  it('restores the exact loose file when a strict replacement cannot convert', async () => {
    const loosePath = join(workspaceRoot, 'imports', 'incoming.fasta');
    const previousBytes = 'previous loose bytes\n';
    mkdirSync(dirname(loosePath), { recursive: true });
    writeFileSync(loosePath, previousBytes);

    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.fasta',
        content: '>protein record\nMEEPQSDPSV\n',
        collisionPolicy: 'replace',
      },
      { db, managedRootDir: managedRoot }
    );

    expect(result).toMatchObject({
      kind: 'refused',
      code: 'IMPORT_CONVERSION_REQUIRED',
      stateChanged: false,
    });
    expect(await readFile(loosePath, 'utf8')).toBe(previousBytes);
    expect(await readdir(join(workspaceRoot, 'imports'))).toEqual(['incoming.fasta']);
  });

  it('refuses an in-place edit while claiming a loose replacement and preserves its bytes', async () => {
    const loosePath = join(workspaceRoot, 'imports', 'incoming.gb');
    mkdirSync(dirname(loosePath), { recursive: true });
    writeFileSync(loosePath, VALID_SEQUENCE);
    const originalIdentity = await lstat(loosePath);
    const outsideBytes = VALID_SEQUENCE.replace('incoming', 'outside loose edit');
    let edited = false;

    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE.replace('incoming', 'requested'),
        collisionPolicy: 'replace',
      },
      {
        db,
        managedRootDir: managedRoot,
        sequenceImportFileOps: {
          rename: async (oldPath, newPath) => {
            if (!edited && oldPath === loosePath) {
              edited = true;
              await writeFile(loosePath, outsideBytes);
              const editedIdentity = await lstat(loosePath);
              expect(editedIdentity.dev).toBe(originalIdentity.dev);
              expect(editedIdentity.ino).toBe(originalIdentity.ino);
            }
            await rename(oldPath, newPath);
          },
        },
      }
    );

    expect(edited).toBe(true);
    expect(result).toMatchObject({
      kind: 'refused',
      code: 'IMPORT_TARGET_EXISTS',
      stateChanged: false,
    });
    expect(await readFile(loosePath, 'utf8')).toBe(outsideBytes);
    expect(await readdir(join(workspaceRoot, 'imports'))).toEqual(['incoming.gb']);
  });

  it('returns a typed no-change refusal for an invalid destination', async () => {
    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: '../escape.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      { db, managedRootDir: managedRoot }
    );

    expect(result).toMatchObject({
      kind: 'refused',
      code: 'IMPORT_INVALID_DESTINATION',
      stateChanged: false,
      partialEffects: [],
    });
    expect(await readdir(workspaceRoot)).toEqual([]);
  });

  it('retains recovery bytes and reports unknown state when ownership is lost', async () => {
    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      {
        db,
        managedRootDir: managedRoot,
        sequencePackageMaterializer: async (stagePath) => {
          await rename(stagePath, `${stagePath}.retained`);
          throw new Error('simulated ownership loss');
        },
      }
    );

    expect(result).toMatchObject({
      kind: 'failed',
      code: 'IMPORT_FAILED',
      stateChanged: 'unknown',
      partialEffects: [{ kind: 'sequence-import-recovery-retained' }],
    });
    const importEntries = await readdir(join(workspaceRoot, 'imports'));
    expect(importEntries).toHaveLength(1);
    expect(importEntries[0]).toMatch(/^\.dnaforge-sequence-import-/u);
    expect(
      await readFile(join(workspaceRoot, 'imports', importEntries[0], 'source.retained'), 'utf8')
    ).toBe(VALID_SEQUENCE);
    expect(existsSync(join(workspaceRoot, 'imports', 'incoming.gb'))).toBe(false);
  });

  it('refuses replacement when the package product is missing', async () => {
    const created = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      { db, managedRootDir: managedRoot }
    );
    if (created.kind !== 'imported') throw new Error(created.error);
    const productPath = created.packageProductPaths[0];
    if (!productPath) throw new Error('Expected a managed product.');
    await unlink(productPath);

    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'replace',
      },
      { db, managedRootDir: managedRoot }
    );

    expect(result).toMatchObject({
      kind: 'refused',
      code: 'IMPORT_PRODUCT_MISSING',
      stateChanged: false,
    });
  });

  it('refuses replacement when the package marker names another product', async () => {
    const created = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      { db, managedRootDir: managedRoot }
    );
    if (created.kind !== 'imported') throw new Error(created.error);
    const packageRoot = created.packageRoots[0];
    if (!packageRoot) throw new Error('Expected a managed package.');
    const markerPath = sequencePackagePaths(packageRoot).metaPath;
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
      product: { file: string };
    };
    marker.product.file = 'different.gb';
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'replace',
      },
      { db, managedRootDir: managedRoot }
    );

    expect(result).toMatchObject({
      kind: 'refused',
      code: 'IMPORT_PRODUCT_MISMATCH',
      stateChanged: false,
    });
  });

  it('refuses a package swapped after replacement validation and preserves the swap', async () => {
    const created = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      { db, managedRootDir: managedRoot }
    );
    if (created.kind !== 'imported') throw new Error(created.error);
    const packageRoot = created.packageRoots[0];
    if (!packageRoot) throw new Error('Expected a managed package.');
    const originalPaths = sequencePackagePaths(packageRoot);
    const replacementProduct = join(packageRoot, 'different.gb');
    const outsideBytes = VALID_SEQUENCE.replace('incoming', 'outside');

    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE.replace('incoming', 'requested'),
        collisionPolicy: 'replace',
      },
      {
        db,
        managedRootDir: managedRoot,
        sequencePackageMaterializer: async (stagePath, ops, options) => {
          const marker = JSON.parse(await readFile(originalPaths.metaPath, 'utf8')) as {
            id: string;
            name: string;
            product: { file: string };
          };
          marker.id = 'outside-package-id';
          marker.name = 'outside package';
          marker.product.file = 'different.gb';
          await rename(originalPaths.productPath, replacementProduct);
          await writeFile(replacementProduct, outsideBytes);
          await writeFile(originalPaths.metaPath, `${JSON.stringify(marker, null, 2)}\n`);
          return materializeImportedSequencePackages(stagePath, ops, options);
        },
      }
    );

    expect(result).toMatchObject({
      kind: 'refused',
      code: 'IMPORT_TARGET_EXISTS',
      stateChanged: false,
    });
    expect(await readFile(replacementProduct, 'utf8')).toBe(outsideBytes);
    expect(
      parseSequencePackageDocument(await readFile(originalPaths.metaPath, 'utf8'))
    ).toMatchObject({
      id: 'outside-package-id',
      product: { file: 'different.gb' },
    });
    expect(existsSync(originalPaths.productPath)).toBe(false);
  });

  it('refuses a product replaced after package validation and preserves its bytes', async () => {
    const created = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      { db, managedRootDir: managedRoot }
    );
    if (created.kind !== 'imported') throw new Error(created.error);
    const packageRoot = created.packageRoots[0];
    if (!packageRoot) throw new Error('Expected a managed package.');
    const packagePaths = sequencePackagePaths(packageRoot);
    const outsideBytes = VALID_SEQUENCE.replace('incoming', 'outside product');
    const outsideReplacement = join(workspaceRoot, 'outside-product-replacement.gb');
    await writeFile(outsideReplacement, outsideBytes);

    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE.replace('incoming', 'requested'),
        collisionPolicy: 'replace',
      },
      {
        db,
        managedRootDir: managedRoot,
        sequencePackageMaterializer: async (stagePath, ops, options) => {
          await rename(outsideReplacement, packagePaths.productPath);
          return materializeImportedSequencePackages(stagePath, ops, options);
        },
      }
    );

    expect(result).toMatchObject({
      kind: 'refused',
      code: 'IMPORT_TARGET_EXISTS',
      stateChanged: false,
    });
    expect(await readFile(packagePaths.productPath, 'utf8')).toBe(outsideBytes);
    expect(existsSync(join(workspaceRoot, 'imports', 'incoming.gb'))).toBe(false);
  });

  it('refuses an in-place product edit after package validation and preserves its bytes', async () => {
    const created = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      { db, managedRootDir: managedRoot }
    );
    if (created.kind !== 'imported') throw new Error(created.error);
    const packageRoot = created.packageRoots[0];
    if (!packageRoot) throw new Error('Expected a managed package.');
    const packagePaths = sequencePackagePaths(packageRoot);
    const originalIdentity = await lstat(packagePaths.productPath);
    const outsideBytes = VALID_SEQUENCE.replace('incoming', 'in-place outside product');

    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE.replace('incoming', 'requested'),
        collisionPolicy: 'replace',
      },
      {
        db,
        managedRootDir: managedRoot,
        sequencePackageMaterializer: async (stagePath, ops, options) => {
          await writeFile(packagePaths.productPath, outsideBytes);
          const editedIdentity = await lstat(packagePaths.productPath);
          expect(editedIdentity.dev).toBe(originalIdentity.dev);
          expect(editedIdentity.ino).toBe(originalIdentity.ino);
          return materializeImportedSequencePackages(stagePath, ops, options);
        },
      }
    );

    expect(result).toMatchObject({
      kind: 'refused',
      code: 'IMPORT_TARGET_EXISTS',
      stateChanged: false,
    });
    expect(await readFile(packagePaths.productPath, 'utf8')).toBe(outsideBytes);
    expect(existsSync(join(workspaceRoot, 'imports', 'incoming.gb'))).toBe(false);
  });

  it('refuses a product replaced while package staging is running', async () => {
    const created = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      { db, managedRootDir: managedRoot }
    );
    if (created.kind !== 'imported') throw new Error(created.error);
    const packageRoot = created.packageRoots[0];
    if (!packageRoot) throw new Error('Expected a managed package.');
    const packagePaths = sequencePackagePaths(packageRoot);
    const outsideBytes = VALID_SEQUENCE.replace('incoming', 'late outside product');
    const outsideReplacement = join(workspaceRoot, 'late-outside-product-replacement.gb');
    await writeFile(outsideReplacement, outsideBytes);

    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE.replace('incoming', 'requested'),
        collisionPolicy: 'replace',
      },
      {
        db,
        managedRootDir: managedRoot,
        sequencePackageFileOps: {
          writeMeta: async (path, content) => {
            await rename(outsideReplacement, packagePaths.productPath);
            await writeFile(path, content, { flag: 'wx' });
          },
        },
      }
    );

    expect(result).toMatchObject({
      kind: 'refused',
      code: 'IMPORT_TARGET_EXISTS',
      stateChanged: false,
    });
    expect(await readFile(packagePaths.productPath, 'utf8')).toBe(outsideBytes);
    expect(existsSync(join(workspaceRoot, 'imports', 'incoming.gb'))).toBe(false);
  });

  it('refuses an in-place marker edit while package staging is running', async () => {
    const created = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      { db, managedRootDir: managedRoot }
    );
    if (created.kind !== 'imported') throw new Error(created.error);
    const packageRoot = created.packageRoots[0];
    if (!packageRoot) throw new Error('Expected a managed package.');
    const packagePaths = sequencePackagePaths(packageRoot);
    const originalMarkerIdentity = await lstat(packagePaths.metaPath);
    const outsideMarker = JSON.parse(await readFile(packagePaths.metaPath, 'utf8')) as {
      name: string;
    };
    outsideMarker.name = 'outside marker edit';
    const outsideMarkerBytes = `${JSON.stringify(outsideMarker, null, 2)}\n`;
    let edited = false;

    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE.replace('incoming', 'requested'),
        collisionPolicy: 'replace',
      },
      {
        db,
        managedRootDir: managedRoot,
        sequencePackageFileOps: {
          writeMeta: async (path, content) => {
            if (!edited) {
              edited = true;
              await writeFile(packagePaths.metaPath, outsideMarkerBytes);
              const editedIdentity = await lstat(packagePaths.metaPath);
              expect(editedIdentity.dev).toBe(originalMarkerIdentity.dev);
              expect(editedIdentity.ino).toBe(originalMarkerIdentity.ino);
            }
            await writeFile(path, content, { flag: 'wx' });
          },
        },
      }
    );

    expect(edited).toBe(true);
    expect(result).toMatchObject({
      kind: 'refused',
      code: 'IMPORT_TARGET_EXISTS',
      stateChanged: false,
    });
    expect(await readFile(packagePaths.metaPath, 'utf8')).toBe(outsideMarkerBytes);
    expect(existsSync(join(workspaceRoot, 'imports', 'incoming.gb'))).toBe(false);
  });

  it('refuses an in-place generated-member edit after package validation', async () => {
    const created = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      { db, managedRootDir: managedRoot }
    );
    if (created.kind !== 'imported') throw new Error(created.error);
    const packageRoot = created.packageRoots[0];
    if (!packageRoot) throw new Error('Expected a managed package.');
    const packagePaths = sequencePackagePaths(packageRoot);
    const primerRelativePath = 'primers/incoming.primers.csv';
    const primerPath = join(packageRoot, primerRelativePath);
    mkdirSync(dirname(primerPath), { recursive: true });
    writeFileSync(primerPath, 'original generated member\n');
    const marker = JSON.parse(await readFile(packagePaths.metaPath, 'utf8')) as Record<
      string,
      unknown
    >;
    marker.assembly = {
      accepted: { id: 'previous-assembly' },
      primers: { csv: primerRelativePath },
    };
    await writeFile(packagePaths.metaPath, `${JSON.stringify(marker, null, 2)}\n`);
    const primerIdentity = await lstat(primerPath);
    const outsideBytes = 'outside generated-member edit\n';

    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE.replace('incoming', 'requested'),
        collisionPolicy: 'replace',
      },
      {
        db,
        managedRootDir: managedRoot,
        sequencePackageMaterializer: async (stagePath, ops, options) => {
          await writeFile(primerPath, outsideBytes);
          const editedIdentity = await lstat(primerPath);
          expect(editedIdentity.dev).toBe(primerIdentity.dev);
          expect(editedIdentity.ino).toBe(primerIdentity.ino);
          return materializeImportedSequencePackages(stagePath, ops, options);
        },
      }
    );

    expect(result).toMatchObject({
      kind: 'refused',
      code: 'IMPORT_TARGET_EXISTS',
      stateChanged: false,
    });
    expect(await readFile(primerPath, 'utf8')).toBe(outsideBytes);
    expect(existsSync(join(workspaceRoot, 'imports', 'incoming.gb'))).toBe(false);
  });

  it('refuses replacement when the package marker is invalid', async () => {
    const packageRoot = join(workspaceRoot, 'imports', 'incoming');
    mkdirSync(join(packageRoot, '.forge'), { recursive: true });
    writeFileSync(join(packageRoot, '.forge', 'plasmid.json'), '{invalid');

    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'replace',
      },
      { db, managedRootDir: managedRoot }
    );

    expect(result).toMatchObject({
      kind: 'refused',
      code: 'IMPORT_INVALID_PACKAGE',
      stateChanged: false,
    });
    expect(await readFile(join(packageRoot, '.forge', 'plasmid.json'), 'utf8')).toBe('{invalid');
  });

  it('replaces a valid package without changing its stable package identity', async () => {
    const created = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      { db, managedRootDir: managedRoot }
    );
    if (created.kind !== 'imported') throw new Error(created.error);
    const packageRoot = created.packageRoots[0];
    if (!packageRoot) throw new Error('Expected the native import to return its package root.');
    const markerPath = sequencePackagePaths(packageRoot).metaPath;
    const originalId = parseSequencePackageDocument(await readFile(markerPath, 'utf8')).id;
    const replacement = VALID_SEQUENCE.replace('incoming', 'replacement');

    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: replacement,
        collisionPolicy: 'replace',
      },
      { db, managedRootDir: managedRoot }
    );

    expect(result).toMatchObject({ kind: 'imported', replaced: true });
    expect(parseSequencePackageDocument(await readFile(markerPath, 'utf8')).id).toBe(originalId);
    expect(await readFile(join(packageRoot, 'incoming.gb'), 'utf8')).toBe(replacement);
    expect(existsSync(join(workspaceRoot, 'imports', 'incoming (1)'))).toBe(false);
  });

  it('reports a durable package as a partial effect when the managed commit fails', async () => {
    writeFileSync(join(workspaceRoot, MANAGED_WORKSPACE_MARKER), '{}');

    const result = await importSequenceContentIntoWorkspaceRoot(
      {
        targetRoot: workspaceRoot,
        relativePath: 'imports/incoming.gb',
        content: VALID_SEQUENCE,
        collisionPolicy: 'refuse',
      },
      {
        db,
        managedRootDir: managedRoot,
        commitAllIfDirty: async () => {
          throw new Error('simulated Git failure');
        },
      }
    );

    expect(result).toMatchObject({
      kind: 'failed',
      code: 'IMPORT_COMMIT_FAILED',
      stateChanged: true,
      partialEffects: [{ kind: 'sequence-packages-created', count: 1 }],
    });
    expect(existsSync(join(workspaceRoot, 'imports', 'incoming', 'incoming.gb'))).toBe(true);
  });
});
