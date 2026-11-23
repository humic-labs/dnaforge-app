export type PaneResizeDisplaySizeInput = {
  liveWidth: number;
  liveHeight: number;
  geometryHeight: number;
  morph: number;
};

export type PaneResizeDisplaySize = {
  width: number;
  height: number;
  geometryHeight: number;
  morph: number;
  backingWidth: number;
  backingHeight: number;
  cssWidth: number;
  cssHeight: number;
  immediate: true;
};

export function resolvePaneResizeDisplaySize(
  input: PaneResizeDisplaySizeInput
): PaneResizeDisplaySize {
  const width = Math.max(1, Math.round(input.liveWidth));
  const height = Math.max(1, Math.round(input.liveHeight));
  const geometryHeight = Math.max(1, Math.round(input.geometryHeight));
  const morph = Number.isFinite(input.morph) ? input.morph : 0;

  return {
    width,
    height,
    geometryHeight,
    morph,
    backingWidth: width,
    backingHeight: height,
    cssWidth: width,
    cssHeight: height,
    immediate: true,
  };
}

export function isCompositorStretchPlan(plan: {
  cssWidth: number;
  cssHeight: number;
  backingWidth: number;
  backingHeight: number;
}): boolean {
  return (
    Math.abs(plan.cssWidth - plan.backingWidth) > 0.5 ||
    Math.abs(plan.cssHeight - plan.backingHeight) > 0.5
  );
}

export function isDrawAspectMismatchPlan(
  plan: { cssWidth: number; cssHeight: number; width: number; height: number },
  epsilon = 0.05
): boolean {
  const cssAspect = plan.cssWidth / Math.max(1, plan.cssHeight);
  const stateAspect = plan.width / Math.max(1, plan.height);
  return Math.abs(cssAspect - stateAspect) > epsilon;
}

export function resolveSequencePaneHeightDuringMapResize(input: {
  layoutHeight: number;
  mapHeight: number;
  handleHeight: number;
  minSequenceHeight: number;
}): number {
  const layoutHeight = Math.max(0, input.layoutHeight);
  const mapHeight = Math.max(0, input.mapHeight);
  const handleHeight = Math.max(0, input.handleHeight);
  const minSequenceHeight = Math.max(0, input.minSequenceHeight);
  const available = layoutHeight - mapHeight - handleHeight;
  return Math.max(minSequenceHeight, Math.round(available));
}

const paneExtentBlock = 128;

export function roundedSequencePaneExtent(required: number): number {
  return Math.ceil(required / paneExtentBlock) * paneExtentBlock;
}

export function reserveSequencePaneExtent(required: number, previous: number): number {
  if (required <= 0) return previous;
  if (required <= previous && previous - required < 3 * paneExtentBlock) return previous;
  return roundedSequencePaneExtent(required) + paneExtentBlock;
}
