export function overflowRowsHavePaintableSource(args: {
  hasField: boolean;
  hasRecords: boolean;
  hasRows: boolean;
  recordCount: number;
  rowCount: number;
  hiddenReadCount: number;
  overflowHeightPx: number;
}): boolean {
  if (args.hiddenReadCount <= 0 || args.overflowHeightPx <= 0) return false;
  if (args.hasField) return true;
  return args.hasRecords && args.hasRows && args.rowCount === args.recordCount;
}

export function overflowExactSourceDomain(args: {
  hasField: boolean;
  records: { length: number } | null | undefined;
  rows: { length: number } | null | undefined;
  readSourceWindowStartBp: number | null;
  readSourceWindowEndBp: number | null;
  loadedStartBp: number;
  loadedEndBp: number;
}): {
  exactSourceStartBp: number;
  exactSourceEndBp: number;
  hasExactSourceDomain: boolean;
} {
  const exactSourceStartBp =
    args.readSourceWindowStartBp !== null ? args.readSourceWindowStartBp : args.loadedStartBp;
  const exactSourceEndBp =
    args.readSourceWindowEndBp !== null ? args.readSourceWindowEndBp : args.loadedEndBp;
  return {
    exactSourceStartBp,
    exactSourceEndBp,
    hasExactSourceDomain:
      !args.hasField &&
      args.records != null &&
      args.rows != null &&
      args.rows.length === args.records.length &&
      exactSourceEndBp > exactSourceStartBp,
  };
}

export function overflowGeometryWindow(args: {
  field: { startBp: number; endBp: number; hiddenCounts: { length: number } } | null;
  hasExactSourceDomain: boolean;
  exactSourceStartBp: number;
  exactSourceEndBp: number;
  viewStart: number;
  viewEnd: number;
  maxColumnBars: number;
  cameraColumnCount: number;
}): {
  columnCount: number;
  geometryStartBp: number;
  geometryEndBp: number;
  columnBp: number;
} {
  const residentFieldColumnCount = args.field
    ? Math.min(args.maxColumnBars, args.field.hiddenCounts.length)
    : 0;
  const columnCount =
    residentFieldColumnCount > 0 ? residentFieldColumnCount : args.cameraColumnCount;
  const geometryStartBp = args.field
    ? args.field.startBp
    : args.hasExactSourceDomain
      ? args.exactSourceStartBp
      : args.viewStart;
  const geometryEndBp = args.field
    ? args.field.endBp
    : args.hasExactSourceDomain
      ? args.exactSourceEndBp
      : args.viewEnd;
  return {
    columnCount,
    geometryStartBp,
    geometryEndBp,
    columnBp: (geometryEndBp - geometryStartBp) / columnCount,
  };
}

export function overflowMeshKey(args: {
  field: {
    startBp: number;
    endBp: number;
    binSizeBp: number;
    hiddenCounts: { length: number };
    maxHiddenCount: number;
  } | null;
  hasExactSourceDomain: boolean;
  viewStart: number;
  viewEnd: number;
  columnCount: number;
  overflowHeightPx: number;
  recordsKey: string;
  hiddenReadCount: number;
  morphBucket: number;
  themedReadColor: number;
}): string {
  const fieldKey = args.field
    ? `${Math.round(args.field.startBp)}:${Math.round(args.field.endBp)}:${args.field.binSizeBp}:${args.field.hiddenCounts.length}:${args.field.maxHiddenCount}`
    : 'none';
  const cameraKey =
    args.field || args.hasExactSourceDomain
      ? 'resident'
      : `${Math.round(args.viewStart)}:${Math.round(args.viewEnd)}`;
  return `${cameraKey}:${args.columnCount}:${Math.round(args.overflowHeightPx)}:${args.recordsKey}:${args.hiddenReadCount}:${args.morphBucket}:${fieldKey}:${args.themedReadColor}`;
}
