import { positionToAngle, createArcPath, createArrowPath } from '../utils/geometry';
import type { PlasmidFeature, PlasmidMapOptions } from '../types';

interface FeatureArcProps {
  feature: PlasmidFeature;
  totalLength: number;
  options: PlasmidMapOptions;
  centerX: number;
  centerY: number;
  layer: number;
  isSelected: boolean;
  isHovered: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClick: () => void;
}

export function FeatureArc({
  feature,
  totalLength,
  options,
  centerX,
  centerY,
  layer,
  isSelected,
  isHovered,
  onMouseEnter,
  onMouseLeave,
  onClick,
}: FeatureArcProps): JSX.Element {
  const { backboneRadius, featureWidth } = options;

  const layerOffset = layer * (featureWidth + 4);
  const innerRadius = backboneRadius + 8 + layerOffset;
  const outerRadius = innerRadius + featureWidth;

  const startAngle = positionToAngle(feature.start, totalLength);
  const endAngle = positionToAngle(feature.end, totalLength);

  const arcPath = createArcPath(startAngle, endAngle, innerRadius, outerRadius, centerX, centerY);

  const showArrow = feature.direction !== 'none';
  const arrowAngle = feature.direction === 'forward' ? endAngle : startAngle;
  const arrowRadius = (innerRadius + outerRadius) / 2;
  const arrowPath = showArrow
    ? createArrowPath(
        arrowAngle,
        arrowRadius,
        centerX,
        centerY,
        8,
        feature.direction as 'forward' | 'reverse'
      )
    : null;

  const fillOpacity = isHovered ? 0.9 : isSelected ? 0.95 : 0.8;
  const strokeWidth = isSelected ? 2 : isHovered ? 1.5 : 0;
  const strokeColor = isSelected ? '#1F2937' : '#374151';

  return (
    <g
      className="feature-arc"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      style={{ cursor: 'pointer' }}
    >
      {}
      <path
        d={arcPath}
        fill={feature.color}
        fillOpacity={fillOpacity}
        stroke={strokeWidth > 0 ? strokeColor : 'none'}
        strokeWidth={strokeWidth}
      />

      {}
      {arrowPath && <path d={arrowPath} fill="#fff" fillOpacity={0.9} pointerEvents="none" />}

      {}
      {isSelected && (
        <path
          d={arcPath}
          fill="none"
          stroke="#3B82F6"
          strokeWidth={3}
          strokeOpacity={0.5}
          pointerEvents="none"
        />
      )}
    </g>
  );
}

export function calculateFeatureLayers(
  features: PlasmidFeature[],
  totalLength: number
): Map<number, number> {
  const layers = new Map<number, number>();
  const layerEnds: number[] = [];

  const sortedIndices = features
    .map((_, i) => i)
    .sort((a, b) => features[a].start - features[b].start);

  for (const idx of sortedIndices) {
    const feature = features[idx];
    const start = feature.start;
    const end = feature.end > feature.start ? feature.end : feature.end + totalLength;

    let assignedLayer = 0;
    for (let layer = 0; layer < layerEnds.length; layer++) {
      if (layerEnds[layer] < start) {
        assignedLayer = layer;
        break;
      }
      assignedLayer = layer + 1;
    }

    layers.set(idx, assignedLayer);
    if (assignedLayer >= layerEnds.length) {
      layerEnds.push(end);
    } else {
      layerEnds[assignedLayer] = end;
    }
  }

  return layers;
}
