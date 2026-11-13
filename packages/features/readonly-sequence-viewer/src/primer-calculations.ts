export function calculateGC(sequence: string): number {
  if (!sequence || sequence.length === 0) return 0;

  const upper = sequence.toUpperCase();
  let gcCount = 0;

  for (const base of upper) {
    if (base === 'G' || base === 'C') {
      gcCount++;
    }
  }

  return Math.round((gcCount / sequence.length) * 100 * 10) / 10;
}

export function calculateTm(sequence: string): number {
  if (!sequence || sequence.length === 0) return 0;

  const upper = sequence.toUpperCase();
  const len = upper.length;

  let gc = 0;
  let at = 0;

  for (const base of upper) {
    if (base === 'G' || base === 'C') {
      gc++;
    } else if (base === 'A' || base === 'T') {
      at++;
    }
  }

  if (len < 14) {
    return 4 * gc + 2 * at;
  } else if (len <= 50) {
    const tm = 64.9 + (41 * (gc - 16.4)) / len;
    return Math.round(tm * 10) / 10;
  } else {
    const gcPercent = (gc / len) * 100;
    const tm = 59.9 + 0.41 * gcPercent - 675 / len;
    return Math.round(tm * 10) / 10;
  }
}

export function generatePrimerId(): string {
  return `primer-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
