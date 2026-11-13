import type {
  CoordMapping,
  CoordMappingPoint,
  CoordMappingPointKind,
  CoordMappingRow,
  CoordMappingStrategy,
  CoordMappingStrategyName,
  ScreenMappingResult,
} from './types';

export type {
  CoordMapping,
  CoordMappingConstraint,
  CoordMappingPoint,
  CoordMappingPointKind,
  CoordMappingRow,
  CoordMappingStrategy,
  CoordMappingStrategyName,
  JunctionWorkbenchRowKind,
  ScreenMappingResult,
} from './types';

export const JUNCTION_WORKBENCH_HORIZONTAL_PADDING = 8;
export const DEFAULT_JUNCTION_WINDOW_BP = 960;
export const MAX_JUNCTION_WINDOW_BP = 1200;

const MAPPABLE_KINDS: ReadonlySet<CoordMappingPointKind> = new Set([
  'valid',
  'many-to-one',
  'generated-tail',
  'constrained-end',
]);

export const coordMappingStrategies: Record<CoordMappingStrategyName, CoordMappingStrategy> = {
  gibson: createStrategy('gibson'),
  nebuilder: createStrategy('nebuilder'),
  goldengate: createStrategy('goldengate'),
};

export function createCoordMapping(
  strategy: CoordMappingStrategyName,
  input: Omit<CoordMapping, 'strategy'>
): CoordMapping {
  return coordMappingStrategies[strategy].create(input);
}

export function toScreen(
  mapping: CoordMapping,
  rowId: string,
  rowPosition: number,
  pxPerBase = 1
): number | null {
  const point = findPointByRowPosition(mapping, rowId, rowPosition);
  if (!point || !MAPPABLE_KINDS.has(point.kind)) return null;
  return JUNCTION_WORKBENCH_HORIZONTAL_PADDING + point.rowPosition * pxPerBase;
}

export function fromScreen(
  mapping: CoordMapping,
  rowId: string,
  screenX: number,
  pxPerBase = 1
): ScreenMappingResult | null {
  if (pxPerBase <= 0) return null;
  const rowPosition = Math.floor((screenX - JUNCTION_WORKBENCH_HORIZONTAL_PADDING) / pxPerBase);
  const point = findPointByRowPosition(mapping, rowId, rowPosition);
  if (!point) return null;
  return pointToScreenResult(point);
}

export function assertBijectionInvariant(mapping: CoordMapping): void {
  for (const row of mapping.rows) {
    const seenPositions = new Set<number>();
    for (const point of row.points) {
      if (seenPositions.has(point.rowPosition)) {
        throw new Error(`Duplicate row position ${row.id}:${point.rowPosition}`);
      }
      seenPositions.add(point.rowPosition);

      const screen = toScreen(mapping, row.id, point.rowPosition, 1);
      if (!MAPPABLE_KINDS.has(point.kind)) {
        if (screen !== null) {
          throw new Error(`Invalid point ${row.id}:${point.rowPosition} mapped to ${screen}`);
        }
        continue;
      }
      if (screen === null) {
        throw new Error(`Valid point ${row.id}:${point.rowPosition} did not map to screen`);
      }
      const roundTrip = fromScreen(mapping, row.id, screen, 1);
      if (!roundTrip || roundTrip.rowPosition !== point.rowPosition) {
        throw new Error(`Round trip failed for ${row.id}:${point.rowPosition}`);
      }
    }
  }
}

export function makeMappingPoint(
  rowId: string,
  rowPosition: number,
  bioCol: number,
  productPosition: number | null,
  kind: CoordMappingPointKind = 'valid',
  options: Pick<CoordMappingPoint, 'sourcePosition' | 'label'> & { editable?: boolean } = {}
): CoordMappingPoint {
  return {
    rowId,
    rowPosition,
    bioCol,
    productPosition,
    sourcePosition: options.sourcePosition,
    kind,
    editable: options.editable ?? kind !== 'constrained-end',
    label: options.label,
  };
}

function createStrategy(name: CoordMappingStrategyName): CoordMappingStrategy {
  return {
    name,
    create(input) {
      const maxWindowBp = Math.min(input.maxWindowBp, MAX_JUNCTION_WINDOW_BP);
      return {
        strategy: name,
        rows: input.rows,
        maxWindowBp,
      };
    },
  };
}

function getRow(mapping: CoordMapping, rowId: string): CoordMappingRow | null {
  return mapping.rows.find((row) => row.id === rowId) ?? null;
}

function findPointByRowPosition(
  mapping: CoordMapping,
  rowId: string,
  rowPosition: number
): CoordMappingPoint | null {
  const row = getRow(mapping, rowId);
  if (!row) return null;
  return row.points.find((point) => point.rowPosition === rowPosition) ?? null;
}

function pointToScreenResult(point: CoordMappingPoint): ScreenMappingResult {
  return {
    rowId: point.rowId,
    rowPosition: point.rowPosition,
    bioCol: point.bioCol,
    productPosition: point.productPosition,
    sourcePosition: point.sourcePosition,
    kind: point.kind,
    editable: point.editable,
  };
}
