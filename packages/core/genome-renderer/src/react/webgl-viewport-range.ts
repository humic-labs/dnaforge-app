export function recenterViewportRangeOnCamera(input: {
  currentRange: [number, number] | null | undefined;
  centerBp: number;
  genomeLength: number;
  circular: boolean;
}): [number, number] | null {
  const { currentRange, centerBp, genomeLength, circular } = input;
  if (!currentRange || genomeLength <= 0) return null;

  const [rawStart, rawEnd] = currentRange;
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || !Number.isFinite(centerBp)) {
    return null;
  }

  const span =
    rawEnd < rawStart ? genomeLength - rawStart + rawEnd + 1 : Math.abs(rawEnd - rawStart) + 1;
  const boundedSpan = Math.max(1, Math.min(genomeLength, span));
  if (boundedSpan >= genomeLength) return [0, genomeLength - 1];

  const halfBefore = (boundedSpan - 1) / 2;
  let start = centerBp - halfBefore;
  let end = start + boundedSpan - 1;

  if (circular) {
    const normalize = (bp: number) => ((bp % genomeLength) + genomeLength) % genomeLength;
    return [normalize(start), normalize(end)];
  }

  if (start < 0) {
    end -= start;
    start = 0;
  }
  if (end > genomeLength - 1) {
    start -= end - (genomeLength - 1);
    end = genomeLength - 1;
  }
  return [
    Math.max(0, Math.min(genomeLength - 1, start)),
    Math.max(0, Math.min(genomeLength - 1, end)),
  ];
}
