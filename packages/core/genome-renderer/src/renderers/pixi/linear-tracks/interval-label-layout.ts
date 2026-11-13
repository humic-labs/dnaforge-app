export interface BoundedIntervalLabel {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly estimatedWidthPx: number;
  readonly recordIndex: number;
}

export interface PlanBoundedIntervalLabelsInput<TRecord extends { start: number; end: number }> {
  readonly records: ReadonlyArray<TRecord>;
  readonly laneAssignments: Int16Array | Int32Array;
  readonly viewportBpRange: { readonly start: number; readonly end: number };
  readonly viewportWidthPx: number;
  readonly bpToX: (bp: number) => number;
  readonly rowHeightPx: number;
  readonly trackHeightPx: number;
  readonly maxLabels: number;
  readonly labelForRecord: (record: TRecord, index: number) => string | undefined;
  readonly strandForRecord?: (record: TRecord, index: number) => '+' | '-' | '.' | undefined;
  readonly isDensityRecord?: (record: TRecord, index: number) => boolean;
  readonly horizontalPaddingPx?: number;
  readonly estimatedCharacterWidthPx?: number;
  readonly labelHeightPx?: number;
  readonly minFeatureWidthPx?: number;
  readonly maxLabelCharacters?: number;
}

const DEFAULT_HORIZONTAL_PADDING_PX = 3;
const DEFAULT_CHARACTER_WIDTH_PX = 5;
const DEFAULT_LABEL_HEIGHT_PX = 8;
const DEFAULT_MIN_FEATURE_WIDTH_PX = 24;
const DEFAULT_MAX_LABEL_CHARACTERS = 80;

export function planBoundedIntervalLabels<TRecord extends { start: number; end: number }>(
  input: PlanBoundedIntervalLabelsInput<TRecord>
): BoundedIntervalLabel[] {
  requireNonNegativeInteger(input.maxLabels, 'maxLabels');
  if (input.maxLabels === 0) return [];

  const padding = finiteNonNegative(
    input.horizontalPaddingPx ?? DEFAULT_HORIZONTAL_PADDING_PX,
    'horizontalPaddingPx'
  );
  const characterWidth = finitePositive(
    input.estimatedCharacterWidthPx ?? DEFAULT_CHARACTER_WIDTH_PX,
    'estimatedCharacterWidthPx'
  );
  const labelHeight = finitePositive(
    input.labelHeightPx ?? DEFAULT_LABEL_HEIGHT_PX,
    'labelHeightPx'
  );
  const minFeatureWidth = finiteNonNegative(
    input.minFeatureWidthPx ?? DEFAULT_MIN_FEATURE_WIDTH_PX,
    'minFeatureWidthPx'
  );
  const maxCharacters = input.maxLabelCharacters ?? DEFAULT_MAX_LABEL_CHARACTERS;
  requirePositiveInteger(maxCharacters, 'maxLabelCharacters');

  const labels: BoundedIntervalLabel[] = [];
  const viewStart = input.viewportBpRange.start;
  const viewEnd = input.viewportBpRange.end;
  if (
    !Number.isFinite(viewStart) ||
    !Number.isFinite(viewEnd) ||
    viewEnd <= viewStart ||
    !Number.isFinite(input.viewportWidthPx) ||
    input.viewportWidthPx <= 0
  ) {
    return labels;
  }

  for (let recordIndex = 0; recordIndex < input.records.length; recordIndex += 1) {
    if (labels.length >= input.maxLabels) break;
    const record = input.records[recordIndex];
    const lane = input.laneAssignments[recordIndex];
    if (!Number.isSafeInteger(lane) || lane < 0) continue;
    if (record.start >= viewEnd || record.end <= viewStart) continue;
    if (input.isDensityRecord?.(record, recordIndex)) continue;

    const rawLabel = input.labelForRecord(record, recordIndex)?.trim();
    if (!rawLabel) continue;
    const strand = input.strandForRecord?.(record, recordIndex);
    const directionalLabel =
      strand === '-' ? `← ${rawLabel}` : strand === '+' ? `${rawLabel} →` : rawLabel;

    const projectedStart = input.bpToX(Math.max(record.start, viewStart));
    const projectedEnd = input.bpToX(Math.min(record.end, viewEnd));
    if (!Number.isFinite(projectedStart) || !Number.isFinite(projectedEnd)) continue;
    const visibleLeft = Math.max(0, Math.min(projectedStart, projectedEnd));
    const visibleRight = Math.min(input.viewportWidthPx, Math.max(projectedStart, projectedEnd));
    const featureWidth = visibleRight - visibleLeft;
    if (featureWidth < minFeatureWidth) continue;

    const availableWidth = featureWidth - padding * 2;
    const fitted = fitLabel(directionalLabel, availableWidth, characterWidth, maxCharacters);
    if (!fitted) continue;
    const y = lane * input.rowHeightPx + Math.max(0, (input.rowHeightPx - labelHeight) / 2);
    if (y + labelHeight > input.trackHeightPx) continue;

    labels.push({
      text: fitted,
      x: visibleLeft + padding,
      y,
      estimatedWidthPx: Array.from(fitted).length * characterWidth,
      recordIndex,
    });
  }
  return labels;
}

function fitLabel(
  text: string,
  availableWidthPx: number,
  characterWidthPx: number,
  maxLabelCharacters: number
): string | null {
  const widthCharacters = Math.floor(availableWidthPx / characterWidthPx);
  const capacity = Math.min(maxLabelCharacters, widthCharacters);
  if (capacity < 2) return null;
  const characters = Array.from(text);
  if (characters.length <= capacity) return text;
  return `${characters.slice(0, capacity - 1).join('')}…`;
}

function requireNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number.`);
  }
  return value;
}

function finitePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number.`);
  }
  return value;
}
