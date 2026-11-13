import type { ParsedPlasmid, PlasmidFeature, Primer } from '../types';

export class FastaParseError extends Error {
  constructor(
    message: string,
    public line?: number
  ) {
    super(line ? `Line ${line}: ${message}` : message);
    this.name = 'FastaParseError';
  }
}

export interface ParsedFastaSequence {
  name: string;
  description?: string;
  sequence: string;
  length: number;
}

export function parseFasta(content: string): ParsedFastaSequence[] {
  const lines = content.split(/\r?\n/);
  const sequences: ParsedFastaSequence[] = [];

  let currentName = '';
  let currentDescription = '';
  let currentSequence = '';
  let lineNumber = 0;

  for (const line of lines) {
    lineNumber++;
    const trimmed = line.trim();

    if (!trimmed) continue;

    if (trimmed.startsWith('>')) {
      if (currentName && currentSequence) {
        sequences.push({
          name: currentName,
          description: currentDescription || undefined,
          sequence: currentSequence,
          length: currentSequence.length,
        });
      }

      const headerContent = trimmed.substring(1).trim();
      const spaceIndex = headerContent.indexOf(' ');

      if (spaceIndex === -1) {
        currentName = headerContent || `Sequence_${sequences.length + 1}`;
        currentDescription = '';
      } else {
        currentName = headerContent.substring(0, spaceIndex);
        currentDescription = headerContent.substring(spaceIndex + 1).trim();
      }

      currentSequence = '';
      continue;
    }

    if (trimmed.startsWith(';')) continue;

    if (currentName) {
      const cleanedLine = trimmed.replace(/\s/g, '');

      if (!/^[ACGTURYSWKMBDHVN\-.*]+$/i.test(cleanedLine)) {
        if (!/^[ACDEFGHIKLMNPQRSTVWY*\-XBZJ]+$/i.test(cleanedLine)) {
          throw new FastaParseError(
            `Invalid sequence characters on line ${lineNumber}: "${cleanedLine.substring(0, 20)}..."`,
            lineNumber
          );
        }
      }

      currentSequence += cleanedLine;
    }
  }

  if (currentName && currentSequence) {
    sequences.push({
      name: currentName,
      description: currentDescription || undefined,
      sequence: currentSequence,
      length: currentSequence.length,
    });
  }

  if (sequences.length === 0) {
    throw new FastaParseError('No valid FASTA sequences found in file');
  }

  return sequences;
}

export function parseFastaAsPlasmid(content: string): ParsedPlasmid {
  const sequences = parseFasta(content);

  const first = sequences[0];

  return {
    name: first.name,
    length: first.length,
    circular: false,
    sequence: first.sequence,
    features: [] as PlasmidFeature[],
    primers: [] as Primer[],
    definition: first.description,
  };
}

export function parseMultiFasta(content: string): ParsedPlasmid[] {
  const sequences = parseFasta(content);

  return sequences.map((seq) => ({
    name: seq.name,
    length: seq.length,
    circular: false,
    sequence: seq.sequence,
    features: [] as PlasmidFeature[],
    primers: [] as Primer[],
    definition: seq.description,
  }));
}

export function isFastaFormat(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith('>');
}

export function countFastaSequences(content: string): number {
  const lines = content.split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    if (line.trim().startsWith('>')) {
      count++;
    }
  }
  return count;
}
