export type SourceBaseIndex = number & { readonly __brand: 'SourceBaseIndex' };
export type SourceBoundaryIndex = number & { readonly __brand: 'SourceBoundaryIndex' };
export type UnwrappedSourceBase = number & { readonly __brand: 'UnwrappedSourceBase' };
export type UnwrappedSourceBoundary = number & { readonly __brand: 'UnwrappedSourceBoundary' };
export type RowPosition = number & { readonly __brand: 'RowPosition' };
export type BioCol = number & { readonly __brand: 'BioCol' };
export type ProductPosition = number & { readonly __brand: 'ProductPosition' };

export interface UnwrappedSourceInterval {
  start: number;
  end: number;
  sourceLength: number;
  circular: boolean;
}

export interface ProductInterval {
  start: number;
  end: number;
}

export function asRowPosition(value: number): RowPosition {
  return value as RowPosition;
}

export function asBioCol(value: number): BioCol {
  return value as BioCol;
}

export function asProductPosition(value: number): ProductPosition {
  return value as ProductPosition;
}

export function asUnwrappedSourceBase(value: number): UnwrappedSourceBase {
  return value as UnwrappedSourceBase;
}

export function normalizeSourceBase(
  unwrapped: number,
  sourceLength: number
): SourceBaseIndex | null {
  if (sourceLength <= 0) return null;
  return positiveModulo(unwrapped, sourceLength) as SourceBaseIndex;
}

export function unwrapCircularInterval(
  start: number,
  end: number,
  sourceLength: number,
  circular: boolean
): UnwrappedSourceInterval {
  if (!circular || sourceLength <= 0 || end >= start) {
    return { start, end, sourceLength, circular };
  }
  return { start, end: end + sourceLength, sourceLength, circular };
}

export function sourceBaseInIntervals(
  sourceBase: number,
  intervals: readonly UnwrappedSourceInterval[]
): boolean {
  return intervals.some((interval) => sourceBaseInInterval(sourceBase, interval));
}

export function sourceBaseInInterval(
  sourceBase: number,
  interval: UnwrappedSourceInterval
): boolean {
  if (!interval.circular || interval.sourceLength <= 0) {
    return sourceBase >= interval.start && sourceBase < interval.end;
  }
  const length = Math.max(0, interval.end - interval.start);
  if (length >= interval.sourceLength) return length > 0;
  const offset = positiveModulo(sourceBase - interval.start, interval.sourceLength);
  return offset < length;
}

export function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}
