const ALLOWED = new Set(['A', 'C', 'G', 'T']);

export function computeGcContent(sequence: string, windowSize = 100): Float32Array {
  const n = sequence.length;
  const out = new Float32Array(n);
  if (n === 0) return out;

  const upper = sequence.toUpperCase();
  const half = Math.max(1, Math.floor(windowSize / 2));

  let gc = 0;
  let total = 0;
  const initialEnd = Math.min(n, half);
  for (let i = 0; i < initialEnd; i++) {
    const ch = upper.charCodeAt(i);
    if (ch === 67 || ch === 71) {
      gc += 1;
      total += 1;
    } else if (ch === 65 || ch === 84) {
      total += 1;
    } else if (ALLOWED.has(upper[i])) {
      total += 1;
    }
  }

  for (let i = 0; i < n; i++) {
    out[i] = total > 0 ? gc / total : 0;

    const leaveIdx = i - half;
    if (leaveIdx >= 0) {
      const ch = upper.charCodeAt(leaveIdx);
      if (ch === 67 || ch === 71) {
        gc -= 1;
        total -= 1;
      } else if (ch === 65 || ch === 84) {
        total -= 1;
      } else if (ALLOWED.has(upper[leaveIdx])) {
        total -= 1;
      }
    }
    const enterIdx = i + half + 1;
    if (enterIdx < n) {
      const ch = upper.charCodeAt(enterIdx);
      if (ch === 67 || ch === 71) {
        gc += 1;
        total += 1;
      } else if (ch === 65 || ch === 84) {
        total += 1;
      } else if (ALLOWED.has(upper[enterIdx])) {
        total += 1;
      }
    }
  }
  return out;
}
