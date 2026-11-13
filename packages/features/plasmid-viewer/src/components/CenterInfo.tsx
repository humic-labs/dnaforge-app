import type { PlasmidMapOptions } from '../types';

interface CenterInfoProps {
  name: string;
  length: number;
  circular: boolean;
  options: PlasmidMapOptions;
  centerX: number;
  centerY: number;
}

export function CenterInfo({
  name,
  length,
  circular,
  options,
  centerX,
  centerY,
}: CenterInfoProps): JSX.Element {
  const { fontFamily } = options;

  const formattedLength =
    length >= 1000 ? `${(length / 1000).toFixed(length % 1000 === 0 ? 0 : 1)} kb` : `${length} bp`;

  const maxNameLength = 20;
  const displayName = name.length > maxNameLength ? name.slice(0, maxNameLength - 1) + '…' : name;

  return (
    <g className="center-info">
      {}
      <text
        x={centerX}
        y={centerY - 12}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={16}
        fontFamily={fontFamily}
        fontWeight={600}
        fill="#1F2937"
      >
        {displayName}
      </text>

      {}
      <text
        x={centerX}
        y={centerY + 10}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={13}
        fontFamily={fontFamily}
        fontWeight={400}
        fill="#6B7280"
      >
        {formattedLength}
      </text>

      {}
      <text
        x={centerX}
        y={centerY + 28}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={10}
        fontFamily={fontFamily}
        fontWeight={400}
        fill="#9CA3AF"
      >
        {circular ? 'circular' : 'linear'}
      </text>
    </g>
  );
}
