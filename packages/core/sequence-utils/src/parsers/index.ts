import type { ParsedSequence, SequenceFormat, ParseOptions } from './types';
import { SequenceParseError } from './types';
import { parseAb1, isAb1Format } from './ab1';
import { parseSeq, isSeqFormat } from './seq';
import { parseFastq, isFastqFormat } from './fastq';
import { parseGenBankRecords } from './genbank';
import { parseSnapGeneSequence, isSnapGeneFormat } from './snapgene';
import { sequenceFileTypeForPath } from '../sequence-file-types';

export type { ParsedSequence, SequenceFormat, ParseOptions } from './types';
export type { Ab1Metadata, FastqMetadata, SeqMetadata, TraceData } from './types';
export { SequenceParseError } from './types';

export { parseAb1, isAb1Format } from './ab1';
export { parseSeq, isSeqFormat } from './seq';
export { parseFastq, parseFastqSingle, isFastqFormat, averageQuality } from './fastq';
export { parseSnapGene, parseSnapGeneSequence, isSnapGeneFormat } from './snapgene';

export {
  parseGenBankFull,
  parseGenBankRecords,
  indexGenBankRecords,
  isDeclaredEmptyGenBankRecord,
  parseFeatureLocation,
  applyComplementOriginWrap,
  extractRawSequence,
  isGenBankFormat,
  GenBankParseError,
} from './genbank';
export type { FeatureLocation, IndexedGenBankRecord } from './genbank';
export { dispatchRouteFor, PARSER_DISPATCH_LIMITS } from './parser-dispatch';
export type { ParserDispatchStat, ParserRoute } from './parser-dispatch';
export { planSplitCDSMerges } from './split-cds-merge';
export type { MergeCandidate } from './split-cds-merge';

export function parseSequenceFile(
  content: string | ArrayBuffer | Buffer,
  options?: ParseOptions & { filename?: string }
): ParsedSequence[] {
  const format = options?.format || detectFormat(content, options?.filename);

  switch (format) {
    case 'ab1': {
      if (typeof content === 'string') {
        throw new SequenceParseError('AB1 files must be provided as ArrayBuffer or Buffer', 'ab1');
      }
      return [parseAb1(content, options?.filename)];
    }

    case 'fastq': {
      if (typeof content !== 'string') {
        throw new SequenceParseError('FASTQ files must be provided as string', 'fastq');
      }
      return parseFastq(content, {
        qualityEncoding: options?.qualityEncoding,
        limit: options?.limit,
      });
    }

    case 'seq': {
      if (typeof content !== 'string') {
        throw new SequenceParseError('SEQ files must be provided as string', 'seq');
      }
      return [parseSeq(content, options?.filename)];
    }

    case 'fasta': {
      if (typeof content !== 'string') {
        throw new SequenceParseError('FASTA files must be provided as string', 'fasta');
      }
      return parseFasta(content, options?.filename);
    }

    case 'genbank': {
      if (typeof content !== 'string') {
        throw new SequenceParseError('GenBank files must be provided as string', 'genbank');
      }
      return parseGenBank(content, options?.filename);
    }

    case 'snapgene': {
      if (typeof content === 'string') {
        throw new SequenceParseError(
          'SnapGene .dna files must be provided as ArrayBuffer or Buffer',
          'snapgene'
        );
      }
      return [parseSnapGeneSequence(content, options?.filename)];
    }

    default:
      throw new SequenceParseError(
        `Unknown or unsupported format: ${format}. Supported: ab1, seq, fasta, fastq, genbank, snapgene`,
        'unknown'
      );
  }
}

export function detectFormat(
  content: string | ArrayBuffer | Buffer,
  filename?: string
): SequenceFormat {
  if (filename) {
    const fileType = sequenceFileTypeForPath(filename);
    if (fileType) return fileType.format;
  }

  if (isBinaryPayload(content)) {
    if (isSnapGeneFormat(content)) {
      return 'snapgene';
    }
    if (isAb1Format(content)) {
      return 'ab1';
    }
    throw new SequenceParseError(
      'Unknown binary format. Supported binary formats: ab1, snapgene',
      'unknown'
    );
  }

  const text = content as string;
  const trimmed = text.trim();

  if (isFastqFormat(text)) {
    return 'fastq';
  }

  if (trimmed.startsWith('>')) {
    return 'fasta';
  }

  if (trimmed.startsWith('LOCUS')) {
    return 'genbank';
  }

  if (isSeqFormat(text)) {
    return 'seq';
  }

  throw new SequenceParseError(
    'Could not detect file format. Supported formats: ab1, seq, fasta, fastq, genbank, snapgene',
    'unknown'
  );
}

function isBinaryPayload(content: string | ArrayBuffer | Buffer): content is ArrayBuffer | Buffer {
  return content instanceof ArrayBuffer || isNodeBuffer(content);
}

function isNodeBuffer(content: unknown): content is Buffer {
  return typeof Buffer !== 'undefined' && Buffer.isBuffer(content);
}

export function parseSequenceFileSingle(
  content: string | ArrayBuffer | Buffer,
  options?: ParseOptions & { filename?: string }
): ParsedSequence {
  const sequences = parseSequenceFile(content, options);
  if (sequences.length === 0) {
    throw new SequenceParseError('No sequences found in file', 'unknown');
  }
  return sequences[0];
}

export function formatToExtension(format: SequenceFormat): string {
  switch (format) {
    case 'ab1':
      return '.ab1';
    case 'fastq':
      return '.fastq';
    case 'seq':
      return '.seq';
    case 'fasta':
      return '.fasta';
    case 'genbank':
      return '.gb';
    case 'snapgene':
      return '.dna';
  }
}

export function formatToMimeType(format: SequenceFormat): string {
  switch (format) {
    case 'ab1':
      return 'application/octet-stream';
    case 'fastq':
      return 'text/plain';
    case 'seq':
      return 'text/plain';
    case 'fasta':
      return 'text/plain';
    case 'genbank':
      return 'text/plain';
    case 'snapgene':
      return 'application/octet-stream';
  }
}

function parseFasta(content: string, filename?: string): ParsedSequence[] {
  const lines = content.split(/\r?\n/);
  const sequences: ParsedSequence[] = [];

  let currentName = '';
  let currentSequence = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) continue;

    if (trimmed.startsWith('>')) {
      if (currentName && currentSequence) {
        sequences.push(createParsedSequence(currentName, currentSequence, 'fasta'));
      }

      const header = trimmed.substring(1).trim();
      const spaceIdx = header.indexOf(' ');
      currentName = spaceIdx === -1 ? header : header.substring(0, spaceIdx);
      currentSequence = '';
      continue;
    }

    if (trimmed.startsWith(';')) continue;

    const cleaned = trimmed.replace(/\s/g, '');
    if (!/^[ACGTUNRYSWKMBDHVacgtunryswkmbdhv\-.*]+$/i.test(cleaned)) {
      if (!/^[ACDEFGHIKLMNPQRSTVWY*\-XBZJ]+$/i.test(cleaned)) {
        const column = line.search(/[^\sACDEFGHIKLMNPQRSTUVWYXBZJ*\-.]/i) + 1;
        throw new SequenceParseError(
          column > 0
            ? `Invalid sequence character ${JSON.stringify(line.charAt(column - 1))} at column ${column}`
            : 'Invalid mix of nucleotide gap and protein characters',
          'fasta',
          i + 1
        );
      }
    }
    currentSequence += cleaned;
  }

  if (currentName && currentSequence) {
    sequences.push(createParsedSequence(currentName, currentSequence, 'fasta'));
  }

  if (sequences.length === 0 && currentSequence) {
    const name = deriveNameFromFilename(filename) || 'Sequence';
    sequences.push(createParsedSequence(name, currentSequence, 'fasta'));
  }

  if (sequences.length === 0) {
    throw new SequenceParseError('No valid FASTA sequences found', 'fasta');
  }

  return sequences;
}

function parseGenBank(content: string, filename?: string): ParsedSequence[] {
  return parseGenBankRecords(content).map((result) => {
    const finalName = result.name || deriveNameFromFilename(filename) || 'GenBank_Sequence';

    return {
      ...createParsedSequence(finalName, result.sequence, 'genbank'),
      id: result.id,
      length: result.length,
      metadata: {
        annotations: result.annotations,
        circular: result.circular ?? false,
        description: result.description,
      },
    };
  });
}

function createParsedSequence(
  name: string,
  sequence: string,
  format: SequenceFormat
): ParsedSequence {
  return {
    id: generateId(name),
    name,
    sequence,
    length: sequence.length,
    format,
  };
}

function generateId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function deriveNameFromFilename(filename?: string): string | undefined {
  if (!filename) return undefined;
  const base = filename.split('/').pop() || filename;
  return (
    base.replace(/\.(fasta|fa|fna|faa|gb|gbk|genbank|seq|fastq|fq|ab1|abi|dna)$/i, '') || undefined
  );
}
