import { getApiUrl } from './config';
import { sidecarFetch } from './sidecar-session-runtime';
import {
  DISCOVERY_RANK_PATH,
  requestDiscoveryRanking,
  type DiscoveryRanker,
} from '../shared/discovery-ranking';

export const rankDiscoveryCandidates: DiscoveryRanker = (query, candidates, signal) =>
  requestDiscoveryRanking(
    query,
    candidates,
    (init) => sidecarFetch(`${getApiUrl()}${DISCOVERY_RANK_PATH}`, init),
    signal
  );
