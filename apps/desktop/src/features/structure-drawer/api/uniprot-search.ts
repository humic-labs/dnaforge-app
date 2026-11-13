import { sidecarUniProtSearch, sidecarUniProtSearchMany } from './sidecar-client';

export interface UniProtSearchHit {
  accession: string;
  reviewed: boolean;
  sequence?: string;
  taxonId?: number;
  organism?: string;
}

export async function searchUniProt(
  baseQuery: string,
  signal: AbortSignal
): Promise<UniProtSearchHit | null> {
  return sidecarUniProtSearch(baseQuery, signal);
}

export async function searchUniProtMany(
  baseQuery: string,
  signal: AbortSignal,
  opts: {
    size?: number;
    includeSequence?: boolean;
    includeUnreviewedAfterReviewed?: boolean;
  } = {}
): Promise<UniProtSearchHit[]> {
  return sidecarUniProtSearchMany(baseQuery, signal, opts);
}
