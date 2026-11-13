import {
  IUPAC_REGEX_CLASS,
  reverseComplement as reverseComplementIupac,
} from '@waypoint/sequence-utils/iupac';
import type { SearchHit } from './types';

const IUPAC_CODES: Readonly<Record<string, string>> = IUPAC_REGEX_CLASS;

export function motifToRegex(motif: string, caseSensitive = false): RegExp | null {
  if (!motif) return null;
  const pattern: string[] = [];
  for (const ch of motif.toUpperCase()) {
    const expanded = IUPAC_CODES[ch];
    if (!expanded) return null;
    pattern.push(expanded);
  }
  return new RegExp(pattern.join(''), caseSensitive ? 'g' : 'gi');
}

export function collectOverlappingMatches(
  sequence: string,
  regex: RegExp,
  chrom: string,
  windowStart: number,
  emitStart: number,
  emitEnd: number,
  motif: string,
  strand: 'forward' | 'reverse'
): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<number>();
  regex.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(sequence)) !== null) {
    const offset = match.index;
    if (seen.has(offset)) {
      regex.lastIndex = offset + 1;
      continue;
    }
    seen.add(offset);

    const start = windowStart + offset;
    const end = start + match[0].length;
    if (start >= emitStart && start < emitEnd) {
      hits.push({ chrom, start, end, strand, motif });
    }

    regex.lastIndex = offset + 1;
  }

  return hits;
}

export function collectCoordinateOrderedMatches(
  sequence: string,
  forwardRegex: RegExp,
  reverseRegex: RegExp | null,
  chrom: string,
  windowStart: number,
  emitStart: number,
  emitEnd: number,
  motif: string
): SearchHit[] {
  const forwardHits = collectOverlappingMatches(
    sequence,
    forwardRegex,
    chrom,
    windowStart,
    emitStart,
    emitEnd,
    motif,
    'forward'
  );
  if (!reverseRegex) return forwardHits;

  const readEnd = windowStart + sequence.length;
  const reverseLocalHits = collectOverlappingMatches(
    reverseComplement(sequence),
    reverseRegex,
    chrom,
    0,
    0,
    sequence.length,
    motif,
    'reverse'
  );
  const forwardCoordinates = new Set(forwardHits.map((hit) => `${hit.start}:${hit.end}`));
  const reverseHits: SearchHit[] = [];
  for (const localHit of reverseLocalHits) {
    const hitLength = localHit.end - localHit.start;
    const mappedEnd = readEnd - localHit.start;
    const mappedStart = mappedEnd - hitLength;
    if (mappedStart < emitStart || mappedStart >= emitEnd) continue;
    if (forwardCoordinates.has(`${mappedStart}:${mappedEnd}`)) continue;
    reverseHits.push({
      chrom,
      start: mappedStart,
      end: mappedEnd,
      strand: 'reverse',
      motif,
    });
  }

  return [...forwardHits, ...reverseHits].sort(
    (left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      (left.strand === right.strand ? 0 : left.strand === 'forward' ? -1 : 1)
  );
}

export function reverseComplement(sequence: string): string {
  return reverseComplementIupac(sequence.toUpperCase());
}
