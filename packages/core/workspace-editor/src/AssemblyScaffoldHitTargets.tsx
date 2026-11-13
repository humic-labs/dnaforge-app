import { assemblyScaffoldTooltip } from '@waypoint/sequence-utils';
import type { LinePositions, RulerSegment, WorkspaceEditorConfig } from './types';

export function AssemblyScaffoldHitTargets({
  rulerSegments,
  linePositions,
  sequenceLength,
  config,
  selectedRegionId,
  onSelect,
}: {
  rulerSegments?: RulerSegment[];
  linePositions: LinePositions[];
  sequenceLength: number;
  config: WorkspaceEditorConfig;
  selectedRegionId?: string | null;
  onSelect?: (regionId: string) => void;
}) {
  return (rulerSegments ?? []).flatMap((segment) => {
    if (!segment.scaffold || !segment.regionId) return [];
    const { scaffold, regionId } = segment;
    const spans =
      segment.end > segment.start
        ? [{ start: segment.start, end: segment.end }]
        : [
            { start: segment.start, end: sequenceLength },
            { start: 0, end: segment.end },
          ];
    return linePositions.flatMap(({ line, sequenceY, complementY }, rowIndex) => {
      const rows =
        line.originPosition === undefined
          ? [{ start: line.startPos, length: line.sequence.length, offset: 0 }]
          : [
              { start: line.startPos, length: line.originPosition, offset: 0 },
              {
                start: 0,
                length: line.sequence.length - line.originPosition,
                offset: line.originPosition,
              },
            ];
      return rows.flatMap((row, rowPart) =>
        spans.flatMap((span, spanIndex) => {
          const start = Math.max(row.start, span.start);
          const end = Math.min(row.start + row.length, span.end);
          if (start >= end) return [];
          return [
            <button
              key={`${regionId}-${rowIndex}-${rowPart}-${spanIndex}`}
              type="button"
              data-testid={`assembly-scaffold-${regionId}`}
              title={assemblyScaffoldTooltip(scaffold)}
              aria-label={`Choose ${assemblyScaffoldTooltip(scaffold)}`}
              aria-pressed={selectedRegionId === regionId}
              onClick={() => onSelect?.(regionId)}
              style={{
                position: 'absolute',
                left: config.marginLeft + (row.offset + start - row.start) * config.charWidth,
                top: sequenceY,
                width: (end - start) * config.charWidth,
                height: Math.max(
                  config.rowHeight,
                  (complementY ?? sequenceY) - sequenceY + config.rowHeight
                ),
                border: 0,
                padding: 0,
                background: 'transparent',
                cursor: 'pointer',
              }}
            />,
          ];
        })
      );
    });
  });
}
