export const MIN_RULER_TICK_SPACING_PX = 72;

export function computeTickStep(visibleBp: number, widthPx?: number): number {
  if (visibleBp <= 0) return 10;
  let rawStep = visibleBp / 25;
  if (widthPx !== undefined && widthPx > 0) {
    rawStep = Math.max(rawStep, (visibleBp * MIN_RULER_TICK_SPACING_PX) / widthPx);
  }
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const step = [1, 2, 5, 10].find((m) => m * magnitude >= rawStep)! * magnitude;
  return Math.max(10, step);
}

export function generateTickPositions(startBp: number, endBp: number, step: number): number[] {
  const firstTick = Math.ceil(startBp / step) * step;
  const ticks: number[] = [];
  for (let bp = firstTick; bp <= endBp; bp += step) {
    ticks.push(bp);
  }
  return ticks;
}

export function enumerateCircularRulerTickBps(
  centerBp: number,
  windowBp: number,
  genomeLength: number,
  step: number,
  circular: boolean
): number[] {
  if (genomeLength <= 0 || step <= 0 || windowBp <= 0) return [];

  const ticks = new Set<number>();
  const addRange = (startBp: number, endBp: number): void => {
    for (const bp of generateTickPositions(startBp, endBp, step)) {
      if (bp >= 0 && bp < genomeLength) ticks.add(bp);
    }
  };

  if (windowBp >= genomeLength * 0.999) {
    addRange(0, genomeLength);
    return [...ticks].sort((a, b) => a - b);
  }

  const halfVisible = windowBp / 2;
  const rawStart = centerBp - halfVisible;
  const rawEnd = centerBp + halfVisible;

  if (!circular) {
    addRange(Math.max(0, rawStart), Math.min(genomeLength, rawEnd));
    return [...ticks].sort((a, b) => a - b);
  }

  const spanBp = Math.min(genomeLength, Math.max(0, rawEnd - rawStart));
  const start = ((rawStart % genomeLength) + genomeLength) % genomeLength;
  const end = start + spanBp;
  if (end <= genomeLength) {
    addRange(start, end);
  } else {
    addRange(start, genomeLength);
    addRange(0, end - genomeLength);
  }
  return [...ticks].sort((a, b) => a - b);
}
