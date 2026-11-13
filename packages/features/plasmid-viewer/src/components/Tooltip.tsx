import type { PlasmidFeature } from '../types';

interface TooltipProps {
  feature: PlasmidFeature | null;
  x: number;
  y: number;
  visible: boolean;
}

export function Tooltip({ feature, x, y, visible }: TooltipProps): JSX.Element | null {
  if (!visible || !feature) return null;

  const lines: Array<{ label: string; value: string }> = [
    { label: 'Name', value: feature.displayName },
    { label: 'Type', value: feature.type },
    { label: 'Location', value: `${feature.start}..${feature.end}` },
    { label: 'Length', value: `${feature.end - feature.start + 1} bp` },
  ];

  if (feature.direction !== 'none') {
    lines.push({
      label: 'Direction',
      value: feature.direction === 'forward' ? '→ Forward' : '← Reverse',
    });
  }

  const product = feature.qualifiers.product?.[0];
  if (product) {
    lines.push({ label: 'Product', value: product });
  }

  const gene = feature.qualifiers.gene?.[0];
  if (gene && gene !== feature.displayName) {
    lines.push({ label: 'Gene', value: gene });
  }

  const note = feature.qualifiers.note?.[0];
  if (note) {
    const truncatedNote = note.length > 50 ? note.slice(0, 47) + '...' : note;
    lines.push({ label: 'Note', value: truncatedNote });
  }

  const padding = 10;
  const lineHeight = 18;
  const labelWidth = 70;
  const valueWidth = 150;
  const width = labelWidth + valueWidth + padding * 2;
  const height = lines.length * lineHeight + padding * 2;

  const offsetX = 15;
  const offsetY = 15;

  return (
    <g
      className="tooltip"
      transform={`translate(${x + offsetX}, ${y + offsetY})`}
      style={{ pointerEvents: 'none' }}
    >
      {}
      <rect x={0} y={0} width={width} height={height} rx={6} fill="#1F2937" fillOpacity={0.95} />

      {}
      <rect
        x={0}
        y={0}
        width={width}
        height={height}
        rx={6}
        fill="none"
        stroke="#374151"
        strokeWidth={1}
      />

      {}
      {lines.map((line, i) => (
        <g key={i} transform={`translate(${padding}, ${padding + i * lineHeight + 12})`}>
          <text x={0} y={0} fontSize={11} fontFamily="'Inter', sans-serif" fill="#9CA3AF">
            {line.label}:
          </text>
          <text
            x={labelWidth}
            y={0}
            fontSize={11}
            fontFamily="'Inter', sans-serif"
            fontWeight={500}
            fill="#F9FAFB"
          >
            {line.value}
          </text>
        </g>
      ))}
    </g>
  );
}
