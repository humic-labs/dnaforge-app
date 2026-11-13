import { positionToAngle, getLabelPosition } from '../utils/geometry';
import type { PlasmidFeature, PlasmidMapOptions } from '../types';

interface FeatureLabelProps {
  feature: PlasmidFeature;
  totalLength: number;
  options: PlasmidMapOptions;
  centerX: number;
  centerY: number;
  layer: number;
  isSelected: boolean;
  isHovered: boolean;
}

export function FeatureLabel({
  feature,
  totalLength,
  options,
  centerX,
  centerY,
  layer,
  isSelected,
  isHovered,
}: FeatureLabelProps): JSX.Element | null {
  const { backboneRadius, featureWidth, fontSize, fontFamily, showLabels } = options;

  if (!showLabels) return null;

  const layerOffset = layer * (featureWidth + 4);
  const labelRadius = backboneRadius + 8 + layerOffset + featureWidth + 5;

  const startAngle = positionToAngle(feature.start, totalLength);
  const endAngle = positionToAngle(feature.end, totalLength);

  const { x, y, anchor } = getLabelPosition(startAngle, endAngle, labelRadius, centerX, centerY, 8);

  const maxLength = 15;
  const label =
    feature.displayName.length > maxLength
      ? feature.displayName.slice(0, maxLength - 1) + '…'
      : feature.displayName;

  const adjustedAnchor = anchor;

  const fontWeight = isSelected || isHovered ? 600 : 400;
  const fillColor = isSelected ? '#1F2937' : isHovered ? '#374151' : '#6B7280';

  return (
    <text
      x={x}
      y={y}
      textAnchor={adjustedAnchor}
      dominantBaseline="middle"
      fontSize={fontSize}
      fontFamily={fontFamily}
      fontWeight={fontWeight}
      fill={fillColor}
      style={{ pointerEvents: 'none' }}
    >
      {label}
    </text>
  );
}
