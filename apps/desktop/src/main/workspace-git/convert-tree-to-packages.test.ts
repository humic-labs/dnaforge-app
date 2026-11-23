import { promises as fs } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectPlasmidPackageGitFiles,
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

  async function file(relPath: string, content: string): Promise<string> {
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

  it('leaves an unrelated .gb file in place when it has no GenBank record', async () => {
    const source = await file('Yeast/Collision.gb', 'unmanaged unrelated file');

    const result = await convertTreeToPlasmidPackages(root);

    expect(result.converted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await readFile(source, 'utf8')).toBe('unmanaged unrelated file');
    expect(await exists(join(root, 'Yeast/Collision'))).toBe(false);
  });

  it('leaves a truncated GenBank record at its original path during project migration', async () => {
    const broken = GB('Interrupted').replace(/\/\/\s*$/u, '');
    const source = await file('Interrupted.gb', broken);

    const result = await convertTreeToPlasmidPackages(root);

    expect(result.converted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await readFile(source, 'utf8')).toBe(broken);
    expect(await exists(join(root, 'Interrupted'))).toBe(false);
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
