import type { Feature } from '../../../types';
import {
  validatePrepackedAnnotationSceneMetadata,
  type PrepackedAnnotationSceneLoadInput,
  type PrepackedAnnotationSceneMetadata,
} from './prepacked-annotation-scene';
import {
  TranscriptPageBundleCompileError,
  compileTranscriptPageBundle,
} from './compile-transcript-page-bundle';

export type PrepackedAnnotationSceneCompileErrorCode =
  | 'invalid-owner'
  | 'invalid-metadata'
  | 'missing-local-lane'
  | 'empty-geometry';

export class PrepackedAnnotationSceneCompileError extends Error {
  constructor(readonly code: PrepackedAnnotationSceneCompileErrorCode) {
    super(`Unable to compile prepacked annotation scene: ${code}`);
    this.name = 'PrepackedAnnotationSceneCompileError';
  }
}

export interface CompilePrepackedAnnotationSceneInput {
  readonly ownerKey: string;
  readonly features: readonly Feature[];
  readonly metadata: PrepackedAnnotationSceneMetadata;
}

export function compilePrepackedAnnotationScene(
  input: CompilePrepackedAnnotationSceneInput
): PrepackedAnnotationSceneLoadInput {
  if (typeof input.ownerKey !== 'string' || input.ownerKey.trim().length === 0) {
    throw new PrepackedAnnotationSceneCompileError('invalid-owner');
  }
  if (!validatePrepackedAnnotationSceneMetadata(input.metadata)) {
    throw new PrepackedAnnotationSceneCompileError('invalid-metadata');
  }

  let bundle;
  try {
    bundle = compileTranscriptPageBundle({
      ownerKey: input.ownerKey,
      features: input.features,
      genomeIdentity: input.metadata.genomeIdentity,
      genomeLengthBp: input.metadata.genomeLengthBp,
      themeMode: input.metadata.themeMode,
      annotationBarHeightPx: input.metadata.annotationBarHeightPx,
      partitionSpanBp: input.metadata.partitionSpanBp,
      laneCapacity: null,
      laneContractIdentity: input.metadata.laneAlgorithmToken,
      mode: 'resident-page',
    });
  } catch (error) {
    if (error instanceof TranscriptPageBundleCompileError && error.code === 'missing-local-lane') {
      throw new PrepackedAnnotationSceneCompileError('missing-local-lane');
    }
    throw error;
  }
  if (bundle.status === 'empty') {
    throw new PrepackedAnnotationSceneCompileError('empty-geometry');
  }

  return {
    ownerKey: input.ownerKey,
    scene: {
      primitives: [],
      featureFamilyIndices: new Uint32Array(bundle.featureCount),
      families: [{ id: 'transcript-glyph-v2', kind: 'transcript', metadata: {} }],
    },
    gpuReadyScene: bundle.gpuReadyScene,
    interactionIndex: bundle.interactionIndex,
    metadata: { ...input.metadata },
  };
}
