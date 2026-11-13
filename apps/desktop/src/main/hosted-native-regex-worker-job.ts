const MAX_SEARCH_FILES = 2_000;
const MAX_SEARCH_BYTES = 8 * 1024 * 1024;
const MAX_PATTERN_LENGTH = 256;
const MAX_LINE_LENGTH = 16 * 1024;
const MAX_MATCHES = 2_000;

export interface HostedNativeRegexWorkerJob {
  readonly source: string;
  readonly caseSensitive: boolean;
  readonly limit: number;
  readonly files: readonly Readonly<{ path: string; content: string }>[];
}

export interface HostedNativeRegexWorkerResult {
  readonly matches: readonly Readonly<{ path: string; line: number; text: string }>[];
  readonly truncated: boolean;
}

function validateJob(job: HostedNativeRegexWorkerJob): void {
  if (
    !job ||
    typeof job.source !== 'string' ||
    job.source.length === 0 ||
    job.source.length > MAX_PATTERN_LENGTH ||
    typeof job.caseSensitive !== 'boolean' ||
    !Number.isSafeInteger(job.limit) ||
    job.limit < 1 ||
    job.limit > MAX_MATCHES ||
    !Array.isArray(job.files) ||
    job.files.length > MAX_SEARCH_FILES
  ) {
    throw new Error('Hosted native regex worker received an invalid job.');
  }
  let bytes = 0;
  for (const file of job.files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      file.path.length === 0 ||
      file.path.length > 4096 ||
      typeof file.content !== 'string'
    ) {
      throw new Error('Hosted native regex worker received an invalid file.');
    }
    bytes += Buffer.byteLength(file.content);
    if (bytes > MAX_SEARCH_BYTES) {
      throw new Error('Hosted native regex worker input is too large.');
    }
  }
}

export function runHostedNativeRegexWorkerJob(
  job: HostedNativeRegexWorkerJob
): HostedNativeRegexWorkerResult {
  validateJob(job);
  const expression = new RegExp(job.source, job.caseSensitive ? '' : 'i');
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const file of job.files) {
    for (const [index, rawLine] of file.content.split('\n').entries()) {
      const text = rawLine.slice(0, MAX_LINE_LENGTH);
      if (expression.test(text)) {
        matches.push({ path: file.path, line: index + 1, text });
        if (matches.length >= job.limit) return { matches, truncated: true };
      }
    }
  }
  return { matches, truncated: false };
}
