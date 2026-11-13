import type {
  GoldenGateFidelityDataset,
  GoldenGateFidelityDatasetKey,
} from './GoldenGateFidelityDataset';
import rawPryor2020Data from './pryor2020-four-base-ligation-counts.json';

interface RawLeanDataset {
  rowOverhangs: string[];
  columnOverhangs: string[];
  countsRowMajor: number[];
}
const RAW_DATASETS = (
  rawPryor2020Data as unknown as {
    datasets: Record<GoldenGateFidelityDatasetKey, RawLeanDataset>;
  }
).datasets;

const BASE_BITS = (() => {
  const table = new Int8Array(128).fill(-1);
  table['A'.charCodeAt(0)] = 0;
  table['a'.charCodeAt(0)] = 0;
  table['C'.charCodeAt(0)] = 1;
  table['c'.charCodeAt(0)] = 1;
  table['G'.charCodeAt(0)] = 2;
  table['g'.charCodeAt(0)] = 2;
  table['T'.charCodeAt(0)] = 3;
  table['t'.charCodeAt(0)] = 3;
  return table;
})();

export function overhangToCode(overhang: string): number {
  if (overhang.length !== 4) return -1;
  let code = 0;
  for (let i = 0; i < 4; i++) {
    const charCode = overhang.charCodeAt(i);
    const bits = charCode < 128 ? BASE_BITS[charCode] : -1;
    if (bits < 0) return -1;
    code = (code << 2) | bits;
  }
  return code;
}

export function reverseComplementCode(code: number): number {
  let rc = 0;
  for (let i = 0; i < 4; i++) {
    const b = (code >> (2 * i)) & 3;
    rc = (rc << 2) | (b ^ 3);
  }
  return rc;
}

export interface LeanFidelityIndex {
  readonly datasetKey: GoldenGateFidelityDatasetKey;
  readonly countTable: Int32Array;
}

const LEAN_INDEX_CACHE = new Map<GoldenGateFidelityDatasetKey, LeanFidelityIndex>();

export function buildLeanFidelityIndex(dataset: GoldenGateFidelityDataset): LeanFidelityIndex {
  const cached = LEAN_INDEX_CACHE.get(dataset.key);
  if (cached) return cached;

  const raw = RAW_DATASETS[dataset.key];
  const rowCodes = raw.rowOverhangs.map(overhangToCode);
  const columnCodes = raw.columnOverhangs.map(overhangToCode);
  const columnCount = raw.columnOverhangs.length;
  const countTable = new Int32Array(256 * 256);
  for (let rowIdx = 0; rowIdx < rowCodes.length; rowIdx++) {
    const rowCode = rowCodes[rowIdx];
    if (rowCode < 0) continue;
    const rawRowBase = rowIdx * columnCount;
    const tableRowBase = rowCode * 256;
    for (let colIdx = 0; colIdx < columnCount; colIdx++) {
      const columnCode = columnCodes[colIdx];
      if (columnCode < 0) continue;
      countTable[tableRowBase + columnCode] = raw.countsRowMajor[rawRowBase + colIdx];
    }
  }

  const index: LeanFidelityIndex = { datasetKey: dataset.key, countTable };
  LEAN_INDEX_CACHE.set(dataset.key, index);
  return index;
}

export interface LeanSetScore {
  valid: boolean;
  conflictCount: number;
  logFidelity: number;
  onTargetCount: number;
}

export function scoreOverhangCodes(
  codes: readonly number[],
  index: LeanFidelityIndex,
  pool: Int32Array,
  rcScratch?: Int32Array
): LeanSetScore {
  const n = codes.length;
  const countTable = index.countTable;
  const rc = rcScratch && rcScratch.length >= n ? rcScratch : new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const ci = codes[i];
    rc[i] = ci < 0 ? -1 : reverseComplementCode(ci);
  }

  let conflictCount = 0;
  for (let i = 0; i < n; i++) {
    const ci = codes[i];
    if (ci < 0) {
      conflictCount++;
      continue;
    }
    if (rc[i] === ci) conflictCount++;
    for (let j = 0; j < i; j++) {
      if (codes[j] === ci) {
        conflictCount++;
        break;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const ci = codes[i];
    if (ci < 0) continue;
    const rci = rc[i];
    let mate = -1;
    for (let j = 0; j < n; j++) {
      if (codes[j] === rci) {
        mate = j;
        break;
      }
    }
    if (mate !== -1 && mate !== i && mate < i) conflictCount++;
  }

  let poolLen = 0;
  for (let i = 0; i < n; i++) {
    const ci = codes[i];
    if (ci < 0) continue;
    const rci = rc[i];
    let seenC = false;
    let seenRc = false;
    for (let p = 0; p < poolLen; p++) {
      if (pool[p] === ci) seenC = true;
      if (pool[p] === rci) seenRc = true;
    }
    if (!seenC) pool[poolLen++] = ci;
    if (!seenRc && rci !== ci) pool[poolLen++] = rci;
  }

  let logFidelity = 0;
  let onTargetCount = 0;
  let allUsable = true;
  for (let i = 0; i < n; i++) {
    const ci = codes[i];
    if (ci < 0) {
      logFidelity = Number.NEGATIVE_INFINITY;
      allUsable = false;
      continue;
    }
    const rci = rc[i];
    if (rci === ci) {
      logFidelity = Number.NEGATIVE_INFINITY;
      allUsable = false;
      continue;
    }
    const correct = countTable[rci * 256 + ci] + countTable[ci * 256 + rci];
    onTargetCount += correct;
    let total = 0;
    for (let p = 0; p < poolLen; p++) {
      const t = pool[p];
      total += countTable[t * 256 + ci] + countTable[t * 256 + rci];
    }
    if (correct <= 0 || total <= 0) allUsable = false;
    const probability = total > 0 ? correct / total : 0;
    logFidelity += probability > 0 ? Math.log(probability) : Number.NEGATIVE_INFINITY;
  }

  return {
    valid: conflictCount === 0 && allUsable,
    conflictCount,
    logFidelity,
    onTargetCount,
  };
}
