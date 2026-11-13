import type { TabType } from '../features/canvas/types';
import {
  TRACK_VIEW_FILE_SUFFIX,
  MOLECULAR_DOCUMENT_FILE_SUFFIX,
  TREE_HIDDEN_COMPOUND_SUFFIXES,
} from '../shared/registry-file-types';
import {
  getStructureFileFormat,
  isSupportedSequencePath,
  SUPPORTED_SEQUENCE_EXTENSIONS,
} from '../shared/scientific-file-types';
import { scientificPackageKindForMetaPath } from '../shared/scientific-package';

export { getStructureFileFormat, type StructureFileFormat } from '../shared/scientific-file-types';

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'bmp',
  'ico',
  'tiff',
  'tif',
]);

const HTML_EXTENSIONS = new Set(['html', 'htm']);

const TABULAR_DATA_EXTENSIONS = new Set(['csv', 'tsv', 'xlsx', 'xls']);

const TEXT_EXTENSIONS = new Set([
  'txt',
  'text',
  'log',
  'md',
  'markdown',
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'py',
  'js',
  'ts',
  'tsx',
  'jsx',
  'rs',
  'go',
  'java',
  'c',
  'cpp',
  'h',
  'hpp',
  'rb',
  'php',
  'swift',
  'kt',
  'scala',
  'r',
  'R',
  'sh',
  'bash',
  'zsh',
  'fish',
  'css',
  'scss',
  'sass',
  'less',
  'ini',
  'cfg',
  'conf',
  'config',
  'env',
  'gitignore',
  'dockerignore',
]);

const PDF_EXTENSIONS = new Set(['pdf']);

const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar']);

const SPREADSHEET_EXTENSIONS = new Set(['csv', 'tsv', 'xls', 'xlsx', 'ods', 'numbers']);

const CODE_EXTENSIONS = new Set([
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'py',
  'rs',
  'go',
  'java',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
  'rb',
  'php',
  'swift',
  'kt',
  'scala',
  'r',
  'sh',
  'bash',
  'zsh',
  'fish',
  'css',
  'scss',
  'sass',
  'less',
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'sql',
]);

const DOC_TEXT_EXTENSIONS = new Set(['txt', 'text', 'log', 'md', 'markdown', 'rst', 'rtf']);

const TEXT_FILENAMES = new Set([
  'Makefile',
  'Dockerfile',
  'README',
  'LICENSE',
  'CHANGELOG',
  'Gemfile',
  'Rakefile',
  'Procfile',
  '.gitignore',
  '.dockerignore',
  '.env',
]);

export function getExtension(path: string): string | null {
  const filename = path.split('/').pop() ?? '';
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1 || lastDot === 0 || lastDot === filename.length - 1) {
    return null;
  }
  return filename.slice(lastDot + 1).toLowerCase();
}

export function getFilename(path: string): string {
  return path.split('/').pop() ?? path;
}

export function getTabTypeForFile(path: string): TabType {
  const ext = getExtension(path);
  const filename = getFilename(path);
  const lowerFilename = filename.toLowerCase();

  if (lowerFilename.endsWith(MOLECULAR_DOCUMENT_FILE_SUFFIX)) return 'structure';

  if (lowerFilename.endsWith('.wpnote.json')) {
    return 'page';
  }

  if (lowerFilename.endsWith('.wpdesign.json')) {
    return 'design';
  }

  if (lowerFilename.endsWith('.primer.json')) {
    return 'primer';
  }

  if (
    lowerFilename.endsWith('.dnaforge-protocol.json') ||
    lowerFilename.endsWith('.dnaforge-protocol-run.json')
  ) {
    return 'scientific-document';
  }

  if (scientificPackageKindForMetaPath(path)) return 'scientific-document';

  if (lowerFilename.endsWith('.faa')) return 'protein';

  if (lowerFilename === 'notebook.json' && path.replace(/\\/g, '/').includes('/.forge/')) {
    return 'page';
  }

  if (isStructureFile(path)) {
    return 'structure';
  }

  if (isSequenceFile(path)) {
    return 'sequence';
  }

  if (ext && IMAGE_EXTENSIONS.has(ext)) {
    return 'image';
  }

  if (ext && PDF_EXTENSIONS.has(ext)) {
    return 'pdf';
  }

  if (ext && HTML_EXTENSIONS.has(ext)) {
    return 'html';
  }

  if (ext && TABULAR_DATA_EXTENSIONS.has(ext)) {
    return 'table';
  }

  if (ext && TEXT_EXTENSIONS.has(ext)) {
    return 'text';
  }

  if (TEXT_FILENAMES.has(filename)) {
    return 'text';
  }

  return 'text';
}

export function isBiologyFile(path: string): boolean {
  return isSequenceFile(path);
}

function isSequenceFile(path: string): boolean {
  return isSupportedSequencePath(path);
}

export function isStructureFile(path: string): boolean {
  return getStructureFileFormat(path) !== null;
}

export function getFileBrowserDisplayName(path: string): string {
  const filename = getFilename(path);
  if (!isStructureFile(filename)) return filename;
  const lastDot = filename.lastIndexOf('.');
  return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}

export function isImageFile(path: string): boolean {
  const ext = getExtension(path);
  return ext !== null && IMAGE_EXTENSIONS.has(ext);
}

export function isTextFile(path: string): boolean {
  const ext = getExtension(path);
  const filename = getFilename(path);
  return (ext !== null && TEXT_EXTENSIONS.has(ext)) || TEXT_FILENAMES.has(filename);
}

export function isHtmlFile(path: string): boolean {
  const ext = getExtension(path);
  return ext !== null && HTML_EXTENSIONS.has(ext);
}

export function isTabularDataFile(path: string): boolean {
  const ext = getExtension(path);
  return ext !== null && TABULAR_DATA_EXTENSIONS.has(ext);
}

export type FileIconCategory =
  | 'design'
  | 'molecular-document'
  | 'structure'
  | 'genome'
  | 'biology'
  | 'web'
  | 'image'
  | 'pdf'
  | 'archive'
  | 'spreadsheet'
  | 'code'
  | 'text'
  | 'generic';

export function getFileIconCategory(path: string): FileIconCategory {
  if (getTabTypeForFile(path) === 'design') return 'design';
  const ext = getExtension(path);
  const filename = getFilename(path);

  const lowerFilename = filename.toLowerCase();
  if (lowerFilename.endsWith(TRACK_VIEW_FILE_SUFFIX)) return 'genome';
  if (lowerFilename.endsWith(MOLECULAR_DOCUMENT_FILE_SUFFIX)) return 'molecular-document';
  if (lowerFilename.endsWith('.wpnote.json')) {
    return 'generic';
  }

  if (isStructureFile(path)) return 'structure';

  if (isSequenceFile(path)) return 'biology';

  if (ext) {
    if (HTML_EXTENSIONS.has(ext)) return 'web';
    if (IMAGE_EXTENSIONS.has(ext)) return 'image';
    if (PDF_EXTENSIONS.has(ext)) return 'pdf';
    if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive';
    if (SPREADSHEET_EXTENSIONS.has(ext)) return 'spreadsheet';
    if (CODE_EXTENSIONS.has(ext)) return 'code';
    if (DOC_TEXT_EXTENSIONS.has(ext)) return 'text';
  }

  if (TEXT_FILENAMES.has(filename)) return 'text';

  return 'generic';
}

const BIOINFORMATICS_DISPLAY_EXTENSIONS = new Set([
  'fastq',
  'fq',
  'sam',
  'bam',
  'cram',
  'vcf',
  'bcf',
  'bed',
  'gff',
  'gff3',
  'gtf',
  'embl',
  'ape',
  'xdna',
  'snapgene',
  'nwk',
  'newick',
  'nex',
  'nexus',
  'phy',
  'aln',
  'clustal',
  'sto',
  'pdb',
  'cif',
  'mmcif',
  'bcif',
  'mol',
  'mol2',
  'sdf',
]);

const RECOGNIZED_DISPLAY_EXTENSIONS: ReadonlySet<string> = new Set<string>([
  ...SUPPORTED_SEQUENCE_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ...HTML_EXTENSIONS,
  ...TABULAR_DATA_EXTENSIONS,
  ...TEXT_EXTENSIONS,
  ...PDF_EXTENSIONS,
  ...ARCHIVE_EXTENSIONS,
  ...SPREADSHEET_EXTENSIONS,
  ...CODE_EXTENSIONS,
  ...DOC_TEXT_EXTENSIONS,
  ...BIOINFORMATICS_DISPLAY_EXTENSIONS,
]);

export function stripDisplayExtension(name: string): string {
  const lower = name.toLowerCase();
  for (const compound of TREE_HIDDEN_COMPOUND_SUFFIXES) {
    if (lower.endsWith(compound) && name.length > compound.length) {
      return name.slice(0, name.length - compound.length);
    }
  }
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return name;
  const ext = name.slice(dot + 1).toLowerCase();
  return RECOGNIZED_DISPLAY_EXTENSIONS.has(ext) ? name.slice(0, dot) : name;
}

export function isBinaryContent(buffer: Uint8Array, sampleSize = 8192): boolean {
  const checkLength = Math.min(buffer.length, sampleSize);
  let nonPrintableCount = 0;

  for (let i = 0; i < checkLength; i++) {
    const byte = buffer[i];

    if (byte === 0) {
      return true;
    }

    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      nonPrintableCount++;
    }
  }

  const nonPrintableRatio = nonPrintableCount / checkLength;
  return nonPrintableRatio > 0.1;
}

export function getLanguageForFile(path: string): string {
  const ext = getExtension(path);
  const filename = getFilename(path);

  const languageMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'jsx',
    ts: 'typescript',
    tsx: 'tsx',

    py: 'python',

    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    xml: 'xml',
    csv: 'csv',

    md: 'markdown',
    markdown: 'markdown',
    html: 'html',
    htm: 'html',

    css: 'css',
    scss: 'scss',
    sass: 'sass',
    less: 'less',

    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'bash',

    rs: 'rust',
    go: 'go',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    rb: 'ruby',
    php: 'php',
    r: 'r',
    R: 'r',

    ini: 'ini',
    cfg: 'ini',
    conf: 'ini',

    pdb: 'plaintext',
  };

  if (ext && languageMap[ext]) {
    return languageMap[ext];
  }

  if (filename === 'Dockerfile') return 'docker';
  if (filename === 'Makefile') return 'makefile';
  if (filename.startsWith('.')) return 'plaintext';

  return 'plaintext';
}
