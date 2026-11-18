import { alignmentColumnToLocus, alignmentLocusToColumn } from '@waypoint/genome-data';
import {
  resolveComparisonCamera,
  type ComparisonCamera,
  type ComparisonProjection,
} from '@waypoint/genome-renderer/pure';

type Range = Readonly<{ start: number; end: number }>;

export function comparisonTargetViewport(
  projection: ComparisonProjection,
  input: ComparisonCamera
): Range | null {
  const camera = resolveComparisonCamera(projection, input);
  const positions: number[] = [];
  for (const entry of projection.layout.entries) {
    const first = Math.max(entry.columnStart, Math.floor(camera.startColumn));
    const last = Math.min(entry.columnEnd - 1, Math.ceil(camera.endColumn) - 1);
    if (last < first) continue;
    if (entry.kind === 'unaligned-join') {
      if (entry.targetGap) positions.push(entry.targetGap.start, entry.targetGap.end - 1);
      continue;
    }
    for (const column of [first, last]) {
      const locus = alignmentColumnToLocus(entry.block, 'target', column - entry.columnStart);
      if (locus?.kind === 'base') positions.push(locus.position);
      else if (locus?.kind === 'gap')
        positions.push(Math.min(projection.comparison.target.length - 1, locus.boundary));
    }
  }
  return positions.length
    ? { start: Math.min(...positions), end: Math.max(...positions) + 1 }
    : null;
}

export function comparisonCameraForTargetViewport(
  projection: ComparisonProjection,
  range: Range
): ComparisonCamera | null {
  const columns: number[] = [];
  for (const entry of projection.layout.entries) {
    const interval = entry.kind === 'block' ? entry.block.target : entry.targetGap;
    if (!interval) continue;
    const first = Math.max(interval.start, Math.floor(range.start));
    const last = Math.min(interval.end - 1, Math.ceil(range.end) - 1);
    if (last < first) continue;
    if (entry.kind === 'unaligned-join') {
      columns.push(entry.columnStart, entry.columnEnd - 1);
      continue;
    }
    for (const position of [first, last]) {
      const column = alignmentLocusToColumn(entry.block, 'target', position);
      if (column !== null) columns.push(entry.columnStart + column);
    }
  }
  return columns.length
    ? resolveComparisonCamera(projection, {
        projectionId: projection.id,
        startColumn: Math.min(...columns),
        endColumn: Math.max(...columns) + 1,
      })
    : null;
}
