export interface SequenceStrandOverride {
  start: number;
  kind?: 'label';
  forward?: string;
  reverse?: string;
}

export function sequenceStrandOverrideAt(
  overrides: readonly SequenceStrandOverride[] | undefined,
  position: number,
  length: number,
  strand: 'forward' | 'reverse'
): string | undefined {
  if (!overrides?.length || length <= 0) return undefined;
  for (const override of overrides) {
    const bases = override[strand];
    if (!bases) continue;
    const offset = (((position - override.start) % length) + length) % length;
    if (offset < bases.length) return bases[offset];
  }
  return undefined;
}

export function applySequenceStrandOverrides(
  row: string,
  rowStart: number,
  sequenceLength: number,
  overrides: readonly SequenceStrandOverride[] | undefined,
  strand: 'forward' | 'reverse'
): string {
  if (!overrides?.length || sequenceLength <= 0) return row;
  let letters: string[] | undefined;
  for (const override of overrides) {
    const bases = override[strand];
    if (!bases) continue;
    for (let offset = 0; offset < bases.length; offset++) {
      const column =
        (((override.start + offset - rowStart) % sequenceLength) + sequenceLength) % sequenceLength;
      for (let i = column; i < row.length; i += sequenceLength) {
        letters ??= row.split('');
        letters[i] = bases[offset];
      }
    }
  }
  return letters?.join('') ?? row;
}
