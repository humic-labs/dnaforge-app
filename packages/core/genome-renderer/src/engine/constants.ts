import type { QuantitativeColumnSemantics } from '@waypoint/genome-data';

export const TILE_PX = 1024;

export const BASE_BIN_BP = 1;

export const LEVEL_FACTOR = 2;

export function binBp(level: number): number {
  return BASE_BIN_BP * LEVEL_FACTOR ** level;
}

export type { QuantitativeColumnSemantics } from '@waypoint/genome-data';

export const CONTINUOUS_QUANTITATIVE_SAMPLES_PER_PIXEL = 4;

export function quantitativeSourceBasesPerSpan(
  level: number,
  semantics: QuantitativeColumnSemantics = 'continuous-signal'
): number {
  const displayBinBp = binBp(level);
  if (semantics === 'native-interval') return BASE_BIN_BP;
  return Math.max(BASE_BIN_BP, displayBinBp / CONTINUOUS_QUANTITATIVE_SAMPLES_PER_PIXEL);
}

export function tileSpanBp(level: number): number {
  return TILE_PX * binBp(level);
}

export function tileIndex(globalBp: number, level: number): number {
  return Math.floor(globalBp / tileSpanBp(level));
}

export function tileGlobalStart(index: number, level: number): number {
  return index * tileSpanBp(level);
}

export function tileGlobalEnd(index: number, level: number): number {
  return (index + 1) * tileSpanBp(level);
}

export function maxLevelForLength(totalLengthBp: number): number {
  if (totalLengthBp <= TILE_PX * BASE_BIN_BP) return 0;
  return Math.ceil(Math.log(totalLengthBp / (TILE_PX * BASE_BIN_BP)) / Math.log(LEVEL_FACTOR));
}
