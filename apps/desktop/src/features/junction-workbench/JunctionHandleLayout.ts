export const HANDLE_REVEAL_INSET_MAX_PX = 96;

export interface JunctionHandleLayoutInput {
  rawCenterX: number;
  hitWidth: number;
  interactive: boolean;
  boundaryDrawable: boolean;
}

export type JunctionHandlePlacement =
  | { kind: 'boundary'; centerX: number; indicatorX: number }
  | {
      kind: 'offscreen';
      edge: 'left' | 'right';
      order: number;
      row: 0 | 1;
      centerX: number;
      distancePx: number;
    }
  | { kind: 'hidden' };

export function layoutJunctionHandles(
  inputs: readonly JunctionHandleLayoutInput[],
  overlayWidth: number,
  parkedWidth: number
): JunctionHandlePlacement[] {
  if (!Number.isFinite(overlayWidth) || overlayWidth <= 0) {
    return inputs.map((input) =>
      input.boundaryDrawable
        ? { kind: 'boundary', centerX: input.rawCenterX, indicatorX: input.hitWidth / 2 }
        : { kind: 'hidden' }
    );
  }

  const placements = new Array<JunctionHandlePlacement>(inputs.length);
  const offLeft: number[] = [];
  const offRight: number[] = [];
  const inView: number[] = [];
  const markers: number[] = [];
  inputs.forEach((input, index) => {
    const offscreen =
      Number.isFinite(input.rawCenterX) &&
      (input.rawCenterX < 0 || input.rawCenterX > overlayWidth);
    if (offscreen && !input.interactive) placements[index] = { kind: 'hidden' };
    else if (offscreen && input.rawCenterX < 0) offLeft.push(index);
    else if (offscreen) offRight.push(index);
    else if (!input.boundaryDrawable) placements[index] = { kind: 'hidden' };
    else if (!Number.isFinite(input.rawCenterX)) {
      placements[index] = {
        kind: 'boundary',
        centerX: input.rawCenterX,
        indicatorX: input.hitWidth / 2,
      };
    } else if (input.interactive) inView.push(index);
    else markers.push(index);
  });

  inView.sort((a, b) => inputs[a].rawCenterX - inputs[b].rawCenterX || a - b);
  const centers = inView.map((index) => clampCenter(inputs[index], overlayWidth));
  for (let i = 1; i < inView.length; i++) {
    centers[i] = Math.max(
      centers[i],
      centers[i - 1] + keptSeparation(inputs[inView[i - 1]], inputs[inView[i]])
    );
  }
  const last = inView.length - 1;
  if (last >= 0) {
    centers[last] = Math.min(centers[last], maxCenter(inputs[inView[last]], overlayWidth));
  }
  for (let i = last - 1; i >= 0; i--) {
    centers[i] = Math.min(
      centers[i],
      centers[i + 1] - keptSeparation(inputs[inView[i]], inputs[inView[i + 1]])
    );
  }
  inView.forEach((index, i) => {
    placements[index] = boundaryPlacement(inputs[index], centers[i]);
  });
  markers.forEach((index) => {
    placements[index] = boundaryPlacement(inputs[index], clampCenter(inputs[index], overlayWidth));
  });

  const gripSpans = [...inView, ...markers].map((index) => {
    const placement = placements[index] as Extract<JunctionHandlePlacement, { kind: 'boundary' }>;
    const half = inputs[index].hitWidth / 2;
    return { start: placement.centerX - half, end: placement.centerX + half };
  });
  const leftZoneEnd = offLeft.length * parkedWidth;
  const rightZoneStart = overlayWidth - offRight.length * parkedWidth;
  const leftRow = gripSpans.some((span) => span.start < leftZoneEnd) ? 1 : 0;
  const rightRow = gripSpans.some((span) => span.end > rightZoneStart) ? 1 : 0;

  offLeft.sort((a, b) => inputs[a].rawCenterX - inputs[b].rawCenterX || a - b);
  offLeft.forEach((index, order) => {
    placements[index] = {
      kind: 'offscreen',
      edge: 'left',
      order,
      row: leftRow,
      centerX: parkedWidth / 2 + order * parkedWidth,
      distancePx: -inputs[index].rawCenterX,
    };
  });
  offRight.sort((a, b) => inputs[b].rawCenterX - inputs[a].rawCenterX || a - b);
  offRight.forEach((index, order) => {
    placements[index] = {
      kind: 'offscreen',
      edge: 'right',
      order,
      row: rightRow,
      centerX: overlayWidth - parkedWidth / 2 - order * parkedWidth,
      distancePx: inputs[index].rawCenterX - overlayWidth,
    };
  });
  return placements;
}

export function panDeltaToRevealHandle(rawCenterX: number, overlayWidth: number): number {
  if (!Number.isFinite(rawCenterX) || !Number.isFinite(overlayWidth) || overlayWidth <= 0) return 0;
  const inset = Math.min(HANDLE_REVEAL_INSET_MAX_PX, overlayWidth / 4);
  if (rawCenterX < 0) return rawCenterX - inset;
  if (rawCenterX > overlayWidth) return rawCenterX - (overlayWidth - inset);
  return 0;
}

function clampCenter(input: JunctionHandleLayoutInput, overlayWidth: number): number {
  if (overlayWidth <= input.hitWidth) return overlayWidth / 2;
  return Math.max(input.hitWidth / 2, Math.min(maxCenter(input, overlayWidth), input.rawCenterX));
}

function maxCenter(input: JunctionHandleLayoutInput, overlayWidth: number): number {
  if (overlayWidth <= input.hitWidth) return overlayWidth / 2;
  return overlayWidth - input.hitWidth / 2;
}

function keptSeparation(left: JunctionHandleLayoutInput, right: JunctionHandleLayoutInput): number {
  return Math.min(right.rawCenterX - left.rawCenterX, Math.min(left.hitWidth, right.hitWidth) / 2);
}

function boundaryPlacement(
  input: JunctionHandleLayoutInput,
  centerX: number
): JunctionHandlePlacement {
  return {
    kind: 'boundary',
    centerX,
    indicatorX: input.hitWidth / 2 + input.rawCenterX - centerX,
  };
}
