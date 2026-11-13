import { projectCodingSequence, type CodingSequenceContext } from './coding-sequence';
import { indexOfSubsequenceBmh, normalizeProteinSearchQuery } from './protein-search';
import type { Annotation } from './types';
import { IUPAC_REGEX_CLASS, IUPAC_DEGENERACY as CANONICAL_IUPAC_DEGENERACY } from './iupac';
import { reverseComplement } from './translation';
import { searchAnnotations } from './annotation-search';

export interface SearchMatch {
  start: number;
  end: number;
  strand: 'forward' | 'reverse';
  type: 'nucleotide' | 'annotation' | 'protein';
  label?: string;
  featureType?: string;
  annotationTrackId?: string;
  canonicalIdentity?: string;
  chrom?: string;
  localStart?: number;
  localEnd?: number;
  annotationTrackVisibility?: 'visible' | 'hidden';
  protein?: SearchMatchProteinIdentity;
  wraps?: boolean;
  annotation?: SearchMatchAnnotationIdentity;
}

export interface SearchMatchAnnotationIdentity {
  type: string;
  name: string;
  start: number;
  end: number;
  direction?: number;
}

export interface SearchMatchProteinIdentity {
  geneId?: string;
  transcriptId: string;
  proteinStart: number;
  proteinEnd: number;
  geneticCode: number;
  segments: ReadonlyArray<Readonly<{ start: number; end: number }>>;
}

const IUPAC_CODES: Readonly<Record<string, string>> = IUPAC_REGEX_CLASS;

const IUPAC_DEGENERACY: Readonly<Record<string, number>> = CANONICAL_IUPAC_DEGENERACY;

export class SearchTooBroadError extends Error {
  readonly maxMatches: number;

  constructor(maxMatches: number) {
    super(`Search produced more than ${maxMatches} matches`);
    this.name = 'SearchTooBroadError';
    this.maxMatches = maxMatches;
  }
}

export function expandIUPACToRegex(query: string): RegExp {
  if (!query) throw new Error('Empty query');

  const upper = query.toUpperCase();
  const pattern = upper
    .split('')
    .map((ch) => {
      if (ch in IUPAC_CODES) return IUPAC_CODES[ch];
      throw new Error(`Invalid character in pattern: ${ch}`);
    })
    .join('');

  return new RegExp(pattern, 'gi');
}

export function estimateNucleotideSearchMatchCount(
  sequenceLength: number,
  query: string,
  options: { circular?: boolean; reverseComplement?: boolean } = {}
): number {
  if (!query || sequenceLength <= 0) return 0;

  const upper = query.toUpperCase();
  let degeneracy = 1;
  for (const ch of upper) {
    const value = IUPAC_DEGENERACY[ch];
    if (value === undefined) {
      throw new Error(`Invalid character in pattern: ${ch}`);
    }
    degeneracy *= value;
  }

  const windowCount = options.circular
    ? sequenceLength
    : Math.max(0, sequenceLength - upper.length + 1);
  const strandMultiplier = options.reverseComplement ? 2 : 1;
  return windowCount * (degeneracy / 4 ** upper.length) * strandMultiplier;
}

export function searchNucleotide(
  sequence: string,
  query: string,
  options: { circular?: boolean; reverseComplement?: boolean; maxMatches?: number } = {}
): SearchMatch[] {
  if (!query || !sequence) return [];
  if (query.length < 2) return [];

  let regex: RegExp;
  try {
    regex = expandIUPACToRegex(query);
  } catch {
    return [];
  }

  const seqLen = sequence.length;
  const matches: SearchMatch[] = [];

  const fwdTarget = options.circular ? sequence + sequence.slice(0, query.length - 1) : sequence;
  collectMatches(fwdTarget, regex, 'forward', seqLen, matches, options.maxMatches);

  if (options.reverseComplement) {
    const revSeq = reverseComplement(sequence);
    const revTarget = options.circular ? revSeq + revSeq.slice(0, query.length - 1) : revSeq;

    const revMatches: SearchMatch[] = [];
    collectMatches(revTarget, regex, 'reverse', seqLen, revMatches, options.maxMatches);

    const fwdKeys = new Set(matches.map((m) => `${m.start}-${m.end}`));

    for (const m of revMatches) {
      const fwdStart = seqLen - 1 - m.end;
      const fwdEnd = seqLen - 1 - m.start;
      const mappedStart = fwdStart < 0 ? fwdStart + seqLen : fwdStart;
      const mappedEnd = fwdEnd < 0 ? fwdEnd + seqLen : fwdEnd;

      const key = `${mappedStart}-${mappedEnd}`;
      if (fwdKeys.has(key)) continue;

      matches.push({
        ...m,
        start: mappedStart,
        end: mappedEnd,
      });
      if (options.maxMatches !== undefined && matches.length > options.maxMatches) {
        throw new SearchTooBroadError(options.maxMatches);
      }
    }
  }

  return matches;
}

function collectMatches(
  target: string,
  regex: RegExp,
  strand: 'forward' | 'reverse',
  seqLen: number,
  out: SearchMatch[],
  maxMatches?: number
): void {
  regex.lastIndex = 0;

  let m: RegExpExecArray | null;
  const seen = new Set<string>();

  while ((m = regex.exec(target)) !== null) {
    const matchStart = m.index;
    const matchEnd = matchStart + m[0].length - 1;

    const start = matchStart % seqLen;
    const end = matchEnd % seqLen;
    const wraps = matchEnd >= seqLen;

    const key = `${start}-${end}-${strand}`;
    if (seen.has(key)) {
      regex.lastIndex = m.index + 1;
      continue;
    }
    seen.add(key);

    if (matchStart >= seqLen) {
      regex.lastIndex = m.index + 1;
      continue;
    }

    out.push({
      start,
      end,
      strand,
      type: 'nucleotide',
      wraps: wraps || undefined,
    });
    if (maxMatches !== undefined && out.length > maxMatches) {
      throw new SearchTooBroadError(maxMatches);
    }

    regex.lastIndex = m.index + 1;
  }
}

function annotationIdentityFromAnnotation(ann: Annotation): SearchMatchAnnotationIdentity {
  return {
    type: ann.type,
    name: ann.name,
    start: ann.start,
    end: ann.end,
    direction: ann.direction,
  };
}

export function searchAnnotationsAndProtein(
  annotations: Annotation[],
  sequence: string,
  query: string,
  context: CodingSequenceContext = {}
): SearchMatch[] {
  if (!query || !annotations.length) return [];

  const matches: SearchMatch[] = [];
  const q = normalizeProteinSearchQuery(query);
  const encoder = new TextEncoder();
  const needle = encoder.encode(q);

  const nameMatches = searchAnnotations(annotations, query);
  const cdsNames = new Set<string>();
  for (const ann of nameMatches) {
    if (ann.type === 'CDS') {
      cdsNames.add(ann.name);
      continue;
    }
    const annStart = ann.start - 1;
    const annEnd = ann.end - 1;
    matches.push({
      start: annStart,
      end: annEnd,
      strand: ann.direction === -1 ? 'reverse' : 'forward',
      type: 'annotation',
      label: ann.name,
      wraps: annStart > annEnd || undefined,
      annotation: annotationIdentityFromAnnotation(ann),
    });
  }

  const cdsAnnotations = annotations.filter((a) => a.type === 'CDS');
  for (const cds of cdsAnnotations) {
    if (!sequence) continue;

    const coding = projectCodingSequence(cds, sequence, context);
    const protein = encoder.encode(coding.protein.toUpperCase());

    let searchIdx = 0;
    let foundProteinMatch = false;
    let idx: number;
    // eslint-disable-next-line no-cond-assign
    while (needle.length > 0 && (idx = indexOfSubsequenceBmh(protein, needle, searchIdx)) !== -1) {
      foundProteinMatch = true;

      const first = coding.codonStartOffset + idx * 3;
      const last = first + q.length * 3 - 1;
      const ntStart = coding.genomicCoordinateMap[cds.direction === -1 ? last : first];
      const ntEnd = coding.genomicCoordinateMap[cds.direction === -1 ? first : last];

      matches.push({
        start: ntStart,
        end: ntEnd,
        strand: cds.direction === -1 ? 'reverse' : 'forward',
        type: 'protein',
        label: cds.name,
        wraps: ntStart > ntEnd || undefined,
        annotation: annotationIdentityFromAnnotation(cds),
      });

      searchIdx = idx + 1;
    }

    if (!foundProteinMatch && cdsNames.has(cds.name)) {
      const fbStart = cds.start - 1;
      const fbEnd = cds.end - 1;
      matches.push({
        start: fbStart,
        end: fbEnd,
        strand: cds.direction === -1 ? 'reverse' : 'forward',
        type: 'annotation',
        label: cds.name,
        wraps: fbStart > fbEnd || undefined,
        annotation: annotationIdentityFromAnnotation(cds),
      });
    }
  }

  return matches;
}
