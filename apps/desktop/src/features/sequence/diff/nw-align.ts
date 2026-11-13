export interface GappedAlignment {
  oldGapped: string;
  newGapped: string;
}

const MATCH = 2;
const MISMATCH = -6;
const GAP_OPEN = -5;
const GAP_EXTEND = -0.1;

const DEFAULT_BANDWIDTH = 200;

const GAP_CHAR = '-';
const NEG_INF = -1e9;

export function alignSequences(
  oldSeq: string,
  newSeq: string,
  bandwidth?: number
): GappedAlignment {
  const n = oldSeq.length;
  const m = newSeq.length;

  if (n === 0 && m === 0) return { oldGapped: '', newGapped: '' };
  if (n === 0) return { oldGapped: GAP_CHAR.repeat(m), newGapped: newSeq };
  if (m === 0) return { oldGapped: oldSeq, newGapped: GAP_CHAR.repeat(n) };
  if (oldSeq === newSeq) return { oldGapped: oldSeq, newGapped: newSeq };
  if (n === m && isSparseSameLengthSubstitution(oldSeq, newSeq)) {
    return { oldGapped: oldSeq, newGapped: newSeq };
  }

  const bw = bandwidth ?? Math.max(DEFAULT_BANDWIDTH, Math.abs(n - m) + 10);
  const useBanding = n > bw * 2 || m > bw * 2;

  if (useBanding) {
    return bandedAffineNW(oldSeq, newSeq, bw);
  }
  return fullAffineNW(oldSeq, newSeq);
}

function isSparseSameLengthSubstitution(oldSeq: string, newSeq: string): boolean {
  if (oldSeq.length < 1024) return false;

  const limit = Math.max(8, Math.min(64, Math.floor(oldSeq.length * 0.001)));
  const maxRunLength = 8;
  let mismatches = 0;
  let runLength = 0;

  for (let i = 0; i < oldSeq.length; i++) {
    if (oldSeq[i] === newSeq[i]) {
      runLength = 0;
      continue;
    }

    mismatches++;
    runLength++;
    if (mismatches > limit || runLength > maxRunLength) return false;
  }

  return mismatches > 0;
}

function fullAffineNW(oldSeq: string, newSeq: string): GappedAlignment {
  const n = oldSeq.length;
  const m = newSeq.length;
  const width = m + 1;
  let previousM = new Float64Array(width).fill(NEG_INF);
  let previousX = new Float64Array(width).fill(NEG_INF);
  let previousY = new Float64Array(width).fill(NEG_INF);
  let currentM = new Float64Array(width).fill(NEG_INF);
  let currentX = new Float64Array(width).fill(NEG_INF);
  let currentY = new Float64Array(width).fill(NEG_INF);
  const predecessors = new Uint8Array((n + 1) * width);

  previousM[0] = 0;
  for (let j = 1; j <= m; j++) {
    previousY[j] = GAP_OPEN + (j - 1) * GAP_EXTEND;
    predecessors[j] = 2 << 4;
  }

  for (let i = 1; i <= n; i++) {
    currentM[0] = NEG_INF;
    currentX[0] = GAP_OPEN + (i - 1) * GAP_EXTEND;
    currentY[0] = NEG_INF;
    predecessors[i * width] = 1 << 2;
    for (let j = 1; j <= m; j++) {
      const score = oldSeq[i - 1] === newSeq[j - 1] ? MATCH : MISMATCH;
      const k = i * width + j;

      const mFromM = previousM[j - 1] + score;
      const mFromX = previousX[j - 1] + score;
      const mFromY = previousY[j - 1] + score;
      if (mFromM >= mFromX && mFromM >= mFromY) {
        currentM[j] = mFromM;
        predecessors[k] = 0;
      } else if (mFromX >= mFromY) {
        currentM[j] = mFromX;
        predecessors[k] = 1;
      } else {
        currentM[j] = mFromY;
        predecessors[k] = 2;
      }

      const xFromM = previousM[j] + GAP_OPEN;
      const xFromX = previousX[j] + GAP_EXTEND;
      if (xFromM >= xFromX) {
        currentX[j] = xFromM;
      } else {
        currentX[j] = xFromX;
        predecessors[k] |= 1 << 2;
      }

      const yFromM = currentM[j - 1] + GAP_OPEN;
      const yFromY = currentY[j - 1] + GAP_EXTEND;
      if (yFromM >= yFromY) {
        currentY[j] = yFromM;
      } else {
        currentY[j] = yFromY;
        predecessors[k] |= 2 << 4;
      }
    }
    let swap = previousM;
    previousM = currentM;
    currentM = swap;
    swap = previousX;
    previousX = currentX;
    currentX = swap;
    swap = previousY;
    previousY = currentY;
    currentY = swap;
  }

  let state: number;
  const finalM = previousM[m];
  const finalX = previousX[m];
  const finalY = previousY[m];
  if (finalM >= finalX && finalM >= finalY) {
    state = 0;
  } else if (finalX >= finalY) {
    state = 1;
  } else {
    state = 2;
  }

  return traceback(
    oldSeq,
    newSeq,
    state,
    (matrix, i, j) => (predecessors[i * width + j] >>> (matrix * 2)) & 3,
    n,
    m
  );
}

function bandedAffineNW(oldSeq: string, newSeq: string, bw: number): GappedAlignment {
  const n = oldSeq.length;
  const m = newSeq.length;

  const width = 2 * bw + 1;
  const jMinByRow = new Int32Array(n + 1);
  const jMaxByRow = new Int32Array(n + 1);
  const rowOffsetByRow = new Int32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const center = Math.round((i * m) / n);
    const min = Math.max(0, center - bw);
    jMinByRow[i] = min;
    jMaxByRow[i] = Math.min(m, center + bw);
    rowOffsetByRow[i] = i * width - min;
  }

  const M = new Float64Array((n + 1) * width).fill(NEG_INF);
  const X = new Float64Array((n + 1) * width).fill(NEG_INF);
  const Y = new Float64Array((n + 1) * width).fill(NEG_INF);
  const trM = new Uint8Array((n + 1) * width);
  const trX = new Uint8Array((n + 1) * width);
  const trY = new Uint8Array((n + 1) * width);

  const idx = (i: number, j: number) => rowOffsetByRow[i] + j;

  M[idx(0, 0)] = 0;
  for (let i = 1; i <= n && i <= bw; i++) {
    const j = 0;
    if (j >= jMinByRow[i] && j <= jMaxByRow[i]) {
      X[idx(i, j)] = GAP_OPEN + (i - 1) * GAP_EXTEND;
      trX[idx(i, j)] = 1;
    }
  }
  for (let j = 1; j <= m && j <= bw; j++) {
    const i = 0;
    if (j >= jMinByRow[i] && j <= jMaxByRow[i]) {
      Y[idx(i, j)] = GAP_OPEN + (j - 1) * GAP_EXTEND;
      trY[idx(i, j)] = 2;
    }
  }

  for (let i = 1; i <= n; i++) {
    const rowOffset = rowOffsetByRow[i];
    const prevRowOffset = rowOffsetByRow[i - 1];
    const minI = jMinByRow[i];
    const maxI = jMaxByRow[i];
    const prevMin = jMinByRow[i - 1];
    const prevMax = jMaxByRow[i - 1];
    const lo = Math.max(1, minI);
    const hi = maxI;
    for (let j = lo; j <= hi; j++) {
      const score = oldSeq[i - 1] === newSeq[j - 1] ? MATCH : MISMATCH;
      const k = rowOffset + j;

      if (j - 1 >= prevMin && j - 1 <= prevMax) {
        const prev = prevRowOffset + j - 1;
        const mFromM = M[prev] + score;
        const mFromX = X[prev] + score;
        const mFromY = Y[prev] + score;
        if (mFromM >= mFromX && mFromM >= mFromY) {
          M[k] = mFromM;
          trM[k] = 0;
        } else if (mFromX >= mFromY) {
          M[k] = mFromX;
          trM[k] = 1;
        } else {
          M[k] = mFromY;
          trM[k] = 2;
        }
      }

      if (j >= prevMin && j <= prevMax) {
        const prev = prevRowOffset + j;
        const xFromM = M[prev] + GAP_OPEN;
        const xFromX = X[prev] + GAP_EXTEND;
        if (xFromM >= xFromX) {
          X[k] = xFromM;
          trX[k] = 0;
        } else {
          X[k] = xFromX;
          trX[k] = 1;
        }
      }

      if (j - 1 >= minI && j - 1 <= maxI) {
        const prev = rowOffset + j - 1;
        const yFromM = M[prev] + GAP_OPEN;
        const yFromY = Y[prev] + GAP_EXTEND;
        if (yFromM >= yFromY) {
          Y[k] = yFromM;
          trY[k] = 0;
        } else {
          Y[k] = yFromY;
          trY[k] = 2;
        }
      }
    }
  }

  const k = idx(n, m);
  const finalM = M[k];
  const finalX = X[k];
  const finalY = Y[k];
  let state: number;
  if (finalM >= finalX && finalM >= finalY) {
    state = 0;
  } else if (finalX >= finalY) {
    state = 1;
  } else {
    state = 2;
  }

  const oldChars: string[] = [];
  const newChars: string[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (j < jMinByRow[i] || j > jMaxByRow[i]) {
      if (i > 0) {
        oldChars.push(oldSeq[i - 1]);
        newChars.push(GAP_CHAR);
        i--;
      } else {
        oldChars.push(GAP_CHAR);
        newChars.push(newSeq[j - 1]);
        j--;
      }
      continue;
    }

    const k = idx(i, j);
    if (state === 0) {
      oldChars.push(oldSeq[i - 1]);
      newChars.push(newSeq[j - 1]);
      state = trM[k];
      i--;
      j--;
    } else if (state === 1) {
      oldChars.push(oldSeq[i - 1]);
      newChars.push(GAP_CHAR);
      state = trX[k];
      i--;
    } else {
      oldChars.push(GAP_CHAR);
      newChars.push(newSeq[j - 1]);
      state = trY[k];
      j--;
    }
  }

  oldChars.reverse();
  newChars.reverse();

  return {
    oldGapped: oldChars.join(''),
    newGapped: newChars.join(''),
  };
}

function traceback(
  oldSeq: string,
  newSeq: string,
  startState: number,
  readPredecessor: (matrix: 0 | 1 | 2, row: number, column: number) => number,
  n: number,
  m: number
): GappedAlignment {
  const oldChars: string[] = [];
  const newChars: string[] = [];
  let i = n;
  let j = m;
  let state = startState;

  while (i > 0 || j > 0) {
    if (state === 0) {
      if (i === 0 || j === 0) {
        if (i > 0) {
          oldChars.push(oldSeq[i - 1]);
          newChars.push(GAP_CHAR);
          i--;
        } else {
          oldChars.push(GAP_CHAR);
          newChars.push(newSeq[j - 1]);
          j--;
        }
      } else {
        oldChars.push(oldSeq[i - 1]);
        newChars.push(newSeq[j - 1]);
        state = readPredecessor(0, i, j);
        i--;
        j--;
      }
    } else if (state === 1) {
      if (i === 0) {
        oldChars.push(GAP_CHAR);
        newChars.push(newSeq[j - 1]);
        j--;
      } else {
        oldChars.push(oldSeq[i - 1]);
        newChars.push(GAP_CHAR);
        state = readPredecessor(1, i, j);
        i--;
      }
    } else {
      if (j === 0) {
        oldChars.push(oldSeq[i - 1]);
        newChars.push(GAP_CHAR);
        i--;
      } else {
        oldChars.push(GAP_CHAR);
        newChars.push(newSeq[j - 1]);
        state = readPredecessor(2, i, j);
        j--;
      }
    }
  }

  oldChars.reverse();
  newChars.reverse();

  return {
    oldGapped: oldChars.join(''),
    newGapped: newChars.join(''),
  };
}
