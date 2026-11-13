import type { CodonInfo, IntronInfo } from '../../../biology/translation';

export function projectCodonColumns(
  codons: readonly CodonInfo[],
  biologicalLength: number,
  bioToColumn: (base: number) => number | null
): CodonInfo[] {
  return codons.flatMap((codon) => {
    const length =
      codon.endBp > codon.startBp
        ? codon.endBp - codon.startBp
        : biologicalLength - codon.startBp + codon.endBp;
    const spans: Array<{ start: number; end: number }> = [];
    for (let offset = 0; offset < length; offset += 1) {
      const column = bioToColumn((codon.startBp + offset) % biologicalLength);
      if (column === null) continue;
      const last = spans[spans.length - 1];
      if (last?.end === column) last.end = column + 1;
      else spans.push({ start: column, end: column + 1 });
    }
    if (!spans.length) return [];
    const codonStartBp = bioToColumn(codon.codonStartBp ?? codon.startBp);
    const codonEndBp = bioToColumn(
      codon.codonEndBp ?? (codon.endBp - 1 + biologicalLength) % biologicalLength
    );
    if (codonStartBp === null || codonEndBp === null) return [];
    const widest = spans.reduce(
      (best, span, index) =>
        span.end - span.start > spans[best].end - spans[best].start ? index : best,
      0
    );
    return spans.map((span, index) => ({
      ...codon,
      startBp: span.start,
      endBp: span.end,
      codonStartBp,
      codonEndBp,

      renderLetter: codon.renderLetter !== false && index === widest && span.end - span.start >= 2,
    }));
  });
}

export function projectIntronColumns(
  introns: readonly IntronInfo[],
  biologicalLength: number,
  bioToColumn: (base: number) => number | null
): IntronInfo[] {
  const boundary = (base: number) => {
    if (base !== biologicalLength) return bioToColumn(base);
    const last = bioToColumn(base - 1);
    return last === null ? null : last + 1;
  };
  return introns.flatMap((intron) => {
    const start = boundary(intron.genomicStart);
    const end = boundary(intron.genomicEnd);
    return start === null || end === null
      ? []
      : [{ ...intron, genomicStart: start, genomicEnd: end }];
  });
}
