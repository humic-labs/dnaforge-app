export type DataColorValue = string | number | boolean | null | undefined;

export type DataColorScale =
  | {
      readonly kind: 'continuous';
      readonly domain: readonly number[];
      readonly colors: readonly string[];
      readonly missingColor: string;
      readonly transform: 'linear' | 'log10';
      readonly quantization?: number;
    }
  | {
      readonly kind: 'categorical';
      readonly colors: Readonly<Record<string, string>>;
      readonly missingColor: string;
    };

export interface DataColorBinding<Target> {
  readonly inputIndex: number;
  readonly target: Target;
}

export interface ResolvedDataColor<Target> extends DataColorBinding<Target> {
  readonly color: string;
}

export interface DataColorMapping<Input, Target> {
  readonly records: readonly Input[];
  readonly bindings: readonly DataColorBinding<Target>[];
  readonly targetKey: (target: Target) => string | number;
  readonly color: (input: Input, inputIndex: number) => string;
  readonly filter?: (input: Input, inputIndex: number) => boolean;
}

export function compileDataColors<Input, Target>({
  records,
  bindings,
  targetKey,
  color,
  filter,
}: DataColorMapping<Input, Target>): ResolvedDataColor<Target>[] {
  const seen = new Map<string | number, number>();
  const colors = new Map<number, string>();
  const result: ResolvedDataColor<Target>[] = [];
  for (const binding of bindings) {
    const { inputIndex, target } = binding;
    if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= records.length) {
      throw new Error('A target binding refers to an observation outside the supplied data.');
    }
    const input = records[inputIndex];
    if (filter && !filter(input, inputIndex)) continue;
    const key = targetKey(target);
    if (seen.has(key) && seen.get(key) !== inputIndex) {
      throw new Error(
        'Multiple observations overlap this target. Select a replicate/condition or publish an explicitly aggregated result.'
      );
    }
    seen.set(key, inputIndex);
    let resolved = colors.get(inputIndex);
    if (resolved === undefined) {
      resolved = color(input, inputIndex);
      if (!/^#[0-9a-f]{6}$/i.test(resolved)) {
        throw new Error('A color mapping must return a six-digit hex color.');
      }
      colors.set(inputIndex, resolved);
    }
    result.push({ inputIndex, target, color: resolved });
  }
  return result;
}

export function dataColor(value: DataColorValue, style: DataColorScale): string {
  if (value === null || value === undefined || value === '') return style.missingColor;
  if (style.kind === 'categorical') {
    return Object.prototype.hasOwnProperty.call(style.colors, String(value))
      ? style.colors[String(value)]
      : style.missingColor;
  }
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(numeric)) {
    throw new Error(
      'The selected value is nonnumeric; choose a categorical palette or supply numeric results.'
    );
  }
  const transform = style.transform === 'log10' ? Math.log10 : (number: number) => number;
  if (style.transform === 'log10' && numeric <= 0) {
    throw new Error('Log10 cannot display zero or negative values.');
  }
  const [low, high] = style.domain.map(transform);
  if (
    style.domain.length !== 2 ||
    !Number.isFinite(low) ||
    !Number.isFinite(high) ||
    low >= high ||
    style.colors.length < 2
  ) {
    throw new Error('A continuous color scale needs an increasing domain and at least two colors.');
  }
  if (
    style.quantization !== undefined &&
    (!Number.isInteger(style.quantization) || style.quantization < 1)
  ) {
    throw new Error('Color steps must be a positive whole number.');
  }
  const t = Math.max(0, Math.min(1, (transform(numeric) - low) / (high - low)));
  const fraction =
    (style.quantization ? Math.round(t * style.quantization) / style.quantization : t) *
    (style.colors.length - 1);
  const index = Math.min(style.colors.length - 2, Math.floor(fraction));
  const amount = fraction - index;
  const channels = (color: string) =>
    [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
  const a = channels(style.colors[index]);
  const b = channels(style.colors[index + 1]);
  return `#${a
    .map((value, index) =>
      Math.round(value + (b[index] - value) * amount)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}
