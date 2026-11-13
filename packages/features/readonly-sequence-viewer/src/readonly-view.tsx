import { useMemo } from 'react';
import type { ReadonlyRenderablePlasmid } from './types';
import type { PlasmidFeature } from './types';
import { getFeatureColor } from './types';
import {
  createFilledArcWithArrow,
  createStadiumBackbonePath,
  getFeatureLabelPosition,
  getStadiumDimensions,
} from './stadium';

export type ReadonlyPlasmidView = 'linear' | 'stadium';

export interface ReadonlyPlasmidViewerProps {
  plasmid: ReadonlyRenderablePlasmid;
  view: ReadonlyPlasmidView;
  className?: string;
}

interface FeaturePlacement {
  feature: PlasmidFeature;
  lane: number;
  index: number;
}

const LINEAR_WIDTH = 960;
const LINEAR_PADDING = 56;
const LINEAR_BACKBONE_Y = 92;
const STADIUM_WIDTH = 900;
const STADIUM_HEIGHT = 360;
const STADIUM_PADDING = 58;
const BACKBONE_STROKE = 'var(--dnaforge-readonly-backbone, #4f6657)';
const MUTED_FILL = 'var(--dnaforge-readonly-muted, #718470)';
const TEXT_FILL = 'var(--dnaforge-readonly-text, #17251d)';

export function ReadonlyPlasmidViewer({
  plasmid,
  view,
  className,
}: ReadonlyPlasmidViewerProps): JSX.Element {
  const annotations = useMemo<PlasmidFeature[]>(
    () => [
      ...plasmid.features,
      ...plasmid.primers.map((primer) => ({
        type: 'primer_bind',
        start: primer.start + 1,
        end: primer.end,
        direction: primer.direction,
        displayName: primer.name,
        color: primer.pbsColor ?? getFeatureColor('primer_bind'),
        qualifiers: { label: [primer.name] },
      })),
    ],
    [plasmid.features, plasmid.primers]
  );
  const placements = useMemo(
    () => placeFeatures(annotations, plasmid.length),
    [annotations, plasmid.length]
  );
  const accessibleName = `${plasmid.name}, ${plasmid.length.toLocaleString('en-US')} base pairs, ${annotations.length} annotations`;

  return (
    <section
      className={className}
      data-testid="readonly-plasmid-viewer"
      data-view={view}
      aria-label={accessibleName}
    >
      {view === 'linear' ? (
        <LinearMap plasmid={plasmid} placements={placements} />
      ) : (
        <StadiumMap plasmid={plasmid} placements={placements} />
      )}
    </section>
  );
}

function LinearMap({
  plasmid,
  placements,
}: {
  plasmid: ReadonlyRenderablePlasmid;
  placements: FeaturePlacement[];
}): JSX.Element {
  const laneCount = Math.max(1, ...placements.map(({ lane }) => lane + 1));
  const height = LINEAR_BACKBONE_Y + laneCount * 28 + 70;
  const usableWidth = LINEAR_WIDTH - LINEAR_PADDING * 2;
  const xForBase = (base: number): number =>
    LINEAR_PADDING + (Math.max(0, Math.min(plasmid.length, base)) / plasmid.length) * usableWidth;

  return (
    <svg
      className="readonly-plasmid-map readonly-plasmid-map--linear"
      viewBox={`0 0 ${LINEAR_WIDTH} ${height}`}
      width="100%"
      role="img"
      aria-label={`Linear annotation map for ${plasmid.name}`}
    >
      <title>{`Linear annotation map for ${plasmid.name}`}</title>
      <line
        className="readonly-plasmid-backbone"
        x1={LINEAR_PADDING}
        x2={LINEAR_WIDTH - LINEAR_PADDING}
        y1={LINEAR_BACKBONE_Y}
        y2={LINEAR_BACKBONE_Y}
        stroke={BACKBONE_STROKE}
        strokeWidth={3}
      />
      {tickPositions(plasmid.length).map((position) => {
        const x = xForBase(position);
        return (
          <g key={position} className="readonly-plasmid-tick">
            <line
              x1={x}
              x2={x}
              y1={LINEAR_BACKBONE_Y - 7}
              y2={LINEAR_BACKBONE_Y + 7}
              stroke={MUTED_FILL}
            />
            <text
              x={x}
              y={LINEAR_BACKBONE_Y - 15}
              textAnchor="middle"
              fill={MUTED_FILL}
              fontSize={12}
            >
              {formatBasePosition(position)}
            </text>
          </g>
        );
      })}
      {placements.flatMap(({ feature, lane, index }) =>
        linearFeatureSegments(feature, plasmid.length).map((segment, segmentIndex) => {
          const x = xForBase(segment.start);
          const width = Math.max(2, xForBase(segment.end) - x);
          const y = LINEAR_BACKBONE_Y + 18 + lane * 28;
          return (
            <g
              key={`${index}-${segmentIndex}`}
              data-testid="readonly-plasmid-feature"
              data-feature-index={index}
              data-feature-name={feature.displayName}
              data-feature-type={feature.type}
              data-feature-start={feature.start}
              data-feature-end={feature.end}
              data-feature-direction={feature.direction}
            >
              <rect
                className="readonly-plasmid-feature"
                x={x}
                y={y}
                width={width}
                height={16}
                rx={3}
                fill={feature.color}
                opacity={0.86}
              />
              {width >= 52 && (
                <text
                  className="readonly-plasmid-feature-label"
                  x={x + width / 2}
                  y={y + 12}
                  textAnchor="middle"
                  fill={TEXT_FILL}
                  fontSize={10}
                  pointerEvents="none"
                >
                  {feature.displayName}
                </text>
              )}
            </g>
          );
        })
      )}
      <MapIdentity plasmid={plasmid} x={LINEAR_PADDING} titleAnchor="start" />
    </svg>
  );
}

function StadiumMap({
  plasmid,
  placements,
}: {
  plasmid: ReadonlyRenderablePlasmid;
  placements: FeaturePlacement[];
}): JSX.Element {
  const dimensions = getStadiumDimensions(
    STADIUM_WIDTH - STADIUM_PADDING * 2,
    210,
    plasmid.circular ? 0.15 : 0
  );
  const centerX = STADIUM_PADDING + dimensions.width / 2;
  const centerY = STADIUM_PADDING + dimensions.height / 2;

  return (
    <svg
      className="readonly-plasmid-map readonly-plasmid-map--stadium"
      viewBox={`0 0 ${STADIUM_WIDTH} ${STADIUM_HEIGHT}`}
      width="100%"
      role="img"
      aria-label={`Stadium annotation map for ${plasmid.name}`}
    >
      <title>{`Stadium annotation map for ${plasmid.name}`}</title>
      <path
        className="readonly-plasmid-backbone"
        d={createStadiumBackbonePath(dimensions, STADIUM_PADDING)}
        fill="none"
        stroke={BACKBONE_STROKE}
        strokeWidth={3}
      />
      {placements.map(({ feature, lane, index }) => {
        const start = Math.max(0, feature.start - 1);
        const end = Math.max(0, feature.end);
        const arcOffset = -12 - lane * 11;
        const label = getFeatureLabelPosition(
          start,
          end,
          plasmid.length,
          0,
          dimensions,
          STADIUM_PADDING,
          arcOffset,
          13
        );
        const featureSpan = featureSpanLength(feature, plasmid.length);
        return (
          <g
            key={`${feature.type}-${feature.start}-${feature.end}-${index}`}
            data-testid="readonly-plasmid-feature"
            data-feature-index={index}
            data-feature-name={feature.displayName}
            data-feature-type={feature.type}
            data-feature-start={feature.start}
            data-feature-end={feature.end}
            data-feature-direction={feature.direction}
          >
            <path
              className="readonly-plasmid-feature"
              d={createFilledArcWithArrow(
                start,
                end,
                plasmid.length,
                0,
                dimensions,
                STADIUM_PADDING,
                arcOffset,
                9,
                feature.direction,
                4,
                8
              )}
              fill={feature.color}
              opacity={0.86}
            />
            {featureSpan >= Math.max(80, plasmid.length * 0.035) && (
              <text
                className="readonly-plasmid-feature-label readonly-plasmid-feature-label--stadium"
                x={label.x}
                y={label.y}
                textAnchor="middle"
                fill={TEXT_FILL}
                fontSize={9}
                pointerEvents="none"
              >
                {feature.displayName}
              </text>
            )}
          </g>
        );
      })}
      <MapIdentity
        plasmid={plasmid}
        x={centerX}
        titleAnchor="middle"
        titleY={centerY - 5}
        subtitleY={centerY + 20}
        subtitle={`${plasmid.length.toLocaleString('en-US')} bp · ${plasmid.circular ? 'circular' : 'linear'}`}
      />
    </svg>
  );
}

function MapIdentity({
  plasmid,
  x,
  titleAnchor,
  titleY = 38,
  subtitleY = 60,
  subtitle = `${plasmid.length.toLocaleString('en-US')} bp · ${plasmid.features.length + plasmid.primers.length} annotations`,
}: {
  plasmid: ReadonlyRenderablePlasmid;
  x: number;
  titleAnchor: 'start' | 'middle';
  titleY?: number;
  subtitleY?: number;
  subtitle?: string;
}): JSX.Element {
  return (
    <>
      <text
        className="readonly-plasmid-map-title"
        x={x}
        y={titleY}
        textAnchor={titleAnchor}
        fill={TEXT_FILL}
        fontSize={20}
        fontWeight={700}
      >
        {plasmid.name}
      </text>
      <text
        className="readonly-plasmid-map-subtitle"
        x={x}
        y={subtitleY}
        textAnchor={titleAnchor}
        fill={MUTED_FILL}
        fontSize={12}
      >
        {subtitle}
      </text>
    </>
  );
}

function placeFeatures(features: PlasmidFeature[], sequenceLength: number): FeaturePlacement[] {
  const laneEnds: number[] = [];
  return features
    .map((feature, index) => ({ feature, index }))
    .sort((left, right) => left.feature.start - right.feature.start)
    .map(({ feature, index }) => {
      const start = Math.max(0, feature.start - 1);
      const end = start + featureSpanLength(feature, sequenceLength);
      let lane = laneEnds.findIndex((laneEnd) => laneEnd < start);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = end;
      return { feature, lane, index };
    });
}

function linearFeatureSegments(
  feature: PlasmidFeature,
  sequenceLength: number
): Array<{ start: number; end: number }> {
  const start = Math.max(0, feature.start - 1);
  const end = Math.max(0, feature.end);
  return end >= start
    ? [{ start, end }]
    : [
        { start, end: sequenceLength },
        { start: 0, end },
      ];
}

function featureSpanLength(feature: PlasmidFeature, sequenceLength: number): number {
  const start = Math.max(0, feature.start - 1);
  const end = Math.max(0, feature.end);
  return end >= start ? end - start : sequenceLength - start + end;
}

function tickPositions(sequenceLength: number): number[] {
  return [0, 0.25, 0.5, 0.75, 1].map((fraction) => Math.round(sequenceLength * fraction));
}

function formatBasePosition(position: number): string {
  return position >= 1_000
    ? `${(position / 1_000).toFixed(position % 1_000 === 0 ? 0 : 1)} kb`
    : `${position} bp`;
}
