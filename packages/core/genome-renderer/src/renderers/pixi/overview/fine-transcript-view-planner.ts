import { unpackBpCoordinate } from './bp-coordinate-packing';
import type { GpuReadyPartitionedTranscriptScene } from './partitioned-transcript-scene';
import { TRANSCRIPT_GLYPH_INSTANCE_LAYOUT } from './transcript-glyph-instances';

export const FINE_TRANSCRIPT_VIEW_SPAN_BP = 512 * 1024;

export interface FineTranscriptInstanceViewRange {
  readonly key: string;
  readonly tileIndex: number;
  readonly startBp: number;
  readonly endBpExclusive: number;
  readonly firstInstance: number;
  readonly instanceCount: number;
}

export interface FineTranscriptViewPlan {
  readonly viewportStartBp: number;
  readonly viewportEndBp: number;
  readonly expandedStartBp: number;
  readonly requiredTileIndices: ReadonlyArray<number>;
  readonly prewarmTileIndices: ReadonlyArray<number>;
}

export function planFineTranscriptViews(
  scene: Pick<GpuReadyPartitionedTranscriptScene, 'maxPrimitiveSpanBp'>,
  viewportStartBp: number,
  viewportEndBp: number,
  haloTiles = 1,
  tileSpanBp = FINE_TRANSCRIPT_VIEW_SPAN_BP,
  tileCount?: number
): FineTranscriptViewPlan {
  if (
    !Number.isSafeInteger(viewportStartBp) ||
    !Number.isSafeInteger(viewportEndBp) ||
    viewportStartBp < 0 ||
    viewportEndBp <= viewportStartBp ||
    !Number.isSafeInteger(tileSpanBp) ||
    tileSpanBp <= 0 ||
    !Number.isSafeInteger(haloTiles) ||
    haloTiles < 0 ||
    (tileCount !== undefined && (!Number.isSafeInteger(tileCount) || tileCount <= 0))
  ) {
    throw new Error('fine transcript viewport plan is invalid');
  }
  const expandedStartBp = Math.max(0, viewportStartBp - scene.maxPrimitiveSpanBp);
  const first = Math.floor(expandedStartBp / tileSpanBp);
  const last = Math.floor((viewportEndBp - 1) / tileSpanBp);
  if (tileCount !== undefined && last >= tileCount) {
    throw new Error('fine transcript viewport lies outside the indexed assembly');
  }
  const requiredTileIndices = integerRange(first, last);
  const prewarmTileIndices = integerRange(
    Math.max(0, first - haloTiles),
    tileCount === undefined ? last + haloTiles : Math.min(tileCount - 1, last + haloTiles)
  );
  return {
    viewportStartBp,
    viewportEndBp,
    expandedStartBp,
    requiredTileIndices,
    prewarmTileIndices,
  };
}

export function fineTranscriptInstanceViewRange(
  scene: Pick<GpuReadyPartitionedTranscriptScene, 'packedInstanceData' | 'featureIndices'>,
  tileIndex: number,
  tileSpanBp = FINE_TRANSCRIPT_VIEW_SPAN_BP
): FineTranscriptInstanceViewRange {
  if (!Number.isSafeInteger(tileIndex) || tileIndex < 0) {
    throw new Error('fine transcript tile index must be a nonnegative safe integer');
  }
  if (!Number.isSafeInteger(tileSpanBp) || tileSpanBp <= 0) {
    throw new Error('fine transcript tile span must be a positive safe integer');
  }
  const startBp = tileIndex * tileSpanBp;
  const endBpExclusive =
    tileSpanBp > Number.MAX_SAFE_INTEGER - startBp ? Number.MAX_SAFE_INTEGER : startBp + tileSpanBp;
  const firstInstance = lowerBoundStart(scene, startBp);
  const endInstance = lowerBoundStart(scene, endBpExclusive);
  return {
    key: `fine-bp-view-${tileIndex}`,
    tileIndex,
    startBp,
    endBpExclusive,
    firstInstance,
    instanceCount: endInstance - firstInstance,
  };
}

export function packedTranscriptPrimitiveStartBp(
  scene: Pick<GpuReadyPartitionedTranscriptScene, 'packedInstanceData' | 'featureIndices'>,
  instanceIndex: number
): number {
  if (
    !Number.isSafeInteger(instanceIndex) ||
    instanceIndex < 0 ||
    instanceIndex >= scene.featureIndices.length
  ) {
    throw new Error('transcript primitive instance index is out of range');
  }
  const base = instanceIndex * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
  return unpackBpCoordinate(
    scene.packedInstanceData[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartChunk],
    scene.packedInstanceData[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartDelta]
  );
}

function lowerBoundStart(
  scene: Pick<GpuReadyPartitionedTranscriptScene, 'packedInstanceData' | 'featureIndices'>,
  targetBp: number
): number {
  let low = 0;
  let high = scene.featureIndices.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (packedTranscriptPrimitiveStartBp(scene, middle) < targetBp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function integerRange(first: number, last: number): number[] {
  const result: number[] = [];
  for (let value = first; value <= last; value += 1) result.push(value);
  return result;
}
