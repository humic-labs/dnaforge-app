import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import type Database from 'better-sqlite3';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import {
  importContentIntoWorkspaceRoot,
  importFileIntoWorkspaceRoot,
  importIntoManagedWorkspaceRepo,
} from './import';
import { resolveHeadCommit } from './index';

describe('importFileIntoWorkspaceRoot dedup modes ', () => {
  let db: Database.Database;
  let tmp: string;
  let managedRoot: string;
  let root: string;

  const ORIGINAL_REL = join('pUC19', 'pUC19.gb');

  beforeEach(async () => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    tmp = mkdtempSync(join(tmpdir(), 'wp-dedup-'));
    managedRoot = join(tmp, 'managed');
    const source = join(tmp, 'ws');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'pUC19.gb'), 'LOCUS ORIGINAL 2686 bp\n');
    const managed = await importIntoManagedWorkspaceRepo(source, {
      db,
      managedRootDir: managedRoot,
    });
    root = managed.repoPath;
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function incoming(name: string, content: string): string {
    const dir = mkdtempSync(join(tmp, 'src-'));
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  }

  it('replace OVERWRITES the same-named file with no `name (1)` twin, single new commit', async () => {
    const before = await resolveHeadCommit(root);
    const src = incoming('pUC19.gb', 'LOCUS REPLACED 111 bp\n');
    const res = await importFileIntoWorkspaceRoot(
      {
        targetRoot: root,
        sourcePath: src,
        dedup: { mode: 'replace', expectedRelPath: ORIGINAL_REL },
      },
      { db, managedRootDir: managedRoot }
    );
    expect(res.relPath).toBe(join('pUC19', 'pUC19.gb'));
    expect(res.replaced).toBe(true);
    expect(readFileSync(join(root, 'pUC19', 'pUC19.gb'), 'utf8')).toContain('REPLACED');
    expect(existsSync(join(root, 'pUC19 (1).gb'))).toBe(false);
    expect(existsSync(join(root, 'pUC19', 'pUC19 (1).gb'))).toBe(false);
    expect(res.committed).toBe(true);
    expect(await resolveHeadCommit(root)).not.toBe(before);
  });

  it('content-authoritative Replace also uses the package transaction', async () => {
    const packageRoot = join(root, 'pUC19');
    const markerPath = join(packageRoot, '.forge', 'plasmid.json');
    const primerPath = join(packageRoot, 'primers', 'pUC19.primers.csv');
    const userAsset = join(packageRoot, 'assets', 'gel.txt');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    marker.product = {
      file: 'pUC19.gb',
      sequenceChecksum: 'sha256:stale-sequence',
      genBankChecksum: 'sha256:stale-genbank',
    };
    marker.assembly = {
      accepted: { designId: 'stale-design' },
      primers: { csv: 'primers/pUC19.primers.csv' },
    };
    mkdirSync(join(packageRoot, 'primers'), { recursive: true });
    mkdirSync(join(packageRoot, 'assets'), { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    writeFileSync(primerPath, 'stale primer export');
    writeFileSync(userAsset, 'IRREPLACEABLE GEL');

    const result = await importContentIntoWorkspaceRoot(
      {
        targetRoot: root,
        fileName: 'pUC19.gb',
        content: 'LOCUS CONTENT_REPLACED 222 bp\n',
        dedup: { mode: 'replace', expectedRelPath: ORIGINAL_REL },
      },
      { db, managedRootDir: managedRoot }
    );

    expect(result.replaced).toBe(true);
    expect(readFileSync(join(root, ORIGINAL_REL), 'utf8')).toContain('CONTENT_REPLACED');
    const nextMarker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      id: string;
      product: Record<string, unknown>;
      assembly?: unknown;
    };
    expect(nextMarker.id).toBe(marker.id);
    expect(nextMarker.assembly).toBeUndefined();
    expect(nextMarker.product).toEqual({ file: 'pUC19.gb' });
    expect(existsSync(primerPath)).toBe(false);
    expect(readFileSync(userAsset, 'utf8')).toBe('IRREPLACEABLE GEL');
  });

  it('skip writes NOTHING and does not commit', async () => {
    const before = await resolveHeadCommit(root);
    const src = incoming('pUC19.gb', 'LOCUS ORIGINAL 2686 bp\n');
    const res = await importFileIntoWorkspaceRoot(
      { targetRoot: root, sourcePath: src, dedup: { mode: 'skip', expectedRelPath: ORIGINAL_REL } },
      { db, managedRootDir: managedRoot }
    );
    expect(res.skipped).toBe(true);
    expect(res.committed).toBe(false);
    expect(existsSync(join(root, 'pUC19 (1).gb'))).toBe(false);
    expect(readFileSync(join(root, ORIGINAL_REL), 'utf8')).toContain('ORIGINAL');
    expect(await resolveHeadCommit(root)).toBe(before);
  });

  it('keep-both keeps the legacy safe-rename', async () => {
    const src = incoming('pUC19.gb', 'LOCUS OTHER 222 bp\n');
    const res = await importFileIntoWorkspaceRoot(
      { targetRoot: root, sourcePath: src, dedup: { mode: 'keep-both' } },
      { db, managedRootDir: managedRoot }
    );
    expect(res.relPath).toBe(join('pUC19 (1)', 'pUC19.gb'));
    expect(readFileSync(join(root, ORIGINAL_REL), 'utf8')).toContain('ORIGINAL');
    expect(readFileSync(join(root, 'pUC19 (1)', 'pUC19.gb'), 'utf8')).toContain('OTHER');
  });

  it('replace of a missing source LEAVES THE ORIGINAL intact (atomicity — never delete-first)', async () => {
    await expect(
      importFileIntoWorkspaceRoot(
        {
          targetRoot: root,
          sourcePath: join(tmp, 'does-not-exist.gb'),
          dedup: { mode: 'replace', expectedRelPath: ORIGINAL_REL },
        },
        { db, managedRootDir: managedRoot }
      )
    ).rejects.toThrow();
    expect(readFileSync(join(root, ORIGINAL_REL), 'utf8')).toContain('ORIGINAL');
  });

  it.each(['file', 'content'] as const)(
    'rejects renderer-controlled expectedRelPath traversal before the %s route mutates outside the workspace root',
    async (route) => {
      const outsideRoot = join(root, '..', 'outside');
      const outsideFile = join(outsideRoot, 'victim.gb');
      mkdirSync(outsideRoot, { recursive: true });
      writeFileSync(outsideFile, 'IRREPLACEABLE OUTSIDE FILE');
      const expectedRelPath = join('..', 'outside', 'victim.gb');

      const operation =
        route === 'file'
          ? importFileIntoWorkspaceRoot(
              {
                targetRoot: root,
                sourcePath: incoming('victim.gb', 'LOCUS ATTACKER_FILE 4 bp\n'),
                dedup: { mode: 'replace', expectedRelPath },
              },
              { db, managedRootDir: managedRoot }
            )
          : importContentIntoWorkspaceRoot(
              {
                targetRoot: root,
                fileName: 'victim.gb',
                content: 'LOCUS ATTACKER_CONTENT 4 bp\n',
                dedup: { mode: 'replace', expectedRelPath },
              },
              { db, managedRootDir: managedRoot }
            );

      await expect(operation).rejects.toThrow(/outside|relative|escape|target root/i);
      expect(readFileSync(outsideFile, 'utf8')).toBe('IRREPLACEABLE OUTSIDE FILE');
    }
  );

  it.each(['file', 'content'] as const)(
    'rejects a renderer-controlled expectedRelPath whose existing parent symlink escapes during the %s route',
    async (route) => {
      const outsideRoot = join(root, '..', 'physical-outside');
      const outsideFile = join(outsideRoot, 'victim.gb');
      mkdirSync(outsideRoot, { recursive: true });
      writeFileSync(outsideFile, 'IRREPLACEABLE PHYSICAL OUTSIDE FILE');
      symlinkSync(outsideRoot, join(root, 'escape'), 'dir');

      const operation =
        route === 'file'
          ? importFileIntoWorkspaceRoot(
              {
                targetRoot: root,
                sourcePath: incoming('victim.gb', 'LOCUS ATTACKER_FILE 4 bp\n'),
                dedup: { mode: 'replace', expectedRelPath: join('escape', 'victim.gb') },
              },
              { db, managedRootDir: managedRoot }
            )
          : importContentIntoWorkspaceRoot(
              {
                targetRoot: root,
                fileName: 'victim.gb',
                content: 'LOCUS ATTACKER_CONTENT 4 bp\n',
                dedup: { mode: 'replace', expectedRelPath: join('escape', 'victim.gb') },
              },
              { db, managedRootDir: managedRoot }
            );

      await expect(operation).rejects.toThrow(/outside|symlink|escape|target root/i);
      expect(readFileSync(outsideFile, 'utf8')).toBe('IRREPLACEABLE PHYSICAL OUTSIDE FILE');
    }
  );

  it('replaces a leaf symlink itself without following or mutating its outside referent', async () => {
    const outsideRoot = join(root, '..', 'leaf-referent');
    const outsideFile = join(outsideRoot, 'victim.gb');
    mkdirSync(outsideRoot, { recursive: true });
    writeFileSync(outsideFile, 'IRREPLACEABLE LEAF REFERENT');
    symlinkSync(outsideFile, join(root, 'linked.gb'));

    const result = await importContentIntoWorkspaceRoot(
      {
        targetRoot: root,
        fileName: 'linked.gb',
        content: 'LOCUS SAFE_REPLACEMENT 4 bp\n',
        dedup: { mode: 'replace', expectedRelPath: 'linked.gb' },
      },
      { db, managedRootDir: managedRoot }
    );

    expect(result.replaced).toBe(true);
    expect(readFileSync(result.destPath, 'utf8')).toContain('SAFE_REPLACEMENT');
    expect(readFileSync(outsideFile, 'utf8')).toBe('IRREPLACEABLE LEAF REFERENT');
  });

  it('no dedup field → legacy keep-both rename (back-compat)', async () => {
    const src = incoming('pUC19.gb', 'LOCUS LEGACY 333 bp\n');
    const res = await importFileIntoWorkspaceRoot(
      { targetRoot: root, sourcePath: src },
      { db, managedRootDir: managedRoot }
    );
    expect(res.relPath).toBe(join('pUC19 (1)', 'pUC19.gb'));
  });
});
