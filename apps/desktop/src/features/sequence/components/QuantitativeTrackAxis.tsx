import {
  normalizeQuantitativeTrackPresentation,
  resolveQuantitativeDisplayRange,
  type QuantitativeScaleMode,
  type QuantitativeScaleTransform,
  type QuantitativeSourceSummaryV1,
  type QuantitativeTrackPresentationV1,
} from '@waypoint/genome-data';

export interface QuantitativeAxisRange {
  readonly min: number;
  readonly max: number;
  readonly transform: QuantitativeScaleTransform;
}

export interface QuantitativeAxisTick {
  readonly value: number;
  readonly position: number;
  readonly label: string;
}

interface QuantitativeRendererRangeDiagnostics {
  readonly displayMin?: unknown;
  readonly displayMax?: unknown;
  readonly scaleTransform?: unknown;
  readonly scaleMode?: unknown;
}

export function quantitativeAxisRangeFromDiagnostics(
  diagnostics: object | null | undefined,
  expectedTransform: QuantitativeScaleTransform,
  expectedMode?: QuantitativeScaleMode
): QuantitativeAxisRange | null {
  if (!diagnostics) return null;
  const range = diagnostics as QuantitativeRendererRangeDiagnostics;
  if (range.scaleTransform !== expectedTransform) return null;
  if (expectedMode !== undefined && range.scaleMode !== expectedMode) return null;
  if (
    typeof range.displayMin !== 'number' ||
    !Number.isFinite(range.displayMin) ||
    typeof range.displayMax !== 'number' ||
    !Number.isFinite(range.displayMax) ||
    range.displayMax <= range.displayMin
  ) {
    return null;
  }
  return { min: range.displayMin, max: range.displayMax, transform: expectedTransform };
}

export function quantitativeAxisRangeFromPresentation(
  presentationValue: QuantitativeTrackPresentationV1 | undefined,
  summary: QuantitativeSourceSummaryV1 | undefined
): QuantitativeAxisRange | null {
  const presentation = normalizeQuantitativeTrackPresentation(presentationValue);
  if (presentation.scale.mode === 'visible-window') return null;
  if (
    (presentation.scale.mode === 'robust-global' || presentation.scale.mode === 'full-global') &&
    !summary
  ) {
    return null;
  }
  try {
    const range = resolveQuantitativeDisplayRange({
      presentation,
      sourceSummary: summary,
      visibleValues: [],
    });
    return { min: range.rawMin, max: range.rawMax, transform: range.transform };
  } catch {
    return null;
  }
}

export function buildQuantitativeAxisTicks(
  range: QuantitativeAxisRange
): ReadonlyArray<QuantitativeAxisTick> {
  const displayMin = transformValue(range.min, range.transform);
  const displayMax = transformValue(range.max, range.transform);
  if (!Number.isFinite(displayMin) || !Number.isFinite(displayMax) || displayMax <= displayMin) {
    return [];
  }

  const values =
    range.transform === 'log1p'
      ? buildLogarithmicTickValues(range.min, range.max)
      : buildLinearTickValues(range.min, range.max);

  return values
    .map((value) => {
      const displayValue = transformValue(value, range.transform);
      const position = (displayMax - displayValue) / (displayMax - displayMin);
      return { value, position, label: formatQuantitativeAxisValue(value) };
    })
    .filter((tick) => Number.isFinite(tick.position) && tick.position > 0 && tick.position < 1)
    .sort((left, right) => left.position - right.position);
}

export function QuantitativeTrackAxis({
  trackId,
  label,
  range,
}: {
  trackId: string;
  label: string;
  range: QuantitativeAxisRange;
}) {
  const ticks = buildQuantitativeAxisTicks(range);
  if (ticks.length === 0) return null;
  const accessibleTransform = range.transform === 'log1p' ? 'Logarithmic' : 'Linear';

  return (
    <div
      data-testid={`quantitative-y-axis-${trackId}`}
      data-scale-transform={range.transform}
      data-tick-count={ticks.length}
      role="img"
      aria-label={`${accessibleTransform} y-axis for ${label}: ${formatQuantitativeAxisValue(range.min)} to ${formatQuantitativeAxisValue(range.max)}`}
      className="pointer-events-none absolute bottom-0 left-0 top-0 z-10 w-2 select-none"
    >
      <div aria-hidden className="absolute inset-0">
        <span
          data-testid="quantitative-y-axis-spine"
          className="absolute inset-y-0 left-0 w-px bg-fg-subtle/60"
        />
        {ticks.map((tick) => (
          <span
            key={tick.value}
            data-testid="quantitative-y-axis-tick"
            data-axis-tick-position={tick.position}
            data-axis-tick-value={tick.value}
            style={{ top: `${tick.position * 100}%` }}
            className="absolute left-0 h-px w-1 bg-fg-subtle/60"
          />
        ))}
      </div>
    </div>
  );
}

function transformValue(value: number, transform: QuantitativeScaleTransform): number {
  return transform === 'log1p' ? Math.log1p(value) : value;
}

function buildLinearTickValues(min: number, max: number): number[] {
  const step = niceTickStep((max - min) / 5);
  if (!Number.isFinite(step) || step <= 0) return [];

  const epsilon = rangeEpsilon(min, max);
  const first = Math.ceil((min + epsilon) / step) * step;
  const values: number[] = [];
  for (let value = first; value < max - epsilon; value += step) {
    values.push(normalizeTickValue(value));
  }
  return values;
}

function niceTickStep(approximateStep: number): number {
  if (!Number.isFinite(approximateStep) || approximateStep <= 0) return Number.NaN;
  const power = 10 ** Math.floor(Math.log10(approximateStep));
  const error = approximateStep / power;
  const factor =
    error >= Math.sqrt(50) ? 10 : error >= Math.sqrt(10) ? 5 : error >= Math.sqrt(2) ? 2 : 1;
  return factor * power;
}

function buildLogarithmicTickValues(min: number, max: number): number[] {
  if (max <= 0) return [];

  const lowerBound = min > 0 ? min : max / 100;
  const firstExponent = Math.floor(Math.log10(lowerBound));
  const lastExponent = Math.ceil(Math.log10(max));
  const epsilon = rangeEpsilon(min, max);
  const values: number[] = [];

  for (let exponent = firstExponent; exponent <= lastExponent; exponent += 1) {
    const power = 10 ** exponent;
    for (const multiplier of [1, 2, 5]) {
      const value = normalizeTickValue(multiplier * power);
      if (value >= lowerBound - epsilon && value > min + epsilon && value < max - epsilon) {
        values.push(value);
      }
    }
  }

  return values;
}

function rangeEpsilon(min: number, max: number): number {
  return Math.max(
    Math.abs(max - min) * 1e-12,
    Number.EPSILON * Math.max(Math.abs(min), Math.abs(max), 1)
  );
}

function normalizeTickValue(value: number): number {
  return Number(value.toPrecision(12));
}

function formatQuantitativeAxisValue(value: number): string {
  if (Object.is(value, -0) || Math.abs(value) < 1e-12) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000 || magnitude < 0.001) return value.toExponential(2);
  if (magnitude >= 1_000) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  return value.toLocaleString(undefined, { maximumSignificantDigits: 3 });
}
