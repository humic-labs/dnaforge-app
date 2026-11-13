import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  REFERENCE_CATALOG,
  REFERENCE_ASSEMBLY_CATALOG,
  referenceAssemblyById,
  formatLengthForPicker,
  groupCatalogEntries,
  resolveCatalogEntry,
  buildGenomeAssembly,
  anchorChromosomeOf,
  joinProjectPath,
  referenceAssemblyCacheRoot,
} from './reference-catalog';
import { chromosomeById } from './tracks/cytobands';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

describe('REFERENCE_CATALOG', () => {
  it('has at least one entry per supported category we ship', () => {
    const categories = new Set(REFERENCE_CATALOG.map((e) => e.category));
    expect(categories.has('plasmid')).toBe(true);
    expect(categories.has('bacteria')).toBe(true);
    expect(categories.has('yeast')).toBe(true);
  });

  it('all entries have unique ids', () => {
    const ids = new Set<string>();
    for (const entry of REFERENCE_CATALOG) {
      expect(ids.has(entry.id), `duplicate id: ${entry.id}`).toBe(false);
      ids.add(entry.id);
    }
  });

  it('all entries point to a repo-relative path (no absolute paths)', () => {
    for (const entry of REFERENCE_CATALOG) {
      expect(entry.relativePath.startsWith('/'), `${entry.id} has absolute path`).toBe(false);
      expect(entry.relativePath.length).toBeGreaterThan(0);
    }
  });

  it('all entries have a positive bp length', () => {
    for (const entry of REFERENCE_CATALOG) {
      expect(entry.lengthBp, `${entry.id} lengthBp`).toBeGreaterThan(0);
    }
  });

  it('all catalog entries resolve to files committed in this repo', () => {
    for (const entry of REFERENCE_CATALOG) {
      const absolutePath = resolve(REPO_ROOT, entry.relativePath);
      expect(existsSync(absolutePath), `${entry.id} missing ${entry.relativePath}`).toBe(true);
    }
  });
});

describe('resolveCatalogEntry', () => {
  it('joins the project root with the entry relative path', () => {
    const entry = REFERENCE_CATALOG[0];
    const { absolutePath } = resolveCatalogEntry(entry, '/Users/foo/waypoint');
    expect(absolutePath).toBe(`/Users/foo/waypoint/${entry.relativePath}`);
  });

  it('strips trailing slashes from the project root', () => {
    const entry = REFERENCE_CATALOG[0];
    const { absolutePath } = resolveCatalogEntry(entry, '/Users/foo/waypoint/');
    expect(absolutePath).toBe(`/Users/foo/waypoint/${entry.relativePath}`);
  });
});

describe('formatLengthForPicker', () => {
  it('formats bp / kb / Mb / Gb thresholds correctly', () => {
    expect(formatLengthForPicker(950)).toBe('950 bp');
    expect(formatLengthForPicker(2_686)).toBe('2.7 kb');
    expect(formatLengthForPicker(50_818_468)).toBe('50.8 Mb');
    expect(formatLengthForPicker(248_956_422)).toBe('249.0 Mb');
    expect(formatLengthForPicker(3_200_000_000)).toBe('3.20 Gb');
  });
});

describe('groupCatalogEntries', () => {
  it('groups entries by category in plasmid → bacteria → yeast order', () => {
    const groups = groupCatalogEntries();
    const order = groups.map((g) => g.category);
    expect(order).toEqual(['plasmid', 'bacteria', 'yeast']);
  });

  it('each group is non-empty', () => {
    const groups = groupCatalogEntries();
    for (const group of groups) {
      expect(group.entries.length).toBeGreaterThan(0);
    }
  });

  it('returns no group for categories with no entries (filtered catalog)', () => {
    const filtered = REFERENCE_CATALOG.filter((e) => e.category === 'yeast');
    const groups = groupCatalogEntries(filtered);
    expect(groups.length).toBe(1);
    expect(groups[0].category).toBe('yeast');
  });
});

describe('REFERENCE_ASSEMBLY_CATALOG ', () => {
  it('ships the GRCh38 full-karyotype assembly with 24 ordered chromosomes', () => {
    expect(REFERENCE_ASSEMBLY_CATALOG.length).toBeGreaterThanOrEqual(1);
    const grch38 = referenceAssemblyById('grch38');
    expect(grch38).toBeDefined();
    expect(grch38!.members.map((m) => m.chrom)).toEqual([
      ...Array.from({ length: 22 }, (_, i) => `chr${i + 1}`),
      'chrX',
      'chrY',
    ]);
  });

  it('marks every GRCh38 chromosome as indexed', () => {
    const grch38 = referenceAssemblyById('grch38')!;
    const indexed = grch38.members.filter((m) => m.manifest).map((m) => m.chrom);
    expect(indexed).toEqual([
      ...Array.from({ length: 22 }, (_, i) => `chr${i + 1}`),
      'chrX',
      'chrY',
    ]);
    expect(grch38.members.filter((m) => !m.manifest)).toHaveLength(0);
  });

  it('separates raw NCBI import inputs from canonical prepared manifests', () => {
    const grch38 = referenceAssemblyById('grch38')!;
    for (const chrom of ['chr1', 'chr2', 'chr11', 'chr22', 'chrX', 'chrY']) {
      const m = grch38.members.find((x) => x.chrom === chrom)!;
      expect(m.importSource).toEqual({
        fastaPath: `test-fixtures/sources/ncbi-gff3/${chrom}.fa`,
        gffPath: `test-fixtures/sources/ncbi-gff3/${chrom}.gff3.gz`,
      });
      expect(m.manifest).toEqual({
        fastaPath: `prepared/${chrom}/${chrom}.fa.gz`,
        faiPath: `prepared/${chrom}/${chrom}.fa.gz.fai`,
        gffPath: `prepared/${chrom}/${chrom}.gff3.gz`,
        tbiPath: `prepared/${chrom}/${chrom}.gff3.gz.tbi`,
      });
    }
  });
});

describe('buildGenomeAssembly  registry → entity)', () => {
  const CACHE_ROOT = '/Users/foo/Library/Application Support/DNAForge/reference-assets';
  const ASSEMBLY_CACHE_ROOT = referenceAssemblyCacheRoot(
    CACHE_ROOT,
    referenceAssemblyById('grch38')!
  );
  const resolveAbs = (rel: string) => joinProjectPath(ASSEMBLY_CACHE_ROOT, rel);

  it('yields all 24 chromosomes in karyotype order with registry lengths', () => {
    const grch38 = buildGenomeAssembly(referenceAssemblyById('grch38')!, resolveAbs);
    expect(grch38.assemblyId).toBe('grch38');
    expect(grch38.displayName).toBe('GRCh38 (human)');
    expect(grch38.organism).toBe('Homo sapiens');
    expect(grch38.chromosomes.map((c) => c.chrom)).toEqual([
      ...Array.from({ length: 22 }, (_, i) => `chr${i + 1}`),
      'chrX',
      'chrY',
    ]);
    for (const c of grch38.chromosomes) {
      expect(c.length).toBe(chromosomeById[c.chrom].length);
      expect(c.length).toBeGreaterThan(0);
      expect(c.cytobandId).toBe(c.chrom);
    }
  });

  it('attaches canonical prepared gff paths for every chromosome', () => {
    const grch38 = buildGenomeAssembly(referenceAssemblyById('grch38')!, resolveAbs);
    const byChrom = Object.fromEntries(grch38.chromosomes.map((c) => [c.chrom, c]));
    for (const chrom of [...Array.from({ length: 22 }, (_, i) => `chr${i + 1}`), 'chrX', 'chrY']) {
      expect(byChrom[chrom].manifest.gffPath).toMatch(
        new RegExp(`^${ASSEMBLY_CACHE_ROOT}/prepared/${chrom}/${chrom}\\.gff3\\.gz$`)
      );
    }
  });

  it('chr11 axis length matches the frozen visual contract (135,086,622 bp)', () => {
    const grch38 = buildGenomeAssembly(referenceAssemblyById('grch38')!, resolveAbs);
    const chr11 = grch38.chromosomes.find((c) => c.chrom === 'chr11')!;
    expect(chr11.length).toBe(135_086_622);
  });

  it('anchorChromosomeOf returns the first indexed chromosome (chr1)', () => {
    const grch38 = buildGenomeAssembly(referenceAssemblyById('grch38')!, resolveAbs);
    const anchor = anchorChromosomeOf(grch38);
    expect(anchor?.chrom).toBe('chr1');
    expect(anchor?.manifest.gffPath).toContain('prepared/chr1/chr1.gff3.gz');
  });

  it('treats FASTA/FAI as the indexed source and preserves a sequence-only member', () => {
    const sequenceOnly = buildGenomeAssembly(
      {
        id: 'sequence-only',
        name: 'Sequence only',
        organism: 'Test organism',
        description: 'No annotation source was supplied.',
        assetCacheKey: 'sequence-only',
        members: [
          {
            chrom: 'contig-1',
            lengthBp: 12_345,
            importSource: { fastaPath: 'sources/contig-1.fa' },
            manifest: {
              fastaPath: 'prepared/contig-1/contig-1.fa',
              faiPath: 'prepared/contig-1/contig-1.fa.fai',
            },
          },
        ],
      },
      resolveAbs
    );

    expect(sequenceOnly.chromosomes[0]?.manifest).toMatchObject({
      fastaPath: `${ASSEMBLY_CACHE_ROOT}/prepared/contig-1/contig-1.fa`,
      faiPath: `${ASSEMBLY_CACHE_ROOT}/prepared/contig-1/contig-1.fa.fai`,
      gffPath: null,
      tbiPath: null,
    });
    expect(anchorChromosomeOf(sequenceOnly)?.chrom).toBe('contig-1');
  });

  it('rejects a partial GFF3/TBI annotation pair instead of guessing a sibling path', () => {
    const partial = {
      id: 'partial-annotation',
      name: 'Partial annotation',
      organism: 'Test organism',
      description: 'Invalid fixture',
      assetCacheKey: 'partial-annotation',
      members: [
        {
          chrom: 'contig-1',
          lengthBp: 12_345,
          manifest: {
            fastaPath: 'prepared/contig-1/contig-1.fa',
            faiPath: 'prepared/contig-1/contig-1.fa.fai',
            gffPath: 'prepared/contig-1/contig-1.gff3.gz',
          },
        },
      ],
    };

    expect(() => buildGenomeAssembly(partial, resolveAbs)).toThrow(
      'partial annotation manifest: contig-1'
    );
  });

  it('does not expose a standalone human chromosome as an assembly-test shortcut', () => {
    expect(
      REFERENCE_ASSEMBLY_CATALOG.some(
        (assembly) =>
          assembly.assembly === 'GRCh38.p14' &&
          assembly.id !== 'grch38' &&
          assembly.members.length < 24
      )
    ).toBe(false);
  });
});
