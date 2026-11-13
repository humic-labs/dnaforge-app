export const FILE_TYPE_COLORS = [
  {
    family: 'sequence',
    ansi: '32',
    extensions: [
      'fa',
      'fasta',
      'fna',
      'ffn',
      'faa',
      'frn',
      'fq',
      'fastq',
      'gb',
      'gbk',
      'genbank',
      'gff',
      'gff3',
      'gtf',
      'bed',
      'sam',
      'bam',
      'cram',
      'vcf',
    ],
  },
  { family: 'structure', ansi: '35', extensions: ['pdb', 'cif', 'mmcif', 'mol', 'sdf', 'mol2'] },
  {
    family: 'data',
    ansi: '36',
    extensions: ['csv', 'tsv', 'xlsx', 'xls', 'parquet', 'h5', 'hdf5', 'feather', 'sqlite', 'db'],
  },
  { family: 'python', ansi: '33', extensions: ['py', 'pyi', 'ipynb'] },
  { family: 'javascript', ansi: '33', extensions: ['js', 'jsx', 'mjs', 'cjs'] },
  {
    family: 'source',
    ansi: '34',
    extensions: ['ts', 'tsx', 'rs', 'go', 'r', 'c', 'cpp', 'h', 'hpp', 'java', 'swift', 'rb'],
  },
  {
    family: 'config',
    ansi: '35',
    extensions: ['json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'conf', 'env'],
  },
  { family: 'shell', ansi: '32', extensions: ['sh', 'bash', 'zsh', 'fish', 'ps1'] },
  {
    family: 'image',
    ansi: '35',
    extensions: ['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp', 'tif', 'tiff'],
  },
  {
    family: 'archive',
    ansi: '31',
    extensions: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar'],
  },
  { family: 'document', ansi: '36', extensions: ['md', 'markdown', 'rst', 'pdf', 'docx', 'txt'] },
] as const;

export function fileColorFamily(name: string, category: string): string {
  const extension = name.toLowerCase().split('.').pop();
  return (
    FILE_TYPE_COLORS.find((group) => group.extensions.some((value) => value === extension))
      ?.family ??
    (
      {
        biology: 'sequence',
        genome: 'sequence',
        structure: 'structure',
        spreadsheet: 'data',
        code: 'source',
        text: 'document',
        web: 'source',
      } as Record<string, string>
    )[category] ??
    category
  );
}

export const DEFAULT_TERMINAL_LS_COLORS = [
  'di=1;34',
  'ln=36',
  'ex=1;32',
  'or=1;31',
  'pi=33',
  'so=35',
  ...FILE_TYPE_COLORS.flatMap((group) =>
    group.extensions.map((extension) => `*.${extension}=${group.ansi}`)
  ),
].join(':');
