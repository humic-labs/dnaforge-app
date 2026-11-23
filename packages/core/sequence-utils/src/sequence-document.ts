import type { AnnotatedSequence, Annotation } from './types';
import {
  detectFormat,
  parseSequenceFileSingle,
  parseGenBankRecords,
  parseSnapGene,
} from './parsers';
import type { ParsedSequence, SequenceFormat } from './parsers';
import { serializeGenBank } from './writers';

export type SequenceDocumentMetadataKey = 'sequenceDocument';

export interface SequenceDocumentSource {
  path?: string;
  filename?: string;
  contentHash?: string;
  binary: boolean;
}

export interface SequenceDocumentCapabilities {
  editable: boolean;
  canSaveInPlace: boolean;
  canExportGenBank: boolean;
  preservesSourceFormat: boolean;
  saveInPlaceDisabledReason?: string;
}

export interface SequenceDocumentMetadata {
  format: SequenceFormat;
  source: SequenceDocumentSource;
  capabilities: SequenceDocumentCapabilities;
}

export interface SequenceDocument {
  sequence: AnnotatedSequence;
  format: SequenceFormat;
  source: SequenceDocumentSource;
  capabilities: SequenceDocumentCapabilities;
}

export type SequenceDocumentContent = string | ArrayBuffer | Uint8Array;

export interface DecodeSequenceDocumentOptions {
  format?: SequenceFormat;
  filename?: string;
  path?: string;
  contentHash?: string;
}

const METADATA_KEY: SequenceDocumentMetadataKey = 'sequenceDocument';

const FORMAT_CAPABILITIES: Record<SequenceFormat, SequenceDocumentCapabilities> = {
  genbank: {
    editable: true,
    canSaveInPlace: true,
    canExportGenBank: true,
    preservesSourceFormat: true,
  },
  fasta: {
    editable: true,
    canSaveInPlace: false,
    canExportGenBank: true,
    preservesSourceFormat: false,
    saveInPlaceDisabledReason:
      'FASTA cannot preserve DNAForge annotations or topology when overwritten in place.',
  },
  snapgene: {
    editable: true,
    canSaveInPlace: false,
    canExportGenBank: true,
    preservesSourceFormat: false,
    saveInPlaceDisabledReason:
      'SnapGene .dna files are decoded for viewing/editing, but DNAForge does not write SnapGene binaries yet.',
  },
  seq: {
    editable: true,
    canSaveInPlace: false,
    canExportGenBank: true,
    preservesSourceFormat: false,
    saveInPlaceDisabledReason:
      'SEQ files are sequence-only imports; overwriting them would discard annotations and topology.',
  },
  fastq: {
    editable: false,
    canSaveInPlace: false,
    canExportGenBank: true,
    preservesSourceFormat: false,
    saveInPlaceDisabledReason:
      'FASTQ files carry quality scores that DNAForge does not round-trip through sequence editing.',
  },
  ab1: {
    editable: false,
    canSaveInPlace: false,
    canExportGenBank: true,
    preservesSourceFormat: false,
    saveInPlaceDisabledReason:
      'AB1 trace files are read-only source evidence; DNAForge does not write AB1 traces.',
  },
};

export function decodeSequenceDocument(
  content: SequenceDocumentContent,
  options: DecodeSequenceDocumentOptions = {}
): SequenceDocument {
  const binary = isBinaryContent(content);
  const detectionContent = binary ? binaryForDetection(content) : content;
  const filename = options.filename ?? basename(options.path);
  const format = options.format ?? detectFormat(detectionContent, filename);
  const source: SequenceDocumentSource = {
    path: options.path,
    filename,
    contentHash: options.contentHash,
    binary,
  };

  const parsed = decodeAnnotatedSequence(content, format, filename);
  const capabilities = getSequenceFormatCapabilities(format);
  const sequence = attachSequenceDocumentMetadata(
    {
      ...parsed,
      id: source.path ?? parsed.id,
    },
    {
      format,
      source,
      capabilities,
    }
  );

  return {
    sequence,
    format,
    source,
    capabilities,
  };
}

export function getSequenceFormatCapabilities(
  format: SequenceFormat
): SequenceDocumentCapabilities {
  return { ...FORMAT_CAPABILITIES[format] };
}

export function sequenceFormatFromFilename(filename?: string): SequenceFormat | undefined {
  if (!filename) return undefined;
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ab1':
    case 'abi':
      return 'ab1';
    case 'fastq':
    case 'fq':
      return 'fastq';
    case 'seq':
      return 'seq';
    case 'fasta':
    case 'fa':
    case 'fna':
    case 'faa':
      return 'fasta';
    case 'gb':
    case 'gbk':
    case 'gbff':
    case 'genbank':
      return 'genbank';
    case 'dna':
      return 'snapgene';
    default:
      return undefined;
  }
}

export function getSequenceDocumentMetadata(
  sequence: AnnotatedSequence
): SequenceDocumentMetadata | null {
  const value = sequence.metadata?.[METADATA_KEY];
  if (!isRecord(value)) return null;
  if (typeof value.format !== 'string') return null;
  if (!isRecord(value.source)) return null;
  if (!isRecord(value.capabilities)) return null;
  return value as unknown as SequenceDocumentMetadata;
}

export function attachSequenceDocumentMetadata(
  sequence: AnnotatedSequence,
  metadata: SequenceDocumentMetadata
): AnnotatedSequence {
  return {
    ...sequence,
    metadata: {
      ...sequence.metadata,
      [METADATA_KEY]: metadata,
    },
  };
}

export function getSequenceSavePolicy(
  sequence: AnnotatedSequence,
  fallbackFilename?: string
): {
  format: SequenceFormat | 'unknown';
  capabilities: SequenceDocumentCapabilities;
} {
  const metadata = getSequenceDocumentMetadata(sequence);
  if (metadata) {
    return {
      format: metadata.format,
      capabilities: metadata.capabilities,
    };
  }

  const format = sequenceFormatFromFilename(fallbackFilename);
  if (format) {
    return {
      format,
      capabilities: getSequenceFormatCapabilities(format),
    };
  }

  return {
    format: 'unknown',
    capabilities: {
      editable: true,
      canSaveInPlace: false,
      canExportGenBank: true,
      preservesSourceFormat: false,
      saveInPlaceDisabledReason:
        'The source file format is unknown, so DNAForge will not overwrite it in place.',
    },
  };
}

export function serializeSequenceForInPlaceSave(
  sequence: AnnotatedSequence,
  fallbackFilename?: string
): string {
  const policy = getSequenceSavePolicy(sequence, fallbackFilename);
  if (!policy.capabilities.canSaveInPlace) {
    const reason =
      policy.capabilities.saveInPlaceDisabledReason ??
      `DNAForge cannot save ${policy.format} files in place.`;
    throw new Error(reason);
  }
  if (policy.format !== 'genbank') {
    throw new Error(`No in-place writer is registered for ${policy.format} files.`);
  }
  return serializeGenBank(sequence);
}

function decodeAnnotatedSequence(
  content: SequenceDocumentContent,
  format: SequenceFormat,
  filename?: string
): AnnotatedSequence {
  switch (format) {
    case 'genbank': {
      if (typeof content !== 'string') {
        throw new Error('GenBank files must be provided as text.');
      }
      return parseGenBankRecords(content)[0];
    }
    case 'snapgene': {
      if (typeof content === 'string') {
        throw new Error('SnapGene .dna files must be provided as binary data.');
      }
      return parseSnapGene(content, filename);
    }
    case 'fasta':
    case 'fastq':
    case 'seq':
    case 'ab1': {
      const parsedContent = typeof content === 'string' ? content : toArrayBuffer(content);
      const parsed = parseSequenceFileSingle(parsedContent, { filename, format });
      return parsedSequenceToAnnotatedSequence(parsed);
    }
  }
}

function parsedSequenceToAnnotatedSequence(parsed: ParsedSequence): AnnotatedSequence {
  const metadata = parsed.metadata as
    | {
        annotations?: Annotation[];
        circular?: boolean;
        description?: string;
      }
    | undefined;

  return {
    id: parsed.id,
    name: parsed.name,
    sequence: parsed.sequence,
    length: parsed.length,
    annotations: metadata?.annotations ?? [],
    circular: metadata?.circular ?? false,
    description:
      metadata?.description ?? (parsed.format === 'ab1' ? 'Sanger sequencing read' : undefined),
    quality: parsed.quality,
    metadata: parsed.metadata,
  };
}

function isBinaryContent(content: SequenceDocumentContent): content is ArrayBuffer | Uint8Array {
  return typeof content !== 'string';
}

function toArrayBuffer(content: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (content instanceof ArrayBuffer) return content;
  return (content.buffer as ArrayBuffer).slice(
    content.byteOffset,
    content.byteOffset + content.byteLength
  );
}

function binaryForDetection(content: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (content instanceof ArrayBuffer) return content;
  return toArrayBuffer(content);
}

function basename(path?: string): string | undefined {
  if (!path) return undefined;
  return path.split(/[\\/]/).pop() || path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
