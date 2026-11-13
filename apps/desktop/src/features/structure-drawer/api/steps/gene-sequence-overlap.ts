import { alphaFoldCandidateFromHit } from '../alphafold-candidate';
import { validateAfdbExists } from '../afdb-validate';
import { searchUniProtMany, type UniProtSearchHit } from '../uniprot-search';
import type { ResolverStep } from '../../types/structure-drawer';

const MIN_OVERLAP_AA = 30;
const MIN_LONGER_COVERAGE = 0.7;
const GENE_OVERLAP_QUERY_SIZE = 10;

interface SequenceOverlapEvidence {
  hit: UniProtSearchHit;
  overlapLength: number;
  queryCoverage: number;
  hitCoverage: number;
  acceptedIdentity: number;
  rank: number;
}

export const geneSequenceOverlapStep: ResolverStep = {
  name: 'gene_sequence_overlap',
  hintsRequired: ['geneName'],
  priority: 65,
  async resolve(translation, hints, signal) {
    if (!translation || !hints.geneName) return null;
    const geneName = sanitizeGeneName(hints.geneName);
    if (!geneName) return null;
    const query = hints.taxonId
      ? `gene:${geneName} AND organism_id:${hints.taxonId}`
      : `gene:${geneName}`;
    const hits = await searchUniProtMany(query, signal, {
      size: GENE_OVERLAP_QUERY_SIZE,
      includeSequence: true,
      includeUnreviewedAfterReviewed: true,
    });
    const overlap = bestStrictSequenceOverlap(translation, hits);
    if (!overlap) return null;
    const afdb = await validateAfdbExists(overlap.hit.accession, signal);
    if (!afdb) return null;
    const candidate = alphaFoldCandidateFromHit(afdb, 'gene_sequence_overlap');
    const identity = roundIdentity(overlap.acceptedIdentity);
    return {
      source: 'gene_sequence_overlap',
      identity,
      structure: candidate.structure,
      recommendedCandidateId: candidate.id,
      candidates: [
        {
          ...candidate,
          metadata: {
            ...candidate.metadata,
            organism: overlap.hit.organism,
          },
          provenance: {
            ...candidate.provenance,
            identity,
            sequenceIdentity: identity,
            externalProtein: {
              kind: 'uniprot',
              accession: overlap.hit.accession,
              reviewed: overlap.hit.reviewed,
              match: 'name_search',
              rank: overlap.rank,
              rankReasons: [
                'gene_name',
                'strict_sequence_overlap',
                `overlap:${overlap.overlapLength}`,
                `query_segment_coverage:${roundIdentity(overlap.queryCoverage)}`,
                `hit_segment_coverage:${roundIdentity(overlap.hitCoverage)}`,
              ],
            },
          },
        },
      ],
      confidenceNote:
        afdb.meanPlddt !== undefined
          ? `Mean pLDDT ${afdb.meanPlddt.toFixed(1)} · gene hit with strict sequence overlap (${Math.round(
              overlap.queryCoverage * 100
            )}% query-segment coverage)`
          : `Gene hit with strict sequence overlap (${Math.round(
              overlap.queryCoverage * 100
            )}% query-segment coverage)`,
    };
  },
};

export function bestStrictSequenceOverlap(
  queryProtein: string,
  hits: readonly UniProtSearchHit[]
): SequenceOverlapEvidence | null {
  const query = normalizeProtein(queryProtein);
  if (!query) return null;
  const accepted = hits
    .map((hit, rank) => {
      const overlap = strictContainmentOverlap(query, normalizeProtein(hit.sequence ?? ''));
      if (!overlap) return null;
      return { hit, rank, ...overlap };
    })
    .filter((item): item is SequenceOverlapEvidence => item !== null);
  accepted.sort((a, b) => {
    if (b.hitCoverage !== a.hitCoverage) return b.hitCoverage - a.hitCoverage;
    if (b.queryCoverage !== a.queryCoverage) return b.queryCoverage - a.queryCoverage;
    if (a.hit.reviewed !== b.hit.reviewed) return a.hit.reviewed ? -1 : 1;
    return a.rank - b.rank;
  });
  return accepted[0] ?? null;
}

function strictContainmentOverlap(
  query: string,
  hitSequence: string
): Omit<SequenceOverlapEvidence, 'hit' | 'rank'> | null {
  if (!query || !hitSequence) return null;
  const accepted: Omit<SequenceOverlapEvidence, 'hit' | 'rank'>[] = [];
  for (const querySegment of stopFreeProteinSegments(query)) {
    for (const hitSegment of stopFreeProteinSegments(hitSequence)) {
      const overlap = segmentContainmentOverlap(querySegment, hitSegment);
      if (overlap) accepted.push(overlap);
    }
  }
  accepted.sort((a, b) => {
    if (b.hitCoverage !== a.hitCoverage) return b.hitCoverage - a.hitCoverage;
    if (b.queryCoverage !== a.queryCoverage) return b.queryCoverage - a.queryCoverage;
    return b.overlapLength - a.overlapLength;
  });
  return accepted[0] ?? null;
}

function segmentContainmentOverlap(
  querySegment: string,
  hitSegment: string
): Omit<SequenceOverlapEvidence, 'hit' | 'rank'> | null {
  const queryContainsHit = querySegment.includes(hitSegment);
  const hitContainsQuery = hitSegment.includes(querySegment);
  if (!queryContainsHit && !hitContainsQuery) return null;
  const overlapLength = Math.min(querySegment.length, hitSegment.length);
  if (overlapLength < MIN_OVERLAP_AA) return null;
  const queryCoverage = overlapLength / querySegment.length;
  const hitCoverage = overlapLength / hitSegment.length;
  if (Math.min(queryCoverage, hitCoverage) < MIN_LONGER_COVERAGE) return null;
  return {
    overlapLength,
    queryCoverage,
    hitCoverage,
    acceptedIdentity: Math.min(queryCoverage, hitCoverage),
  };
}

function normalizeProtein(sequence: string): string {
  const normalized = sequence.replace(/\s+/g, '').toUpperCase();
  return normalized.endsWith('*') ? normalized.slice(0, -1) : normalized;
}

function stopFreeProteinSegments(sequence: string): string[] {
  return sequence
    .split('*')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= MIN_OVERLAP_AA);
}

function sanitizeGeneName(geneName: string): string | null {
  const trimmed = geneName.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) return null;
  return trimmed;
}

function roundIdentity(value: number): number {
  return Math.round(value * 1000) / 1000;
}
