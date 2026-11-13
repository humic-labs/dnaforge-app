import type { ParsedSequence, FastqMetadata } from './types';
import { SequenceParseError } from './types';

type QualityEncoding = 'sanger' | 'illumina-1.3' | 'illumina-1.5' | 'illumina-1.8';

export function parseFastq(
  content: string,
  options?: { qualityEncoding?: QualityEncoding; limit?: number }
): ParsedSequence[] {
  const lines = content.split(/\r?\n/);
  const sequences: ParsedSequence[] = [];
  const limit = options?.limit;

  let encoding = options?.qualityEncoding;
  if (!encoding) {
    encoding = detectQualityEncoding(content);
  }

  let i = 0;
  let recordNum = 0;

  while (i < lines.length) {
    while (i < lines.length && !lines[i].trim()) {
      i++;
    }

    if (i >= lines.length) break;

    if (limit !== undefined && sequences.length >= limit) break;

    recordNum++;
    const startLine = i + 1;

    const headerLine = lines[i];
    if (!headerLine.startsWith('@')) {
      throw new SequenceParseError(
        `Expected header line starting with '@', got: "${headerLine.substring(0, 30)}..."`,
        'fastq',
        startLine
      );
    }
    const header = headerLine.substring(1).trim();
    i++;

    if (i >= lines.length) {
      throw new SequenceParseError(
        `Unexpected end of file: missing sequence line for record ${recordNum}`,
        'fastq',
        startLine
      );
    }
    const sequenceLine = lines[i].trim();
    if (!sequenceLine) {
      throw new SequenceParseError(`Empty sequence line for record ${recordNum}`, 'fastq', i + 1);
    }
    if (!/^[ACGTUNRYSWKMBDHVacgtunryswkmbdhv.]+$/.test(sequenceLine)) {
      throw new SequenceParseError(
        `Invalid sequence characters in record ${recordNum}`,
        'fastq',
        i + 1
      );
    }
    i++;

    if (i >= lines.length) {
      throw new SequenceParseError(
        `Unexpected end of file: missing plus line for record ${recordNum}`,
        'fastq',
        startLine
      );
    }
    const plusLine = lines[i];
    if (!plusLine.startsWith('+')) {
      throw new SequenceParseError(
        `Expected plus line starting with '+', got: "${plusLine.substring(0, 30)}..."`,
        'fastq',
        i + 1
      );
    }
    i++;

    if (i >= lines.length) {
      throw new SequenceParseError(
        `Unexpected end of file: missing quality line for record ${recordNum}`,
        'fastq',
        startLine
      );
    }
    const qualityLine = lines[i];
    if (qualityLine.length !== sequenceLine.length) {
      throw new SequenceParseError(
        `Quality line length (${qualityLine.length}) does not match sequence length (${sequenceLine.length}) for record ${recordNum}`,
        'fastq',
        i + 1
      );
    }
    i++;

    const quality = decodeQualityScores(qualityLine, encoding);

    const { name, id } = parseHeader(header, recordNum);

    const metadata: FastqMetadata = {
      qualityEncoding: encoding,
      header,
    };

    sequences.push({
      id,
      name,
      sequence: sequenceLine,
      length: sequenceLine.length,
      format: 'fastq',
      quality,
      metadata: metadata as Record<string, unknown>,
    });
  }

  if (sequences.length === 0) {
    throw new SequenceParseError('No valid FASTQ records found in file', 'fastq');
  }

  return sequences;
}

export function parseFastqSingle(
  content: string,
  options?: { qualityEncoding?: QualityEncoding }
): ParsedSequence {
  const sequences = parseFastq(content, { ...options, limit: 1 });
  return sequences[0];
}

export function isFastqFormat(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith('@')) return false;

  const lines = trimmed.split(/\r?\n/);
  if (lines.length < 4) return false;

  const seqLine = lines[1].trim();
  if (!/^[ACGTUNRYSWKMBDHVacgtunryswkmbdhv.]+$/i.test(seqLine)) return false;

  if (!lines[2].trim().startsWith('+')) return false;

  const qualLine = lines[3];
  if (qualLine.length !== seqLine.length) return false;

  return true;
}

function detectQualityEncoding(content: string): QualityEncoding {
  const lines = content.split(/\r?\n/);
  let lineNum = 0;

  for (const line of lines) {
    lineNum++;
    if (lineNum % 4 === 0 && line.trim()) {
      for (const char of line) {
        const code = char.charCodeAt(0);
        if (code < 64 && code >= 33) {
          return 'sanger';
        }
      }
    }
  }

  return 'illumina-1.8';
}

function decodeQualityScores(qualityLine: string, encoding: QualityEncoding): number[] {
  const offset = encoding === 'illumina-1.3' || encoding === 'illumina-1.5' ? 64 : 33;

  return Array.from(qualityLine).map((char) => {
    const score = char.charCodeAt(0) - offset;
    return Math.max(0, Math.min(93, score));
  });
}

function parseHeader(header: string, recordNum: number): { name: string; id: string } {
  if (!header) {
    return {
      name: `Read_${recordNum}`,
      id: `read-${recordNum}`,
    };
  }

  const spaceIdx = header.indexOf(' ');
  const rawId = spaceIdx === -1 ? header : header.substring(0, spaceIdx);

  const name = rawId || `Read_${recordNum}`;
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return { name, id: id || `read-${recordNum}` };
}

export function averageQuality(quality: number[]): number {
  if (quality.length === 0) return 0;
  const sum = quality.reduce((a, b) => a + b, 0);
  return sum / quality.length;
}

export function phredToErrorProb(phred: number): number {
  return Math.pow(10, -phred / 10);
}

export function errorProbToPhred(prob: number): number {
  if (prob <= 0) return 93;
  if (prob >= 1) return 0;
  return Math.round(-10 * Math.log10(prob));
}
