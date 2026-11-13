import type { RenderState } from '../../../types';

export interface LabelBounds {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface LabelOccupancyRecord extends LabelBounds {
  kind: string;
  featureId?: number;
  text?: string;
}

const LABEL_COLLISION_PADDING_PX = 1.5;
const occupancyByState = new WeakMap<RenderState, LabelOccupancyRecord[]>();

function inflate(bounds: LabelBounds, paddingPx = LABEL_COLLISION_PADDING_PX): LabelBounds {
  return {
    xMin: bounds.xMin - paddingPx,
    xMax: bounds.xMax + paddingPx,
    yMin: bounds.yMin - paddingPx,
    yMax: bounds.yMax + paddingPx,
  };
}

function overlaps(a: LabelBounds, b: LabelBounds): boolean {
  return a.xMin < b.xMax && a.xMax > b.xMin && a.yMin < b.yMax && a.yMax > b.yMin;
}

function recordsFor(state: RenderState): LabelOccupancyRecord[] {
  let records = occupancyByState.get(state);
  if (!records) {
    records = [];
    occupancyByState.set(state, records);
  }
  return records;
}

export function resetLabelOccupancy(state: RenderState): void {
  occupancyByState.set(state, []);
}

export function removeLabelOccupancyRecords(
  state: RenderState,
  predicate: (record: LabelOccupancyRecord) => boolean
): void {
  occupancyByState.set(
    state,
    recordsFor(state).filter((record) => !predicate(record))
  );
}

export function reserveLabelBounds(
  state: RenderState,
  bounds: LabelBounds,
  record: Omit<LabelOccupancyRecord, keyof LabelBounds>,
  options: { force?: boolean; paddingPx?: number } = {}
): boolean {
  const records = recordsFor(state);
  if (!options.force && !canReserveLabelBounds(state, bounds, options)) return false;
  records.push({ ...bounds, ...record });
  return true;
}

export function canReserveLabelBounds(
  state: RenderState,
  bounds: LabelBounds,
  options: { paddingPx?: number } = {}
): boolean {
  const padded = inflate(bounds, options.paddingPx);
  return !recordsFor(state).some((existing) => overlaps(padded, existing));
}

export function getLabelOccupancyRecords(state: RenderState): LabelOccupancyRecord[] {
  return [...recordsFor(state)];
}
