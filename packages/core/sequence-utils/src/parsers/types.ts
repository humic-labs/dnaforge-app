export type SequenceFormat = 'ab1' | 'seq' | 'fasta' | 'fastq' | 'genbank' | 'snapgene';

export interface ParsedSequence {
  id: string;
  name: string;
  sequence: string;
  length: number;
  format: SequenceFormat;
  quality?: number[];
  metadata?: Record<string, unknown>;
}

export interface TraceData {
  channels: {
    A: number[];
    C: number[];
    G: number[];
    T: number[];
  };
  peakPositions: number[];
  baseOrder: string;
  maxValue: number;
}

export interface Ab1Metadata {
  instrumentModel?: string;
  runName?: string;
  sampleName?: string;
  lane?: number;
  spacing?: number;
  numPoints?: number;
  dyeSet?: string;
  baseCaller?: string;
  trace?: TraceData;
}

export interface FastqMetadata {
  qualityEncoding?: 'sanger' | 'illumina-1.3' | 'illumina-1.5' | 'illumina-1.8';
  header?: string;
  plusLine?: string;
}

export interface SeqMetadata {
  comments?: string[];
  circular?: boolean;
}

export class SequenceParseError extends Error {
  constructor(
    message: string,
    public format: SequenceFormat | 'unknown',
    public line?: number,
    public cause?: Error
  ) {
    super(line !== undefined ? `Line ${line}: ${message}` : message);
    this.name = 'SequenceParseError';
  }
}

export interface ParseOptions {
  format?: SequenceFormat;
  qualityEncoding?: FastqMetadata['qualityEncoding'];
  limit?: number;
}
