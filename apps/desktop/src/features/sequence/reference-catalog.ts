import {
  buildAssemblyManifest,
  type AssemblySequenceAliases,
  type AssemblySequenceRole,
  type ChromosomeMorphologyV1,
  type GenomeAssembly,
} from '@waypoint/genome-data';
import type {
  AssemblyReferenceAssetGenerationByThemeV1,
  IndexedGenomeManifest,
} from '../../shared/indexed-genome';
import { chromosomeById } from './tracks/cytobands';
import type {
  ReferenceContentIdentity,
  ReferenceVersionIdentity,
} from '../../shared/reference-content-identity';

export interface ReferenceCatalogEntry {
  id: string;
  name: string;
  organism: string;
  assembly?: string;
  description: string;
  lengthBp: number;
  circular: boolean;
  relativePath: string;
  category: 'plasmid' | 'bacteria' | 'yeast' | 'human' | 'other';
  tags?: ReadonlyArray<string>;
}

export const REFERENCE_CATALOG: ReadonlyArray<ReferenceCatalogEntry> = [
  {
    id: 'puc19',
    name: 'pUC19',
    organism: 'Synthetic plasmid',
    description: 'Classic cloning vector. 2.7 kb circular with lacZ, AmpR, ori.',
    lengthBp: 2686,
    circular: true,
    relativePath: 'test-fixtures/sequences/circular/pUC19.gb',
    category: 'plasmid',
    tags: ['cloning', 'small', 'classic'],
  },

  {
    id: 'ecoli-mg1655',
    name: 'E. coli MG1655',
    organism: 'Escherichia coli',
    assembly: 'U00096.3',
    description: '4.6 Mb circular bacterial chromosome — workhorse strain.',
    lengthBp: 4_641_652,
    circular: true,
    relativePath: 'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb',
    category: 'bacteria',
    tags: ['model-organism', 'circular', 'workhorse'],
  },
  {
    id: 'scerevisiae-chrIV',
    name: 'S. cerevisiae chrIV',
    organism: 'Saccharomyces cerevisiae',
    assembly: 'S288C',
    description: '1.5 Mb yeast chromosome — model eukaryote with some spliced genes.',
    lengthBp: 1_531_933,
    circular: false,
    relativePath: 'test-fixtures/genomes/yeast-chrIV/chrIV.gbff',
    category: 'yeast',
    tags: ['model-organism', 'eukaryotic'],
  },
];

export function resolveCatalogEntry(
  entry: ReferenceCatalogEntry,
  projectRoot: string
): { absolutePath: string } {
  return { absolutePath: joinProjectPath(projectRoot, entry.relativePath) };
}

export function joinProjectPath(projectRoot: string, relativePath: string): string {
  const normalizedRoot = projectRoot.replace(/[/\\]+$/, '');
  const sep = normalizedRoot.includes('\\') ? '\\' : '/';
  return `${normalizedRoot}${sep}${relativePath.replace(/[/\\]+/g, sep)}`;
}

export interface ReferenceAssemblyImportSource {
  readonly fastaPath: string;
  readonly gffPath?: string;
  readonly sourceSeqId?: string;
  readonly fastaSha256?: string;
  readonly gffSha256?: string;
}

export interface ReferenceAssemblyMember {
  chrom: string;
  readonly displayName?: string;
  readonly lengthBp?: number;
  readonly role?: AssemblySequenceRole;
  readonly aliases?: AssemblySequenceAliases;
  readonly md5?: string;
  readonly circular?: boolean;
  readonly cytobandId?: string;
  readonly morphology?: ChromosomeMorphologyV1;
  readonly importSource?: Readonly<ReferenceAssemblyImportSource>;
  manifest?: Readonly<{
    fastaPath: string;
    faiPath: string;
    gffPath?: string;
    tbiPath?: string;
  }>;
}

export interface ReferenceAssemblyEntry {
  id: string;
  name: string;
  organism: string;
  taxId?: number;
  assembly?: string;
  description: string;
  assetCacheKey: string;
  members: ReadonlyArray<ReferenceAssemblyMember>;
  readonly referenceIdentity?: ReferenceContentIdentity;
  readonly referenceVersionHistory?: readonly ReferenceVersionIdentity[];
  ucscTrackTarget?: Readonly<{ genomeId: string; hubUrl: string }>;
  portableView?: Readonly<{
    generationRoot: string;
    bundleFingerprint: string;
    trackTypes: readonly string[];
    datasetVersion?: string;
    assetGenerationsByTheme?: AssemblyReferenceAssetGenerationByThemeV1;
    searchReady?: boolean;
  }>;
}

const GRCH38_KARYOTYPE: ReadonlyArray<string> = [
  ...Array.from({ length: 22 }, (_, i) => `chr${i + 1}`),
  'chrX',
  'chrY',
];

const GRCH38_MEMBERS: ReadonlyArray<ReferenceAssemblyMember> = GRCH38_KARYOTYPE.map((chrom) => ({
  chrom,
  role: 'assembled-molecule',
  circular: false,
  cytobandId: chrom,
  importSource: {
    fastaPath: `test-fixtures/sources/ncbi-gff3/${chrom}.fa`,
    gffPath: `test-fixtures/sources/ncbi-gff3/${chrom}.gff3.gz`,
  },
  manifest: {
    fastaPath: `prepared/${chrom}/${chrom}.fa.gz`,
    faiPath: `prepared/${chrom}/${chrom}.fa.gz.fai`,
    gffPath: `prepared/${chrom}/${chrom}.gff3.gz`,
    tbiPath: `prepared/${chrom}/${chrom}.gff3.gz.tbi`,
  },
}));

export const REFERENCE_ASSEMBLY_CATALOG: ReadonlyArray<ReferenceAssemblyEntry> = [
  {
    id: 'grch38',
    name: 'GRCh38 (human)',
    organism: 'Homo sapiens',
    assembly: 'GRCh38.p14',
    description:
      'Human reference — full karyotype (chr1-22, X, Y). Ideograms + annotation ' +
      'detail for all 24 chromosomes (NCBI RefSeq GRCh38.p14).',
    assetCacheKey: 'grch38',
    members: GRCH38_MEMBERS,
  },
];

export function referenceAssemblyById(id: string): ReferenceAssemblyEntry | undefined {
  return REFERENCE_ASSEMBLY_CATALOG.find((a) => a.id === id);
}

export function referenceAssemblyViewsForAssetCacheKey(
  assetCacheKey: string
): ReadonlyArray<ReferenceAssemblyEntry> {
  return REFERENCE_ASSEMBLY_CATALOG.filter((entry) => entry.assetCacheKey === assetCacheKey);
}

export function referenceAssemblySourceOwner(
  entry: Pick<ReferenceAssemblyEntry, 'assetCacheKey'>
): ReferenceAssemblyEntry | undefined {
  return REFERENCE_ASSEMBLY_CATALOG.find(
    (candidate) =>
      candidate.id === entry.assetCacheKey && candidate.assetCacheKey === entry.assetCacheKey
  );
}

export function referenceAssemblyCacheRoot(
  referenceAssetCacheRoot: string,
  entry: Pick<ReferenceAssemblyEntry, 'assetCacheKey'>
): string {
  return joinProjectPath(referenceAssetCacheRoot, entry.assetCacheKey);
}

export function buildGenomeAssembly(
  entry: ReferenceAssemblyEntry,
  resolveAbs: (relativePath: string) => string
): GenomeAssembly {
  const chromosomes = entry.members.map((member) => {
    const registryChrom = member.cytobandId ? chromosomeById[member.cytobandId] : undefined;
    const length = member.lengthBp ?? registryChrom?.length ?? 0;
    const hasGff = Boolean(member.manifest?.gffPath);
    const hasTbi = Boolean(member.manifest?.tbiPath);
    if (hasGff !== hasTbi) {
      throw new Error(
        `Reference assembly chromosome has a partial annotation manifest: ${member.chrom}`
      );
    }
    const manifest: IndexedGenomeManifest = {
      chrom: member.chrom,
      fastaPath: member.manifest ? resolveAbs(member.manifest.fastaPath) : '',
      faiPath: member.manifest ? resolveAbs(member.manifest.faiPath) : '',
      gffPath: hasGff ? resolveAbs(member.manifest!.gffPath!) : null,
      tbiPath: hasTbi ? resolveAbs(member.manifest!.tbiPath!) : null,
      length,
    };
    return {
      chrom: member.chrom,
      displayName: member.displayName ?? member.chrom,
      length,
      manifest,
      role: member.role,
      aliases: member.aliases,
      md5: member.md5,
      circular: member.circular,
      cytobandId: registryChrom ? member.cytobandId : undefined,
      morphology: member.morphology,
    };
  });
  return buildAssemblyManifest({
    assemblyId: entry.id,
    displayName: entry.name,
    organism: entry.organism,
    taxId: entry.taxId,
    assembly: entry.assembly,
    ...(entry.ucscTrackTarget ? { ucscTrackTarget: { ...entry.ucscTrackTarget } } : {}),
    chromosomes,
  });
}

export function anchorChromosomeOf(
  assembly: GenomeAssembly
): GenomeAssembly['chromosomes'][number] | null {
  return (
    assembly.chromosomes.find(
      (chromosome) => Boolean(chromosome.manifest.fastaPath) && Boolean(chromosome.manifest.faiPath)
    ) ?? null
  );
}

export function referenceAssemblyLengthBp(entry: ReferenceAssemblyEntry): number {
  return entry.members.reduce((total, member) => {
    const length =
      member.lengthBp ??
      (member.cytobandId ? chromosomeById[member.cytobandId]?.length : undefined);
    if (!length)
      throw new Error(`Reference assembly chromosome has no registered length: ${member.chrom}`);
    return total + length;
  }, 0);
}

export function formatLengthForPicker(lengthBp: number): string {
  if (lengthBp < 1000) return `${lengthBp.toLocaleString()} bp`;
  if (lengthBp < 1_000_000) return `${(lengthBp / 1000).toFixed(1)} kb`;
  if (lengthBp < 1_000_000_000) return `${(lengthBp / 1_000_000).toFixed(1)} Mb`;
  return `${(lengthBp / 1_000_000_000).toFixed(2)} Gb`;
}

export function groupCatalogEntries(
  catalog: ReadonlyArray<ReferenceCatalogEntry> = REFERENCE_CATALOG
): Array<{ category: ReferenceCatalogEntry['category']; entries: ReferenceCatalogEntry[] }> {
  const groups = new Map<ReferenceCatalogEntry['category'], ReferenceCatalogEntry[]>();
  for (const entry of catalog) {
    const arr = groups.get(entry.category) ?? [];
    arr.push(entry);
    groups.set(entry.category, arr);
  }
  const order: ReferenceCatalogEntry['category'][] = [
    'plasmid',
    'bacteria',
    'yeast',
    'human',
    'other',
  ];
  return order.flatMap((category) => {
    const entries = groups.get(category);
    return entries ? [{ category, entries }] : [];
  });
}
