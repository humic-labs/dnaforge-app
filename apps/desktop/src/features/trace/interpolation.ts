import type { ColumnGridMapping, SamplePosition } from './types';

export function buildColumnGridMapping(
  peakPositions: ReadonlyArray<number>,
  baseToColumn: ReadonlyArray<number>,
  totalColumns: number
): ColumnGridMapping {
  if (peakPositions.length !== baseToColumn.length) {
    throw new Error(
      `buildColumnGridMapping: peakPositions (${peakPositions.length}) and ` +
        `baseToColumn (${baseToColumn.length}) must have the same length`
    );
  }
  if (!Number.isFinite(totalColumns) || totalColumns < 0) {
    throw new Error(`buildColumnGridMapping: totalColumns must be >= 0 (got ${totalColumns})`);
  }
  for (let i = 1; i < baseToColumn.length; i++) {
    if (baseToColumn[i] < baseToColumn[i - 1]) {
      throw new Error(
        `buildColumnGridMapping: baseToColumn must be non-decreasing ` +
          `(index ${i}: ${baseToColumn[i]} < ${baseToColumn[i - 1]})`
      );
    }
  }

  const N = peakPositions.length;

  if (N === 0) {
    return { sampleAtColumnX: () => null };
  }

  let columnToBaseIndex: Int32Array | null = null;
  const ensureLookup = (): Int32Array => {
    if (columnToBaseIndex !== null) return columnToBaseIndex;
    const arr = new Int32Array(totalColumns);
    arr.fill(-1);
    for (let i = 0; i < N; i++) {
      const col = baseToColumn[i];
      if (col >= 0 && col < totalColumns) {
        arr[col] = i;
      }
    }
    columnToBaseIndex = arr;
    return arr;
  };

  const firstCol = baseToColumn[0];
  const lastCol = baseToColumn[N - 1];

  const sampleAtColumnX = (column: number, frac: number): SamplePosition => {
    if (!Number.isFinite(column) || !Number.isFinite(frac)) return null;
    if (column < 0 || column >= totalColumns) return null;
    if (column < firstCol || column > lastCol) return null;

    const baseAtCol = ensureLookup()[column];
    if (baseAtCol < 0) return null;

    const p = column + (frac - 0.5);

    let i: number;
    if (frac >= 0.5) {
      i = baseAtCol;
    } else {
      i = baseAtCol - 1;
      if (i < 0) {
        return peakPositions[baseAtCol];
      }
    }

    const colA = baseToColumn[i];
    const colB = baseToColumn[i + 1];
    if (colB === undefined) {
      return peakPositions[i];
    }

    const sampleA = peakPositions[i];
    const sampleB = peakPositions[i + 1];

    if (colB === colA) return sampleA;

    const t = (p - colA) / (colB - colA);
    return sampleA + (sampleB - sampleA) * t;
  };

  return { sampleAtColumnX };
}
