import {
  DISCOVERY_RANK_PATH,
  requestDiscoveryRanking,
  type DiscoveryRanker,
} from '../shared/discovery-ranking';
import { resolveSidecarBaseUrl, sidecarFetch } from './sidecar-session';

export const rankDiscoveryCandidates: DiscoveryRanker = async (query, candidates, signal) => {
  try {
    const baseUrl = await resolveSidecarBaseUrl('discovery');
    return await requestDiscoveryRanking(
      query,
      candidates,
      (init) => sidecarFetch(`${baseUrl}${DISCOVERY_RANK_PATH}`, init),
      signal
    );
  } catch {
    signal?.throwIfAborted();
    return null;
  }
};
