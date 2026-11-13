export interface StadiumDimensions {
  width: number;
  height: number;
  radius: number;
  straightLength: number;
  totalLength: number;
}

export interface StadiumPoint {
  x: number;
  y: number;
  angle: number;
  segment: 'top' | 'right-cap' | 'bottom' | 'left-cap';
}

export interface ClosestSeqPosCandidate {
  segment: 'top' | 'bottom' | 'right-cap' | 'left-cap';
  normalizedPos: number;
  seqPos: number;
  distSq: number;
  closestX: number;
  closestY: number;
}

export interface ClosestSeqPosDebug {
  seqPos: number;
  best: ClosestSeqPosCandidate;
  candidates: ClosestSeqPosCandidate[];
}

export function getStadiumDimensions(
  width: number,
  height: number,
  morphToCircle: number = 0,
  padding: number = 0
): StadiumDimensions {
  const effectiveWidth = width - 2 * padding;
  const effectiveHeight = height - 2 * padding;
  const morph = Math.max(0, Math.min(1, morphToCircle));

  if (morph === 0 && effectiveWidth >= effectiveHeight) {
    const radius = effectiveHeight / 2;
    const straightLength = Math.max(0, effectiveWidth - effectiveHeight);
    const capLength = Math.PI * radius;
    const totalLength = 2 * straightLength + 2 * capLength;
    return { width: effectiveWidth, height: effectiveHeight, radius, straightLength, totalLength };
  }

  const initialRadius = effectiveHeight / 2;
  const initialStraightLength = Math.max(0, effectiveWidth - effectiveHeight);
  const perimeter = 2 * initialStraightLength + 2 * Math.PI * initialRadius;

  const unscaledStraightLength = initialStraightLength * (1 - morph);
  const unscaledRadius = (perimeter - 2 * unscaledStraightLength) / (2 * Math.PI);

  const unscaledWidth = 2 * unscaledRadius + unscaledStraightLength;
  const unscaledHeight = 2 * unscaledRadius;

  const scaleX = effectiveWidth / unscaledWidth;
  const scaleY = effectiveHeight / unscaledHeight;
  const scale = Math.min(scaleX, scaleY, 1);

  const scaledRadius = unscaledRadius * scale;
  const scaledStraightLength = unscaledStraightLength * scale;
  const scaledWidth = unscaledWidth * scale;
  const scaledHeight = unscaledHeight * scale;

  return {
    width: scaledWidth,
    height: scaledHeight,
    radius: scaledRadius,
    straightLength: scaledStraightLength,
    totalLength: perimeter * scale,
  };
}

function getSegmentBoundaries(dims: StadiumDimensions) {
  const { straightLength, radius, totalLength } = dims;
  const capLength = Math.PI * radius;
  return {
    topEnd: straightLength / totalLength,
    rightCapEnd: (straightLength + capLength) / totalLength,
    bottomEnd: (2 * straightLength + capLength) / totalLength,
    leftCapEnd: 1.0,
  };
}

function normalizeSeqPos(pos: number, seqLength: number): number {
  return ((pos % seqLength) + seqLength) % seqLength;
}

function normalizedToSeqPos(
  normalizedPos: number,
  seqLength: number,
  viewOffsetNormalized: number
): number {
  const viewOffsetBp = viewOffsetNormalized * seqLength;
  const seqPos = (normalizedPos * seqLength + viewOffsetBp + seqLength) % seqLength;
  return normalizeSeqPos(Math.round(seqPos), seqLength);
}

export function normalizedPosToPoint(
  normalizedPos: number,
  dims: StadiumDimensions,
  padding: number = 0
): StadiumPoint {
  const pos = ((normalizedPos % 1) + 1) % 1;
  const { straightLength, radius } = dims;
  const bounds = getSegmentBoundaries(dims);

  const leftCenterX = padding + radius;
  const rightCenterX = padding + radius + straightLength;
  const centerY = padding + radius;
  const topY = padding;
  const bottomY = padding + 2 * radius;

  if (straightLength > 0 && pos < bounds.topEnd) {
    const t = pos / bounds.topEnd;
    return { x: leftCenterX + t * straightLength, y: topY, angle: 0, segment: 'top' };
  } else if (pos < bounds.rightCapEnd) {
    const t =
      bounds.topEnd > 0
        ? (pos - bounds.topEnd) / (bounds.rightCapEnd - bounds.topEnd)
        : pos / bounds.rightCapEnd;
    const angle = -Math.PI / 2 + t * Math.PI;
    return {
      x: rightCenterX + radius * Math.cos(angle),
      y: centerY + radius * Math.sin(angle),
      angle: angle + Math.PI / 2,
      segment: 'right-cap',
    };
  } else if (straightLength > 0 && pos < bounds.bottomEnd) {
    const t = (pos - bounds.rightCapEnd) / (bounds.bottomEnd - bounds.rightCapEnd);
    return { x: rightCenterX - t * straightLength, y: bottomY, angle: Math.PI, segment: 'bottom' };
  } else {
    const t = bounds.bottomEnd < 1 ? (pos - bounds.bottomEnd) / (1 - bounds.bottomEnd) : 0;
    const angle = Math.PI / 2 + t * Math.PI;
    return {
      x: leftCenterX + radius * Math.cos(angle),
      y: centerY + radius * Math.sin(angle),
      angle: angle + Math.PI / 2,
      segment: 'left-cap',
    };
  }
}

export function seqPosToPoint(
  seqPos: number,
  seqLength: number,
  viewOffset: number,
  dims: StadiumDimensions,
  padding: number = 0
): StadiumPoint {
  const normalizedPos = ((seqPos - viewOffset) / seqLength + 1) % 1;
  return normalizedPosToPoint(normalizedPos, dims, padding);
}

export function seqPosToPointNorm(
  bp: number,
  genomeLength: number,
  viewOffset: number,
  dims: StadiumDimensions,
  padding: number = 0
): StadiumPoint {
  const viewOffsetBp = viewOffset * genomeLength;
  return seqPosToPoint(bp, genomeLength, viewOffsetBp, dims, padding);
}

export function computeOffsetPoint(
  basePoint: StadiumPoint,
  arcOffset: number
): { x: number; y: number } {
  let offsetX = 0;
  let offsetY = 0;

  if (basePoint.segment === 'top') {
    offsetY = arcOffset;
  } else if (basePoint.segment === 'bottom') {
    offsetY = -arcOffset;
  } else {
    const outwardAngle = basePoint.angle - Math.PI / 2;
    offsetX = -arcOffset * Math.cos(outwardAngle);
    offsetY = -arcOffset * Math.sin(outwardAngle);
  }

  return { x: basePoint.x + offsetX, y: basePoint.y + offsetY };
}

export function clickToSeqPos(
  clickX: number,
  clickY: number,
  dims: StadiumDimensions,
  padding: number,
  seqLength: number,
  viewOffset: number,
  customTolerance?: number
): number | null {
  const { straightLength, radius } = dims;
  const leftCenterX = padding + radius;
  const rightCenterX = padding + radius + straightLength;
  const centerY = padding + radius;
  const topY = padding;
  const bottomY = padding + 2 * radius;
  const tolerance = customTolerance ?? 15;

  const bounds = getSegmentBoundaries(dims);
  let normalizedPos: number | null = null;

  if (
    Math.abs(clickY - topY) <= tolerance &&
    clickX >= leftCenterX &&
    clickX <= rightCenterX &&
    straightLength > 0
  ) {
    const t = (clickX - leftCenterX) / straightLength;
    normalizedPos = t * bounds.topEnd;
  } else if (
    Math.abs(clickY - bottomY) <= tolerance &&
    clickX >= leftCenterX &&
    clickX <= rightCenterX &&
    straightLength > 0
  ) {
    const t = (rightCenterX - clickX) / straightLength;
    normalizedPos = bounds.rightCapEnd + t * (bounds.bottomEnd - bounds.rightCapEnd);
  } else {
    const dxRight = clickX - rightCenterX;
    const dyRight = clickY - centerY;
    const distRight = Math.sqrt(dxRight * dxRight + dyRight * dyRight);

    const dxLeft = clickX - leftCenterX;
    const dyLeft = clickY - centerY;
    const distLeft = Math.sqrt(dxLeft * dxLeft + dyLeft * dyLeft);

    if (Math.abs(distRight - radius) < tolerance && dxRight >= 0) {
      const angle = Math.atan2(dyRight, dxRight);
      const t = (angle + Math.PI / 2) / Math.PI;
      normalizedPos = bounds.topEnd + t * (bounds.rightCapEnd - bounds.topEnd);
    } else if (Math.abs(distLeft - radius) < tolerance && dxLeft <= 0) {
      const angle = Math.atan2(dyLeft, dxLeft);
      let normalizedAngle = angle;
      if (normalizedAngle < Math.PI / 2) normalizedAngle += 2 * Math.PI;
      const t = (normalizedAngle - Math.PI / 2) / Math.PI;
      normalizedPos = bounds.bottomEnd + t * (1 - bounds.bottomEnd);
    }
  }

  if (normalizedPos === null) return null;

  return normalizedToSeqPos(normalizedPos, seqLength, viewOffset);
}

export function closestSeqPosOnBackbone(
  clickX: number,
  clickY: number,
  dims: StadiumDimensions,
  padding: number,
  seqLength: number,
  viewOffset: number
): number {
  return closestSeqPosOnBackboneDebug(clickX, clickY, dims, padding, seqLength, viewOffset).seqPos;
}

export function closestSeqPosOnBackboneDebug(
  clickX: number,
  clickY: number,
  dims: StadiumDimensions,
  padding: number,
  seqLength: number,
  viewOffset: number,
  normalOffset: number = 0
): ClosestSeqPosDebug {
  const { straightLength, radius } = dims;
  const leftCenterX = padding + radius;
  const rightCenterX = padding + radius + straightLength;
  const centerY = padding + radius;
  const offsetRadius = Math.max(0, radius - normalOffset);
  const topY = centerY - offsetRadius;
  const bottomY = centerY + offsetRadius;

  const bounds = getSegmentBoundaries(dims);

  const candidates: ClosestSeqPosCandidate[] = [];

  const addCandidate = (
    segment: ClosestSeqPosCandidate['segment'],
    normalizedPos: number,
    distSq: number,
    closestX: number,
    closestY: number
  ) => {
    candidates.push({
      segment,
      normalizedPos,
      seqPos: normalizedToSeqPos(normalizedPos, seqLength, viewOffset),
      distSq,
      closestX,
      closestY,
    });
  };

  if (straightLength > 0) {
    const clampedX = Math.max(leftCenterX, Math.min(rightCenterX, clickX));
    const distSq = (clickX - clampedX) ** 2 + (clickY - topY) ** 2;
    const t = (clampedX - leftCenterX) / straightLength;
    addCandidate('top', t * bounds.topEnd, distSq, clampedX, topY);
  }

  if (straightLength > 0) {
    const clampedX = Math.max(leftCenterX, Math.min(rightCenterX, clickX));
    const distSq = (clickX - clampedX) ** 2 + (clickY - bottomY) ** 2;
    const t = (rightCenterX - clampedX) / straightLength;
    addCandidate(
      'bottom',
      bounds.rightCapEnd + t * (bounds.bottomEnd - bounds.rightCapEnd),
      distSq,
      clampedX,
      bottomY
    );
  }

  {
    const dx = clickX - rightCenterX;
    const dy = clickY - centerY;
    const angle = Math.atan2(dy, dx);
    const clampedAngle = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, angle));
    const closestX = rightCenterX + offsetRadius * Math.cos(clampedAngle);
    const closestY = centerY + offsetRadius * Math.sin(clampedAngle);
    const distSq = (clickX - closestX) ** 2 + (clickY - closestY) ** 2;
    const t = (clampedAngle + Math.PI / 2) / Math.PI;
    addCandidate(
      'right-cap',
      bounds.topEnd + t * (bounds.rightCapEnd - bounds.topEnd),
      distSq,
      closestX,
      closestY
    );
  }

  {
    const dx = clickX - leftCenterX;
    const dy = clickY - centerY;
    const angle = Math.atan2(dy, dx);
    let clampedAngle = angle;
    if (angle > -Math.PI / 2 && angle < Math.PI / 2) {
      clampedAngle = angle < 0 ? -Math.PI / 2 : Math.PI / 2;
    }
    const closestX = leftCenterX + offsetRadius * Math.cos(clampedAngle);
    const closestY = centerY + offsetRadius * Math.sin(clampedAngle);
    const distSq = (clickX - closestX) ** 2 + (clickY - closestY) ** 2;

    let normalizedAngle = clampedAngle;
    if (normalizedAngle < Math.PI / 2) normalizedAngle += 2 * Math.PI;
    const t = (normalizedAngle - Math.PI / 2) / Math.PI;
    addCandidate(
      'left-cap',
      bounds.bottomEnd + t * (1 - bounds.bottomEnd),
      distSq,
      closestX,
      closestY
    );
  }

  let best = candidates[0];
  for (const c of candidates) {
    if (c.distSq < best.distSq) best = c;
  }

  return {
    seqPos: best.seqPos,
    best,
    candidates,
  };
}

export function getViewOffsetForPosition(
  targetPos: number,
  seqLength: number,
  viewContextNormalizedPos: number = 0.125
): number {
  return (targetPos - viewContextNormalizedPos * seqLength + seqLength) % seqLength;
}
