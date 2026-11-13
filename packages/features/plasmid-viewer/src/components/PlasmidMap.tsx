import { useState, useCallback, useRef, useMemo } from 'react';
import type { ParsedPlasmid, PlasmidFeature, PlasmidMapOptions } from '../types';
import { DEFAULT_MAP_OPTIONS } from '../types';
import { CircularBackbone } from './CircularBackbone';
import { FeatureArc, calculateFeatureLayers } from './FeatureArc';
import { FeatureLabel } from './FeatureLabel';
import { CenterInfo } from './CenterInfo';
import { Tooltip } from './Tooltip';

export interface PlasmidMapProps {
  plasmid: ParsedPlasmid;
  options?: Partial<PlasmidMapOptions>;
  selectedFeature?: PlasmidFeature | null;
  onFeatureSelect?: (feature: PlasmidFeature | null) => void;
  onFeatureHover?: (feature: PlasmidFeature | null) => void;
  className?: string;
  style?: React.CSSProperties;
}

export function PlasmidMap({
  plasmid,
  options: partialOptions,
  selectedFeature,
  onFeatureSelect,
  onFeatureHover,
  className,
  style,
}: PlasmidMapProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoveredFeature, setHoveredFeature] = useState<PlasmidFeature | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const options: PlasmidMapOptions = useMemo(
    () => ({ ...DEFAULT_MAP_OPTIONS, ...partialOptions }),
    [partialOptions]
  );

  const { width, height } = options;
  const centerX = width / 2;
  const centerY = height / 2;

  const featureLayers = useMemo(
    () => calculateFeatureLayers(plasmid.features, plasmid.length),
    [plasmid.features, plasmid.length]
  );

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;

    const rect = svg.getBoundingClientRect();
    setTooltipPos({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  }, []);

  const handleFeatureMouseEnter = useCallback(
    (feature: PlasmidFeature) => {
      setHoveredFeature(feature);
      onFeatureHover?.(feature);
    },
    [onFeatureHover]
  );

  const handleFeatureMouseLeave = useCallback(() => {
    setHoveredFeature(null);
    onFeatureHover?.(null);
  }, [onFeatureHover]);

  const handleFeatureClick = useCallback(
    (feature: PlasmidFeature) => {
      if (selectedFeature === feature) {
        onFeatureSelect?.(null);
      } else {
        onFeatureSelect?.(feature);
      }
    },
    [selectedFeature, onFeatureSelect]
  );

  const handleBackgroundClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === svgRef.current) {
        onFeatureSelect?.(null);
      }
    },
    [onFeatureSelect]
  );

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      style={{
        fontFamily: options.fontFamily,
        userSelect: 'none',
        ...style,
      }}
      onMouseMove={handleMouseMove}
      onClick={handleBackgroundClick}
    >
      {}
      <rect x={0} y={0} width={width} height={height} fill="hsl(var(--color-viewer-bg))" />

      {}
      <CircularBackbone
        length={plasmid.length}
        options={options}
        centerX={centerX}
        centerY={centerY}
      />

      {}
      <g className="features">
        {plasmid.features.map((feature, idx) => (
          <FeatureArc
            key={`${feature.type}-${feature.start}-${feature.end}-${idx}`}
            feature={feature}
            totalLength={plasmid.length}
            options={options}
            centerX={centerX}
            centerY={centerY}
            layer={featureLayers.get(idx) || 0}
            isSelected={selectedFeature === feature}
            isHovered={hoveredFeature === feature}
            onMouseEnter={() => handleFeatureMouseEnter(feature)}
            onMouseLeave={handleFeatureMouseLeave}
            onClick={() => handleFeatureClick(feature)}
          />
        ))}
      </g>

      {}
      <g className="labels">
        {plasmid.features.map((feature, idx) => (
          <FeatureLabel
            key={`label-${feature.type}-${feature.start}-${feature.end}-${idx}`}
            feature={feature}
            totalLength={plasmid.length}
            options={options}
            centerX={centerX}
            centerY={centerY}
            layer={featureLayers.get(idx) || 0}
            isSelected={selectedFeature === feature}
            isHovered={hoveredFeature === feature}
          />
        ))}
      </g>

      {}
      <CenterInfo
        name={plasmid.name}
        length={plasmid.length}
        circular={plasmid.circular}
        options={options}
        centerX={centerX}
        centerY={centerY}
      />

      {}
      <Tooltip
        feature={hoveredFeature}
        x={tooltipPos.x}
        y={tooltipPos.y}
        visible={hoveredFeature !== null}
      />
    </svg>
  );
}
