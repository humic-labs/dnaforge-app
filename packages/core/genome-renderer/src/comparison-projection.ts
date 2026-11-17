import {
  alignmentColumnToLocus,
  alignmentLocusToColumn,
  buildGenomeComparisonLayout,
  type GenomeComparison,
  type GenomeComparisonColumnLocus,
  type GenomeComparisonLayout,
  type GenomeComparisonSide,
} from '@waypoint/genome-data';

export interface ComparisonAnnotation {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly label: string;
  readonly color?: string;
  readonly strand?: '+' | '-';
}

export interface ComparisonProjection {
  readonly kind: 'aligned-comparison';
  readonly id: string;
  readonly comparison: GenomeComparison;
  readonly layout: GenomeComparisonLayout;
  readonly targetLabel?: string;
  readonly queryLabel?: string;
  readonly targetSequence?: string;
  readonly querySequence?: string;
  readonly annotations?: Readonly<{
    target?: readonly ComparisonAnnotation[];
    query?: readonly ComparisonAnnotation[];
  }>;
}

export interface ComparisonCamera {
  readonly projectionId: string;
  readonly startColumn: number;
  readonly endColumn: number;
}

export type ComparisonLocus =
  | GenomeComparisonColumnLocus
  | {
      readonly kind: 'unaligned';
      readonly referenceId: string;
      readonly reason: 'unaligned' | 'overlap' | 'rearrangement';
      readonly interval: Readonly<{ start: number; end: number }> | null;
    };

export interface ComparisonHit {
  readonly projectionId: string;
  readonly column: number;
  readonly side: GenomeComparisonSide | 'link';
  readonly blockId: string | null;
  readonly target: ComparisonLocus;
  readonly query: ComparisonLocus;
  readonly strand: '+' | '-' | null;
  readonly mappingQuality: number | null;
}

export interface ComparisonPlot {
  readonly x: number;
  readonly width: number;
  readonly targetY: number;
  readonly queryY: number;
  readonly rowHeight: number;
}

export function createComparisonProjection(
  input: Omit<ComparisonProjection, 'kind' | 'layout'>
): ComparisonProjection {
  if (!input.id.trim() || input.comparison.blocks.length === 0)
    throw new Error('An aligned comparison needs an identity and exact alignment blocks.');
  for (const side of ['target', 'query'] as const) {
    const reference = input.comparison[side];
    if (!reference.id || !Number.isSafeInteger(reference.length) || reference.length < 1)
      throw new Error('A comparison reference needs an exact identity and length.');
    for (const block of input.comparison.blocks) {
      if (block[side].referenceId !== reference.id || block[side].end > reference.length)
        throw new Error('Comparison blocks must belong to their exact reference.');
    }
    const sequence = side === 'target' ? input.targetSequence : input.querySequence;
    if (sequence !== undefined && sequence.length !== reference.length)
      throw new Error('Comparison sequence bases do not match their exact reference length.');
    const ids = new Set<string>();
    for (const annotation of input.annotations?.[side] ?? []) {
      if (
        !annotation.id ||
        ids.has(annotation.id) ||
        !Number.isSafeInteger(annotation.start) ||
        !Number.isSafeInteger(annotation.end) ||
        annotation.start < 0 ||
        annotation.end <= annotation.start ||
        annotation.end > reference.length
      )
        throw new Error('Comparison annotation coordinates or identities are invalid.');
      ids.add(annotation.id);
      if (annotation.color !== undefined && !/^#[0-9a-f]{6}$/iu.test(annotation.color))
        throw new Error('A comparison annotation requires a hexadecimal color.');
    }
  }
  return {
    ...input,
    kind: 'aligned-comparison',
    layout: buildGenomeComparisonLayout(input.comparison.blocks),
  };
}

export function comparisonPlot(width: number, height: number): ComparisonPlot {
  const h = Number.isFinite(height) ? Math.max(100, height) : 100;
  return {
    x: 24,
    width: Math.max(1, width - 48),
    targetY: Math.max(68, h * 0.28),
    queryY: Math.max(136, h * 0.72),
    rowHeight: 18,
  };
}

export function resolveComparisonCamera(
  projection: ComparisonProjection,
  camera?: ComparisonCamera | null
): ComparisonCamera {
  const length = projection.layout.columnLength;
  const current = camera?.projectionId === projection.id ? camera : undefined;
  const span =
    current &&
    Number.isFinite(current.startColumn) &&
    Number.isFinite(current.endColumn) &&
    current.endColumn > current.startColumn
      ? Math.max(1, Math.min(length, current.endColumn - current.startColumn))
      : length;
  const startColumn =
    current && Number.isFinite(current.startColumn)
      ? Math.max(0, Math.min(length - span, current.startColumn))
      : 0;
  return { projectionId: projection.id, startColumn, endColumn: startColumn + span };
}

export function panComparisonCamera(
  projection: ComparisonProjection,
  camera: ComparisonCamera | null | undefined,
  deltaPx: number,
  plot: ComparisonPlot
): ComparisonCamera {
  const current = resolveComparisonCamera(projection, camera);
  const shift = Number.isFinite(deltaPx)
    ? (deltaPx / plot.width) * (current.endColumn - current.startColumn)
    : 0;
  return resolveComparisonCamera(projection, {
    projectionId: projection.id,
    startColumn: current.startColumn + shift,
    endColumn: current.endColumn + shift,
  });
}

export function zoomComparisonCamera(
  projection: ComparisonProjection,
  camera: ComparisonCamera | null | undefined,
  factor: number,
  x: number,
  plot: ComparisonPlot
): ComparisonCamera {
  const current = resolveComparisonCamera(projection, camera);
  if (!Number.isFinite(factor) || factor <= 0) return current;
  const fraction = Math.max(0, Math.min(1, (x - plot.x) / plot.width));
  const span = current.endColumn - current.startColumn;
  const nextSpan = Math.max(1, Math.min(projection.layout.columnLength, span / factor));
  const startColumn = current.startColumn + fraction * (span - nextSpan);
  return resolveComparisonCamera(projection, {
    projectionId: projection.id,
    startColumn,
    endColumn: startColumn + nextSpan,
  });
}

export function comparisonColumnLoci(
  projection: ComparisonProjection,
  column: number
): Omit<ComparisonHit, 'side'> | null {
  if (!Number.isSafeInteger(column) || column < 0 || column >= projection.layout.columnLength)
    return null;
  let low = 0,
    high = projection.layout.entries.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const entry = projection.layout.entries[mid];
    if (column < entry.columnStart) high = mid - 1;
    else if (column >= entry.columnEnd) low = mid + 1;
    else if (entry.kind === 'block') {
      const target = alignmentColumnToLocus(entry.block, 'target', column - entry.columnStart)!;
      const query = alignmentColumnToLocus(entry.block, 'query', column - entry.columnStart)!;
      return {
        projectionId: projection.id,
        column,
        blockId: entry.block.id,
        target,
        query,
        strand: entry.block.strand,
        mappingQuality: entry.block.mappingQuality,
      };
    } else
      return {
        projectionId: projection.id,
        column,
        blockId: null,
        strand: null,
        mappingQuality: null,
        target: {
          kind: 'unaligned',
          referenceId: projection.comparison.target.id,
          reason: entry.reason,
          interval: entry.targetGap,
        },
        query: {
          kind: 'unaligned',
          referenceId: projection.comparison.query.id,
          reason: entry.reason,
          interval: entry.queryGap,
        },
      };
  }
  return null;
}

export function comparisonLocusColumns(
  projection: ComparisonProjection,
  side: GenomeComparisonSide,
  position: number
): readonly number[] {
  return projection.layout.entries.flatMap((entry) => {
    if (entry.kind !== 'block') return [];
    const column = alignmentLocusToColumn(entry.block, side, position);
    return column === null ? [] : [entry.columnStart + column];
  });
}

export function comparisonColumnX(
  column: number,
  camera: ComparisonCamera,
  plot: ComparisonPlot
): number {
  return (
    plot.x + ((column - camera.startColumn) / (camera.endColumn - camera.startColumn)) * plot.width
  );
}

export function hitTestComparison(
  projection: ComparisonProjection,
  camera: ComparisonCamera,
  plot: ComparisonPlot,
  x: number,
  y: number
): ComparisonHit | null {
  if (x < plot.x || x >= plot.x + plot.width || y < plot.targetY - 28 || y > plot.queryY + 28)
    return null;
  const column = Math.floor(
    camera.startColumn + ((x - plot.x) / plot.width) * (camera.endColumn - camera.startColumn)
  );
  const loci = comparisonColumnLoci(projection, column);
  if (!loci) return null;
  const side =
    Math.abs(y - plot.targetY) <= 28
      ? 'target'
      : Math.abs(y - plot.queryY) <= 28
        ? 'query'
        : 'link';
  return { ...loci, side };
}
