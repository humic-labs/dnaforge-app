'use client';

import { LengthControl } from './LengthControl';
import {
  computeGibsonSegments,
  reverseString,
  PRIMER_SVG_CONSTANTS,
  PRIMER_PADDING,
  buildPbsPath,
  buildHorizontalBordersPath,
  type GibsonPrimerInput,
} from './computeSegments';
import type { PrimerColors } from './types';

export interface GibsonPrimerRowProps {
  name: string;
  direction: 'forward' | 'reverse';
  overhangSequence: string;
  spacerSequence: string;
  pbsSequence: string;
  overhangLength: number;
  pbsLength: number;
  tm?: number;
  colors: PrimerColors;
  onUpdateOverhang?: (length: number) => void;
  onUpdatePbs?: (length: number) => void;
  nameWidthClass?: string;
  tmWidthClass?: string;
  alignOffset?: number;
  svgWidth?: number;
}

export function GibsonPrimerRow({
  name,
  direction,
  overhangSequence,
  spacerSequence,
  pbsSequence,
  nameWidthClass = 'w-14',
  tmWidthClass = 'w-12',
  overhangLength,
  pbsLength,
  tm,
  colors,
  onUpdateOverhang,
  onUpdatePbs,
  alignOffset = 0,
  svgWidth,
}: GibsonPrimerRowProps) {
  const {
    BOX_HEIGHT: boxHeight,
    ARROW_HEIGHT: arrowHeight,
    ARROW_WIDTH: arrowWidth,
    STROKE_WIDTH: strokeWidth,
    DASH_ARRAY: dashArray,
  } = PRIMER_SVG_CONSTANTS;
  const padding = PRIMER_PADDING.GIBSON;

  const input: GibsonPrimerInput = {
    direction,
    overhangSequence,
    spacerSequence,
    pbsSequence,
  };
  const segments = computeGibsonSegments(input);

  const isForward = direction === 'forward';

  const computedSvgWidth = svgWidth ?? segments.totalWidth + alignOffset;

  const getPbsPathConfig = (
    x: number,
    width: number,
    dir: 'forward' | 'reverse',
    hasAdjacent: boolean,
    forFill: boolean
  ) => ({
    x,
    y: 0,
    width,
    height: boxHeight,
    arrowHeight,
    arrowWidth,
    direction: dir,
    closePath: forFill,
    hasAdjacentRegion: forFill ? false : hasAdjacent,
  });

  const buildHomologyBorderPath = (
    x: number,
    width: number,
    dir: 'forward' | 'reverse'
  ): string => {
    if (dir === 'forward') {
      return `M ${x} ${boxHeight} L ${x} 0 L ${x + width} 0 M ${x + width} ${boxHeight} L ${x} ${boxHeight}`;
    } else {
      return `M ${x + width} 0 L ${x + width} ${boxHeight} L ${x} ${boxHeight} M ${x} 0 L ${x + width} 0`;
    }
  };

  return (
    <div className="flex items-center gap-2 py-0.5">
      {}
      <div className="flex items-center gap-2 text-xs shrink-0 sticky left-0 bg-bg-subtle z-10 pr-1">
        <span className={`font-medium ${nameWidthClass} ${colors.pbs.text}`}>{name}</span>
        {onUpdateOverhang && (
          <LengthControl
            label="OH"
            value={overhangLength}
            min={0}
            max={60}
            colorClass={colors.overhang.text}
            onChange={onUpdateOverhang}
            hideLabel
          />
        )}
        {onUpdatePbs && (
          <LengthControl
            label="PBS"
            value={pbsLength}
            min={10}
            max={500}
            colorClass={colors.pbs.text}
            onChange={onUpdatePbs}
            hideLabel
          />
        )}
        <span className={`text-fg-muted ${tmWidthClass} text-center`}>{tm?.toFixed(1) ?? '—'}</span>
        {}
        <span className="text-xs text-fg-muted font-mono">{isForward ? "5'" : "3'"}</span>
      </div>

      {}
      <div className="flex items-center">
        {isForward ? (
          <svg
            width={computedSvgWidth}
            height={boxHeight}
            className="flex-shrink-0"
            style={{ overflow: 'visible' }}
          >
            {}
            {segments.homology && (
              <g>
                <rect
                  x={alignOffset}
                  y={0}
                  width={segments.homology.width}
                  height={boxHeight}
                  fill={colors.overhang.hex}
                  fillOpacity={0.25}
                />
                <path
                  d={buildHomologyBorderPath(alignOffset, segments.homology.width, 'forward')}
                  fill="none"
                  stroke={colors.overhang.hex}
                  strokeWidth={strokeWidth}
                  strokeDasharray={dashArray}
                />
              </g>
            )}
            {}
            {segments.spacer && (
              <g>
                <rect
                  x={alignOffset + (segments.homology?.width ?? 0)}
                  y={0}
                  width={segments.spacer.width}
                  height={boxHeight}
                  fill="#6B7280"
                  fillOpacity={0.15}
                />
                <path
                  d={buildHorizontalBordersPath(
                    alignOffset + (segments.homology?.width ?? 0),
                    0,
                    segments.spacer.width,
                    boxHeight
                  )}
                  fill="none"
                  stroke="#6B7280"
                  strokeWidth={strokeWidth}
                  strokeDasharray={dashArray}
                />
              </g>
            )}
            {}
            {(() => {
              const pbsX =
                alignOffset + (segments.homology?.width ?? 0) + (segments.spacer?.width ?? 0);
              const hasAdjacent = overhangLength > 0;
              return (
                <g>
                  <path
                    d={buildPbsPath(
                      getPbsPathConfig(pbsX, segments.pbs.width, 'forward', hasAdjacent, true)
                    )}
                    fill={colors.pbs.hex}
                    fillOpacity={0.2}
                  />
                  <path
                    d={buildPbsPath(
                      getPbsPathConfig(pbsX, segments.pbs.width, 'forward', hasAdjacent, false)
                    )}
                    fill="none"
                    stroke={colors.pbs.hex}
                    strokeWidth={strokeWidth}
                    strokeLinejoin="round"
                  />
                </g>
              );
            })()}
            {}
            <text
              x={alignOffset + padding}
              y={boxHeight / 2}
              dy="0.35em"
              fontSize="11"
              fontFamily="ui-monospace, monospace"
            >
              {segments.homology && (
                <tspan fill={colors.overhang.hex} textLength={segments.homology.width - padding}>
                  {segments.homology.sequence}
                </tspan>
              )}
              {segments.spacer && (
                <tspan fill="#6B7280" textLength={segments.spacer.width}>
                  {segments.spacer.sequence}
                </tspan>
              )}
              <tspan fill={colors.pbs.hex} textLength={segments.pbs.width - padding}>
                {pbsSequence}
              </tspan>
            </text>
          </svg>
        ) : (
          <svg
            width={computedSvgWidth}
            height={boxHeight}
            className="block"
            style={{ overflow: 'visible' }}
          >
            {}
            {(() => {
              const hasAdjacent = overhangLength > 0;
              return (
                <g>
                  <path
                    d={buildPbsPath(
                      getPbsPathConfig(
                        alignOffset,
                        segments.pbs.width,
                        'reverse',
                        hasAdjacent,
                        true
                      )
                    )}
                    fill={colors.pbs.hex}
                    fillOpacity={0.2}
                  />
                  <path
                    d={buildPbsPath(
                      getPbsPathConfig(
                        alignOffset,
                        segments.pbs.width,
                        'reverse',
                        hasAdjacent,
                        false
                      )
                    )}
                    fill="none"
                    stroke={colors.pbs.hex}
                    strokeWidth={strokeWidth}
                    strokeLinejoin="round"
                  />
                </g>
              );
            })()}
            {}
            {segments.spacer && (
              <g>
                <rect
                  x={alignOffset + segments.pbs.width}
                  y={0}
                  width={segments.spacer.width}
                  height={boxHeight}
                  fill="#6B7280"
                  fillOpacity={0.15}
                />
                <path
                  d={buildHorizontalBordersPath(
                    alignOffset + segments.pbs.width,
                    0,
                    segments.spacer.width,
                    boxHeight
                  )}
                  fill="none"
                  stroke="#6B7280"
                  strokeWidth={strokeWidth}
                  strokeDasharray={dashArray}
                />
              </g>
            )}
            {}
            {segments.homology && (
              <g>
                <rect
                  x={alignOffset + segments.pbs.width + (segments.spacer?.width ?? 0)}
                  y={0}
                  width={segments.homology.width}
                  height={boxHeight}
                  fill={colors.overhang.hex}
                  fillOpacity={0.25}
                />
                <path
                  d={buildHomologyBorderPath(
                    alignOffset + segments.pbs.width + (segments.spacer?.width ?? 0),
                    segments.homology.width,
                    'reverse'
                  )}
                  fill="none"
                  stroke={colors.overhang.hex}
                  strokeWidth={strokeWidth}
                  strokeDasharray={dashArray}
                />
              </g>
            )}
            {}
            <text
              x={alignOffset + padding}
              y={boxHeight / 2}
              dy="0.35em"
              fontSize="11"
              fontFamily="ui-monospace, monospace"
            >
              <tspan fill={colors.pbs.hex} textLength={segments.pbs.width - padding}>
                {reverseString(pbsSequence)}
              </tspan>
              {segments.spacer && (
                <tspan fill="#6B7280" textLength={segments.spacer.width}>
                  {reverseString(segments.spacer.sequence)}
                </tspan>
              )}
              {segments.homology && (
                <tspan fill={colors.overhang.hex} textLength={segments.homology.width - padding}>
                  {reverseString(segments.homology.sequence)}
                </tspan>
              )}
            </text>
          </svg>
        )}
        {}
        <span className="text-xs text-fg-muted font-mono ml-1">{isForward ? "3'" : "5'"}</span>
      </div>
    </div>
  );
}
