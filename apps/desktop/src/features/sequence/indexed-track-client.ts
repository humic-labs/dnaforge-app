import type { LocalAuthorityContext } from '../../shared/local-indexed-track-authority';
import type { BbiRangeGrant } from './bbi-reader-worker-protocol';
import { admitIndexedRangeSource, type IndexedRangeSourceInput } from './indexed-range-client';

export async function admitIndexedTrack(
  input: {
    source: IndexedRangeSourceInput;
    formatId: 'bigwig' | 'bigbed';
    provenanceId: string;
  },
  options: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    localAuthorityContext?: LocalAuthorityContext;
  } = {}
): Promise<BbiRangeGrant> {
  return admitIndexedRangeSource(input, options);
}
