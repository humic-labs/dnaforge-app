import {
  AnnotationRolePaletteBuilderV1,
  sourceShapeRoleKeyV1,
} from '../../../annotation-role-palette';
import { sourceAnnotationAliasesV1 } from '../../../annotation-data-appearance';
import { annotationCanonicalIdentityV2 } from '../../../geometry/annotation-canonical-identity-v2';
import { featureTypeColor, isTranscriptSourceType } from '../../../feature-colors';
import type { Feature } from '../../../types';
import { webglAnnotationColorForMode, type WebGLThemeMode } from '../shared/theme';
import type { AnnotationScenePrimitiveV1 } from './annotation-scene-binary-v1';
import {
  buildPartitionedTranscriptScene,
  type GpuReadyPartitionedTranscriptScene,
} from './partitioned-transcript-scene';
import {
  buildPrepackedAnnotationInteractionIndexV2,
  validatePrepackedAnnotationInteractionVisualCouplingV2,
  type PrepackedAnnotationInteractionIndexV2,
} from './prepacked-annotation-interaction-index-v2';
import { buildTranscriptGlyphBlocks } from './transcript-glyph-vertices';

export const TRANSCRIPT_PAGE_LANE_STEP_PX = 16;

export type TranscriptPageBundleCompileErrorCode =
  | 'invalid-owner'
  | 'invalid-genome-identity'
  | 'invalid-genome-length'
  | 'invalid-theme'
  | 'invalid-bar-height'
  | 'invalid-partition-span'
  | 'invalid-lane-capacity'
  | 'invalid-lane-contract'
  | 'missing-local-lane'
  | 'local-lane-out-of-range';

export class TranscriptPageBundleCompileError extends Error {
  constructor(readonly code: TranscriptPageBundleCompileErrorCode) {
    super(`Unable to compile transcript page bundle: ${code}`);
    this.name = 'TranscriptPageBundleCompileError';
  }
}

export interface CompileTranscriptPageBundleInput {
  readonly ownerKey: string;
  readonly features: ReadonlyArray<Feature>;
  readonly genomeIdentity: string;
  readonly genomeLengthBp: number;
  readonly themeMode: WebGLThemeMode;
  readonly annotationBarHeightPx: number;
  readonly partitionSpanBp: number;
  readonly laneCapacity: number | null;
  readonly laneContractIdentity: string;
  readonly rendererIdForFeature?: (feature: Feature, featureIndex: number) => number;
  readonly mode?: 'transcript-only' | 'resident-page';
}

export interface CompiledTranscriptPageBundle {
  readonly status: 'compiled' | 'empty' | 'incomplete';
  readonly mode: 'transcript-only' | 'resident-page';
  readonly ownerKey: string;
  readonly genomeIdentity: string;
  readonly genomeLengthBp: number;
  readonly themeMode: WebGLThemeMode;
  readonly annotationBarHeightPx: number;
  readonly partitionSpanBp: number;
  readonly laneCapacity: number | null;
  readonly laneContractIdentity: string;
  readonly featureCount: number;
  readonly renderedFeatureCount: number;
  readonly unsupportedFeatureIndices: ReadonlyArray<number>;
  readonly sortedPrimitives: ReadonlyArray<AnnotationScenePrimitiveV1>;
  readonly gpuReadyScene: GpuReadyPartitionedTranscriptScene;
  readonly interactionIndex: PrepackedAnnotationInteractionIndexV2;
}

function isRefinedTranscript(feature: Feature): boolean {
  if (!Array.isArray(feature.exons) || feature.exons.length === 0) return false;
  return feature.compositeKind !== undefined || isTranscriptSourceType(feature.type);
}

function isOutlineOnly(feature: Feature): boolean {
  if (feature.outlineOnly === true) return true;
  return (
    feature.qualifiers?.source === 'pLannotate-draft' && feature.qualifiers?.status !== 'accepted'
  );
}

export function compileTranscriptPageBundle(
  input: CompileTranscriptPageBundleInput
): CompiledTranscriptPageBundle {
  validateInput(input);
  const mode = input.mode ?? 'transcript-only';
  const unsupportedFeatureIndices: number[] = [];
  for (let featureIndex = 0; featureIndex < input.features.length; featureIndex += 1) {
    const feature = input.features[featureIndex];
    const featureMode = residentFeatureMode(feature, mode);
    if (featureMode === 'ignored') continue;
    if (featureMode === 'unsupported') {
      unsupportedFeatureIndices.push(featureIndex);
      continue;
    }
    if (
      !Number.isSafeInteger(feature.annotationTrackLane) ||
      (feature.annotationTrackLane ?? -1) < 0
    ) {
      throw new TranscriptPageBundleCompileError('missing-local-lane');
    }
    if (input.laneCapacity !== null && (feature.annotationTrackLane ?? 0) >= input.laneCapacity) {
      throw new TranscriptPageBundleCompileError('local-lane-out-of-range');
    }
  }

  const primitives: AnnotationScenePrimitiveV1[] = [];
  const roles = new AnnotationRolePaletteBuilderV1();
  const halfHeight = input.annotationBarHeightPx / 2;
  const renderedFeatureIndices = new Set<number>();
  if (unsupportedFeatureIndices.length === 0) {
    for (let featureIndex = 0; featureIndex < input.features.length; featureIndex += 1) {
      const feature = input.features[featureIndex];
      const featureMode = residentFeatureMode(feature, mode);
      if (featureMode === 'ignored' || featureMode === 'unsupported') continue;
      const localLane = feature.annotationTrackLane!;
      if (featureMode === 'source-shape') {
        primitives.push({
          startBp: feature.start,
          endBp: feature.end,
          featureIndex,
          offsetCenter: Math.fround(-halfHeight - localLane * TRANSCRIPT_PAGE_LANE_STEP_PX),
          halfH: Math.fround(halfHeight),
          color: webglAnnotationColorForMode(
            feature.color || featureTypeColor(feature.type),
            input.themeMode
          ),
          alpha: Math.fround(0.85),
          cdsFade: 0,
          dirSign: feature.direction === 'forward' ? 1 : feature.direction === 'reverse' ? -1 : 0,
          roleIndex: roles.indexOf(
            sourceShapeRoleKeyV1(feature.color || featureTypeColor(feature.type))
          ),
        });
        renderedFeatureIndices.add(featureIndex);
        continue;
      }
      const blocks = buildTranscriptGlyphBlocks([feature], {
        getOffset: () => -halfHeight - localLane * TRANSCRIPT_PAGE_LANE_STEP_PX,
        halfHeight,
        themeMode: input.themeMode,
        cdsDetail: 0,
      });
      if (blocks.length > 0) renderedFeatureIndices.add(featureIndex);
      for (const block of blocks) {
        primitives.push({
          startBp: block.startBp,
          endBp: block.endBp,
          featureIndex,
          offsetCenter: Math.fround(block.offsetCenter),
          halfH: Math.fround(block.halfH),
          color: block.color,
          alpha: Math.fround(block.alpha),
          cdsFade: Math.fround(block.cdsFade),
          dirSign: block.dirSign,
          roleIndex: roles.indexOf(block.role),
        });
      }
    }
  }

  const partitioned = buildPartitionedTranscriptScene(primitives, input.partitionSpanBp, {
    ownsPrimitives: true,
  });
  const interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
    input.features.map((feature, featureIndex) => {
      const sourceId =
        feature.sourceId ??
        feature.qualifiers?.ID ??
        feature.transcriptId ??
        `feature-${featureIndex}`;
      return {
        rendererId: input.rendererIdForFeature?.(feature, featureIndex) ?? featureIndex,
        startBp: feature.start,
        endBp: feature.end,
        lane: feature.lane,
        direction: feature.direction,
        displayName: feature.displayName,
        type: feature.type,
        transcriptId: feature.transcriptId ?? null,
        sourceId,
        canonicalIdentity: annotationCanonicalIdentityV2({
          genomeIdentity: input.genomeIdentity,
          sourceId,
          transcriptId: feature.transcriptId ?? null,
          trackId: feature.annotationTrackId ?? feature.type,
          type: feature.type,
          startBp: feature.start,
          endBp: feature.end,
          direction: feature.direction,
        }),
      };
    }),
    partitioned.sortedPrimitives
  );
  const gpuReadyScene: GpuReadyPartitionedTranscriptScene = {
    sourceAnnotationAliases: Object.freeze(
      input.features.map((feature, featureIndex) =>
        Object.freeze({
          featureIndex,
          aliases: feature.sourceAnnotationAliases ?? sourceAnnotationAliasesV1(feature.qualifiers),
        })
      )
    ),
    partitionSpanBp: partitioned.partitionSpanBp,
    maxPrimitiveSpanBp: partitioned.maxPrimitiveSpanBp,
    packedInstanceData: partitioned.packedInstanceData,
    featureIndices: partitioned.featureIndices,
    partitions: partitioned.partitions,
    ...(roles.roles.length <= 256
      ? {
          roleIndices: Uint8Array.from(
            partitioned.sortedPrimitives,
            (primitive) => primitive.roleIndex ?? 0
          ),
          roleTable: [...roles.roles],
        }
      : {}),
  };
  validatePrepackedAnnotationInteractionVisualCouplingV2(
    interactionIndex,
    gpuReadyScene,
    input.genomeLengthBp
  );
  return {
    status:
      unsupportedFeatureIndices.length > 0
        ? 'incomplete'
        : primitives.length === 0
          ? 'empty'
          : 'compiled',
    mode,
    ownerKey: input.ownerKey,
    genomeIdentity: input.genomeIdentity,
    genomeLengthBp: input.genomeLengthBp,
    themeMode: input.themeMode,
    annotationBarHeightPx: input.annotationBarHeightPx,
    partitionSpanBp: input.partitionSpanBp,
    laneCapacity: input.laneCapacity,
    laneContractIdentity: input.laneContractIdentity,
    featureCount: input.features.length,
    renderedFeatureCount: renderedFeatureIndices.size,
    unsupportedFeatureIndices: Object.freeze([...unsupportedFeatureIndices]),
    sortedPrimitives: partitioned.sortedPrimitives,
    gpuReadyScene,
    interactionIndex,
  };
}

export type CompileResidentAnnotationPageBundleInput = Omit<
  CompileTranscriptPageBundleInput,
  'mode' | 'rendererIdForFeature'
>;

export function compileResidentAnnotationPageBundle(
  input: CompileResidentAnnotationPageBundleInput
): CompiledTranscriptPageBundle {
  return compileTranscriptPageBundle({
    ...input,
    mode: 'resident-page',
    rendererIdForFeature: (feature) => feature.id,
  });
}

type ResidentFeatureMode = 'refined-transcript' | 'source-shape' | 'unsupported' | 'ignored';

function residentFeatureMode(
  feature: Feature,
  mode: 'transcript-only' | 'resident-page'
): ResidentFeatureMode {
  if (mode === 'transcript-only') {
    return isRefinedTranscript(feature) && !isOutlineOnly(feature)
      ? 'refined-transcript'
      : 'ignored';
  }
  if (isOutlineOnly(feature)) return 'unsupported';
  if (isRefinedTranscript(feature)) return 'refined-transcript';
  if (isTranscriptSourceType(feature.type)) return 'source-shape';
  return 'source-shape';
}

function validateInput(input: CompileTranscriptPageBundleInput): void {
  if (typeof input.ownerKey !== 'string' || input.ownerKey.trim().length === 0) {
    throw new TranscriptPageBundleCompileError('invalid-owner');
  }
  if (typeof input.genomeIdentity !== 'string' || input.genomeIdentity.trim().length === 0) {
    throw new TranscriptPageBundleCompileError('invalid-genome-identity');
  }
  if (!Number.isSafeInteger(input.genomeLengthBp) || input.genomeLengthBp <= 0) {
    throw new TranscriptPageBundleCompileError('invalid-genome-length');
  }
  if (input.themeMode !== 'light' && input.themeMode !== 'dark') {
    throw new TranscriptPageBundleCompileError('invalid-theme');
  }
  if (!Number.isFinite(input.annotationBarHeightPx) || input.annotationBarHeightPx <= 0) {
    throw new TranscriptPageBundleCompileError('invalid-bar-height');
  }
  if (!Number.isSafeInteger(input.partitionSpanBp) || input.partitionSpanBp <= 0) {
    throw new TranscriptPageBundleCompileError('invalid-partition-span');
  }
  if (
    input.laneCapacity !== null &&
    (!Number.isSafeInteger(input.laneCapacity) || input.laneCapacity <= 0)
  ) {
    throw new TranscriptPageBundleCompileError('invalid-lane-capacity');
  }
  if (
    typeof input.laneContractIdentity !== 'string' ||
    input.laneContractIdentity.trim().length === 0
  ) {
    throw new TranscriptPageBundleCompileError('invalid-lane-contract');
  }
}
