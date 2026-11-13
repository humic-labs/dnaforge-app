import type { PileupRecord } from '@waypoint/genome-data';

export interface CollapsedPileupField {
  startBp: number;
  endBp: number;
  binSizeBp: number;
  sourceRows: Uint16Array;
  exactDepthRows: Uint16Array;
  peakDepthRows: Uint16Array;
  visibleRows: Uint16Array;
  hiddenCounts: Uint16Array;
  maxSourceRows: number;
  maxExactDepthRows: number;
  maxPeakDepthRows: number;
  maxVisibleRows: number;
  maxHiddenCount: number;
}

export interface BuildCollapsedPileupFieldOptions {
  targetBinBp: number;
  maxBins: number;
}

export interface PileupVerticalScaleContract {
  sourceRowPitchPx: number;
  sourceReadHeightPx: number;
  sourceReadHalfHeightPx: number;
  collapsedRowPitchPx: number;
  collapsedReadHeightPx: number;
  collapsedReadHalfHeightPx: number;
  sourceRowsHeightPx: number;
  overflowScale: 'log';
  overflowMinFillFraction: number;
  overflowMaxFillFraction: number;
  overflowDenominator: number;
}

export interface PileupVerticalScaleOptions {
  rowHeightPx: number;
  effectiveMaxRows: number;
  maxHiddenCount: number;
  overflowMinFillFraction: number;
  overflowMaxFillFraction: number;
  overflowMinDenominatorReads: number;
}

export function buildEmptyCollapsedPileupField(
  loadedStartBp: number,
  loadedEndBp: number,
  options: BuildCollapsedPileupFieldOptions
): CollapsedPileupField | null {
  if (
    !Number.isFinite(loadedStartBp) ||
    !Number.isFinite(loadedEndBp) ||
    loadedEndBp <= loadedStartBp ||
    !(options.targetBinBp > 0) ||
    !(options.maxBins > 0)
  ) {
    return null;
  }
  const span = loadedEndBp - loadedStartBp;
  const binCount = Math.min(
    Math.max(1, Math.floor(options.maxBins)),
    Math.max(1, Math.ceil(span / options.targetBinBp))
  );
  const binSizeBp = span / binCount;
  return {
    startBp: loadedStartBp,
    endBp: loadedEndBp,
    binSizeBp,
    sourceRows: new Uint16Array(binCount),
    exactDepthRows: new Uint16Array(binCount),
    peakDepthRows: new Uint16Array(binCount),
    visibleRows: new Uint16Array(binCount),
    hiddenCounts: new Uint16Array(binCount),
    maxSourceRows: 0,
    maxExactDepthRows: 0,
    maxPeakDepthRows: 0,
    maxVisibleRows: 0,
    maxHiddenCount: 0,
  };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function buildPileupVerticalScaleContract(
  options: PileupVerticalScaleOptions
): PileupVerticalScaleContract {
  const pitch = Math.max(1, options.rowHeightPx);
  const sourceReadHeightPx = Math.max(0, pitch - 1);
  const collapsedReadHeightPx = sourceReadHeightPx > 0 ? sourceReadHeightPx : pitch;
  return {
    sourceRowPitchPx: pitch,
    sourceReadHeightPx,
    sourceReadHalfHeightPx: sourceReadHeightPx / 2,
    collapsedRowPitchPx: collapsedReadHeightPx,
    collapsedReadHeightPx,
    collapsedReadHalfHeightPx: collapsedReadHeightPx / 2,
    sourceRowsHeightPx: Math.max(0, options.effectiveMaxRows * pitch),
    overflowScale: 'log',
    overflowMinFillFraction: options.overflowMinFillFraction,
    overflowMaxFillFraction: options.overflowMaxFillFraction,
    overflowDenominator: Math.max(
      1,
      Math.log1p(Math.max(options.maxHiddenCount, options.overflowMinDenominatorReads))
    ),
  };
}

export function collapsedVisibleRowsHeightPx(
  contract: PileupVerticalScaleContract,
  visibleRows: number
): number {
  return Math.max(0, visibleRows) * contract.collapsedRowPitchPx;
}

export function overflowFillForHiddenCount(
  contract: PileupVerticalScaleContract,
  hiddenCount: number
): number {
  return hiddenCount > 0
    ? Math.max(
        contract.overflowMinFillFraction,
        Math.min(
          contract.overflowMaxFillFraction,
          Math.log1p(hiddenCount) / contract.overflowDenominator
        )
      )
    : 0;
}

export function overflowBaseYForMorph(
  contract: PileupVerticalScaleContract,
  visibleRows: number,
  morph: number
): number {
  const targetBase = Math.min(
    contract.sourceRowsHeightPx,
    collapsedVisibleRowsHeightPx(contract, visibleRows)
  );
  return contract.sourceRowsHeightPx + (targetBase - contract.sourceRowsHeightPx) * clamp01(morph);
}

export function sampleUint16FieldMax(
  field: CollapsedPileupField,
  values: Uint16Array,
  viewStart: number,
  viewEnd: number,
  columnBp: number,
  columnCount: number
): Uint16Array {
  const out = new Uint16Array(columnCount);
  if (columnCount <= 0 || columnBp <= 0 || viewEnd <= viewStart || field.endBp <= field.startBp) {
    return out;
  }
  for (let c = 0; c < columnCount; c++) {
    const colStart = viewStart + c * columnBp;
    const colEnd = colStart + columnBp;
    const start = Math.max(colStart, field.startBp);
    const end = Math.min(colEnd, field.endBp);
    if (end <= start) continue;
    const b0 = Math.max(
      0,
      Math.min(values.length - 1, Math.floor((start - field.startBp) / field.binSizeBp))
    );
    const b1 = Math.max(
      b0 + 1,
      Math.min(values.length, Math.ceil((end - field.startBp) / field.binSizeBp))
    );
    let max = 0;
    for (let b = b0; b < b1; b++) if (values[b] > max) max = values[b];
    out[c] = max;
  }
  return out;
}

export function collapsedFieldCoversViewport(
  field: CollapsedPileupField | null,
  viewStart: number,
  viewEnd: number
): field is CollapsedPileupField {
  return (
    !!field && viewEnd > viewStart && viewStart >= field.startBp - 1 && viewEnd <= field.endBp + 1
  );
}

export function collapsedFieldOverlapsViewport(
  field: CollapsedPileupField | null,
  viewStart: number,
  viewEnd: number
): field is CollapsedPileupField {
  return (
    !!field &&
    viewEnd > viewStart &&
    field.endBp > field.startBp &&
    viewStart < field.endBp &&
    viewEnd > field.startBp
  );
}

function collapsedFieldAdmission(
  records: ReadonlyArray<PileupRecord> | null,
  rows: Int32Array | null,
  loadedStartBp: number,
  loadedEndBp: number
): records is ReadonlyArray<PileupRecord> {
  return Boolean(
    records &&
    rows &&
    records.length > 0 &&
    rows.length === records.length &&
    loadedEndBp > loadedStartBp
  );
}

function recordsAreCoordinateOrdered(records: ReadonlyArray<PileupRecord>): boolean {
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1];
    const cur = records[i];
    if (prev.start > cur.start || (prev.start === cur.start && prev.end > cur.end)) {
      return false;
    }
  }
  return true;
}

function accumulateCollapsedSourceAndHidden(
  records: ReadonlyArray<PileupRecord>,
  rows: Int32Array,
  loadedStartBp: number,
  loadedEndBp: number,
  binCount: number,
  binSizeBp: number,
  order: number[] | null,
  sourceRows: Uint16Array,
  hiddenCounts: Uint16Array
): void {
  const hiddenDelta = new Int32Array(binCount + 1);
  for (let ordinal = 0; ordinal < records.length; ordinal++) {
    const i = order ? order[ordinal] : ordinal;
    const rec = records[i];
    const start = Math.max(rec.start, loadedStartBp);
    const end = Math.min(rec.end, loadedEndBp);
    if (end <= start) continue;
    const b0 = Math.max(0, Math.min(binCount - 1, Math.floor((start - loadedStartBp) / binSizeBp)));
    const b1 = Math.max(b0 + 1, Math.min(binCount, Math.ceil((end - loadedStartBp) / binSizeBp)));
    const row = rows[i];
    if (row < 0) {
      hiddenDelta[b0]++;
      hiddenDelta[b1]--;
      continue;
    }
    const sourceHeight = Math.min(65535, row + 1);
    for (let b = b0; b < b1; b++) {
      if (sourceHeight > sourceRows[b]) sourceRows[b] = sourceHeight;
    }
  }
  let hidden = 0;
  for (let b = 0; b < binCount; b++) {
    hidden += hiddenDelta[b];
    hiddenCounts[b] = Math.min(65535, hidden);
  }
}

export function buildCollapsedPileupFieldFromExact(
  records: ReadonlyArray<PileupRecord> | null,
  rows: Int32Array | null,
  loadedStartBp: number,
  loadedEndBp: number,
  effectiveMaxRows: number,
  options: BuildCollapsedPileupFieldOptions
): CollapsedPileupField | null {
  if (!collapsedFieldAdmission(records, rows, loadedStartBp, loadedEndBp) || !records || !rows) {
    return null;
  }

  const span = loadedEndBp - loadedStartBp;
  const binCount = Math.min(options.maxBins, Math.max(1, Math.ceil(span / options.targetBinBp)));
  const binSizeBp = span / binCount;
  const sourceRows = new Uint16Array(binCount);
  const exactDepthRows = new Uint16Array(binCount);
  const peakDepthRows = new Uint16Array(binCount);
  const visibleRows = new Uint16Array(binCount);
  const hiddenCounts = new Uint16Array(binCount);
  const fineIntegerBins =
    binSizeBp === 1 &&
    Number.isInteger(loadedStartBp) &&
    records.every((record) => Number.isInteger(record.start) && Number.isInteger(record.end));
  const order =
    fineIntegerBins || recordsAreCoordinateOrdered(records)
      ? null
      : Array.from({ length: records.length }, (_, idx) => idx).sort(
          (a, b) => records[a].start - records[b].start || records[a].end - records[b].end
        );
  accumulateCollapsedSourceAndHidden(
    records,
    rows,
    loadedStartBp,
    loadedEndBp,
    binCount,
    binSizeBp,
    order,
    sourceRows,
    hiddenCounts
  );

  if (effectiveMaxRows > 0 && !fineIntegerBins) {
    const slotEndBp = new Float64Array(binCount * effectiveMaxRows);
    for (let ordinal = 0; ordinal < records.length; ordinal++) {
      const i = order ? order[ordinal] : ordinal;
      if (rows[i] < 0) continue;
      const rec = records[i];
      const start = Math.max(rec.start, loadedStartBp);
      const end = Math.min(rec.end, loadedEndBp);
      if (end <= start) continue;
      const b0 = Math.max(
        0,
        Math.min(binCount - 1, Math.floor((start - loadedStartBp) / binSizeBp))
      );
      const b1 = Math.max(b0 + 1, Math.min(binCount, Math.ceil((end - loadedStartBp) / binSizeBp)));
      for (let b = b0; b < b1; b++) {
        const fragStart = Math.max(start, loadedStartBp + b * binSizeBp);
        const fragEnd = Math.min(end, loadedStartBp + (b + 1) * binSizeBp);
        if (fragEnd <= fragStart) continue;
        const slotBase = b * effectiveMaxRows;
        let slot = -1;
        for (let candidate = 0; candidate < effectiveMaxRows; candidate++) {
          if (slotEndBp[slotBase + candidate] <= fragStart + 1e-6) {
            slot = candidate;
            break;
          }
        }
        if (slot < 0) {
          exactDepthRows[b] = Math.max(exactDepthRows[b], effectiveMaxRows);
          continue;
        }
        slotEndBp[slotBase + slot] = fragEnd;
        if (slot + 1 > exactDepthRows[b]) exactDepthRows[b] = slot + 1;
      }
    }
  }

  {
    const binDelta = new Int32Array(binCount + 1);
    const visibleDelta = fineIntegerBins ? new Int32Array(binCount + 1) : null;
    for (let ordinal = 0; ordinal < records.length; ordinal++) {
      const i = order ? order[ordinal] : ordinal;
      const rec = records[i];
      const start = Math.max(rec.start, loadedStartBp);
      const end = Math.min(rec.end, loadedEndBp);
      if (end <= start) continue;
      const b0 = Math.max(
        0,
        Math.min(binCount - 1, Math.floor((start - loadedStartBp) / binSizeBp))
      );
      const b1 = Math.max(b0 + 1, Math.min(binCount, Math.ceil((end - loadedStartBp) / binSizeBp)));
      binDelta[b0] += 1;
      binDelta[b1] -= 1;
      if (visibleDelta && rows[i] >= 0) {
        visibleDelta[b0]++;
        visibleDelta[b1]--;
      }
    }
    let depth = 0;
    let visibleDepth = 0;
    for (let b = 0; b < binCount; b++) {
      depth += binDelta[b];
      peakDepthRows[b] = depth > 65535 ? 65535 : depth;
      if (visibleDelta) {
        visibleDepth += visibleDelta[b];
        exactDepthRows[b] = Math.min(effectiveMaxRows, visibleDepth);
      }
    }
  }

  let maxSourceRows = 0;
  let maxExactDepthRows = 0;
  let maxPeakDepthRows = 0;
  let maxVisibleRows = 0;
  let maxHiddenCount = 0;
  for (let b = 0; b < binCount; b++) {
    const source = sourceRows[b];
    const exact = exactDepthRows[b];
    const visible = source > 0 && exact > 0 ? Math.min(source, exact, effectiveMaxRows) : 0;
    visibleRows[b] = visible;
    if (source > maxSourceRows) maxSourceRows = source;
    if (exact > maxExactDepthRows) maxExactDepthRows = exact;
    if (peakDepthRows[b] > maxPeakDepthRows) maxPeakDepthRows = peakDepthRows[b];
    if (visible > maxVisibleRows) maxVisibleRows = visible;
    if (hiddenCounts[b] > maxHiddenCount) maxHiddenCount = hiddenCounts[b];
  }

  return {
    startBp: loadedStartBp,
    endBp: loadedEndBp,
    binSizeBp,
    sourceRows,
    exactDepthRows,
    peakDepthRows,
    visibleRows,
    hiddenCounts,
    maxSourceRows,
    maxExactDepthRows,
    maxPeakDepthRows,
    maxVisibleRows,
    maxHiddenCount,
  };
}
