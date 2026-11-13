const BENCHLING_MISSING_VALUE_TOKENS = new Set(['none', '-']);

export function isBenchlingMissingSourceValue(value: string): boolean {
  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
  return normalized.length === 0 || BENCHLING_MISSING_VALUE_TOKENS.has(normalized);
}
