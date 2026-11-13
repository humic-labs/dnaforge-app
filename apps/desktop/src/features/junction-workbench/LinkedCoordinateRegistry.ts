import {
  JUNCTION_WORKBENCH_HORIZONTAL_PADDING,
  type CoordMapping,
  type JunctionWorkbenchRowKind,
} from './coord-mapping';
import type { JunctionWorkbenchRow } from './model';

export interface LinkedCoordinateAxis {
  startBioCol: number;
  endBioCol: number;
  length: number;
  anchorRowPosition: number;
}

export interface LinkedCoordinateRowRegistration {
  id: string;
  kind: JunctionWorkbenchRowKind;
  sequenceLength: number;
  startBioCol: number;
  endBioCol: number;
  anchorRowPosition: number;
}

export class LinkedCoordinateRegistry {
  readonly axis: LinkedCoordinateAxis;
  readonly rows: readonly LinkedCoordinateRowRegistration[];
  readonly referenceRowId: string | null;

  constructor(rows: JunctionWorkbenchRow[], mapping: CoordMapping) {
    const mappingRowsById = new Map(mapping.rows.map((row) => [row.id, row]));
    this.axis = inferAxis(rows);
    this.rows = rows.map((row) => {
      const mappedRow = mappingRowsById.get(row.id);
      if (!mappedRow) {
        throw new Error(`Linked coordinate row ${row.id} is missing from mapping registry.`);
      }
      assertRegisteredRow(row, this.axis);
      assertRegisteredRow(mappedRow as JunctionWorkbenchRow, this.axis);
      return {
        id: row.id,
        kind: row.kind,
        sequenceLength: row.sequence.length,
        startBioCol: rowStartBioCol(row),
        endBioCol: rowEndBioCol(row),
        anchorRowPosition: row.anchorRowPosition,
      };
    });
    this.referenceRowId = rows.find((row) => row.kind === 'product')?.id ?? rows[0]?.id ?? null;
  }

  hasRow(rowId: string): boolean {
    return this.rows.some((row) => row.id === rowId);
  }

  screenXForBioCol(bioCol: number, pxPerBase: number): number {
    if (this.axis.length === 0) return JUNCTION_WORKBENCH_HORIZONTAL_PADDING;
    const rowPosition = bioCol - this.axis.startBioCol;
    return JUNCTION_WORKBENCH_HORIZONTAL_PADDING + rowPosition * pxPerBase;
  }

  bioColForScreenX(screenX: number, pxPerBase: number): number | null {
    if (this.axis.length === 0 || pxPerBase <= 0) return null;
    const rowPosition = (screenX - JUNCTION_WORKBENCH_HORIZONTAL_PADDING) / pxPerBase;
    return Math.round(this.axis.startBioCol + rowPosition);
  }

  screenXForBioColInRow(rowId: string, bioCol: number, pxPerBase: number): number {
    const row = this.rows.find((item) => item.id === rowId);
    const startBioCol = row?.startBioCol ?? this.axis.startBioCol;
    return JUNCTION_WORKBENCH_HORIZONTAL_PADDING + (bioCol - startBioCol) * pxPerBase;
  }

  bioColForRowScreenX(rowId: string, screenX: number, pxPerBase: number): number | null {
    if (pxPerBase <= 0) return null;
    const row = this.rows.find((item) => item.id === rowId);
    const startBioCol = row?.startBioCol ?? this.axis.startBioCol;
    const rowPosition = (screenX - JUNCTION_WORKBENCH_HORIZONTAL_PADDING) / pxPerBase;
    return Math.round(startBioCol + rowPosition);
  }

  scrollLeftForBioCol(bioCol: number, pxPerBase: number, viewportWidth: number): number {
    return this.clampScrollLeft(this.screenXForBioCol(bioCol, pxPerBase) - viewportWidth / 2, {
      pxPerBase,
      viewportWidth,
    });
  }

  bioColForScrollLeft(scrollLeft: number, pxPerBase: number, viewportWidth: number): number | null {
    return this.bioColForScreenX(scrollLeft + viewportWidth / 2, pxPerBase);
  }

  totalWidth(pxPerBase: number): number {
    return JUNCTION_WORKBENCH_HORIZONTAL_PADDING * 2 + this.axis.length * pxPerBase;
  }

  maxScrollLeft(pxPerBase: number, viewportWidth: number): number {
    return Math.max(0, this.totalWidth(pxPerBase) - viewportWidth);
  }

  clampScrollLeft(scrollLeft: number, input: { pxPerBase: number; viewportWidth: number }): number {
    return clamp(scrollLeft, 0, this.maxScrollLeft(input.pxPerBase, input.viewportWidth));
  }

  scrollLeftForRow(rowId: string, sharedScrollLeft: number, pxPerBase: number): number {
    const row = this.rows.find((item) => item.id === rowId);
    if (!row) return 0;
    return sharedScrollLeft - (row.startBioCol - this.axis.startBioCol) * pxPerBase;
  }
}

function inferAxis(rows: JunctionWorkbenchRow[]): LinkedCoordinateAxis {
  if (rows.length === 0) {
    return {
      startBioCol: 0,
      endBioCol: 0,
      length: 0,
      anchorRowPosition: 0,
    };
  }

  const populatedRows = rows.filter((row) => row.sequence.length > 0 && row.points.length > 0);
  const first = populatedRows[0] ?? rows[0];
  if (!first || first.sequence.length === 0 || first.points.length === 0) {
    return {
      startBioCol: 0,
      endBioCol: 0,
      length: 0,
      anchorRowPosition: first.anchorRowPosition,
    };
  }

  const startBioCol = Math.min(...populatedRows.map(rowStartBioCol));
  const endBioCol = Math.max(...populatedRows.map(rowEndBioCol));
  const length = endBioCol - startBioCol;
  return {
    startBioCol,
    endBioCol,
    length,
    anchorRowPosition: -startBioCol,
  };
}

function assertRegisteredRow(row: JunctionWorkbenchRow, axis: LinkedCoordinateAxis): void {
  if (row.points.length !== row.sequence.length) {
    throw new Error(
      `Linked coordinate row ${row.id} has ${row.points.length} mapping points for ${row.sequence.length} bases.`
    );
  }
  const startBioCol = rowStartBioCol(row);
  const endBioCol = rowEndBioCol(row);
  if (startBioCol < axis.startBioCol || endBioCol > axis.endBioCol) {
    throw new Error(
      `Linked coordinate row ${row.id} [${startBioCol}, ${endBioCol}) falls outside registered axis [${axis.startBioCol}, ${axis.endBioCol}).`
    );
  }
  if (row.anchorRowPosition !== -startBioCol) {
    throw new Error(
      `Linked coordinate row ${row.id} anchor ${row.anchorRowPosition} does not match row start ${startBioCol}.`
    );
  }
  for (let rowPosition = 0; rowPosition < row.points.length; rowPosition++) {
    const point = row.points[rowPosition];
    const expectedBioCol = startBioCol + rowPosition;
    if (point.rowPosition !== rowPosition) {
      throw new Error(
        `Linked coordinate row ${row.id} point ${rowPosition} has rowPosition ${point.rowPosition}.`
      );
    }
    if (point.bioCol !== expectedBioCol) {
      throw new Error(
        `Linked coordinate row ${row.id} point ${rowPosition} maps to bioCol ${point.bioCol}; expected ${expectedBioCol}.`
      );
    }
  }
}

function rowStartBioCol(row: JunctionWorkbenchRow): number {
  return row.points[0]?.bioCol ?? -row.anchorRowPosition;
}

function rowEndBioCol(row: JunctionWorkbenchRow): number {
  return rowStartBioCol(row) + row.sequence.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
