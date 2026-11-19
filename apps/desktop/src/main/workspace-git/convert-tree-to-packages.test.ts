import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectPlasmidPackageGitFiles,
  convertLooseSequenceFile,
  convertTreeToPlasmidPackages,
} from './convert-tree-to-packages';

describe('convertTreeToPlasmidPackages', () => {
  let root: string;
  const GB = (n: string) => `LOCUS       ${n}  10 bp    DNA     circular SYN\n//\n`;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fixture-tree-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function file(relPath: string, content: string | Buffer): Promise<string> {
    const full = join(root, relPath);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
    return full;
  }

  const exists = async (p: string) => !!(await stat(p).catch(() => null));

  it('converts sequences at every depth, PRESERVING the folder layout', async () => {
    await file('pUC19.gb', GB('pUC19'));
    await file('plasmids/pBR322.gb', GB('pBR322'));
    await file('plasmids/vectors/pET28.gb', GB('pET28'));

    const result = await convertTreeToPlasmidPackages(root);

    expect(result.converted).toBe(3);
    expect(await exists(join(root, 'pUC19', 'pUC19.gb'))).toBe(true);
    expect(await exists(join(root, 'plasmids', 'pBR322', 'pBR322.gb'))).toBe(true);
    expect(await exists(join(root, 'plasmids', 'vectors', 'pET28', 'pET28.gb'))).toBe(true);
  });

  it('retains declared paths in an older project while converting its unlisted files', async () => {
    const first = await file('Imported/First.gb', GB('Same'));
    const second = await file('Imported/Second.gb', GB('Same'));
    await file('Imported/Unlisted.gb', GB('Same'));
    const entities = [
      { id: 'first', name: 'Same', path: 'Imported/First.gb' },
      { id: 'second', name: 'Same', path: 'Imported/Second.gb' },
    ].map((entity) => ({ ...entity, type: 'sequence', fileKind: 'genbank' }));
    await file(
      '.forge/catalog.json',
      JSON.stringify({ schema: 'dnaforge.native-workspace-manifest.v1', entities, links: [] })
    );
    expect((await convertTreeToPlasmidPackages(root)).converted).toBe(1);
    expect(await readFile(first, 'utf8')).toBe(GB('Same'));
    expect(await readFile(second, 'utf8')).toBe(GB('Same'));
    expect(await exists(join(root, 'Imported/Unlisted/Unlisted.gb'))).toBe(true);
  });

  it('preserves exact native file and package placements while converting unmanaged constructs', async () => {
    const native = await file('DNA/Native.gb', GB('Native'));
    const nested = await file('Protocol/assets/Template.gb', GB('Template'));
    await file('DNA/Unmanaged.gb', GB('Unmanaged'));
    await file(
      '.forge/catalog.json',
      JSON.stringify({
        schema: 'dnaforge.native-workspace-manifest.v2',
        entities: [
          {
            id: 'native-sequence',
            type: 'sequence',
            name: 'Native',
            placement: { kind: 'file', relativePath: 'DNA/Native.gb', fileKind: 'genbank' },
          },
          {
            id: 'native-protocol',
            type: 'protocol',
            name: 'Protocol',
            placement: {
              kind: 'package',
              rootRelativePath: 'Protocol',
              primaryRelativePath: 'Protocol/.forge/protocol.json',
              fileKind: 'protocol',
            },
          },
        ],
        links: [],
      })
    );
    const result = await convertTreeToPlasmidPackages(root);
    expect(result.converted).toBe(1);
    expect(await readFile(native, 'utf8')).toBe(GB('Native'));
    expect(await readFile(nested, 'utf8')).toBe(GB('Template'));
    expect(await exists(join(root, 'DNA/Unmanaged/Unmanaged.gb'))).toBe(true);
  });

  it.each(['sha256', 'git'] as const)(
    'preserves a moved standalone file with its recorded %s identity',
    async (format) => {
      const bytes = GB('Native');
      const sizeBytes = Buffer.byteLength(bytes);
      const hash =
        format === 'git' ? createHash('sha1').update(`blob ${sizeBytes}\0`) : createHash('sha256');
      const contentHash = `${format}:${hash.update(bytes).digest('hex')}`;
      const oldPath = join(root, 'Old.gb');
      const moved = await file('Renamed/Other.gb', bytes);
      const duplicate = await file('Duplicate.gb', bytes);
      await file('Unrelated.gb', GB('Change'));
      await file(
        '.forge/catalog.json',
        JSON.stringify({
          schema: 'dnaforge.native-workspace-manifest.v2',
          entities: [
            {
              id: 'original',
              type: 'sequence',
              name: 'Original',
              placement: { kind: 'file', relativePath: 'Old.gb', fileKind: 'genbank' },
            },
          ],
          links: [],
        })
      );
      const result = await convertTreeToPlasmidPackages(root, {
        getMissingFileBindings: () => [{ path: oldPath, sizeBytes, contentHash }],
      });
      expect(result.converted).toBe(1);
      expect(await readFile(moved, 'utf8')).toBe(bytes);
      expect(await readFile(duplicate, 'utf8')).toBe(bytes);
      expect(await exists(join(root, 'Unrelated/Unrelated.gb'))).toBe(true);
      await file('Old.gb', bytes);
      const restored = await convertTreeToPlasmidPackages(root, {
        getMissingFileBindings: () => [{ path: oldPath, sizeBytes, contentHash }],
      });
      expect(restored.converted).toBe(2);
      expect(await readFile(oldPath, 'utf8')).toBe(bytes);
    }
  );

  it('refuses conversion before mutating files when the native placement catalog is invalid', async () => {
    const native = await file('Native.gb', GB('Native'));
    await file('.forge/catalog.json', '{"schema":"invalid"}');
    await expect(convertTreeToPlasmidPackages(root)).rejects.toThrow(/catalog|manifest/i);
    expect(await readFile(native, 'utf8')).toBe(GB('Native'));
  });

  it('converts a FASTA and leaves non-sequence files untouched', async () => {
    await file('seq.fasta', '>seq plasmid DNA\nACGTACGTAC\n');
    await file('README.md', '# notes');
    await file('data/results.csv', 'a,b\n1,2\n');

    const result = await convertTreeToPlasmidPackages(root);

    expect(await exists(join(root, 'seq', 'seq.gb'))).toBe(true);
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('# notes');
    expect(await readFile(join(root, 'data', 'results.csv'), 'utf8')).toBe('a,b\n1,2\n');
    expect(result.converted).toBe(1);
  });

  it.each([
    ['assembly.fna', 'assembly.gff3'],
    ['reference.v2.fa', 'reference.v2.GFF.gz'],
  ])(
    'keeps %s beside its indexed annotation source on mount and individual open',
    async (name, annotation) => {
      const fasta = '>reference DNA\nACGTACGTACGT\n';
      const gffBytes = Buffer.from('##gff-version 3\n');
      const gff = annotation.endsWith('.gz') ? gzipSync(gffBytes) : gffBytes;
      const source = await file(`data/${name}`, fasta);
      const paired = await file(`data/${annotation}`, gff);
      await file('data/another.fasta', fasta);
      await file(`other/${name}`, fasta);

      const tree = await convertTreeToPlasmidPackages(root);
      expect(tree.converted).toBe(2);
      expect(tree.failures).toEqual([]);
      expect(await convertLooseSequenceFile(root, source, { automatic: true })).toMatchObject({
        converted: false,
        packageRoots: [],
      });
      expect(await readFile(source, 'utf8')).toBe(fasta);
      expect(await readFile(paired)).toEqual(gff);
    }
  );

  it('keeps a FASTA with its own .fai during individual open and workspace conversion', async () => {
    const fasta = '>reference DNA\nACGTACGTACGT\n';
    const index = 'reference\t12\t15\t12\t13\n';
    const source = await file('reads/reference.fa', fasta);
    const paired = await file('reads/reference.fa.fai', index);
    await file('reads/reference.fna', fasta);
    await file('other/reference.fa', fasta);

    expect(await convertLooseSequenceFile(root, source, { automatic: true })).toMatchObject({
      converted: false,
      packageRoots: [],
    });
    const tree = await convertTreeToPlasmidPackages(root);
    expect(tree.failures).toEqual([]);
    expect(tree.converted).toBe(2);
    expect(await readFile(source, 'utf8')).toBe(fasta);
    expect(await readFile(paired, 'utf8')).toBe(index);
  });

  it('leaves an unrelated .gb file in place when it has no GenBank record', async () => {
    const source = await file('Yeast/Collision.gb', 'unmanaged unrelated file');

    const result = await convertTreeToPlasmidPackages(root);

    expect(result.converted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await readFile(source, 'utf8')).toBe('unmanaged unrelated file');
    expect(await exists(join(root, 'Yeast/Collision'))).toBe(false);
  });

  it('splits a multi-record FASTA into a package per record', async () => {
    await file(
      'many.fasta',
      '>recA DNA gene sequence\nATGACCATGATTACGCCAAGCTTGCATGCCTGCAGGTCGACTCTAGAGGATCCCCGGGTACCGAGCTCGAATTCACTGGCCGTCGTTTTACAACGTCGTGACTG\n>lacZ DNA gene sequence\nATGAGCATTCAACATTTCCGTGTCGCCCTTATTCCCTTTTTTGCGGCATTTTGCCTTCCTGTTTTTGCTCACCCAGAAACGCTGGTGAAAGTAAAAGATGCTGAA\n'
    );

    const result = await convertTreeToPlasmidPackages(root);

    expect(await exists(join(root, 'recA', 'recA.gb'))).toBe(true);
    expect(await exists(join(root, 'lacZ', 'lacZ.gb'))).toBe(true);
    expect(result.converted).toBe(1);
    expect(result.packages).toBe(2);
  });

  it('does not heal constructs hidden under .waypoint (trash / cache)', async () => {
    await file('.waypoint/trash/gone.gb', GB('gone'));

    const result = await convertTreeToPlasmidPackages(root);

    expect(result.converted).toBe(0);
    expect(await exists(join(root, '.waypoint', 'trash', 'gone.gb'))).toBe(true);
    expect(await exists(join(root, '.waypoint', 'trash', 'gone', 'gone.gb'))).toBe(false);
  });

  it('does not heal the repo test-fixtures corpus if this tree is mounted', async () => {
    await file('test-fixtures/sequences/pUC19.gb', GB('pUC19'));

    const result = await convertTreeToPlasmidPackages(root);

    expect(result.converted).toBe(0);
    expect(await exists(join(root, 'test-fixtures', 'sequences', 'pUC19.gb'))).toBe(true);
  });

  it('is idempotent — a second pass does not nest or duplicate', async () => {
    await file('pUC19.gb', GB('pUC19'));
    await convertTreeToPlasmidPackages(root);
    const second = await convertTreeToPlasmidPackages(root);

    expect(second.converted).toBe(0);
    expect(await exists(join(root, 'pUC19', 'pUC19', 'pUC19.gb'))).toBe(false);
    expect(await exists(join(root, 'pUC19', 'pUC19.gb'))).toBe(true);
  });

  it('leaves an ALREADY packaged sequence alone', async () => {
    await file('pUC19/pUC19.gb', GB('pUC19'));
    await file(
      'pUC19/.forge/plasmid.json',
      JSON.stringify({
        schema: 'waypoint.plasmid.v1',
        kind: 'plasmid',
        id: 'pkg-1',
        name: 'pUC19',
        product: { file: 'pUC19.gb' },
      })
    );

    const result = await convertTreeToPlasmidPackages(root);

    expect(result.converted).toBe(0);
    expect(await exists(join(root, 'pUC19', 'pUC19.gb'))).toBe(true);
  });

  it('force-includes nested package members even when the outer package is already valid', async () => {
    await file('Outer/Outer.gb', GB('Outer'));
    await file(
      'Outer/.forge/plasmid.json',
      JSON.stringify({
        schema: 'waypoint.plasmid.v1',
        kind: 'plasmid',
        id: 'outer',
        name: 'Outer',
        product: { file: 'Outer.gb' },
      })
    );
    await file('Outer/assets/Inner/Inner.gb', GB('Inner'));
    await file(
      'Outer/assets/Inner/.forge/plasmid.json',
      JSON.stringify({
        schema: 'waypoint.plasmid.v1',
        kind: 'plasmid',
        id: 'inner',
        name: 'Inner',
        product: { file: 'Inner.gb' },
      })
    );

    const required = await collectPlasmidPackageGitFiles(root);

    expect(required).toEqual(
      expect.arrayContaining([
        join(root, 'Outer', '.forge', 'plasmid.json'),
        join(root, 'Outer', 'Outer.gb'),
        join(root, 'Outer', 'assets', 'Inner', '.forge', 'plasmid.json'),
        join(root, 'Outer', 'assets', 'Inner', 'Inner.gb'),
      ])
    );
  });

  it('lists package members without rewriting an old marker', async () => {
    await file('pUC19/pUC19.gb', GB('pUC19'));
    const markerPath = 'pUC19/.forge/plasmid.json';
    const marker = JSON.stringify({
      schema: 'waypoint.plasmid.v1',
      kind: 'plasmid',
      id: 'puc19',
      name: 'pUC19',
      product: { file: 'pUC19.gb' },
    });
    await file(markerPath, marker);

    const required = await collectPlasmidPackageGitFiles(root);

    expect(required).toEqual(
      expect.arrayContaining([
        join(root, 'pUC19', '.forge', 'plasmid.json'),
        join(root, 'pUC19', 'pUC19.gb'),
      ])
    );
    expect(await readFile(join(root, markerPath), 'utf8')).toBe(marker);
  });

  it('only skips a directory that is REALLY a package, not any .forge dir', async () => {
    await file('unrelated/.forge/some-other-tool.json', '{}');
    await file('unrelated/pUC19.gb', GB('pUC19'));

    const result = await convertTreeToPlasmidPackages(root);

    expect(result.converted).toBe(1);
    expect(await exists(join(root, 'unrelated', 'pUC19', 'pUC19.gb'))).toBe(true);
    expect(await exists(join(root, 'unrelated', '.forge', 'some-other-tool.json'))).toBe(true);
  });

  it('reports an unreadable directory instead of silently omitting it', async () => {
    await file('locked/pUC19.gb', GB('pUC19'));
    await fs.chmod(join(root, 'locked'), 0o000);
    try {
      const result = await convertTreeToPlasmidPackages(root);
      expect(result.failures.length).toBeGreaterThanOrEqual(1);
      expect(result.failures[0].path).toContain('locked');
    } finally {
      await fs.chmod(join(root, 'locked'), 0o700);
    }
  });

  it('never walks into .git or node_modules', async () => {
    await file('.git/objects/stray.gb', GB('stray'));
    await file('node_modules/pkg/vendor.gb', GB('vendor'));

    const result = await convertTreeToPlasmidPackages(root);

    expect(result.converted).toBe(0);
    expect(await exists(join(root, '.git', 'objects', 'stray.gb'))).toBe(true);
  });

  it('one bad file does not abort the import', async () => {
    await file('good.gb', GB('good'));
    await file('broken.fasta', 'not a fasta at all');
    await file('alsogood.gb', GB('alsogood'));

    const result = await convertTreeToPlasmidPackages(root);

    expect(await exists(join(root, 'good', 'good.gb'))).toBe(true);
    expect(await exists(join(root, 'alsogood', 'alsogood.gb'))).toBe(true);
    expect(result.converted).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.skippedDetails).toContainEqual(
      expect.objectContaining({ path: expect.stringContaining('broken.fasta') })
    );
    expect(result.skippedDetails[0].reason).toBeTruthy();
  });

  it('reports progress so a large import is not a frozen window', async () => {
    await file('a.gb', GB('a'));
    await file('b.gb', GB('b'));
    await file('c.gb', GB('c'));

    const seen: Array<{ done: number; total: number }> = [];
    await convertTreeToPlasmidPackages(root, {
      onProgress: (done, total) => seen.push({ done, total }),
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual({ done: 3, total: 3 });
    expect(seen.every((p) => p.total === 3)).toBe(true);
  });
});
