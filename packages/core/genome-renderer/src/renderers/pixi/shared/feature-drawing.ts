import type { Feature } from '../../../types';
import { LODTier } from '../../../types';
import { computeLODTier } from '../../../geometry/lod';
import { truncateLabel } from './label-utils';
import { ARROW_MAX_WIDTH } from './theme';

const MIN_BAR_FOR_ARROW = 16;
const CHAR_WIDTH = 6.5;

export interface FeatureDrawDecision {
  visible: boolean;
  tier: LODTier;
  featureLen: number;
  pixelWidth: number;
  isCDS: boolean;
  hasArrow: boolean;
  arrowWidth: number;
  labelText: string | null;
  labelPlacement: 'internal' | 'external' | 'none';
  alpha: number;
}

export function computeFeatureDrawDecision(
  feature: Feature,
  genomeLength: number,
  visibleBp: number,
  circumferencePixels: number,
  isHovered: boolean,
  isSelected: boolean
): FeatureDrawDecision {
  const featureLen =
    feature.end > feature.start
      ? feature.end - feature.start
      : genomeLength - feature.start + feature.end;

  const tier = computeLODTier(featureLen, visibleBp, circumferencePixels);
  if (tier === LODTier.Hidden) {
    return {
      visible: false,
      tier,
      featureLen,
      pixelWidth: 0,
      isCDS: false,
      hasArrow: false,
      arrowWidth: 0,
      labelText: null,
      labelPlacement: 'none',
      alpha: 0,
    };
  }

  const pixelWidth = (featureLen / visibleBp) * circumferencePixels;
  const isCDS = feature.type === 'CDS';
  const alpha = isHovered ? 1.0 : isSelected ? 0.95 : 0.8;

  const hasArrow = feature.direction !== 'none' && pixelWidth > MIN_BAR_FOR_ARROW;
  const arrowWidth = hasArrow ? Math.min(ARROW_MAX_WIDTH, pixelWidth * (isCDS ? 0.2 : 0.3)) : 0;

  let labelText: string | null = null;
  let labelPlacement: 'internal' | 'external' | 'none' = 'none';

  if (tier >= LODTier.Detailed && feature.displayName) {
    const availablePx = isCDS ? pixelWidth * 0.8 : pixelWidth - 6;
    const truncated = truncateLabel(feature.displayName, availablePx, CHAR_WIDTH);
    if (truncated) {
      labelText = truncated;
      labelPlacement = 'internal';
    } else if (feature.displayName.length >= 3 && pixelWidth > 6) {
      labelText = feature.displayName;
      labelPlacement = 'external';
    }
  }

  return {
    visible: true,
    tier,
    featureLen,
    pixelWidth,
    isCDS,
    hasArrow,
    arrowWidth,
    labelText,
    labelPlacement,
    alpha,
  };
}

export function cdsLabelBlockWidth(displayText: string, pixelWidth: number): number {
  return Math.min(pixelWidth * 0.9, displayText.length * CHAR_WIDTH + 8);
}
