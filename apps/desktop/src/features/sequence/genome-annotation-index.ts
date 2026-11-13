import type { PrepackedAnnotationSearchDirectionV1 } from '@waypoint/genome-data';

export interface IndexableFeature {
  type: string;
  annotationTrackId?: string;
  canonicalIdentity?: string;
  direction: PrepackedAnnotationSearchDirectionV1;
  start: number;
  end: number;
  displayName?: string;
  qualifiers?: Record<string, ReadonlyArray<string> | string | undefined>;
  attributes?: Record<string, ReadonlyArray<string> | string | undefined>;
}

const NGRAM_SIZE = 3;
const FIELD_SEPARATOR = '|][|';

export interface AnnotationIndexMatch {
  featureIndex: number;
  start: number;
  end: number;
  label: string;
  featureType: string;
  annotationTrackId?: string;
  canonicalIdentity?: string;
  direction: PrepackedAnnotationSearchDirectionV1;
}

export interface AnnotationIndex {
  size: number;
  query(input: string, limit?: number): AnnotationIndexMatch[];
}

interface IndexedRecord {
  featureIndex: number;
  start: number;
  end: number;
  featureType: string;
  annotationTrackId?: string;
  canonicalIdentity?: string;
  direction: PrepackedAnnotationSearchDirectionV1;
  haystack: string;
  primaryLabel: string;
}

export function buildAnnotationIndex(features: ReadonlyArray<IndexableFeature>): AnnotationIndex {
  const records: IndexedRecord[] = new Array(features.length);
  const postings = new Map<string, number[]>();

  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    const haystack = buildHaystack(f);
    const primaryLabel = f.displayName || firstQualifierValue(f) || f.type;
    records[i] = {
      featureIndex: i,
      start: f.start,
      end: f.end,
      featureType: f.type,
      direction: f.direction,
      ...(f.annotationTrackId ? { annotationTrackId: f.annotationTrackId } : {}),
      ...(f.canonicalIdentity ? { canonicalIdentity: f.canonicalIdentity } : {}),
      haystack,
      primaryLabel,
    };
    addNgramsToPostings(haystack, i, postings);
  }

  return {
    size: features.length,
    query(input: string, limit = 200): AnnotationIndexMatch[] {
      const folded = input.toLowerCase().trim();
      if (folded.length === 0) return [];
      if (limit <= 0) return [];

      let candidateIndices: Iterable<number>;
      if (folded.length < NGRAM_SIZE) {
        candidateIndices = enumerate(records.length);
      } else {
        const queryNgrams = ngramsOf(folded);
        const postingLists: number[][] = [];
        for (const ng of queryNgrams) {
          const list = postings.get(ng);
          if (!list) return [];
          postingLists.push(list);
        }
        candidateIndices = intersectSortedLists(postingLists);
      }

      const matches: AnnotationIndexMatch[] = [];
      for (const i of candidateIndices) {
        if (matches.length >= limit) break;
        const rec = records[i];
        if (rec.haystack.indexOf(folded) < 0) continue;
        matches.push({
          featureIndex: rec.featureIndex,
          start: rec.start,
          end: rec.end,
          label: rec.primaryLabel,
          featureType: rec.featureType,
          direction: rec.direction,
          ...(rec.annotationTrackId ? { annotationTrackId: rec.annotationTrackId } : {}),
          ...(rec.canonicalIdentity ? { canonicalIdentity: rec.canonicalIdentity } : {}),
        });
      }
      matches.sort((a, b) => a.start - b.start || a.end - b.end || a.featureIndex - b.featureIndex);
      return matches;
    },
  };
}

function buildHaystack(f: IndexableFeature): string {
  const parts: string[] = [];
  if (f.displayName) parts.push(f.displayName.toLowerCase());
  if (f.type) parts.push(f.type.toLowerCase());
  collectFieldValues(f.qualifiers, parts);
  collectFieldValues(f.attributes, parts);
  return parts.join(FIELD_SEPARATOR);
}

function collectFieldValues(
  source: Record<string, ReadonlyArray<string> | string | undefined> | undefined,
  out: string[]
): void {
  if (!source) return;
  for (const value of Object.values(source)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === 'string' && v.length > 0) out.push(v.toLowerCase());
      }
    } else if (typeof value === 'string' && value.length > 0) {
      out.push(value.toLowerCase());
    }
  }
}

function firstQualifierValue(f: IndexableFeature): string {
  return firstString(f.qualifiers) ?? firstString(f.attributes) ?? '';
}

function firstString(
  source: Record<string, ReadonlyArray<string> | string | undefined> | undefined
): string | null {
  if (!source) return null;
  for (const value of Object.values(source)) {
    if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === 'string' && v.length > 0) return v;
      }
    } else if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

function ngramsOf(s: string): Set<string> {
  const set = new Set<string>();
  if (s.length < NGRAM_SIZE) return set;
  for (let i = 0; i <= s.length - NGRAM_SIZE; i++) {
    set.add(s.substring(i, i + NGRAM_SIZE));
  }
  return set;
}

function addNgramsToPostings(
  haystack: string,
  featureIndex: number,
  postings: Map<string, number[]>
): void {
  if (haystack.length < NGRAM_SIZE) return;
  const seen = new Set<string>();
  for (let i = 0; i <= haystack.length - NGRAM_SIZE; i++) {
    const ng = haystack.substring(i, i + NGRAM_SIZE);
    if (seen.has(ng)) continue;
    seen.add(ng);
    const list = postings.get(ng);
    if (list) list.push(featureIndex);
    else postings.set(ng, [featureIndex]);
  }
}

function* enumerate(n: number): Generator<number> {
  for (let i = 0; i < n; i++) yield i;
}

function intersectSortedLists(lists: number[][]): number[] {
  if (lists.length === 0) return [];
  if (lists.length === 1) return lists[0];
  const sorted = [...lists].sort((a, b) => a.length - b.length);
  let acc = sorted[0];
  for (let i = 1; i < sorted.length && acc.length > 0; i++) {
    acc = intersectTwo(acc, sorted[i]);
  }
  return acc;
}

function intersectTwo(a: number[], b: number[]): number[] {
  const out: number[] = [];
  let ai = 0;
  let bi = 0;
  while (ai < a.length && bi < b.length) {
    const av = a[ai];
    const bv = b[bi];
    if (av === bv) {
      out.push(av);
      ai++;
      bi++;
    } else if (av < bv) {
      ai++;
    } else {
      bi++;
    }
  }
  return out;
}
