export type EntityColorFamily = 'dna' | 'rna' | 'protein' | 'data' | 'code' | 'neutral';

export interface EntityColorContext {
  kind?: string;
  molecule?: string;
  path?: string;
  packageKind?: string;
  isDirectory?: boolean;
}

const KIND_FAMILIES: Readonly<Record<string, EntityColorFamily>> = {
  dna: 'dna',
  'dna-sequence': 'dna',
  'dna-sequences': 'dna',
  'dna-oligos': 'dna',
  'dna-oligo': 'dna',
  plasmid: 'dna',
  genome: 'dna',
  chromosome: 'dna',
  design: 'dna',
  assembly: 'dna',
  'assembly-panel': 'dna',
  'assembly-browser': 'dna',
  'adjacency-graph': 'dna',
  construct: 'dna',
  allele: 'dna',
  locus: 'dna',
  part: 'dna',
  fragment: 'dna',
  marker: 'dna',
  rna: 'rna',
  'rna-sequence': 'rna',
  'rna-sequences': 'rna',
  'rna-oligo': 'rna',
  'rna-oligos': 'rna',
  'guide-rna': 'rna',
  protein: 'protein',
  proteins: 'protein',
  'protein-sequence': 'protein',
  structure: 'protein',
  structure3d: 'protein',
  'molecular-document': 'protein',
  annotation: 'data',
  annotations: 'data',
  'sequence-region': 'data',
  alignment: 'data',
  data: 'data',
  table: 'data',
  spreadsheet: 'data',
  'track-view': 'data',
  trace: 'data',
  selection: 'data',
  notebook: 'neutral',
  note: 'neutral',
  page: 'neutral',
  'page-link': 'neutral',
  'scientific-document': 'neutral',
  protocol: 'neutral',
  'protocol-run': 'neutral',
  image: 'neutral',
  pdf: 'neutral',
  archive: 'neutral',
  document: 'neutral',
  strain: 'neutral',
  strains: 'neutral',
  organism: 'neutral',
  record: 'neutral',
  sample: 'neutral',
  'external-ref': 'neutral',
  folder: 'neutral',
  directory: 'neutral',
  workspace: 'neutral',
  chat: 'neutral',
  terminal: 'neutral',
  report: 'neutral',
  config: 'code',
  web: 'code',
  html: 'code',
};

const EXTENSION_FAMILIES: Readonly<Record<string, EntityColorFamily>> = Object.fromEntries(
  (
    [
      [
        'dna',
        [
          'fa',
          'fasta',
          'fas',
          'fna',
          'ffn',
          'dnas',
          'gb',
          'gbk',
          'gbff',
          'genbank',
          'embl',
          'ape',
          'xdna',
          'dna',
          'snapgene',
          'seq',
        ],
      ],
      ['rna', ['frn', 'rna']],
      ['protein', ['faa', 'pdb', 'cif', 'mmcif', 'mcif', 'bcif', 'mol', 'mol2', 'sdf']],
      [
        'data',
        [
          'csv',
          'tsv',
          'xlsx',
          'xls',
          'ods',
          'numbers',
          'parquet',
          'h5',
          'hdf5',
          'feather',
          'sqlite',
          'db',
          'gff',
          'gff3',
          'gtf',
          'bed',
          'bedgraph',
          'bw',
          'bigwig',
          'bb',
          'bigbed',
          'sam',
          'bam',
          'cram',
          'vcf',
          'bcf',
          'fq',
          'fastq',
          'ab1',
          'abi',
          'aln',
          'clustal',
          'sto',
          'phy',
          'nex',
          'nexus',
          'nwk',
          'newick',
        ],
      ],
      [
        'code',
        [
          'py',
          'pyi',
          'ipynb',
          'js',
          'jsx',
          'mjs',
          'cjs',
          'ts',
          'tsx',
          'rs',
          'go',
          'r',
          'c',
          'cc',
          'cpp',
          'h',
          'hpp',
          'java',
          'swift',
          'rb',
          'php',
          'kt',
          'scala',
          'sh',
          'bash',
          'zsh',
          'fish',
          'ps1',
          'json',
          'yaml',
          'yml',
          'toml',
          'xml',
          'ini',
          'cfg',
          'conf',
          'config',
          'env',
          'html',
          'htm',
          'css',
          'scss',
          'sass',
          'less',
        ],
      ],
    ] as const
  ).flatMap(([family, extensions]) => extensions.map((extension) => [extension, family]))
);

const NATIVE_SUFFIX_FAMILIES: ReadonlyArray<readonly [string, EntityColorFamily]> = [
  ['.primer.json', 'dna'],
  ['.wpdesign.json', 'dna'],
  ['.dnaforge-track-view.json', 'data'],
  ['.dnaforge-molecular.json', 'protein'],
  ['.wpnote.json', 'neutral'],
  ['.wpselection.json', 'data'],
  ['.entity.json', 'neutral'],
  ['.dnaforge-protocol.json', 'neutral'],
  ['.dnaforge-protocol-run.json', 'neutral'],
  ['/.forge/plasmid.json', 'dna'],
  ['/.forge/sequence.json', 'dna'],
  ['/.forge/notebook.json', 'neutral'],
  ['/.forge/table.json', 'data'],
  ['/.forge/protocol.json', 'neutral'],
  ['/.forge/protocol-run.json', 'neutral'],
];

function pathColorFamily(path: string | undefined): EntityColorFamily | undefined {
  if (!path) return undefined;
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const native = NATIVE_SUFFIX_FAMILIES.find(([suffix]) => normalized.endsWith(suffix));
  if (native) return native[1];
  const filename = normalized.split('/').pop() ?? '';
  const extension = filename.split('.').pop() ?? '';
  if (['gz', 'bgz', 'bgzf'].includes(extension)) {
    const contentExtension =
      filename
        .slice(0, -(extension.length + 1))
        .split('.')
        .pop() ?? '';
    const contentFamily = Object.hasOwn(EXTENSION_FAMILIES, contentExtension)
      ? EXTENSION_FAMILIES[contentExtension]
      : undefined;
    return contentFamily && contentFamily !== 'code' ? contentFamily : 'neutral';
  }
  if (filename === 'dockerfile' || filename === 'makefile') return 'code';
  if (filename === '.gitignore' || filename === '.dockerignore') return 'code';
  return Object.hasOwn(EXTENSION_FAMILIES, extension) ? EXTENSION_FAMILIES[extension] : undefined;
}

function moleculeColorFamily(molecule: string | undefined): EntityColorFamily | undefined {
  if (!molecule) return undefined;
  if (/rna$/i.test(molecule)) return 'rna';
  if (/dna$/i.test(molecule)) return 'dna';
  if (/^(protein|amino[-_ ]?acid)$/i.test(molecule)) return 'protein';
  return undefined;
}

export function entityColorFamily(context: EntityColorContext): EntityColorFamily {
  if (context.isDirectory) return 'neutral';
  const kind = (context.kind ?? context.packageKind ?? '').toLowerCase().replace(/_/g, '-');
  const molecule = moleculeColorFamily(context.molecule);
  if (
    molecule &&
    [
      'sequence',
      'biology',
      'primer',
      'primers',
      'oligo',
      'dna-oligos',
      'rna-oligos',
      'dna-sequence',
      'rna-sequence',
      'dna-sequences',
      'rna-sequences',
      '',
    ].includes(kind)
  )
    return molecule;
  const typed = Object.hasOwn(KIND_FAMILIES, kind) ? KIND_FAMILIES[kind] : undefined;
  if (typed) return typed;
  const pathFamily = pathColorFamily(context.path);
  if (pathFamily) return pathFamily;
  if (['sequence', 'biology', 'primer', 'primers', 'oligo'].includes(kind)) return 'dna';
  if (kind === 'code' || kind === 'source') return 'code';
  if (context.packageKind && kind !== context.packageKind) {
    return entityColorFamily({ kind: context.packageKind, molecule: context.molecule });
  }
  return molecule ?? 'neutral';
}

export function entityIconClassName(context: EntityColorContext, className = ''): string {
  if (/(?:^|\s)entity-icon-color-(?:dna|rna|protein|data|code|neutral)(?:\s|$)/.test(className))
    return className;
  return `${className} entity-icon-color entity-icon-color-${entityColorFamily(context)}`.trim();
}
