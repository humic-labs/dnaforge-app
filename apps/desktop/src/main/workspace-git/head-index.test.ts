import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireQuickLookRendererMutationLease,
  beginQuickLookPromotionWrite,
  commitAllIfDirty,
  commitOwnedPathsIfDirty,
  hasActiveQuickLookPromotion,
  initManagedRepo,
  listFilesAtHead,
  readFileAtHead,
  resolveHeadCommit,
  withManagedWorkspaceMutationLock,
  withQuickLookMainMutationLock,
} from './index';
import { collectManagedCatalogHeadIndex, collectManagedHeadIndex } from './head-index';
import { buildDefaultMolecularDocument } from '../../shared/default-molecular-view';
import { serializeMolecularDocument } from '../../shared/molecular-document';

describe('collectManagedHeadIndex (S3 main half)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wphead-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty index for a repo with no commits', async () => {
    await initManagedRepo(dir);
    const index = await collectManagedHeadIndex(dir);
    expect(index.headCommit).toBeNull();
    expect(index.files).toEqual([]);
  });

  it('lists every tracked blob at HEAD with its git oid + size, including nested paths', async () => {
    await initManagedRepo(dir);
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'pUC19.gb'), 'LOCUS pUC19 2686 bp\n');
    writeFileSync(join(dir, 'sub', 'genome.fasta'), '>seq\nACGT\n');
    await commitAllIfDirty(dir, 'add');

    const index = await collectManagedHeadIndex(dir);
    expect(index.headCommit).toMatch(/^[0-9a-f]{40}$/);
    const byPath = Object.fromEntries(index.files.map((f) => [f.relPath, f]));
    expect(Object.keys(byPath).sort()).toEqual(
      expect.arrayContaining(['pUC19/pUC19.gb', 'pUC19/.forge/plasmid.json', 'sub/genome.fasta'])
    );
    expect(byPath['pUC19.gb']).toBeUndefined();
    expect(byPath['pUC19/pUC19.gb'].oid).toMatch(/^[0-9a-f]{40}$/);
    expect(byPath['pUC19/pUC19.gb'].sizeBytes).toBe('LOCUS pUC19 2686 bp\n'.length);
    expect(byPath['sub/genome.fasta'].sizeBytes).toBe('>seq\nACGT\n'.length);
  });

  it('packages a loose GenBank an agent dropped, then commits the package into HEAD', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'from-ncbi.gb'), 'LOCUS from-ncbi 12 bp DNA\n//\n');

    const index = await collectManagedHeadIndex(dir);
    const paths = index.files.map((f) => f.relPath);
    expect(paths).toContain('from-ncbi/from-ncbi.gb');
    expect(paths).toContain('from-ncbi/.forge/plasmid.json');
    expect(paths).not.toContain('from-ncbi.gb');
  });

  it('reports how many loose files the heal converted so the tree can refresh', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'loose.gb'), 'LOCUS loose 12 bp DNA\n//\n');

    const first = await collectManagedCatalogHeadIndex(dir, []);
    const second = await collectManagedCatalogHeadIndex(dir, []);

    expect(first.healedFileCount).toBe(1);
    expect(second.healedFileCount).toBe(0);
  });

  it('keeps the complete legacy compute tree readable across every indexing pass', async () => {
    await initManagedRepo(dir);
    const folder = join(dir, 'compute', 'boltz', 'r1');
    mkdirSync(join(folder, 'nested'), { recursive: true });
    const coordinates = 'HEADER    TEST\nEND\n';
    const view = serializeMolecularDocument(
      await buildDefaultMolecularDocument({
        name: 'legacy.pdb',
        format: 'pdb',
        text: coordinates,
        createdAt: 1,
        documentId: '11111111-1111-4111-8111-111111111111',
        referenceId: '22222222-2222-4222-8222-222222222222',
      })
    );
    const files = {
      'compute-job.json': Buffer.from('{"provider":"boltz","remoteId":"r1"}'),
      'result.gb': Buffer.from('LOCUS result 12 bp DNA\n//\n'),
      'model.pdb': Buffer.from(coordinates),
      'nested/secondary.gb': Buffer.from('LOCUS secondary 12 bp DNA\n//\n'),
      'nested/model.cif': Buffer.from('data_x\n#\n'),
      'nested/evidence.bin': Buffer.from([0, 255, 4]),
      'legacy.pdb.dnaforge-molecular.json': Buffer.from(view),
    };
    for (const [path, bytes] of Object.entries(files)) writeFileSync(join(folder, path), bytes);
    const removed: string[] = [];
    const options = {
      removeCoordinateSource: async (path: string) => {
        removed.push(path);
      },
    };
    const first = await collectManagedCatalogHeadIndex(dir, [], options);
    const second = await collectManagedCatalogHeadIndex(dir, [], options);
    expect(first.healedFileCount).toBe(0);
    expect(second.headCommit).toBe(first.headCommit);
    expect(second.files).toEqual(first.files);
    expect(removed).toEqual([]);
    for (const [path, bytes] of Object.entries(files)) {
      expect(readFileSync(join(folder, path))).toEqual(bytes);
      expect(await readFileAtHead(dir, `compute/boltz/r1/${path}`)).toEqual(bytes);
    }
    expect((await collectManagedHeadIndex(dir)).files.map((file) => file.relPath).sort()).toEqual(
      Object.keys(files)
        .map((path) => `compute/boltz/r1/${path}`)
        .sort()
    );
    expect(first.files.map((file) => file.relPath)).toContain('compute/boltz/r1/result.gb');
    expect(first.files.map((file) => file.relPath)).toContain('compute/boltz/r1/model.pdb');
  });

  it('does not move native or source-evidence sequences in an unlocked Benchling projection', async () => {
    await initManagedRepo(dir);
    const objectRoot = join(dir, 'Benchling Imports', 'Sequence__seq_1');
    mkdirSync(join(objectRoot, 'source'), { recursive: true });
    mkdirSync(join(dir, '.dnaforge', 'migration'), { recursive: true });
    writeFileSync(join(objectRoot, 'Sequence__seq_1.gb'), 'LOCUS editable 4 bp DNA\n//\n');
    writeFileSync(
      join(objectRoot, 'source', 'benchling-original.gb'),
      'LOCUS evidence 4 bp DNA\n//\n'
    );
    writeFileSync(
      join(dir, '.dnaforge', 'migration', 'workspace.json'),
      `${JSON.stringify({
        schema: 'dnaforge.benchling-migration-workspace.v1',
        workspaceId: 'workspace-1',
        runId: 'migration-workspace-1',
        status: 'unlocked',
      })}\n`
    );
    await commitAllIfDirty(dir, 'native Benchling projection');

    const index = await collectManagedHeadIndex(dir);
    const paths = index.files.map((file) => file.relPath);

    expect(paths).toContain('Benchling Imports/Sequence__seq_1/Sequence__seq_1.gb');
    expect(paths).toContain('Benchling Imports/Sequence__seq_1/source/benchling-original.gb');
    expect(paths).not.toContain(
      'Benchling Imports/Sequence__seq_1/Sequence__seq_1/Sequence__seq_1.gb'
    );
    expect(paths).not.toContain(
      'Benchling Imports/Sequence__seq_1/source/benchling-original/benchling-original.gb'
    );
  });

  it('refuses to index a locked Benchling migration workspace', async () => {
    await initManagedRepo(dir);
    mkdirSync(join(dir, '.dnaforge', 'migration'), { recursive: true });
    writeFileSync(
      join(dir, '.dnaforge', 'migration', 'workspace.json'),
      `${JSON.stringify({
        schema: 'dnaforge.benchling-migration-workspace.v1',
        workspaceId: 'workspace-1',
        runId: 'migration-workspace-1',
        status: 'locked',
      })}\n`
    );
    await commitAllIfDirty(dir, 'locked Benchling projection');

    await expect(collectManagedHeadIndex(dir)).rejects.toThrow('migration workspace is locked');
  });

  it('auto-commits working-tree drift before reading HEAD (HEAD becomes the single truth)', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'a.gb'), 'LOCUS a 1 bp\n');
    await commitAllIfDirty(dir, 'first');

    writeFileSync(join(dir, 'a.gb'), 'LOCUS a 2 bp\n');
    writeFileSync(join(dir, 'b.gb'), 'LOCUS b 1 bp\n');

    const index = await collectManagedHeadIndex(dir);
    const paths = index.files.map((f) => f.relPath).sort();
    expect(paths).toEqual(
      expect.arrayContaining(['a/.forge/plasmid.json', 'a/a.gb', 'b/.forge/plasmid.json', 'b/b.gb'])
    );
    expect(paths).not.toContain('a.gb');
    expect(paths).not.toContain('b.gb');

    const edited = await collectManagedHeadIndex(dir);
    expect(edited.headCommit).toBe(index.headCommit);
  });

  it('reads HEAD without healing or committing during post-replica projection', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'tracked.txt'), 'tracked\n');
    await commitAllIfDirty(dir, 'baseline');
    writeFileSync(join(dir, 'uncommitted.gb'), 'LOCUS uncommitted 1 bp\n');
    writeFileSync(join(dir, 'tracked.txt'), 'external working bytes with a different length\n');

    const index = await collectManagedCatalogHeadIndex(dir, ['tracked.txt'], {
      healWorkingTree: false,
    });

    expect(index.files.map((file) => file.relPath)).not.toContain('uncommitted.gb');
    expect(index.scannedFileCount).toBe(1);
    expect(index.files[0].sizeBytes).toBe(Buffer.byteLength('tracked\n'));
    expect(readFileSync(join(dir, 'tracked.txt'), 'utf8')).toBe(
      'external working bytes with a different length\n'
    );
    rmSync(join(dir, 'tracked.txt'));
    const second = await collectManagedCatalogHeadIndex(dir, [], { healWorkingTree: false });
    expect(second.headCommit).toBe(index.headCommit);
  });

  it('indexes an owned migration commit without consuming unrelated working-tree drift', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'owned.txt'), 'owned v1\n');
    writeFileSync(join(dir, 'unrelated.txt'), 'unrelated v1\n');
    await commitAllIfDirty(dir, 'baseline');
    const preActionHead = await resolveHeadCommit(dir);
    writeFileSync(join(dir, 'owned.txt'), 'owned v2\n');
    writeFileSync(join(dir, 'unrelated.txt'), 'unrelated v2\n');

    const committedHead = await commitOwnedPathsIfDirty(dir, 'migration action', {
      paths: ['owned.txt'],
      expectedHead: preActionHead,
    });
    const index = await collectManagedCatalogHeadIndex(dir, ['owned.txt', 'unrelated.txt'], {
      healWorkingTree: false,
    });

    expect(index.headCommit).toBe(committedHead);
    expect((await readFileAtHead(dir, 'owned.txt')).toString('utf8')).toBe('owned v2\n');
    expect((await readFileAtHead(dir, 'unrelated.txt')).toString('utf8')).toBe('unrelated v1\n');
    expect(readFileSync(join(dir, 'unrelated.txt'), 'utf8')).toBe('unrelated v2\n');
  });

  it('keeps the renderer payload proportional to catalog data, not total Git file count', async () => {
    await initManagedRepo(dir);
    mkdirSync(join(dir, 'notes'), { recursive: true });
    mkdirSync(join(dir, 'pkg', '.forge'), { recursive: true });
    mkdirSync(join(dir, '.hidden'), { recursive: true });
    for (let index = 0; index < 64; index++) {
      writeFileSync(join(dir, 'notes', `irrelevant-${index}.txt`), `note ${index}\n`);
    }
    writeFileSync(join(dir, 'notes', 'preserved.txt'), 'catalog-bound legacy file\n');
    writeFileSync(join(dir, 'genome.gb'), 'LOCUS genome 4 bp\n');
    writeFileSync(join(dir, 'reads.bam'), 'alignment-placeholder\n');
    writeFileSync(join(dir, 'oligo.primer.json'), '{}\n');
    writeFileSync(join(dir, 'pkg', '.forge', 'plasmid.json'), '{}\n');
    writeFileSync(join(dir, '.hidden', 'secret.txt'), 'hidden\n');
    await commitAllIfDirty(dir, 'large mixed tree');

    const index = await collectManagedCatalogHeadIndex(dir, ['notes/preserved.txt']);

    expect(index.scannedFileCount).toBe(71);
    expect(index.visibleFileCount).toBe(68);
    expect(index.files.map((file) => file.relPath).sort()).toEqual([
      'genome/.forge/plasmid.json',
      'genome/genome.gb',
      'notes/preserved.txt',
      'oligo.primer.json',
      'pkg/.forge/plasmid.json',
      'reads.bam',
    ]);
  });

  it('shares promotion state and mutation serialization across symlink aliases', async () => {
    const alias = `${dir}-alias`;
    symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const candidate = join(dir, 'promoting-package');
    const promotionLease = await beginQuickLookPromotionWrite(candidate);
    try {
      expect(hasActiveQuickLookPromotion(alias)).toBe(true);
    } finally {
      promotionLease.release();
    }

    const order: string[] = [];
    let releaseFirst = (): void => {
      throw new Error('First mutation release was not initialized.');
    };
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withManagedWorkspaceMutationLock(dir, async () => {
      order.push('first-start');
      await firstCanFinish;
      order.push('first-end');
    });
    const second = withManagedWorkspaceMutationLock(alias, async () => {
      order.push('second');
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    rmSync(alias, { force: true });
  });

  it('atomically orders whole renderer mutations before main publication', async () => {
    const candidate = join(dir, 'future-package');
    const releaseRenderer = acquireQuickLookRendererMutationLease([
      join(candidate, 'future-package.gb'),
    ]);
    let mainAcquired = false;
    const mainLeasePromise = beginQuickLookPromotionWrite(candidate).then((lease) => {
      mainAcquired = true;
      return lease;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mainAcquired).toBe(false);
    expect(() => acquireQuickLookRendererMutationLease([candidate])).toThrow(
      'Renderer mutation of an active Quick Look promotion is denied'
    );

    releaseRenderer();
    const mainLease = await mainLeasePromise;
    expect(mainAcquired).toBe(true);
    expect(() => acquireQuickLookRendererMutationLease([candidate])).toThrow(
      'Renderer mutation of an active Quick Look promotion is denied'
    );
    mainLease.release();

    const releaseAfter = acquireQuickLookRendererMutationLease([candidate]);
    releaseAfter();
  });

  it('drains renderer claims before main takes the managed workspace mutex', async () => {
    const order: string[] = [];
    const releaseRenderer = acquireQuickLookRendererMutationLease([dir]);

    const mainTransaction = withQuickLookMainMutationLock(dir, async () => {
      order.push('main');
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const rendererTransaction = withManagedWorkspaceMutationLock(dir, async () => {
      order.push('renderer');
      releaseRenderer();
    });

    await Promise.all([mainTransaction, rendererTransaction]);
    expect(order).toEqual(['renderer', 'main']);
  });

  it('blocks case aliases for future package paths on case-insensitive platforms', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return;

    const mainLease = await beginQuickLookPromotionWrite(join(dir, 'Package'));
    try {
      expect(() =>
        acquireQuickLookRendererMutationLease([join(dir, 'package', 'member.gb')])
      ).toThrow('Renderer mutation of an active Quick Look promotion is denied');
    } finally {
      mainLease.release();
    }
  });

  it('allows exact Git publication while retaining the renderer mutation block', async () => {
    await initManagedRepo(dir);
    const candidate = join(dir, 'published-package');
    const lease = await beginQuickLookPromotionWrite(candidate);
    mkdirSync(candidate);
    writeFileSync(join(candidate, 'manifest.txt'), 'verified package member\n');

    lease.allowGitPublication();
    expect(hasActiveQuickLookPromotion(dir)).toBe(false);
    expect(() => acquireQuickLookRendererMutationLease([candidate])).toThrow(
      'Renderer mutation of an active Quick Look promotion is denied'
    );
    await commitAllIfDirty(dir, 'publish verified package');
    expect(await listFilesAtHead(dir)).toContain('published-package/manifest.txt');

    lease.release();
    const releaseAfter = acquireQuickLookRendererMutationLease([candidate]);
    releaseAfter();
  });
});

describe('managed project indexing turns loose coordinate files into packages ', () => {
  let dir: string;
  const PDB = 'HEADER    TEST PROTEIN\nATOM      1  CA  ALA A   1\nEND\n';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wphead-coordinates-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('packages a loose structure file, commits the result and leaves pinned Structures copies alone', async () => {
    await initManagedRepo(dir);
    mkdirSync(join(dir, 'models'), { recursive: true });
    mkdirSync(join(dir, 'Structures'), { recursive: true });
    writeFileSync(join(dir, 'models', '1ABC.pdb'), PDB);
    writeFileSync(join(dir, 'Structures', '1ABC.selection-pin.pdb'), PDB);
    await commitAllIfDirty(dir, 'add structures');
    await collectManagedCatalogHeadIndex(dir, [], {
      removeCoordinateSource: (path) => unlink(path),
    });
    const files = await listFilesAtHead(dir);
    expect(files).toEqual(
      expect.arrayContaining([
        'models/1ABC.dnaforge-molecular.json',
        'Structures/1ABC.selection-pin.pdb',
      ])
    );
    expect(files).not.toContain('models/1ABC.pdb');
    expect(
      JSON.parse(readFileSync(join(dir, 'models', '1ABC.dnaforge-molecular.json'), 'utf8'))
    ).toMatchObject({
      schema: expect.stringMatching(/^dnaforge\.molecular-document\.v\d+$/),
      name: '1ABC',
    });
  });

  it('falls back to removing a committed original when the Trash is unavailable', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, '1ABC.pdb'), PDB);
    await commitAllIfDirty(dir, 'add structure');
    await collectManagedCatalogHeadIndex(dir, []);
    const files = await listFilesAtHead(dir);
    expect(files).toContain('1ABC.dnaforge-molecular.json');
    expect(files).not.toContain('1ABC.pdb');
  });

  it('keeps the loose file and writes no view when the original cannot be removed', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, '1ABC.pdb'), PDB);
    await commitAllIfDirty(dir, 'add structure');
    const refuse = async () => {
      throw new Error('Trash unavailable');
    };
    await collectManagedCatalogHeadIndex(dir, [], { removeCoordinateSource: refuse });
    await collectManagedCatalogHeadIndex(dir, [], { removeCoordinateSource: refuse });
    const files = await listFilesAtHead(dir);
    expect(files).toContain('1ABC.pdb');
    expect(files.filter((path) => path.endsWith('.dnaforge-molecular.json'))).toEqual([]);
  });

  it('renames an extension-named view file and its name, keeping its identity ', async () => {
    await initManagedRepo(dir);
    mkdirSync(join(dir, 'Molecular views'), { recursive: true });
    writeFileSync(join(dir, 'source.pdb'), PDB);
    await commitAllIfDirty(dir, 'add structure');
    await collectManagedCatalogHeadIndex(dir, [], {
      removeCoordinateSource: (path) => unlink(path),
    });
    const view = JSON.parse(readFileSync(join(dir, 'source.dnaforge-molecular.json'), 'utf8'));
    writeFileSync(
      join(dir, 'Molecular views', '1FS0.pdb.dnaforge-molecular.json'),
      JSON.stringify({ ...view, name: '1FS0.pdb' }, null, 2) + '\n'
    );
    await commitAllIfDirty(dir, 'add legacy view');
    await collectManagedCatalogHeadIndex(dir, []);
    const files = await listFilesAtHead(dir);
    expect(files).toContain('Molecular views/1FS0.dnaforge-molecular.json');
    expect(files).not.toContain('Molecular views/1FS0.pdb.dnaforge-molecular.json');
    const renamed = JSON.parse(
      readFileSync(join(dir, 'Molecular views', '1FS0.dnaforge-molecular.json'), 'utf8')
    );
    expect(renamed).toMatchObject({ id: view.id, name: '1FS0' });
  });
});
