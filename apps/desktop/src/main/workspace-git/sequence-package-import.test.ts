import { existsSync, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import { parseSequencePackageDocument } from '../../db/sequence-package';
import {
  existingPlasmidPackageRootForProduct,
  isConstructSequenceFile,
  materializeImportedSequencePackages,
  previewImportedSequencePackages,
  rewriteSidecarQueryPaths,
} from './sequence-package-import';

describe('rewriteSidecarQueryPaths', () => {
  it('rewrites a relative query path so it still hits the original file', () => {
    const rewritten = rewriteSidecarQueryPaths(
      JSON.stringify({
        type: 'alignment-history',
        sessions: [{ tracks: [{ queryPath: 'clone-1.fasta' }] }],
      }),
      '/lab/alignments',
      '/lab/alignments/reference'
    );
    expect(JSON.parse(rewritten).sessions[0].tracks[0].queryPath).toBe(join('..', 'clone-1.fasta'));
  });
});

describe('materializeImportedSequencePackages', () => {
  let dir: string;
  const GENBANK = 'LOCUS       pUC19  2686 bp    DNA     circular SYN\n//\n';
  const FASTA_ONE = '>pUC19 cloning vector\nACGTACGTAC\nGTACGTACGT\n';
  const FASTA_MANY = '>recA DNA gene sequence\nAAAACCCC\n>lacZ DNA gene sequence\nGGGGTTTT\n';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fixture-import-'));
  });

  afterEach(async () => {
    await fs.chmod(dir, 0o700).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });

  const cdc28Coding = resolve(
    process.cwd(),
    '../../test-fixtures/import-formats/S288C_YBR160W_CDC28_coding.dnas'
  );

  it.skipIf(!existsSync(cdc28Coding))(
    'recognizes a genuine generic DNA FASTA from its composition',
    async () => {
      const original = await readFile(cdc28Coding);
      const source = join(dir, 'unknown-molecule.fa');
      await writeFile(source, original);
      expect(await previewImportedSequencePackages(source)).toMatchObject({ kind: 'ready' });
      const output = await materializeImportedSequencePackages(source);
      expect(output.converted).toBe(true);
      expect(parseGenBankFull(await readFile(output.packages[0].productPath, 'utf8')).length).toBe(
        897
      );
    }
  );

  it('confirms a too-short generic FASTA as DNA only for the exact inspected bytes', async () => {
    const original = Buffer.from('>unknown-molecule\nATGTCCGGTGAA\n');
    const source = join(dir, 'unknown-molecule.fa');
    await writeFile(source, original);
    const hash = createHash('sha256').update(original).digest('hex');
    const blocked = await previewImportedSequencePackages(source);
    expect(blocked).toMatchObject({
      kind: 'blocked',
      reasonCode: 'unconfirmed_molecule_identity',
      sourceSha256: hash,
    });
    const confirmed = await previewImportedSequencePackages(source, {
      confirmedDnaSourceSha256: hash,
    });
    expect(confirmed.kind).toBe('ready');
    const output = await materializeImportedSequencePackages(source, undefined, {
      expectedSourceSha256: hash,
      confirmedDnaSourceSha256: hash,
    });
    expect(output.converted).toBe(true);
    expect(parseGenBankFull(await readFile(output.packages[0].productPath, 'utf8')).length).toBe(
      12
    );
  });

  it('rejects stale DNA confirmation instead of applying it to changed bytes', async () => {
    const source = join(dir, 'unknown.fa');
    await writeFile(source, '>unknown\nACGTACGTACGT\n');
    const hash = createHash('sha256')
      .update(await readFile(source))
      .digest('hex');
    await writeFile(source, '>unknown\nACGTACGTACGTA\n');
    await expect(
      previewImportedSequencePackages(source, { confirmedDnaSourceSha256: hash })
    ).rejects.toThrow(/changed after preview/i);
    await expect(
      materializeImportedSequencePackages(source, undefined, { confirmedDnaSourceSha256: hash })
    ).rejects.toThrow(/changed after preview/i);
    expect(await readdir(dir)).toEqual(['unknown.fa']);
  });

  it.each([
    ['protein', '>protein\nACGTACGTACGT\n', 'non_dna_content'],
    ['comments', '>unknown\n;preserve this\nACGTACGTACGT\n', 'lossless_conversion_blocked'],
  ])('DNA confirmation preserves the %s refusal', async (_name, content, reasonCode) => {
    const source = join(dir, 'unknown.fa');
    await writeFile(source, content);
    const hash = createHash('sha256').update(content).digest('hex');
    const result = await previewImportedSequencePackages(source, {
      confirmedDnaSourceSha256: hash,
    });
    expect(result).toMatchObject({ kind: 'blocked', reasonCode });
  });

  it('converts an N-rich record once its exact bytes are confirmed as DNA', async () => {
    const bases = `ACGTACGTACGTACGTACGT${'N'.repeat(40)}ACGTACGTACGTACGTACGT`;
    const content = `>scaffold_1\n${bases}\n`;
    const source = join(dir, 'scaffold.fa');
    await writeFile(source, content);
    const hash = createHash('sha256').update(content).digest('hex');
    const blocked = await previewImportedSequencePackages(source);
    expect(blocked).toMatchObject({
      kind: 'blocked',
      reasonCode: 'unconfirmed_molecule_identity',
      sourceSha256: hash,
    });
    expect(blocked.kind === 'blocked' && blocked.reason).toMatch(/N-rich/);
    const output = await materializeImportedSequencePackages(source, undefined, {
      expectedSourceSha256: hash,
      confirmedDnaSourceSha256: hash,
    });
    expect(output.converted).toBe(true);
    expect(parseGenBankFull(await readFile(output.packages[0].productPath, 'utf8')).sequence).toBe(
      bases
    );
  });

  it('imports a short uracil-only record as RNA without asking', async () => {
    const source = join(dir, 'short.fa');
    await writeFile(source, '>RNA\nACGUACGU\n');
    expect(await previewImportedSequencePackages(source)).toMatchObject({ kind: 'ready' });
    const result = await materializeImportedSequencePackages(source);
    const product = await readFile(result.packages[0].productPath, 'utf8');
    expect(parseGenBankFull(product)).toMatchObject({ molecule: 'RNA', sequence: 'ACGUACGU' });
  });

  describe('NCBI-style mRNA FASTA ', () => {
    const TP53_START =
      'GATGGGATTGGGGTTTTCCCCTCCCATGTGCTCAAGACTGGCGCTAAAAGTTTTGAGCTTCTCAAAAGTCTAGAGCCACCGTCCAGGGAGCAGGTAGCTGCTGGGCTCCGGGGACACTTTGCGTTCGGGCTGGGAGCGTGCTTTCCACGACGGTGACACGCTTCCCTGGATTGGCAGCCAGACTGCCTTCCGGGTCACTGCC';

    it('imports a RefSeq transcript as cDNA by default and keeps its title', async () => {
      const header =
        'NM_000546.6 Homo sapiens tumor protein p53 (TP53), transcript variant 1, mRNA';
      const source = join(dir, 'tp53.fasta');
      await writeFile(source, `>${header}\n${TP53_START}\n`);
      expect(await previewImportedSequencePackages(source)).toMatchObject({ kind: 'ready' });
      const result = await materializeImportedSequencePackages(source);
      const product = await readFile(result.packages[0].productPath, 'utf8');
      expect(product).toMatch(/^LOCUS\s+\S+\s+\d+ bp\s+DNA\s/m);
      expect(parseGenBankFull(product)).toMatchObject({
        description: header,
        sequence: TP53_START,
      });
    });

    it('offers cDNA or RNA for a T-based record whose header declares RNA', async () => {
      const content = `>guide transcript mRNA\n${TP53_START}\n`;
      const source = join(dir, 'declared.fasta');
      await writeFile(source, content);
      const hash = createHash('sha256').update(content).digest('hex');

      expect(await previewImportedSequencePackages(source)).toMatchObject({
        kind: 'blocked',
        reasonCode: 'unconfirmed_molecule_identity',
        canConfirmDnaIdentity: true,
        canConvertToRna: true,
      });
      expect(
        await previewImportedSequencePackages(source, {
          confirmedDnaSourceSha256: hash,
          confirmedNucleicAcid: 'dna',
        })
      ).toMatchObject({ kind: 'ready' });

      const result = await materializeImportedSequencePackages(source, undefined, {
        confirmedDnaSourceSha256: hash,
        confirmedNucleicAcid: 'rna',
      });
      expect(result.converted).toBe(true);
      const packageRoot = result.packages[0].packageRoot;
      const product = await readFile(result.packages[0].productPath, 'utf8');
      expect(product).toMatch(/^LOCUS\s+\S+\s+\d+ bp\s+RNA\s/m);
      expect(parseGenBankFull(product).sequence).toBe(TP53_START.replace(/T/g, 'U'));
      const record = parseSequencePackageDocument(
        await readFile(join(packageRoot, '.forge/plasmid.json'), 'utf8')
      );
      const evidence = record.members.find((member) => member.role === 'evidence-input');
      expect(evidence).toBeDefined();
      expect(await readFile(join(packageRoot, evidence!.path), 'utf8')).toBe(content);
    });

    it('still refuses a protein declaration', async () => {
      const source = join(dir, 'pep.fasta');
      await writeFile(source, `>signal peptide\n${TP53_START}\n`);
      expect(await previewImportedSequencePackages(source)).toMatchObject({
        kind: 'blocked',
        reasonCode: 'non_dna_content',
      });
    });
  });

  async function importedFile(name: string, content: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, content, 'utf8');
    return path;
  }

  describe('a file named by a sibling sidecar', () => {
    it('packages the sequence and moves the sidecar beside the product', async () => {
      const file = await importedFile('reference.gb', GENBANK);
      await writeFile(
        join(dir, 'reference.gb.waypoint.json'),
        JSON.stringify({
          type: 'alignment-history',
          version: '2.0',
          sessions: [
            {
              id: 's1',
              tracks: [{ id: 't1', queryPath: 'clone-1.fasta' }],
            },
          ],
        })
      );
      await writeFile(join(dir, 'clone-1.fasta'), '>c\nACGT\n');

      const result = await materializeImportedSequencePackages(file);

      expect(result.converted).toBe(true);
      expect(result.packages[0].productPath).toBe(join(dir, 'reference', 'reference.gb'));
      expect(await fs.readFile(join(dir, 'reference', 'reference.gb'), 'utf8')).toBe(GENBANK);
      const moved = JSON.parse(
        await readFile(join(dir, 'reference', 'contents', 'reference.gb.waypoint.json'), 'utf8')
      ) as { sessions: Array<{ tracks: Array<{ queryPath: string }> }> };
      const rewrittenQuery = moved.sessions[0].tracks[0].queryPath;
      expect(rewrittenQuery).toBe(join('..', 'clone-1.fasta'));
      expect(resolve(join(dir, 'reference'), rewrittenQuery)).toBe(join(dir, 'clone-1.fasta'));
      await expect(fs.access(join(dir, 'reference.gb.waypoint.json'))).rejects.toThrow();
      await expect(
        fs.access(join(dir, 'reference', 'reference.gb.waypoint.json'))
      ).rejects.toThrow();
      const marker = JSON.parse(
        await readFile(join(dir, 'reference', '.forge', 'plasmid.json'), 'utf8')
      ) as { members: Array<{ role: string; path: string }> };
      expect(marker.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'alignment',
            path: 'contents/reference.gb.waypoint.json',
          }),
        ])
      );
    });

    it('still packages a neighbor that does not own the sidecar', async () => {
      await writeFile(join(dir, 'reference.gb.waypoint.json'), '{}');
      const other = await importedFile('pUC19.gb', GENBANK);

      const result = await materializeImportedSequencePackages(other);

      expect(result.converted).toBe(true);
      expect(await fs.readFile(join(dir, 'reference.gb.waypoint.json'), 'utf8')).toBe('{}');
    });
  });

  const readRecord = async (root: string) =>
    JSON.parse(await readFile(join(root, '.forge', 'plasmid.json'), 'utf8'));

  describe('GenBank in', () => {
    it('refuses preview when a .gb file has no GenBank record', async () => {
      const sourcePath = await importedFile('Collision.gb', 'unmanaged unrelated file');

      expect(await previewImportedSequencePackages(sourcePath)).toMatchObject({
        kind: 'blocked',
        reasonCode: 'parse_failure',
      });
      expect(await readFile(sourcePath, 'utf8')).toBe('unmanaged unrelated file');
      expect(await readdir(dir)).toEqual(['Collision.gb']);
    });

    it('previews every real multi-record package without changing the source tree', async () => {
      const first = await readFile(
        resolve(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb'),
        'utf8'
      );
      const second = await readFile(
        resolve(
          __dirname,
          '../../../../../test-fixtures/sequences/linear/structure-mg1655-mioc-ape-label.gb'
        ),
        'utf8'
      );
      const sourcePath = await importedFile('two-real-records.gb', `${first.trimEnd()}\n${second}`);

      const preview = await previewImportedSequencePackages(sourcePath);

      expect(preview).toEqual({
        kind: 'ready',
        sourcePath,
        sourceSha256: createHash('sha256').update(`${first.trimEnd()}\n${second}`).digest('hex'),
        packages: [
          { name: 'SYNPUC19CV', recordIndex: 0, recordCount: 2 },
          { name: 'STRUCT_MG1655_MIOC', recordIndex: 1, recordCount: 2 },
        ],
      });
      expect(await readdir(dir)).toEqual(['two-real-records.gb']);
      expect(await readFile(sourcePath, 'utf8')).toBe(`${first.trimEnd()}\n${second}`);
    });

    it('uses the same bounded package-name allocator for preview and materialization', async () => {
      const content = Array.from({ length: 3 }, () => '>duplicate DNA sequence\nACGTACGT\n').join(
        ''
      );
      const sourcePath = await importedFile('duplicates.fna', content);

      const preview = await previewImportedSequencePackages(sourcePath);
      expect(preview.kind).toBe('ready');
      if (preview.kind !== 'ready') throw new Error(preview.reason);
      expect(preview.packages.map(({ name }) => name)).toEqual([
        'duplicate',
        'duplicate (1)',
        'duplicate (2)',
      ]);

      const result = await materializeImportedSequencePackages(sourcePath);
      expect(result.packages.map(({ packageRoot }) => packageRoot)).toEqual(
        preview.packages.map(({ name }) => join(dir, name))
      );
    });

    it('blocks a duplicate-name batch at the exact writer collision limit', async () => {
      const record = '>duplicate DNA sequence\nACGTACGT\n';
      const successPath = await importedFile('success-edge.fna', record.repeat(1001));
      const success = await previewImportedSequencePackages(successPath);
      expect(success.kind).toBe('ready');
      if (success.kind !== 'ready') throw new Error(success.reason);
      expect(success.packages).toHaveLength(1001);
      expect(success.packages.at(-1)?.name).toBe('duplicate (1000)');

      const blockedPath = await importedFile('blocked-edge.fna', record.repeat(1002));
      const blocked = await previewImportedSequencePackages(blockedPath);
      expect(blocked).toMatchObject({ kind: 'blocked' });
      if (blocked.kind !== 'blocked') throw new Error('Expected duplicate-name preview to block.');
      expect(blocked.reason).toMatch(/1001 records resolve to the same package name/i);
    });

    it('moves it into a package WITHOUT rewriting the bytes', async () => {
      const result = await materializeImportedSequencePackages(
        await importedFile('pUC19.gb', GENBANK)
      );

      expect(result.converted).toBe(true);
      expect(result.packages).toHaveLength(1);
      expect(result.packages[0].productPath).toBe(join(dir, 'pUC19', 'pUC19.gb'));
      expect(await readFile(result.packages[0].productPath, 'utf8')).toBe(GENBANK);
      await expect(fs.stat(join(dir, 'pUC19.gb'))).rejects.toThrow();

      const record = await readRecord(result.packages[0].packageRoot);
      expect(record).toMatchObject({
        schema: 'waypoint.sequence.v1',
        product: {
          file: 'pUC19.gb',
          genBankChecksum: `sha256:${createHash('sha256').update(GENBANK).digest('hex')}`,
        },
      });
      expect('assembly' in record).toBe(false);
      expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
      await expect(fs.stat(join(result.packages[0].packageRoot, 'primers'))).rejects.toThrow();
    });

    it('splits a real multi-record GenBank into one byte-preserving package per record', async () => {
      const first = await readFile(
        resolve(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb'),
        'utf8'
      );
      const second = await readFile(
        resolve(
          __dirname,
          '../../../../../test-fixtures/sequences/linear/structure-mg1655-mioc-ape-label.gb'
        ),
        'utf8'
      );
      const sourcePath = await importedFile('two-records.gb', `${first.trimEnd()}\n${second}`);

      const result = await materializeImportedSequencePackages(sourcePath);

      expect(result.converted).toBe(true);
      expect(result.packages).toHaveLength(2);
      expect(result.packages.map(({ productPath }) => productPath)).toEqual([
        join(dir, 'SYNPUC19CV', 'SYNPUC19CV.gb'),
        join(dir, 'STRUCT_MG1655_MIOC', 'STRUCT_MG1655_MIOC.gb'),
      ]);
      expect(await readFile(result.packages[0].productPath, 'utf8')).toBe(`${first.trimEnd()}\n`);
      expect(await readFile(result.packages[1].productPath, 'utf8')).toBe(second);
      const records = await Promise.all(
        result.packages.map(({ packageRoot }) => readRecord(packageRoot))
      );
      expect(records[0].id).not.toBe(records[1].id);
      await expect(fs.stat(sourcePath)).rejects.toThrow();
    });

    it('rewrites a relative symlink target when moving the link into a deeper package', async () => {
      const backingDir = join(dir, 'backing');
      const backingPath = join(backingDir, 'vector.source');
      await fs.mkdir(backingDir, { recursive: true });
      await writeFile(backingPath, GENBANK);
      const importedPath = join(dir, 'vector.gb');
      await fs.symlink('backing/vector.source', importedPath);

      const result = await materializeImportedSequencePackages(importedPath);

      expect(result.converted).toBe(true);
      expect((await fs.lstat(result.packages[0].productPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(result.packages[0].productPath, 'utf8')).toBe(GENBANK);
      expect(await readFile(backingPath, 'utf8')).toBe(GENBANK);
      await expect(fs.lstat(importedPath)).rejects.toThrow();
    });

    it('atomically claims a GenBank symlink before a newer source can occupy its pathname', async () => {
      const backingPath = join(dir, 'vector.source');
      await writeFile(backingPath, GENBANK);
      const importedPath = join(dir, 'vector.gb');
      await fs.symlink('vector.source', importedPath);
      const newerSource =
        'LOCUS       newer  8 bp    DNA     linear SYN\nORIGIN\n        1 ttttcccc\n//\n';
      let sourceClaimed = false;

      const result = await materializeImportedSequencePackages(importedPath, {
        writeMeta: (path, content) =>
          writeFile(path, content, { encoding: 'utf8', flag: 'wx' }).then(() => undefined),
        rename: async (from, to) => {
          await fs.rename(from, to);
          if (from === importedPath) {
            sourceClaimed = true;
            await writeFile(importedPath, newerSource);
          }
        },
      });

      expect(sourceClaimed).toBe(true);
      expect(await readFile(importedPath, 'utf8')).toBe(newerSource);
      expect((await fs.lstat(result.packages[0].productPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(result.packages[0].productPath, 'utf8')).toBe(GENBANK);
    });

    it('does not delete a concurrent user file when package creation rolls back', async () => {
      const importedPath = await importedFile('rollback.gb', GENBANK);
      const concurrentNote = join(dir, 'rollback', 'notes.txt');

      await expect(
        materializeImportedSequencePackages(importedPath, {
          writeMeta: async () => {
            await writeFile(concurrentNote, 'created while import was running', 'utf8');
            throw new Error('simulated marker write failure');
          },
        })
      ).rejects.toThrow(/marker write failure/i);

      expect(await readFile(importedPath, 'utf8')).toBe(GENBANK);
      expect(await readFile(concurrentNote, 'utf8')).toBe('created while import was running');
    });

    it('revalidates the confirmed digest after atomically claiming the source', async () => {
      const importedPath = await importedFile('claimed-digest.gb', GENBANK);
      const expectedSourceSha256 = createHash('sha256').update(GENBANK).digest('hex');
      const changed =
        'LOCUS       changed  8 bp    DNA     linear SYN\nORIGIN\n        1 ttttcccc\n//\n';

      await expect(
        materializeImportedSequencePackages(
          importedPath,
          {
            writeMeta: (path, content) =>
              writeFile(path, content, { encoding: 'utf8', flag: 'wx' }).then(() => undefined),
            rename: async (from, to) => {
              await fs.rename(from, to);
              await writeFile(to, changed);
            },
          },
          { expectedSourceSha256 }
        )
      ).rejects.toThrow(/changed after preview/i);

      expect(await readFile(importedPath, 'utf8')).toBe(changed);
      await expect(
        fs.access(join(dir, 'claimed-digest', '.forge', 'plasmid.json'))
      ).rejects.toThrow();
    });

    it('does not overwrite a source path concurrently recreated while package creation rolls back', async () => {
      const importedPath = await importedFile('rollback-source.gb', GENBANK);
      const recoveryProduct = join(dir, 'rollback-source', 'rollback-source.gb');

      await expect(
        materializeImportedSequencePackages(importedPath, {
          writeMeta: async () => {
            await writeFile(importedPath, 'CONCURRENT RECREATED SOURCE', 'utf8');
            throw new Error('simulated marker write failure');
          },
        })
      ).rejects.toThrow(/could not be restored|surviving product|recovery/i);

      expect(await readFile(importedPath, 'utf8')).toBe('CONCURRENT RECREATED SOURCE');
      expect(await readFile(recoveryProduct, 'utf8')).toBe(GENBANK);
    });

    it('transactionally replaces an existing product and retires its stale assembly record', async () => {
      const packageRoot = join(dir, 'pUC19');
      const productPath = join(packageRoot, 'pUC19.gb');
      const metaPath = join(packageRoot, '.forge', 'plasmid.json');
      const csvPath = join(packageRoot, 'primers', 'pUC19.primers.csv');
      const fastaPath = join(packageRoot, 'primers', 'pUC19.primers.fasta');
      const assetPath = join(packageRoot, 'assets', 'gel.png');
      await fs.mkdir(join(packageRoot, '.forge'), { recursive: true });
      await fs.mkdir(join(packageRoot, 'primers'), { recursive: true });
      await fs.mkdir(join(packageRoot, 'assets'), { recursive: true });
      await writeFile(productPath, GENBANK);
      await writeFile(csvPath, 'old primers');
      await writeFile(fastaPath, '>old\nACGT\n');
      await writeFile(assetPath, 'USER ASSET');
      await writeFile(
        metaPath,
        JSON.stringify({
          schema: 'waypoint.sequence.v1',
          kind: 'plasmid',
          id: 'stable-package-id',
          name: 'pUC19',
          updatedAt: '2026-07-26T00:00:00.000Z',
          product: {
            file: 'pUC19.gb',
            sequenceChecksum: 'old-sequence',
            genBankChecksum: 'old-genbank',
          },
          assembly: {
            accepted: { id: 'stale-accepted-version' },
            primers: {
              csv: 'primers/pUC19.primers.csv',
              fasta: 'primers/pUC19.primers.fasta',
            },
          },
        })
      );
      const replacement =
        'LOCUS       replacement  8 bp    DNA     linear SYN\nORIGIN\n        1 acgtacgt\n//\n';
      const looseImport = await importedFile('replacement.gb', replacement);

      const result = await materializeImportedSequencePackages(looseImport, undefined, {
        overwritePackageRoot: packageRoot,
      });

      expect(result).toMatchObject({
        converted: true,
        packages: [{ packageRoot, productPath }],
      });
      expect(await readFile(productPath, 'utf8')).toBe(replacement);
      const record = await readRecord(packageRoot);
      expect(record).toMatchObject({
        id: 'stable-package-id',
        name: 'pUC19',
        product: { file: 'pUC19.gb' },
      });
      expect(record.product.sequenceChecksum).toBeUndefined();
      expect(record.product.genBankChecksum).toBeUndefined();
      expect(record.assembly).toBeUndefined();
      expect(await readFile(assetPath, 'utf8')).toBe('USER ASSET');
      await expect(fs.stat(csvPath)).rejects.toThrow();
      await expect(fs.stat(fastaPath)).rejects.toThrow();
      await expect(fs.stat(looseImport)).rejects.toThrow();
    });

    it('refuses a malformed marker that nominates a user directory for generated cleanup', async () => {
      const packageRoot = join(dir, 'pUC19');
      const productPath = join(packageRoot, 'pUC19.gb');
      const metaPath = join(packageRoot, '.forge', 'plasmid.json');
      const assetPath = join(packageRoot, 'assets', 'gel.png');
      await fs.mkdir(join(packageRoot, '.forge'), { recursive: true });
      await fs.mkdir(join(packageRoot, 'assets'), { recursive: true });
      await writeFile(productPath, GENBANK);
      const malformedMeta = JSON.stringify({
        schema: 'waypoint.sequence.v1',
        kind: 'plasmid',
        id: 'stable-package-id',
        name: 'pUC19',
        product: { file: 'pUC19.gb' },
        assembly: {
          accepted: { id: 'old-build' },
          primers: { csv: 'assets/gel.png' },
        },
      });
      await writeFile(metaPath, malformedMeta);
      await writeFile(assetPath, 'IRREPLACEABLE USER ASSET');
      const replacement =
        'LOCUS       replacement  8 bp    DNA     linear SYN\nORIGIN\n        1 acgtacgt\n//\n';
      const looseImport = await importedFile('replacement.gb', replacement);

      await expect(
        materializeImportedSequencePackages(looseImport, undefined, {
          overwritePackageRoot: packageRoot,
        })
      ).rejects.toThrow(/exact generated primer file/i);

      expect(await readFile(assetPath, 'utf8')).toBe('IRREPLACEABLE USER ASSET');
      expect(await readFile(productPath, 'utf8')).toBe(GENBANK);
      expect(await readFile(metaPath, 'utf8')).toBe(malformedMeta);
      expect(await readFile(looseImport, 'utf8')).toBe(replacement);
    });

    it('refuses to consume a package member atomically replaced after inspection', async () => {
      const packageRoot = join(dir, 'pUC19');
      const productPath = join(packageRoot, 'pUC19.gb');
      const metaPath = join(packageRoot, '.forge', 'plasmid.json');
      await fs.mkdir(join(packageRoot, '.forge'), { recursive: true });
      await writeFile(productPath, GENBANK);
      await writeFile(
        metaPath,
        JSON.stringify({
          schema: 'waypoint.sequence.v1',
          kind: 'plasmid',
          id: 'stable-package-id',
          name: 'pUC19',
          product: { file: 'pUC19.gb' },
        })
      );
      const replacement =
        'LOCUS       replacement  8 bp    DNA     linear SYN\nORIGIN\n        1 acgtacgt\n//\n';
      const concurrentEdit =
        'LOCUS       concurrent  8 bp    DNA     linear SYN\nORIGIN\n        1 ttttcccc\n//\n';
      const looseImport = await importedFile('replacement.gb', replacement);
      let swapped = false;

      await expect(
        materializeImportedSequencePackages(
          looseImport,
          {
            writeMeta: (path, content) =>
              writeFile(path, content, { encoding: 'utf8', flag: 'wx' }).then(() => undefined),
            rename: async (from, to) => {
              if (!swapped && from === productPath && to.includes('.pUC19.import-previous-')) {
                swapped = true;
                const concurrentPath = join(packageRoot, '.concurrent.gb');
                await writeFile(concurrentPath, concurrentEdit);
                await fs.rename(concurrentPath, productPath);
              }
              await fs.rename(from, to);
            },
          },
          { overwritePackageRoot: packageRoot }
        )
      ).rejects.toThrow(/sequence package changed/i);

      expect(swapped).toBe(true);
      expect(await readFile(productPath, 'utf8')).toBe(concurrentEdit);
      expect(await readFile(looseImport, 'utf8')).toBe(replacement);
    });

    it('retains a replaced member in recovery when a third actor recreates its package path', async () => {
      const packageRoot = join(dir, 'pUC19');
      const productPath = join(packageRoot, 'pUC19.gb');
      const metaPath = join(packageRoot, '.forge', 'plasmid.json');
      await fs.mkdir(join(packageRoot, '.forge'), { recursive: true });
      await writeFile(productPath, GENBANK);
      await writeFile(
        metaPath,
        JSON.stringify({
          schema: 'waypoint.sequence.v1',
          kind: 'plasmid',
          id: 'stable-package-id',
          name: 'pUC19',
          product: { file: 'pUC19.gb' },
        })
      );
      const replacement =
        'LOCUS       replacement  8 bp    DNA     linear SYN\nORIGIN\n        1 acgtacgt\n//\n';
      const displacedEdit =
        'LOCUS       displaced  8 bp    DNA     linear SYN\nORIGIN\n        1 ttttcccc\n//\n';
      const newestEdit =
        'LOCUS       newest  8 bp    DNA     linear SYN\nORIGIN\n        1 ggggaaaa\n//\n';
      const looseImport = await importedFile('replacement.gb', replacement);
      let recoveryPath = '';

      await expect(
        materializeImportedSequencePackages(
          looseImport,
          {
            writeMeta: (path, content) =>
              writeFile(path, content, { encoding: 'utf8', flag: 'wx' }).then(() => undefined),
            rename: async (from, to) => {
              if (!recoveryPath && from === productPath && to.includes('.pUC19.import-previous-')) {
                const displaced = join(packageRoot, '.displaced.gb');
                await writeFile(displaced, displacedEdit);
                await fs.rename(displaced, productPath);
                await fs.rename(from, to);
                recoveryPath = to;
                await writeFile(productPath, newestEdit);
                return;
              }
              await fs.rename(from, to);
            },
          },
          { overwritePackageRoot: packageRoot }
        )
      ).rejects.toThrow(/recovery was incomplete|remains at/i);

      expect(recoveryPath).not.toBe('');
      expect(await readFile(productPath, 'utf8')).toBe(newestEdit);
      expect(await readFile(recoveryPath, 'utf8')).toBe(displacedEdit);
      expect(await readFile(looseImport, 'utf8')).toBe(replacement);
      expect((await readdir(dir)).some((name) => name.includes('.import-previous-'))).toBe(true);
    });

    it('never deletes a concurrent install destination when staged-source unlink fails', async () => {
      const packageRoot = join(dir, 'pUC19');
      const productPath = join(packageRoot, 'pUC19.gb');
      const metaPath = join(packageRoot, '.forge', 'plasmid.json');
      const oldMeta = JSON.stringify({
        schema: 'waypoint.sequence.v1',
        kind: 'plasmid',
        id: 'stable-package-id',
        name: 'pUC19',
        product: { file: 'pUC19.gb' },
      });
      await fs.mkdir(join(packageRoot, '.forge'), { recursive: true });
      await writeFile(productPath, GENBANK);
      await writeFile(metaPath, oldMeta);
      const replacement =
        'LOCUS       replacement  8 bp    DNA     linear SYN\nORIGIN\n        1 acgtacgt\n//\n';
      const concurrentEdit =
        'LOCUS       concurrent  8 bp    DNA     linear SYN\nORIGIN\n        1 ccccgggg\n//\n';
      const looseImport = await importedFile('replacement.gb', replacement);
      let rejectedStagedUnlink = false;

      await expect(
        materializeImportedSequencePackages(
          looseImport,
          {
            writeMeta: (path, content) =>
              writeFile(path, content, { encoding: 'utf8', flag: 'wx' }).then(() => undefined),
            unlink: async (path) => {
              if (
                !rejectedStagedUnlink &&
                path.includes('.pUC19.import-staging-') &&
                path.endsWith('/pUC19.gb')
              ) {
                rejectedStagedUnlink = true;
                const concurrent = join(packageRoot, '.concurrent.gb');
                await writeFile(concurrent, concurrentEdit);
                await fs.rename(concurrent, productPath);
                throw new Error('simulated staged source unlink failure');
              }
              await fs.unlink(path);
            },
          },
          { overwritePackageRoot: packageRoot }
        )
      ).rejects.toThrow(/recovery was incomplete|unlink failure/i);

      expect(rejectedStagedUnlink).toBe(true);
      expect(await readFile(productPath, 'utf8')).toBe(concurrentEdit);
      expect(await readFile(looseImport, 'utf8')).toBe(replacement);
      expect((await readdir(dir)).some((name) => name.includes('.import-staging-'))).toBe(true);
      expect((await readdir(dir)).some((name) => name.includes('.import-previous-'))).toBe(true);
    });

    it('recognizes and transactionally replaces a symlink-backed package product', async () => {
      const packageRoot = join(dir, 'pUC19');
      const productPath = join(packageRoot, 'pUC19.gb');
      const metaPath = join(packageRoot, '.forge', 'plasmid.json');
      const backingPath = join(dir, 'large-source.gb');
      await fs.mkdir(join(packageRoot, '.forge'), { recursive: true });
      await writeFile(backingPath, GENBANK);
      await fs.symlink(backingPath, productPath);
      await writeFile(
        metaPath,
        JSON.stringify({
          schema: 'waypoint.sequence.v1',
          kind: 'plasmid',
          id: 'stable-package-id',
          name: 'pUC19',
          product: { file: 'pUC19.gb' },
          assembly: { accepted: { id: 'stale-build' } },
        })
      );
      const replacement =
        'LOCUS       replacement  8 bp    DNA     linear SYN\nORIGIN\n        1 acgtacgt\n//\n';
      const looseImport = await importedFile('replacement.gb', replacement);

      await expect(existingPlasmidPackageRootForProduct(productPath)).resolves.toBe(packageRoot);
      await expect(
        materializeImportedSequencePackages(looseImport, undefined, {
          overwritePackageRoot: packageRoot,
        })
      ).resolves.toMatchObject({ converted: true });

      expect((await fs.lstat(productPath)).isFile()).toBe(true);
      expect(await readFile(productPath, 'utf8')).toBe(replacement);
      expect(await readFile(backingPath, 'utf8')).toBe(GENBANK);
      expect((await readRecord(packageRoot)).assembly).toBeUndefined();
    });

    it('does not delete a newer FASTA atomically installed while package overwrite is running', async () => {
      const packageRoot = join(dir, 'pUC19');
      const productPath = join(packageRoot, 'pUC19.gb');
      const metaPath = join(packageRoot, '.forge', 'plasmid.json');
      await fs.mkdir(join(packageRoot, '.forge'), { recursive: true });
      await writeFile(productPath, GENBANK);
      await writeFile(
        metaPath,
        JSON.stringify({
          schema: 'waypoint.sequence.v1',
          kind: 'plasmid',
          id: 'stable-package-id',
          name: 'pUC19',
          product: { file: 'pUC19.gb' },
        })
      );
      const oldSource = '>replacement plasmid DNA\nACGTACGTACGTACGTACGT\n';
      const newerSource = '>replacement plasmid DNA newer\nTTTTCCCCAAAAGGGGTTTT\n';
      const looseImport = await importedFile('replacement.fasta', oldSource);
      let installedNewerSource = false;

      const result = await materializeImportedSequencePackages(
        looseImport,
        {
          writeMeta: async (path, content) => {
            if (!installedNewerSource) {
              installedNewerSource = true;
              const concurrent = join(dir, '.replacement-concurrent.fasta');
              await writeFile(concurrent, newerSource, 'utf8');
              await fs.rename(concurrent, looseImport);
            }
            await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
          },
        },
        { overwritePackageRoot: packageRoot }
      );

      expect(result.converted).toBe(true);
      expect(await readFile(looseImport, 'utf8')).toBe(newerSource);
      expect(parseGenBankFull(await readFile(productPath, 'utf8')).sequence).toBe(
        'ACGTACGTACGTACGTACGT'
      );
    });

    it('refuses to replace a marker-recorded primer through a symlinked package parent', async () => {
      const packageRoot = join(dir, 'pUC19');
      const productPath = join(packageRoot, 'pUC19.gb');
      const metaPath = join(packageRoot, '.forge', 'plasmid.json');
      const externalRoot = join(dir, 'external-primers');
      const externalPrimer = join(externalRoot, 'pUC19.primers.csv');
      await fs.mkdir(join(packageRoot, '.forge'), { recursive: true });
      await fs.mkdir(externalRoot, { recursive: true });
      await writeFile(productPath, GENBANK);
      await writeFile(externalPrimer, 'IRREPLACEABLE EXTERNAL PRIMERS');
      await fs.symlink(externalRoot, join(packageRoot, 'primers'), 'dir');
      const oldMeta = JSON.stringify({
        schema: 'waypoint.sequence.v1',
        kind: 'plasmid',
        id: 'stable-package-id',
        name: 'pUC19',
        updatedAt: '2026-07-26T00:00:00.000Z',
        product: { file: 'pUC19.gb' },
        assembly: {
          accepted: { id: 'old-build' },
          primers: { csv: 'primers/pUC19.primers.csv' },
        },
      });
      await writeFile(metaPath, oldMeta);
      const replacement =
        'LOCUS       replacement  8 bp    DNA     linear SYN\nORIGIN\n        1 acgtacgt\n//\n';
      const looseImport = await importedFile('replacement.gb', replacement);

      await expect(
        materializeImportedSequencePackages(looseImport, undefined, {
          overwritePackageRoot: packageRoot,
        })
      ).rejects.toThrow(/symlink|outside|contain/i);

      expect(await readFile(externalPrimer, 'utf8')).toBe('IRREPLACEABLE EXTERNAL PRIMERS');
      expect(await readFile(productPath, 'utf8')).toBe(GENBANK);
      expect(await readFile(metaPath, 'utf8')).toBe(oldMeta);
      expect(await readFile(looseImport, 'utf8')).toBe(replacement);
    });

    it('restores the old package and loose import when marker installation fails after product replacement', async () => {
      const packageRoot = join(dir, 'pUC19');
      const productPath = join(packageRoot, 'pUC19.gb');
      const metaPath = join(packageRoot, '.forge', 'plasmid.json');
      const assetPath = join(packageRoot, 'assets', 'gel.png');
      const oldMeta = JSON.stringify({
        schema: 'waypoint.sequence.v1',
        kind: 'plasmid',
        id: 'stable-package-id',
        name: 'pUC19',
        updatedAt: '2026-07-26T00:00:00.000Z',
        product: { file: 'pUC19.gb', genBankChecksum: 'old-genbank' },
        assembly: { accepted: { id: 'old-build' } },
      });
      await fs.mkdir(join(packageRoot, '.forge'), { recursive: true });
      await fs.mkdir(join(packageRoot, 'assets'), { recursive: true });
      await writeFile(productPath, GENBANK);
      await writeFile(metaPath, oldMeta);
      await writeFile(assetPath, 'USER ASSET');
      const replacement =
        'LOCUS       replacement  8 bp    DNA     linear SYN\nORIGIN\n        1 acgtacgt\n//\n';
      const looseImport = await importedFile('replacement.gb', replacement);
      let rejectedInstall = false;

      await expect(
        materializeImportedSequencePackages(
          looseImport,
          {
            writeMeta: (path, content) =>
              writeFile(path, content, { encoding: 'utf8', flag: 'wx' }).then(() => undefined),
            link: async (oldPath, newPath) => {
              if (
                !rejectedInstall &&
                oldPath.includes('.pUC19.import-staging-') &&
                oldPath.endsWith('/.forge/plasmid.json') &&
                newPath === metaPath
              ) {
                rejectedInstall = true;
                throw new Error('simulated marker install failure');
              }
              await fs.link(oldPath, newPath);
            },
          },
          { overwritePackageRoot: packageRoot }
        )
      ).rejects.toThrow(/marker install failure/i);

      expect(rejectedInstall).toBe(true);
      expect(await readFile(productPath, 'utf8')).toBe(GENBANK);
      expect(await readFile(metaPath, 'utf8')).toBe(oldMeta);
      expect(await readFile(looseImport, 'utf8')).toBe(replacement);
      expect(await readFile(assetPath, 'utf8')).toBe('USER ASSET');
      expect((await readdir(dir)).filter((name) => name.includes('.import-'))).toEqual([]);
    });

    it('reports successful replacement even if retiring the private recovery directory fails', async () => {
      const packageRoot = join(dir, 'pUC19');
      const productPath = join(packageRoot, 'pUC19.gb');
      const metaPath = join(packageRoot, '.forge', 'plasmid.json');
      await fs.mkdir(join(packageRoot, '.forge'), { recursive: true });
      await writeFile(productPath, GENBANK);
      await writeFile(
        metaPath,
        JSON.stringify({
          schema: 'waypoint.sequence.v1',
          kind: 'plasmid',
          id: 'stable-package-id',
          name: 'pUC19',
          product: { file: 'pUC19.gb' },
        })
      );
      const replacement =
        'LOCUS       replacement  8 bp    DNA     linear SYN\nORIGIN\n        1 acgtacgt\n//\n';
      const looseImport = await importedFile('replacement.gb', replacement);
      const originalRm = fs.rm.bind(fs);
      const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(async (path, options) => {
        if (String(path).includes('.pUC19.import-previous-')) {
          throw new Error('simulated recovery cleanup failure');
        }
        return originalRm(path, options);
      });

      try {
        await expect(
          materializeImportedSequencePackages(looseImport, undefined, {
            overwritePackageRoot: packageRoot,
          })
        ).resolves.toMatchObject({ converted: true });
      } finally {
        rmSpy.mockRestore();
      }

      expect(await readFile(productPath, 'utf8')).toBe(replacement);
      await expect(fs.stat(looseImport)).rejects.toThrow();
      expect((await readdir(dir)).some((name) => name.includes('.import-previous-'))).toBe(true);
    });
  });

  describe('FASTA in', () => {
    it('CONVERTS a single record to GenBank inside a package', async () => {
      const result = await materializeImportedSequencePackages(
        await importedFile('pUC19.fasta', FASTA_ONE)
      );

      expect(result.converted).toBe(true);
      expect(result.packages).toHaveLength(1);
      expect(result.packages[0].productPath).toBe(join(dir, 'pUC19', 'pUC19.gb'));

      const genBank = await readFile(result.packages[0].productPath, 'utf8');
      expect(genBank).toContain('LOCUS');
      expect(genBank.toUpperCase()).toContain('ACGTACGTAC');

      await expect(fs.stat(join(dir, 'pUC19.fasta'))).rejects.toThrow();
      expect((await readRecord(result.packages[0].packageRoot)).product.file).toBe('pUC19.gb');
      await expect(fs.stat(join(result.packages[0].packageRoot, 'primers'))).rejects.toThrow();
    });

    it('splits a MULTI-record FASTA into one package per sequence, named by header', async () => {
      const result = await materializeImportedSequencePackages(
        await importedFile('many.fasta', FASTA_MANY)
      );

      expect(result.converted).toBe(true);
      expect(result.packages).toHaveLength(2);
      expect(result.packages.map((p) => p.productPath)).toEqual([
        join(dir, 'recA', 'recA.gb'),
        join(dir, 'lacZ', 'lacZ.gb'),
      ]);
      expect((await readFile(result.packages[0].productPath, 'utf8')).toUpperCase()).toContain(
        'AAAACCCC'
      );
      expect((await readFile(result.packages[1].productPath, 'utf8')).toUpperCase()).toContain(
        'GGGGTTTT'
      );
      const records = await Promise.all(result.packages.map((p) => readRecord(p.packageRoot)));
      expect(records[0].id).not.toBe(records[1].id);
      await expect(fs.stat(join(dir, 'many.fasta'))).rejects.toThrow();
    });

    it('does NOT convert a protein FASTA into a DNA record', async () => {
      const path = await importedFile('gfp.faa', '>GFP\nMSKGEELFTGVVPILVELDGDVNGHKFSVSGEGEGDAT\n');
      const result = await materializeImportedSequencePackages(path);

      expect(result.converted).toBe(false);
      expect(result.untouchedPath).toBe(path);
      expect((await fs.stat(path)).isFile()).toBe(true);
    });

    describe('fidelity', () => {
      const basesOf = (genBank: string) =>
        genBank
          .slice(genBank.indexOf('ORIGIN') + 'ORIGIN'.length)
          .replace(/[^A-Za-z]/g, '')
          .toUpperCase();

      it('preserves IUPAC ambiguity codes', async () => {
        const bases = 'ACGTACGTACGTACGTACGTACGTRYSWACGTACGTACGTACGTACGTACGT';
        const result = await materializeImportedSequencePackages(
          await importedFile('amb.fna', `>amb\n${bases}\n`)
        );
        expect(basesOf(await readFile(result.packages[0].productPath, 'utf8'))).toBe(bases);
      });

      it('preserves base CASE exactly as written, in both directions', async () => {
        const written = async (content: string) => {
          const result = await materializeImportedSequencePackages(
            await importedFile(`case-${content.length}.fna`, content)
          );
          const genBank = await readFile(result.packages[0].productPath, 'utf8');
          return genBank
            .slice(genBank.indexOf('ORIGIN') + 'ORIGIN'.length)
            .replace(/[^A-Za-z]/g, '');
        };
        expect(await written('>u\nACGTACGTAC\n')).toBe('ACGTACGTAC');
        expect(await written('>l\nacgtacgtacg\n')).toBe('acgtacgtacg');
      });

      it('handles CRLF line endings', async () => {
        const result = await materializeImportedSequencePackages(
          await importedFile('crlf.fna', '>crlf\r\nACGTACGTAC\r\nGGGG\r\n')
        );
        expect(basesOf(await readFile(result.packages[0].productPath, 'utf8'))).toBe(
          'ACGTACGTACGGGG'
        );
      });

      it('preserves the FULL FASTA header, which LOCUS alone cannot hold', async () => {
        const header = 'pUC19 cloning vector complete sequence, synthetic construct';
        const result = await materializeImportedSequencePackages(
          await importedFile('hdr.fasta', `>${header}\nACGTACGTAC\n`)
        );
        const genBank = await readFile(result.packages[0].productPath, 'utf8');
        expect(genBank).toContain(`DEFINITION  ${header}`);
      });

      it('preserves a FASTA identifier longer than the legacy LOCUS width after reopen', async () => {
        const identifier = 'ABCDEFGHIJKLMNOPQ';
        const result = await materializeImportedSequencePackages(
          await importedFile('long-id.fasta', `>${identifier} plasmid DNA\nACGTACGTAC\n`)
        );
        const reopened = parseGenBankFull(await readFile(result.packages[0].productPath, 'utf8'));

        expect(reopened.name).toBe(identifier);
      });

      it('keeps every base of a long multi-line record', async () => {
        const bases = 'ACGT'.repeat(500);
        const wrapped = bases.match(/.{1,60}/g)!.join('\n');
        const result = await materializeImportedSequencePackages(
          await importedFile('long.fna', `>long\n${wrapped}\n`)
        );
        expect(basesOf(await readFile(result.packages[0].productPath, 'utf8'))).toBe(bases);
      });
    });

    describe('refuses a lossy conversion instead of destroying the source', () => {
      const untouched = async (name: string, content: string) => {
        const path = await importedFile(name, content);
        const result = await materializeImportedSequencePackages(path);
        expect(result.converted).toBe(false);
        expect(await readFile(path, 'utf8')).toBe(content);
        return result;
      };

      it('leaves a PROTEIN sequence alone even in a plain .fasta', async () => {
        const result = await untouched(
          'gfp.fasta',
          '>GFP\nMSKGEELFTGVVPILVELDGDVNGHKFSVSGEGEGDAT\n'
        );
        expect(result.skippedReason).toMatch(/not.*dna|nucleotide/i);
      });

      it.each([
        ['an explicit peptide header', '>peptide\nACGTACGTACGTACGTACGT\n'],
        ['a record too short to classify', '>mystery\nACGTACGTACGT\n'],
        ['a two-letter repeat', '>lacZ gene\nGAGAGAGAGAGAGAGAGAGAGAGA\n'],
      ])(
        'does not infer DNA from composition when the generic FASTA has %s',
        async (_label, content) => {
          const result = await untouched('ambiguous.fasta', content);
          expect(result.skippedReason).toMatch(/protein|nucleotide|confirm/i);
        }
      );

      it.each([
        ['declares peptide content', 'peptide'],
        ['declares RNA content represented with T', 'RNA genome'],
        ['declares messenger RNA content represented with T', 'mRNA transcript'],
        ['declares single-stranded RNA content represented with T', 'ssRNA genome'],
        ['declares double-stranded RNA content represented with T', 'dsRNA genome'],
        ['declares RNA with an underscore-delimited suffix', 'sample_RNA'],
        ['declares messenger RNA with underscore delimiters', 'mRNA_transcript'],
      ])(
        'lets explicit non-DNA metadata override a .fna suffix that %s',
        async (_label, header) => {
          const result = await untouched('mislabelled.fna', `>${header}\nACGTACGTACGTACGTACGT\n`);
          expect(result.skippedReason).toMatch(/protein|peptide|RNA/i);
        }
      );

      it('leaves an ALIGNED sequence with gap characters alone', async () => {
        const result = await untouched('aln.fasta', '>aligned\nACGT--ACGT..ACGT\n');
        expect(result.skippedReason).toMatch(/gap|character/i);
      });

      it('leaves a file containing an EMPTY record alone', async () => {
        const result = await untouched('mixed.fasta', '>empty\n>kept\nACGTACGT\n');
        expect(result.skippedReason).toMatch(/empty/i);
      });

      it('requires nucleotide identity for every record in a multi-record generic FASTA', async () => {
        const content =
          '>known plasmid DNA sequence\nACGTACGTACGTACGTACGT\n' + '>mystery\nTTTTCCCCAAAA\n';
        const result = await untouched('mixed-identity.fasta', content);

        expect(result.skippedReason).toMatch(/record|mystery|nucleotide|confirm/i);
      });

      it('still converts an ordinary nucleotide FASTA', async () => {
        const path = await importedFile('ok.fna', '>ok\nACGTACGTACGTACGTACGT\n');
        const result = await materializeImportedSequencePackages(path);
        expect(result.converted).toBe(true);
      });

      it('does not delete a newer FASTA atomically installed while conversion is running', async () => {
        const oldSource = '>sample plasmid DNA\nACGTACGTACGTACGTACGT\n';
        const newerSource = '>sample plasmid DNA newer\nTTTTCCCCAAAAGGGGTTTT\n';
        const path = await importedFile('sample.fna', oldSource);
        let installedNewerSource = false;

        const result = await materializeImportedSequencePackages(path, {
          writeMeta: async (metaPath, content) => {
            if (!installedNewerSource) {
              installedNewerSource = true;
              const concurrent = join(dir, '.sample-concurrent.fna');
              await writeFile(concurrent, newerSource, 'utf8');
              await fs.rename(concurrent, path);
            }
            await writeFile(metaPath, content, { encoding: 'utf8', flag: 'wx' });
          },
        });

        expect(result.converted).toBe(true);
        expect(await readFile(path, 'utf8')).toBe(newerSource);
        expect(
          parseGenBankFull(await readFile(result.packages[0].productPath, 'utf8')).sequence
        ).toBe('ACGTACGTACGTACGTACGT');
      });

      it.each([
        ['MKWV', 'a protein of pure ambiguity-code letters'],
        ['MKWVMKWVMKWV', 'the same, long enough to look like a sequence'],
        ['ACGTRYSWKMBDHVN', 'a string that is mostly ambiguity codes'],
      ])('refuses %s (%s) rather than calling it DNA', async (bases, _why) => {
        const path = await importedFile('p.fasta', `>p\n${bases}\n`);
        const result = await materializeImportedSequencePackages(path);
        expect(result.converted).toBe(false);
        expect(result.skippedReason).toMatch(/ambiguity|not a DNA/i);
        expect(await readFile(path, 'utf8')).toContain(bases);
      });

      it('previews a large generic FASTA without allocating a per-base match array', async () => {
        const content = `>large-b\n${'acgT'.repeat(256 * 1024)}\n`;
        const path = await importedFile('large-b.fasta', content);
        const matches = vi.spyOn(String.prototype, 'match');
        try {
          const preview = await previewImportedSequencePackages(path);
          expect(preview.kind).toBe('ready');
          expect(await readFile(path, 'utf8')).toBe(content);
          const largestMatchResult = Math.max(
            0,
            ...matches.mock.results.map(({ type, value }) =>
              type === 'return' && Array.isArray(value) ? value.length : 0
            )
          );
          expect(largestMatchResult).toBeLessThanOrEqual(1024);
        } finally {
          matches.mockRestore();
        }
      });

      it.each([
        ['aCgTacGTAN', 'ready'],
        ['aCgTACGTNN', 'blocked'],
      ] as const)(
        'preserves the mixed-case 90%% core-base threshold for %s',
        async (bases, kind) => {
          const path = await importedFile('fraction.fna', `>DNA gene\n${bases}\n`);
          const preview = await previewImportedSequencePackages(path);
          expect(preview.kind).toBe(kind);
          if (preview.kind === 'blocked') expect(preview.reason).toMatch(/ambiguity/i);
        }
      );

      it('packages RNA with an RNA molecule type instead of labelling it DNA', async () => {
        const path = await importedFile('r.fasta', '>r\nACGUACGUACGUACGUACGU\n');
        const result = await materializeImportedSequencePackages(path);
        expect(result.converted).toBe(true);
        const product = await readFile(result.packages[0].productPath, 'utf8');
        expect(product).toMatch(/^LOCUS\s+\S+\s+20 bp\s+RNA\s/m);
        expect(parseGenBankFull(product)).toMatchObject({
          molecule: 'RNA',
          sequence: 'ACGUACGUACGUACGUACGU',
        });
      });

      it('refuses a file that mixes DNA and RNA records', async () => {
        const path = await importedFile(
          'mixed.fasta',
          '>d\nACGTACGTACGTACGTACGT\n>r\nACGUACGUACGUACGUACGU\n'
        );
        const result = await materializeImportedSequencePackages(path);
        expect(result.converted).toBe(false);
        expect(result.skippedReason).toContain('1 DNA, 1 RNA');
      });

      it.each([
        [
          'preamble text',
          'some notes about this file\n>ok\nACGTACGTACGTACGTACGT\n',
          /text before|could not be read/i,
        ],
        ['a ";" comment line', '>ok\n; this is a comment\nACGTACGTACGTACGTACGT\n', /comment/i],
        [
          'an indented header',
          '>a\nACGTACGTACGTACGTACGT\n  >b\nACGTACGTACGTACGTACGT\n',
          /indented/i,
        ],
      ])('refuses a file with %s', async (_label, content, expected) => {
        const path = await importedFile('odd.fasta', content);
        const result = await materializeImportedSequencePackages(path);
        expect(result.converted).toBe(false);
        expect(result.skippedReason).toMatch(expected);
        expect(await readFile(path, 'utf8')).toBe(content);
      });

      it('keeps BOM-prefixed multi-record descriptions aligned with their records', async () => {
        const path = await importedFile(
          'bom.fasta',
          '\uFEFF>first plasmid DNA alpha\nACGTACGTACGTACGTACGT\n' +
            '>second plasmid DNA beta\nTTTTCCCCAAAAGGGGTTTT\n'
        );
        const result = await materializeImportedSequencePackages(path);
        expect(result.converted).toBe(true);
        expect(result.packages).toHaveLength(2);
        const first = await readFile(result.packages[0].productPath, 'utf8');
        const second = await readFile(result.packages[1].productPath, 'utf8');
        expect(first).toContain('DEFINITION  first plasmid DNA alpha');
        expect(second).toContain('DEFINITION  second plasmid DNA beta');
      });
    });

    it('refuses to convert a file too large to hold in memory safely', async () => {
      const huge = `>big\n${'ACGT'.repeat(2000)}\n`;
      const path = await importedFile('big.fna', huge);

      const result = await materializeImportedSequencePackages(path, undefined, {
        maxConvertibleBytes: 1024,
      });

      expect(result.converted).toBe(false);
      expect(result.skippedReason).toMatch(/too large/i);
      expect(await readFile(path, 'utf8')).toBe(huge);
    });

    it('accepts the other FASTA extensions', async () => {
      for (const name of ['a.fa', 'b.fna', 'c.fas']) {
        const result = await materializeImportedSequencePackages(
          await importedFile(name, FASTA_ONE)
        );
        expect(result.converted).toBe(true);
      }
    });
  });

  describe('instrument data', () => {
    it('leaves reads and traces exactly where they are', async () => {
      for (const [name, content] of [
        ['reads.fastq', '@r\nAC\n+\nII\n'],
        ['trace.ab1', 'binary-ish'],
      ] as const) {
        const path = await importedFile(name, content);
        const result = await materializeImportedSequencePackages(path);
        expect(result.converted).toBe(false);
        expect(result.untouchedPath).toBe(path);
        expect((await fs.stat(path)).isFile()).toBe(true);
      }
    });

    it('classifies which files become packages', () => {
      expect(isConstructSequenceFile('a.gb')).toBe(true);
      expect(isConstructSequenceFile('a.GBK')).toBe(true);
      expect(isConstructSequenceFile('a.genbank')).toBe(true);
      expect(isConstructSequenceFile('a.fasta')).toBe(true);
      expect(isConstructSequenceFile('a.fa')).toBe(true);
      expect(isConstructSequenceFile('a.faa')).toBe(false);
      expect(isConstructSequenceFile('a.fastq')).toBe(false);
      expect(isConstructSequenceFile('a.ab1')).toBe(false);
      expect(isConstructSequenceFile('a.txt')).toBe(false);
    });
  });

  describe('safety', () => {
    it('publishes an opaque staging file under its explicit logical destination', async () => {
      const stagingRoot = join(dir, '.native-import-staging');
      await fs.mkdir(stagingRoot);
      const stagedPath = await importedFile('.native-import-staging/opaque-upload', GENBANK);

      const result = await materializeImportedSequencePackages(stagedPath, undefined, {
        destinationDirectory: dir,
        logicalFileName: 'incoming.gb',
        packageCollisionPolicy: 'exact',
      });

      expect(result.converted).toBe(true);
      expect(result.packages[0]).toEqual({
        packageRoot: join(dir, 'incoming'),
        productPath: join(dir, 'incoming', 'incoming.gb'),
      });
      expect(await readFile(result.packages[0].productPath, 'utf8')).toBe(GENBANK);
    });

    it('refuses an exact package collision instead of silently adding a suffix', async () => {
      const stagingRoot = join(dir, '.native-import-staging');
      await fs.mkdir(stagingRoot);
      const stagedPath = await importedFile('.native-import-staging/opaque-upload', GENBANK);
      await fs.mkdir(join(dir, 'incoming'));
      await writeFile(join(dir, 'incoming', 'external.txt'), 'owned elsewhere');

      await expect(
        materializeImportedSequencePackages(stagedPath, undefined, {
          destinationDirectory: dir,
          logicalFileName: 'incoming.gb',
          packageCollisionPolicy: 'exact',
        })
      ).rejects.toMatchObject({ code: 'SEQUENCE_PACKAGE_TARGET_EXISTS' });

      expect(await readFile(stagedPath, 'utf8')).toBe(GENBANK);
      expect(await readFile(join(dir, 'incoming', 'external.txt'), 'utf8')).toBe('owned elsewhere');
      expect(await readdir(dir)).toEqual(expect.not.arrayContaining(['incoming (1)']));
    });

    it('does not overwrite a product created after the exact package root is claimed', async () => {
      const stagingRoot = join(dir, '.native-import-staging');
      await fs.mkdir(stagingRoot);
      const stagedPath = await importedFile('.native-import-staging/opaque-upload', GENBANK);
      const productPath = join(dir, 'incoming', 'incoming.gb');
      const externalBytes = 'owned by an outside writer';
      let injected = false;

      await expect(
        materializeImportedSequencePackages(
          stagedPath,
          {
            writeMeta: (path, content) => writeFile(path, content, { flag: 'wx' }),
            link: async (sourcePath, destinationPath) => {
              if (!injected && destinationPath === productPath) {
                injected = true;
                await writeFile(productPath, externalBytes, { flag: 'wx' });
              }
              await fs.link(sourcePath, destinationPath);
            },
          },
          {
            destinationDirectory: dir,
            logicalFileName: 'incoming.gb',
            packageCollisionPolicy: 'exact',
          }
        )
      ).rejects.toMatchObject({ code: 'EEXIST' });

      expect(await readFile(stagedPath, 'utf8')).toBe(GENBANK);
      expect(await readFile(productPath, 'utf8')).toBe(externalBytes);
    });

    it('preserves a source replacement that appears after the destination link is created', async () => {
      const stagingRoot = join(dir, '.native-import-staging');
      await fs.mkdir(stagingRoot);
      const stagedPath = await importedFile('.native-import-staging/opaque-upload', GENBANK);
      const displacedPath = `${stagedPath}.displaced`;
      const externalBytes = 'new source owned by an outside writer';
      let injected = false;

      await expect(
        materializeImportedSequencePackages(
          stagedPath,
          {
            writeMeta: (path, content) => writeFile(path, content, { flag: 'wx' }),
            link: async (sourcePath, destinationPath) => {
              await fs.link(sourcePath, destinationPath);
              if (!injected) {
                injected = true;
                await fs.rename(sourcePath, displacedPath);
                await writeFile(sourcePath, externalBytes, { flag: 'wx' });
              }
            },
          },
          {
            destinationDirectory: dir,
            logicalFileName: 'incoming.gb',
            packageCollisionPolicy: 'exact',
          }
        )
      ).rejects.toThrow(/SOURCE_CHANGED/u);

      expect(await readFile(stagedPath, 'utf8')).toBe(externalBytes);
      expect(await readFile(displacedPath, 'utf8')).toBe(GENBANK);
      expect(existsSync(join(dir, 'incoming'))).toBe(false);
    });

    it('gives two imports of the same name two separate packages', async () => {
      const first = await materializeImportedSequencePackages(
        await importedFile('pUC19.gb', GENBANK)
      );
      const second = await materializeImportedSequencePackages(
        await importedFile('pUC19.gb', GENBANK)
      );

      expect(first.packages[0].packageRoot).toBe(join(dir, 'pUC19'));
      expect(second.packages[0].packageRoot).toBe(join(dir, 'pUC19 (1)'));
      const a = await readRecord(first.packages[0].packageRoot);
      const b = await readRecord(second.packages[0].packageRoot);
      expect(a.id).not.toBe(b.id);
    });

    it('does not claim a stray file is the package product', async () => {
      const first = await materializeImportedSequencePackages(
        await importedFile('pUC19.gb', GENBANK)
      );
      const strayPath = join(first.packages[0].packageRoot, 'unrelated.gb');
      await writeFile(strayPath, GENBANK, 'utf8');

      const result = await materializeImportedSequencePackages(strayPath);

      expect(result.converted).toBe(false);
      expect(result.packages).toHaveLength(0);
      expect(result.untouchedPath).toBe(strayPath);
      expect(result.skippedReason).toMatch(/not the product/i);
    });

    it('does not nest a package when the file is already inside one', async () => {
      const first = await materializeImportedSequencePackages(
        await importedFile('pUC19.gb', GENBANK)
      );
      const again = await materializeImportedSequencePackages(first.packages[0].productPath);

      expect(again.converted).toBe(false);
      await expect(fs.stat(join(dir, 'pUC19', 'pUC19'))).rejects.toThrow();
    });

    it('leaves an unparseable file alone rather than half-converting it', async () => {
      const path = await importedFile('broken.fasta', 'this is not a fasta at all');
      const result = await materializeImportedSequencePackages(path);
      expect(result.converted).toBe(false);
      expect(await readFile(path, 'utf8')).toBe('this is not a fasta at all');
    });

    it('restores the plasmid when the record write fails AFTER the move', async () => {
      const path = await importedFile('pUC19.gb', GENBANK);

      await expect(
        materializeImportedSequencePackages(path, {
          writeMeta: async () => {
            throw new Error('simulated disk full');
          },
        })
      ).rejects.toThrow(/disk full/i);

      expect(await readFile(path, 'utf8')).toBe(GENBANK);
      await expect(fs.stat(join(dir, 'pUC19'))).rejects.toThrow();
    });

    it('reports the recovery location when metadata writing and source restoration both fail', async () => {
      const path = await importedFile('pUC19.gb', GENBANK);
      const packageProduct = join(dir, 'pUC19', 'pUC19.gb');

      await expect(
        materializeImportedSequencePackages(path, {
          writeMeta: async () => {
            await fs.mkdir(path);
            throw new Error('simulated metadata failure');
          },
        })
      ).rejects.toThrow(/could not restore|surviving product|recovery/i);

      expect(await readFile(packageProduct, 'utf8')).toBe(GENBANK);
      expect((await fs.stat(path)).isDirectory()).toBe(true);
    });

    it('never loses the import when packaging cannot proceed', async () => {
      const path = await importedFile('pUC19.gb', GENBANK);
      await fs.chmod(dir, 0o500);
      try {
        await expect(materializeImportedSequencePackages(path)).rejects.toThrow();
        expect(await readFile(path, 'utf8')).toBe(GENBANK);
      } finally {
        await fs.chmod(dir, 0o700);
      }
    });
  });

  describe('overwriting with a file that cannot be read', () => {
    it('reports a skip with a real reason instead of throwing', async () => {
      const original = await importedFile('pUC19.gb', GENBANK);
      const created = await materializeImportedSequencePackages(original);
      const packageRoot = created.packages[0]?.packageRoot;
      expect(packageRoot).toBeTruthy();

      const unreadable = join(dir, 'pUC19.fna');
      await fs.mkdir(unreadable);

      try {
        const result = await materializeImportedSequencePackages(unreadable, undefined, {
          overwritePackageRoot: packageRoot,
        });

        expect(result.packages).toEqual([]);
        expect(result.untouchedPath).toBe(unreadable);
        expect(typeof result.skippedReason).toBe('string');
        expect(result.skippedReason).toContain('pUC19.fna');
        expect(result.skippedReason).not.toContain('errorMessage is not defined');

        expect(await readFile(join(packageRoot!, 'pUC19.gb'), 'utf8')).toBe(GENBANK);
      } finally {
        await fs.rm(unreadable, { recursive: true, force: true }).catch(() => {});
      }
    });
  });
});
