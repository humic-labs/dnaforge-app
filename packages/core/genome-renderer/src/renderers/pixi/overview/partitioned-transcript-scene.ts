import type { AnnotationScenePrimitiveV1 } from './annotation-scene-binary-v1';
import { packTranscriptGlyphInstances } from './transcript-glyph-instances';
import type { AnnotationColorRoleKeyV1 } from '../../../annotation-role-palette';

export interface TranscriptInstancePartition {
  key: string;
  partitionIndex: number;
  startBp: number;
  endBpExclusive: number;
  firstInstance: number;
  instanceCount: number;
  minStartBp: number;
  maxEndBp: number;
}

export interface GpuReadyPartitionedTranscriptScene {
  readonly sourceAnnotationIdentity?: Readonly<{ payloadSha256: string; contractSha256: string }>;
  readonly sourceAnnotationAliases?: readonly import('../../../annotation-data-appearance').SourceAnnotationAliasesV1[];
  partitionSpanBp: number;
  maxPrimitiveSpanBp: number;
  packedInstanceData: Float32Array;
  featureIndices: Uint32Array;
  partitions: TranscriptInstancePartition[];
  roleIndices?: Uint8Array;
  roleTable?: readonly AnnotationColorRoleKeyV1[];
}

export interface PartitionedTranscriptScene extends GpuReadyPartitionedTranscriptScene {
  sortedPrimitives: AnnotationScenePrimitiveV1[];
}

export function buildPartitionedTranscriptScene(
  primitives: ReadonlyArray<AnnotationScenePrimitiveV1>,
  partitionSpanBp: number,
  options: {
    readonly ownsPrimitives?: boolean;
  } = {}
): PartitionedTranscriptScene {
  if (!Number.isSafeInteger(partitionSpanBp) || partitionSpanBp <= 0) {
    throw new Error('partitionSpanBp must be a positive safe integer');
  }

  const count = primitives.length;
  const starts = new Float64Array(count);
  const ends = new Float64Array(count);
  const featureOrder = new Float64Array(count);
  const order = new Uint32Array(count);
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const primitive = primitives[ordinal];
    validatePrimitiveCoordinates(primitive, ordinal);
    starts[ordinal] = primitive.startBp;
    ends[ordinal] = primitive.endBp;
    featureOrder[ordinal] = primitive.featureIndex;
    order[ordinal] = ordinal;
  }
  order.sort(
    (a, b) =>
      starts[a] - starts[b] || ends[a] - ends[b] || featureOrder[a] - featureOrder[b] || a - b
  );
  const sortedPrimitives: AnnotationScenePrimitiveV1[] = new Array(count);
  for (let rank = 0; rank < count; rank++) {
    const primitive = primitives[order[rank]];
    sortedPrimitives[rank] = options.ownsPrimitives ? primitive : { ...primitive };
  }
  const featureIndices = new Uint32Array(sortedPrimitives.length);
  let maxPrimitiveSpanBp = 0;
  for (let i = 0; i < sortedPrimitives.length; i++) {
    const primitive = sortedPrimitives[i];
    featureIndices[i] = primitive.featureIndex;
    maxPrimitiveSpanBp = Math.max(maxPrimitiveSpanBp, primitive.endBp - primitive.startBp);
  }

  const partitions: TranscriptInstancePartition[] = [];
  let cursor = 0;
  while (cursor < sortedPrimitives.length) {
    const first = cursor;
    const partitionIndex = Math.floor(sortedPrimitives[cursor].startBp / partitionSpanBp);
    let minStartBp = sortedPrimitives[cursor].startBp;
    let maxEndBp = sortedPrimitives[cursor].endBp;
    cursor++;
    while (
      cursor < sortedPrimitives.length &&
      Math.floor(sortedPrimitives[cursor].startBp / partitionSpanBp) === partitionIndex
    ) {
      minStartBp = Math.min(minStartBp, sortedPrimitives[cursor].startBp);
      maxEndBp = Math.max(maxEndBp, sortedPrimitives[cursor].endBp);
      cursor++;
    }
    const startBp = partitionIndex * partitionSpanBp;
    const endBpExclusive =
      partitionSpanBp > Number.MAX_SAFE_INTEGER - startBp
        ? Number.MAX_SAFE_INTEGER
        : startBp + partitionSpanBp;
    partitions.push({
      key: `bp-partition-${partitionIndex}`,
      partitionIndex,
      startBp,
      endBpExclusive,
      firstInstance: first,
      instanceCount: cursor - first,
      minStartBp,
      maxEndBp,
    });
  }

  return {
    partitionSpanBp,
    maxPrimitiveSpanBp,
    packedInstanceData: packTranscriptGlyphInstances(sortedPrimitives).data,
    featureIndices,
    sortedPrimitives,
    partitions,
  };
}

export function planTranscriptPartitionSubmissions(
  scene: Pick<GpuReadyPartitionedTranscriptScene, 'maxPrimitiveSpanBp' | 'partitions'>,
  viewportStartBp: number,
  viewportEndBp: number
): TranscriptInstancePartition[] {
  if (
    !Number.isSafeInteger(viewportStartBp) ||
    !Number.isSafeInteger(viewportEndBp) ||
    viewportStartBp < 0 ||
    viewportEndBp <= viewportStartBp
  ) {
    throw new Error('viewport must be a non-empty Number-safe half-open bp range');
  }
  const expandedStartBp = Math.max(0, viewportStartBp - scene.maxPrimitiveSpanBp);
  return scene.partitions.filter(
    (partition) =>
      partition.startBp < viewportEndBp &&
      partition.endBpExclusive > expandedStartBp &&
      partition.minStartBp < viewportEndBp &&
      partition.maxEndBp > viewportStartBp
  );
}

export function featureIndexForPartitionInstance(
  scene: Pick<GpuReadyPartitionedTranscriptScene, 'featureIndices'>,
  partition: Pick<TranscriptInstancePartition, 'firstInstance' | 'instanceCount'>,
  localInstanceIndex: number
): number | null {
  if (
    !Number.isInteger(localInstanceIndex) ||
    localInstanceIndex < 0 ||
    localInstanceIndex >= partition.instanceCount
  ) {
    return null;
  }
  return scene.featureIndices[partition.firstInstance + localInstanceIndex] ?? null;
}

function validatePrimitiveCoordinates(primitive: AnnotationScenePrimitiveV1, index: number): void {
  if (
    !Number.isSafeInteger(primitive.startBp) ||
    !Number.isSafeInteger(primitive.endBp) ||
    primitive.startBp < 0 ||
    primitive.endBp <= primitive.startBp
  ) {
    throw new Error(`primitive ${index} has invalid Number-safe half-open coordinates`);
  }
  if (
    !Number.isInteger(primitive.featureIndex) ||
    primitive.featureIndex < 0 ||
    primitive.featureIndex > 0xffff_ffff
  ) {
    throw new Error(`primitive ${index} has invalid uint32 featureIndex`);
  }
  if (
    !Number.isFinite(primitive.offsetCenter) ||
    !Number.isFinite(Math.fround(primitive.offsetCenter)) ||
    !Number.isFinite(primitive.halfH) ||
    !Number.isFinite(Math.fround(primitive.halfH)) ||
    primitive.halfH < 0 ||
    !Number.isInteger(primitive.color) ||
    primitive.color < 0 ||
    primitive.color > 0xff_ffff ||
    !Number.isFinite(primitive.alpha) ||
    primitive.alpha < 0 ||
    primitive.alpha > 1 ||
    !Number.isFinite(primitive.cdsFade) ||
    primitive.cdsFade < 0 ||
    primitive.cdsFade > 1 ||
    (primitive.dirSign !== -1 && primitive.dirSign !== 0 && primitive.dirSign !== 1)
  ) {
    throw new Error(`primitive ${index} has invalid GPU instance attributes`);
  }
}
