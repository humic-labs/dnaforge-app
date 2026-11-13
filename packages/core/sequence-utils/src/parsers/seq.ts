import type { ParsedSequence, SeqMetadata } from './types';
import { SequenceParseError } from './types';

export function parseSeq(content: string, filename?: string): ParsedSequence {
  const lines = content.split(/\r?\n/);
  const comments: string[] = [];
  let name = '';
  let sequence = '';
  let circular = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) continue;

    if (trimmed.startsWith(';') || trimmed.startsWith('#')) {
      const comment = trimmed.substring(1).trim();
      comments.push(comment);

      if (/circular/i.test(comment)) {
        circular = true;
      }
      continue;
    }

    if (trimmed.startsWith('>')) {
      name = trimmed.substring(1).trim();
      continue;
    }

    const cleaned = trimmed.replace(/[^A-Za-z]/g, '');

    if (cleaned && !/^[ACGTUNRYSWKMBDHVacgtunryswkmbdhv]+$/.test(cleaned)) {
      throw new SequenceParseError(
        `Invalid nucleotide characters: "${cleaned.substring(0, 20)}..."`,
        'seq',
        i + 1
      );
    }

    sequence += cleaned;
  }

  if (!sequence) {
    throw new SequenceParseError('No sequence data found in file', 'seq');
  }

  const derivedName = name || deriveNameFromFilename(filename) || 'Untitled';

  const id = generateId(derivedName);

  const metadata: SeqMetadata = {};
  if (comments.length > 0) {
    metadata.comments = comments;
  }
  if (circular) {
    metadata.circular = circular;
  }

  return {
    id,
    name: derivedName,
    sequence,
    length: sequence.length,
    format: 'seq',
    metadata: Object.keys(metadata).length > 0 ? (metadata as Record<string, unknown>) : undefined,
  };
}

export function isSeqFormat(content: string): boolean {
  const trimmed = content.trim();

  if (trimmed.startsWith('>')) return false;
  if (trimmed.startsWith('@')) return false;
  if (trimmed.startsWith('LOCUS')) return false;

  const lines = trimmed.split(/\r?\n/);
  for (const line of lines) {
    const l = line.trim();
    if (!l || l.startsWith(';') || l.startsWith('#')) continue;

    const cleaned = l.replace(/[^A-Za-z]/g, '');
    if (cleaned && /^[ACGTUNRYSWKMBDHVacgtunryswkmbdhv]+$/.test(cleaned)) {
      return true;
    }
    return false;
  }

  return false;
}

function deriveNameFromFilename(filename?: string): string | undefined {
  if (!filename) return undefined;

  const base = filename.split('/').pop() || filename;
  const name = base.replace(/\.(seq|txt)$/i, '');

  return name || undefined;
}

function generateId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
