export const SOFT_WARN_BYTES = 100 * 1024 * 1024;
export const HARD_CAP_BYTES = 256 * 1024 * 1024;

export class OversizedFileError extends Error {
  readonly sizeBytes: number;
  readonly path: string;
  readonly hardCap: boolean;

  constructor(sizeBytes: number, path: string, hardCap: boolean) {
    const cap = hardCap ? 'hard cap' : 'soft warn';
    super(`File too large (${sizeBytes} bytes, above ${cap}): ${path}`);
    this.name = 'OversizedFileError';
    this.sizeBytes = sizeBytes;
    this.path = path;
    this.hardCap = hardCap;
  }
}

export function isOversizedFileError(err: unknown): err is OversizedFileError {
  if (err instanceof OversizedFileError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Partial<OversizedFileError> & { message?: string };
  if (e.name === 'OversizedFileError') return true;
  if (typeof e.message === 'string' && e.message.startsWith('File too large')) return true;
  return false;
}

export type ExtBucket = 'gb' | 'gbk' | 'fasta' | 'fa' | 'fastq' | 'ab1' | 'other';

const EXT_WHITELIST: readonly ExtBucket[] = ['gb', 'gbk', 'fasta', 'fa', 'fastq', 'ab1'];

export function extBucket(path: string): ExtBucket {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return 'other';
  const ext = path.slice(dot + 1).toLowerCase();
  return (EXT_WHITELIST as readonly string[]).includes(ext) ? (ext as ExtBucket) : 'other';
}

export type SizeBucket = '<100MB' | '100-256MB' | '>256MB';

export function sizeBucket(bytes: number): SizeBucket {
  if (bytes < SOFT_WARN_BYTES) return '<100MB';
  if (bytes <= HARD_CAP_BYTES) return '100-256MB';
  return '>256MB';
}

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(2)} GB`;
}
