import type { GenomeTileRequest, GenomeTrackTile } from '../../../shared/indexed-genome';

import { buildAnnotationTileRequest } from './indexed-annotation-tile-request';
import { isPendingAnnotationTile } from './indexed-genome-viewer-viewport';
import type { LaneLimit } from './indexed-genome-legacy-adapter';

export const SUMMARY_TILE_RETRY_MS = 700;
export const SUMMARY_TILE_MAX_ATTEMPTS = 120;

export type PollAnnotationSummaryTileInput = {
  sessionId: string;
  chrom: string;
  length: number;
  generation: number;
  visibleTypes: ReadonlySet<string>;
  laneLimit: LaneLimit;
  sourceFingerprint: string;
  isCancelled: () => boolean;
  getAnnotationTile: (
    sessionId: string,
    request: GenomeTileRequest,
    requestId: string
  ) => Promise<GenomeTrackTile>;
  onRequestStart?: (requestId: string) => void;
  onRequestEnd?: (requestId: string) => void;
  onPendingTile?: (tile: GenomeTrackTile) => void;
  delay?: (ms: number) => Promise<void>;
};

export async function pollAnnotationSummaryTile(
  input: PollAnnotationSummaryTileInput
): Promise<GenomeTrackTile> {
  const delay = input.delay ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastTile: GenomeTrackTile | null = null;
  let lastPendingKey: string | null = null;
  for (let attempt = 0; attempt < SUMMARY_TILE_MAX_ATTEMPTS; attempt += 1) {
    if (input.isCancelled()) throw new Error('Annotation summary request cancelled.');
    const requestId = `overview-annotations-${input.generation}-${attempt}`;
    input.onRequestStart?.(requestId);
    const tile = await input
      .getAnnotationTile(
        input.sessionId,
        buildAnnotationTileRequest({
          chrom: input.chrom,
          start: 0,
          end: input.length,
          lod: 0,
          generation: input.generation,
          fidelity: 'summary',
          byteBudget: 4_000_000,
          sourceFingerprint: input.sourceFingerprint,
          visibleTypes: input.visibleTypes,
          laneLimit: input.laneLimit,
        }),
        requestId
      )
      .finally(() => input.onRequestEnd?.(requestId));
    if (input.isCancelled()) throw new Error('Annotation summary request cancelled.');
    lastTile = tile;
    if (!isPendingAnnotationTile(tile)) return tile;
    const pendingKey = [tile.state, tile.fidelity, tile.recordCount, tile.byteCount].join(':');
    if (pendingKey !== lastPendingKey) {
      lastPendingKey = pendingKey;
      input.onPendingTile?.(tile);
    }
    await delay(SUMMARY_TILE_RETRY_MS);
  }
  throw new Error(lastTile?.message ?? 'Annotation summary did not become ready.');
}
