import {
  positionToAngle,
  angleToPoint,
  calculateTickPositions,
  formatPosition,
} from '../utils/geometry';
import type { PlasmidMapOptions } from '../types';

interface CircularBackboneProps {
  length: number;
  options: PlasmidMapOptions;
  centerX: number;
  centerY: number;
}

export function CircularBackbone({
  length,
  options,
  centerX,
  centerY,
}: CircularBackboneProps): JSX.Element {
  const {
    backboneRadius,
    backboneWidth,
    tickLength,
    tickInterval,
    showTicks,
    fontSize,
    fontFamily,
  } = options;

  const tickPositions = showTicks ? calculateTickPositions(length, tickInterval) : [];

  return (
    <g className="backbone">
      {}
      <circle
        cx={centerX}
        cy={centerY}
        r={backboneRadius}
        fill="none"
        stroke="#374151"
        strokeWidth={backboneWidth}
      />

      {}
      {tickPositions.map((position) => {
        const angle = positionToAngle(position, length);
        const innerPoint = angleToPoint(angle, backboneRadius - tickLength / 2, centerX, centerY);
        const outerPoint = angleToPoint(angle, backboneRadius + tickLength / 2, centerX, centerY);
        const labelPoint = angleToPoint(angle, backboneRadius + tickLength + 12, centerX, centerY);

        const normalizedAngle = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        let textAnchor: 'start' | 'middle' | 'end' = 'middle';
        let dy = '0.35em';

        if (normalizedAngle > 0.3 && normalizedAngle < Math.PI - 0.3) {
          textAnchor = 'start';
        } else if (normalizedAngle > Math.PI + 0.3 && normalizedAngle < 2 * Math.PI - 0.3) {
          textAnchor = 'end';
        }

        if (normalizedAngle < 0.3 || normalizedAngle > 2 * Math.PI - 0.3) {
          dy = '1em';
        } else if (Math.abs(normalizedAngle - Math.PI) < 0.3) {
          dy = '-0.5em';
        }

        return (
          <g key={position}>
            {}
            <line
              x1={innerPoint.x}
              y1={innerPoint.y}
              x2={outerPoint.x}
              y2={outerPoint.y}
              stroke="#6B7280"
              strokeWidth={1}
            />
            {}
            <text
              x={labelPoint.x}
              y={labelPoint.y}
              textAnchor={textAnchor}
              dy={dy}
              fontSize={fontSize - 2}
              fontFamily={fontFamily}
              fill="#6B7280"
            >
              {formatPosition(position)}
            </text>
          </g>
        );
      })}
    </g>
  );
}
