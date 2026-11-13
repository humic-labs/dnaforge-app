const NICE_STEPS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000,
];

export function pickTickStep(
  pxPerBase: number,
  minPxBetweenLabels: number = 40,
  minStep: number = 1
): number {
  if (!(pxPerBase > 0)) return Math.max(1, minStep);
  for (const step of NICE_STEPS) {
    if (step < minStep) continue;
    if (step * pxPerBase >= minPxBetweenLabels) return step;
  }
  return NICE_STEPS[NICE_STEPS.length - 1];
}
