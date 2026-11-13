import { overviewLodThresholds } from './annotation-lod-policy';

export const LARGE_GENOME_TEXT_LOD_LENGTH_BP = 100_000;

export const ASSEMBLY_SCALE_TEXT_LOD_LENGTH_BP = 50_000_000;

export const LARGE_GENOME_SEQUENCE_TEXT_MIN_PIXELS_PER_BP_AFTER_REVEAL = 0;

export interface FeatureTextLodInputs {
  sequenceVisible: boolean;
  genomeLength: number;
  pixelsPerBp: number;
  isArcMode?: boolean;
}

export function shouldRenderFeatureTextAtLod({
  sequenceVisible,
  genomeLength,
  pixelsPerBp,
  isArcMode = false,
}: FeatureTextLodInputs): boolean {
  if (
    isArcMode &&
    genomeLength >= ASSEMBLY_SCALE_TEXT_LOD_LENGTH_BP &&
    pixelsPerBp < overviewLodThresholds().fullShapePixelsPerBp
  ) {
    return false;
  }
  if (genomeLength < LARGE_GENOME_TEXT_LOD_LENGTH_BP) return true;
  if (!sequenceVisible) return true;
  return pixelsPerBp >= LARGE_GENOME_SEQUENCE_TEXT_MIN_PIXELS_PER_BP_AFTER_REVEAL;
}
