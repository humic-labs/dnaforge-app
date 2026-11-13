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

export function getStadiumDimensions(
  width: number,
  height: number,
  morphToCircle: number = 0
): StadiumDimensions {
  const morph = Math.max(0, Math.min(1, morphToCircle));

  if (morph === 0) {
    const radius = height / 2;
    const straightLength = Math.max(0, width - height);
    const capLength = Math.PI * radius;
    const totalLength = 2 * straightLength + 2 * capLength;

    return { width, height, radius, straightLength, totalLength };
  }

  const initialRadius = height / 2;
  const initialStraightLength = Math.max(0, width - height);
  const perimeter = 2 * initialStraightLength + 2 * Math.PI * initialRadius;

  const unscaledStraightLength = initialStraightLength * (1 - morph);
  const unscaledRadius = (perimeter - 2 * unscaledStraightLength) / (2 * Math.PI);

  const unscaledWidth = 2 * unscaledRadius + unscaledStraightLength;
  const unscaledHeight = 2 * unscaledRadius;

  const scaleX = width / unscaledWidth;
  const scaleY = height / unscaledHeight;
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
    return {
      x: leftCenterX + t * straightLength,
      y: topY,
      angle: 0,
      segment: 'top',
    };
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
    return {
      x: rightCenterX - t * straightLength,
      y: bottomY,
      angle: Math.PI,
      segment: 'bottom',
    };
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

export function createStadiumArcPath(
  startPos: number,
  endPos: number,
  seqLength: number,
  viewOffset: number,
  dims: StadiumDimensions,
  padding: number = 0,
  arcOffset: number = 0,
  reverse: boolean = false
): string {
  const points = sampleStadiumCenterline(
    startPos,
    endPos,
    seqLength,
    viewOffset,
    dims,
    padding,
    arcOffset
  );
  if (reverse) points.reverse();
  return pointsToPolyline(points);
}

export function sampleStadiumCenterline(
  startPos: number,
  endPos: number,
  seqLength: number,
  viewOffset: number,
  dims: StadiumDimensions,
  padding: number,
  arcOffset: number
): { x: number; y: number }[] {
  let effectiveEnd = endPos;
  if (endPos < startPos) {
    effectiveEnd = endPos + seqLength;
  }
  const featureLength = effectiveEnd - startPos;
  const numSegments = Math.max(120, Math.ceil(featureLength / 3));
  const points: { x: number; y: number }[] = [];

  for (let i = 0; i <= numSegments; i++) {
    const t = i / numSegments;
    const pos = (startPos + t * featureLength) % seqLength;
    const basePoint = seqPosToPoint(pos, seqLength, viewOffset, dims, padding);
    points.push(computeOffsetPoint(basePoint, arcOffset));
  }

  return points;
}

export function pointsToPolyline(points: { x: number; y: number }[]): string {
  if (points.length < 2) return '';
  let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    path += ` L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`;
  }
  return path;
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

  return {
    x: basePoint.x + offsetX,
    y: basePoint.y + offsetY,
  };
}

export function createFilledArcWithArrow(
  startPos: number,
  endPos: number,
  seqLength: number,
  viewOffset: number,
  dims: StadiumDimensions,
  padding: number = 0,
  arcOffset: number = 0,
  strokeWidth: number = 2,
  direction: 'forward' | 'reverse' | 'none' = 'none',
  arrowSize: number = 4,
  minLengthForArrow: number = 12
): string {
  let effectiveEnd = endPos;
  const wrapsAround = endPos < startPos;
  if (wrapsAround) {
    effectiveEnd = endPos + seqLength;
  }
  const featureLength = effectiveEnd - startPos;

  if (wrapsAround && featureLength > seqLength * 0.5) {
    const path1 = createFilledArcSegment(
      startPos,
      seqLength,
      seqLength,
      viewOffset,
      dims,
      padding,
      arcOffset,
      strokeWidth,
      direction === 'reverse' ? direction : 'none',
      arrowSize,
      minLengthForArrow
    );
    const path2 = createFilledArcSegment(
      0,
      endPos,
      seqLength,
      viewOffset,
      dims,
      padding,
      arcOffset,
      strokeWidth,
      direction === 'forward' ? direction : 'none',
      arrowSize,
      minLengthForArrow
    );
    return `${path1} ${path2}`;
  }

  return createFilledArcSegment(
    startPos,
    effectiveEnd,
    seqLength,
    viewOffset,
    dims,
    padding,
    arcOffset,
    strokeWidth,
    direction,
    arrowSize,
    minLengthForArrow
  );
}

function createFilledArcSegment(
  startPos: number,
  effectiveEnd: number,
  seqLength: number,
  viewOffset: number,
  dims: StadiumDimensions,
  padding: number,
  arcOffset: number,
  strokeWidth: number,
  direction: 'forward' | 'reverse' | 'none',
  arrowSize: number,
  minLengthForArrow: number
): string {
  const numSegments = Math.max(120, Math.ceil(Math.abs(effectiveEnd - startPos) / 3));
  const halfWidth = strokeWidth / 2;
  const featureLength = effectiveEnd - startPos;

  const centerPoints: { x: number; y: number; angle: number; segment: string }[] = [];
  for (let i = 0; i <= numSegments; i++) {
    const t = i / numSegments;
    const pos = (startPos + t * featureLength) % seqLength;
    const basePoint = seqPosToPoint(pos, seqLength, viewOffset, dims, padding);
    const offsetPoint = computeOffsetPoint(basePoint, arcOffset);
    centerPoints.push({
      x: offsetPoint.x,
      y: offsetPoint.y,
      angle: basePoint.angle,
      segment: basePoint.segment,
    });
  }

  if (centerPoints.length < 2) return '';

  const outerPoints: { x: number; y: number }[] = [];
  const innerPoints: { x: number; y: number }[] = [];

  for (let i = 0; i < centerPoints.length; i++) {
    const pt = centerPoints[i];
    const perpAngle = pt.angle - Math.PI / 2;

    outerPoints.push({
      x: pt.x + halfWidth * Math.cos(perpAngle),
      y: pt.y + halfWidth * Math.sin(perpAngle),
    });
    innerPoints.push({
      x: pt.x - halfWidth * Math.cos(perpAngle),
      y: pt.y - halfWidth * Math.sin(perpAngle),
    });
  }

  const pathParts: string[] = [];

  const arrowLength = arrowSize * 1.5;

  const totalLength = outerPoints.reduce((acc, pt, i) => {
    if (i === 0) return 0;
    const prev = outerPoints[i - 1];
    return acc + Math.sqrt((pt.x - prev.x) ** 2 + (pt.y - prev.y) ** 2);
  }, 0);

  const showArrow = totalLength >= minLengthForArrow;

  if (direction === 'reverse' && showArrow) {
    const firstCenter = centerPoints[0];

    let outerBaseIdx = 0;
    let innerBaseIdx = 0;
    for (let i = 1; i < outerPoints.length; i++) {
      const dx = outerPoints[i].x - outerPoints[0].x;
      const dy = outerPoints[i].y - outerPoints[0].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= arrowLength) {
        outerBaseIdx = i;
        break;
      }
    }
    for (let i = 1; i < innerPoints.length; i++) {
      const dx = innerPoints[i].x - innerPoints[0].x;
      const dy = innerPoints[i].y - innerPoints[0].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= arrowLength) {
        innerBaseIdx = i;
        break;
      }
    }

    pathParts.push(`M ${firstCenter.x.toFixed(2)} ${firstCenter.y.toFixed(2)}`);
    pathParts.push(
      `L ${outerPoints[outerBaseIdx].x.toFixed(2)} ${outerPoints[outerBaseIdx].y.toFixed(2)}`
    );
    for (let i = outerBaseIdx + 1; i < outerPoints.length; i++) {
      pathParts.push(`L ${outerPoints[i].x.toFixed(2)} ${outerPoints[i].y.toFixed(2)}`);
    }
    for (let i = innerPoints.length - 1; i >= innerBaseIdx; i--) {
      pathParts.push(`L ${innerPoints[i].x.toFixed(2)} ${innerPoints[i].y.toFixed(2)}`);
    }
    pathParts.push('Z');
  } else if (direction === 'forward' && showArrow) {
    const lastCenter = centerPoints[centerPoints.length - 1];

    let outerBaseIdx = outerPoints.length - 1;
    let innerBaseIdx = innerPoints.length - 1;
    for (let i = outerPoints.length - 2; i >= 0; i--) {
      const dx = outerPoints[i].x - outerPoints[outerPoints.length - 1].x;
      const dy = outerPoints[i].y - outerPoints[outerPoints.length - 1].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= arrowLength) {
        outerBaseIdx = i;
        break;
      }
    }
    for (let i = innerPoints.length - 2; i >= 0; i--) {
      const dx = innerPoints[i].x - innerPoints[innerPoints.length - 1].x;
      const dy = innerPoints[i].y - innerPoints[innerPoints.length - 1].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= arrowLength) {
        innerBaseIdx = i;
        break;
      }
    }

    pathParts.push(`M ${outerPoints[0].x.toFixed(2)} ${outerPoints[0].y.toFixed(2)}`);
    for (let i = 1; i <= outerBaseIdx; i++) {
      pathParts.push(`L ${outerPoints[i].x.toFixed(2)} ${outerPoints[i].y.toFixed(2)}`);
    }
    pathParts.push(`L ${lastCenter.x.toFixed(2)} ${lastCenter.y.toFixed(2)}`);
    for (let i = innerBaseIdx; i >= 0; i--) {
      pathParts.push(`L ${innerPoints[i].x.toFixed(2)} ${innerPoints[i].y.toFixed(2)}`);
    }
    pathParts.push('Z');
  } else {
    pathParts.push(`M ${outerPoints[0].x.toFixed(2)} ${outerPoints[0].y.toFixed(2)}`);
    for (let i = 1; i < outerPoints.length; i++) {
      pathParts.push(`L ${outerPoints[i].x.toFixed(2)} ${outerPoints[i].y.toFixed(2)}`);
    }
    for (let i = innerPoints.length - 1; i >= 0; i--) {
      pathParts.push(`L ${innerPoints[i].x.toFixed(2)} ${innerPoints[i].y.toFixed(2)}`);
    }
    pathParts.push('Z');
  }

  return pathParts.join(' ');
}

export function getChevronPositions(
  startPos: number,
  endPos: number,
  seqLength: number,
  viewOffset: number,
  dims: StadiumDimensions,
  padding: number = 0,
  arcOffset: number = 0,
  direction: 'forward' | 'reverse' | 'none' = 'none'
): Array<{ x: number; y: number; angle: number }> {
  if (direction === 'none') return [];

  let effectiveEnd = endPos;
  if (endPos < startPos) {
    effectiveEnd = endPos + seqLength;
  }
  const featureLength = effectiveEnd - startPos;

  if (featureLength < 50) return [];

  const positions: Array<{ x: number; y: number; angle: number }> = [];

  const chevronOffsets = [0.12, 0.16, 0.84, 0.88];

  for (const t of chevronOffsets) {
    const pos = (startPos + t * featureLength) % seqLength;
    const basePoint = seqPosToPoint(pos, seqLength, viewOffset, dims, padding);
    const offsetPoint = computeOffsetPoint(basePoint, arcOffset);

    const angle = direction === 'forward' ? basePoint.angle : basePoint.angle + Math.PI;

    positions.push({
      x: offsetPoint.x,
      y: offsetPoint.y,
      angle,
    });
  }

  return positions;
}

export function getFeatureArcEndpoint(
  startPos: number,
  endPos: number,
  seqLength: number,
  viewOffset: number,
  dims: StadiumDimensions,
  padding: number = 0,
  arcOffset: number = 0,
  direction: 'forward' | 'reverse' | 'none' = 'forward'
): { x: number; y: number; angle: number } | null {
  if (direction === 'none') return null;

  const targetPos = direction === 'forward' ? endPos : startPos;
  const basePoint = seqPosToPoint(targetPos, seqLength, viewOffset, dims, padding);

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

  const angle = direction === 'forward' ? basePoint.angle : basePoint.angle + Math.PI;

  return {
    x: basePoint.x + offsetX,
    y: basePoint.y + offsetY,
    angle,
  };
}

export function createStadiumBackbonePath(dims: StadiumDimensions, padding: number = 0): string {
  const { straightLength, radius } = dims;

  const leftCapCenterX = padding + radius;
  const rightCapCenterX = padding + radius + straightLength;
  const _centerY = padding + radius;

  const topY = padding;
  const bottomY = padding + 2 * radius;

  if (straightLength <= 0) {
    return `
      M ${leftCapCenterX} ${topY}
      A ${radius} ${radius} 0 1 1 ${leftCapCenterX} ${bottomY}
      A ${radius} ${radius} 0 1 1 ${leftCapCenterX} ${topY}
      Z
    `.trim();
  }

  return `
    M ${leftCapCenterX} ${topY}
    L ${rightCapCenterX} ${topY}
    A ${radius} ${radius} 0 0 1 ${rightCapCenterX} ${bottomY}
    L ${leftCapCenterX} ${bottomY}
    A ${radius} ${radius} 0 0 1 ${leftCapCenterX} ${topY}
    Z
  `.trim();
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

  const seqPos = (normalizedPos * seqLength + viewOffset + seqLength) % seqLength;
  return Math.round(seqPos);
}

export function closestSeqPosOnBackbone(
  clickX: number,
  clickY: number,
  dims: StadiumDimensions,
  padding: number,
  seqLength: number,
  viewOffset: number
): number {
  const { straightLength, radius } = dims;
  const leftCenterX = padding + radius;
  const rightCenterX = padding + radius + straightLength;
  const centerY = padding + radius;
  const topY = padding;
  const bottomY = padding + 2 * radius;

  const bounds = getSegmentBoundaries(dims);

  type Candidate = { normalizedPos: number; distSq: number };
  const candidates: Candidate[] = [];

  if (straightLength > 0) {
    const clampedX = Math.max(leftCenterX, Math.min(rightCenterX, clickX));
    const distSq = (clickX - clampedX) ** 2 + (clickY - topY) ** 2;
    const t = (clampedX - leftCenterX) / straightLength;
    candidates.push({ normalizedPos: t * bounds.topEnd, distSq });
  }

  if (straightLength > 0) {
    const clampedX = Math.max(leftCenterX, Math.min(rightCenterX, clickX));
    const distSq = (clickX - clampedX) ** 2 + (clickY - bottomY) ** 2;
    const t = (rightCenterX - clampedX) / straightLength;
    candidates.push({
      normalizedPos: bounds.rightCapEnd + t * (bounds.bottomEnd - bounds.rightCapEnd),
      distSq,
    });
  }

  {
    const dx = clickX - rightCenterX;
    const dy = clickY - centerY;
    const angle = Math.atan2(dy, dx);
    const clampedAngle = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, angle));
    const closestX = rightCenterX + radius * Math.cos(clampedAngle);
    const closestY = centerY + radius * Math.sin(clampedAngle);
    const distSq = (clickX - closestX) ** 2 + (clickY - closestY) ** 2;
    const t = (clampedAngle + Math.PI / 2) / Math.PI;
    candidates.push({
      normalizedPos: bounds.topEnd + t * (bounds.rightCapEnd - bounds.topEnd),
      distSq,
    });
  }

  {
    const dx = clickX - leftCenterX;
    const dy = clickY - centerY;
    const angle = Math.atan2(dy, dx);
    let clampedAngle = angle;
    if (angle > -Math.PI / 2 && angle < Math.PI / 2) {
      clampedAngle = angle < 0 ? -Math.PI / 2 : Math.PI / 2;
    }

    const closestX = leftCenterX + radius * Math.cos(clampedAngle);
    const closestY = centerY + radius * Math.sin(clampedAngle);
    const distSq = (clickX - closestX) ** 2 + (clickY - closestY) ** 2;

    let normalizedAngle = clampedAngle;
    if (normalizedAngle < Math.PI / 2) normalizedAngle += 2 * Math.PI;
    const t = (normalizedAngle - Math.PI / 2) / Math.PI;
    candidates.push({
      normalizedPos: bounds.bottomEnd + t * (1 - bounds.bottomEnd),
      distSq,
    });
  }

  let best = candidates[0];
  for (const c of candidates) {
    if (c.distSq < best.distSq) best = c;
  }

  const seqPos = (best.normalizedPos * seqLength + viewOffset + seqLength) % seqLength;
  return Math.round(seqPos);
}

export function getViewOffsetForPosition(
  targetPos: number,
  seqLength: number,
  viewContextNormalizedPos: number = 0.125
): number {
  const viewOffset = (targetPos - viewContextNormalizedPos * seqLength + seqLength) % seqLength;
  return viewOffset;
}

export function createFilledHighlightArc(
  startPos: number,
  endPos: number,
  seqLength: number,
  viewOffset: number,
  dims: StadiumDimensions,
  padding: number = 0,
  innerOffset: number = 0,
  outerOffset: number = -20
): string {
  let effectiveEnd = endPos;
  const wrapsAround = endPos < startPos;
  if (wrapsAround) {
    effectiveEnd = endPos + seqLength;
  }
  const featureLength = effectiveEnd - startPos;

  if (wrapsAround && featureLength > seqLength * 0.5) {
    const path1 = createFilledHighlightArcSegment(
      startPos,
      seqLength,
      seqLength,
      viewOffset,
      dims,
      padding,
      innerOffset,
      outerOffset
    );
    const path2 = createFilledHighlightArcSegment(
      0,
      endPos,
      seqLength,
      viewOffset,
      dims,
      padding,
      innerOffset,
      outerOffset
    );
    return `${path1} ${path2}`;
  }

  return createFilledHighlightArcSegment(
    startPos,
    effectiveEnd,
    seqLength,
    viewOffset,
    dims,
    padding,
    innerOffset,
    outerOffset
  );
}

function createFilledHighlightArcSegment(
  startPos: number,
  effectiveEnd: number,
  seqLength: number,
  viewOffset: number,
  dims: StadiumDimensions,
  padding: number,
  innerOffset: number,
  outerOffset: number
): string {
  const numSegments = Math.max(120, Math.ceil(Math.abs(effectiveEnd - startPos) / 3));
  const featureLength = effectiveEnd - startPos;

  const innerPoints: { x: number; y: number }[] = [];
  const outerPoints: { x: number; y: number }[] = [];

  for (let i = 0; i <= numSegments; i++) {
    const t = i / numSegments;
    const pos = (startPos + t * featureLength) % seqLength;
    const basePoint = seqPosToPoint(pos, seqLength, viewOffset, dims, padding);

    const innerPt = computeOffsetPoint(basePoint, innerOffset);
    innerPoints.push(innerPt);

    const outerPt = computeOffsetPoint(basePoint, outerOffset);
    outerPoints.push(outerPt);
  }

  if (innerPoints.length < 2) return '';

  const pathParts: string[] = [];
  pathParts.push(`M ${outerPoints[0].x.toFixed(2)} ${outerPoints[0].y.toFixed(2)}`);
  for (let i = 1; i < outerPoints.length; i++) {
    pathParts.push(`L ${outerPoints[i].x.toFixed(2)} ${outerPoints[i].y.toFixed(2)}`);
  }
  for (let i = innerPoints.length - 1; i >= 0; i--) {
    pathParts.push(`L ${innerPoints[i].x.toFixed(2)} ${innerPoints[i].y.toFixed(2)}`);
  }
  pathParts.push('Z');

  return pathParts.join(' ');
}

export function getFeatureLabelPosition(
  startPos: number,
  endPos: number,
  seqLength: number,
  viewOffset: number,
  dims: StadiumDimensions,
  padding: number = 0,
  arcOffset: number = 0,
  labelOffset: number = 12
): { x: number; y: number; angle: number; segment: string } {
  let effectiveEnd = endPos;
  if (endPos < startPos) {
    effectiveEnd = endPos + seqLength;
  }
  const featureLength = effectiveEnd - startPos;

  const midPos = (startPos + featureLength / 2) % seqLength;
  const basePoint = seqPosToPoint(midPos, seqLength, viewOffset, dims, padding);

  const arcPoint = computeOffsetPoint(basePoint, arcOffset);

  const outwardAngle = basePoint.angle - Math.PI / 2;
  const labelX = arcPoint.x + labelOffset * Math.cos(outwardAngle);
  const labelY = arcPoint.y + labelOffset * Math.sin(outwardAngle);

  return {
    x: labelX,
    y: labelY,
    angle: basePoint.angle,
    segment: basePoint.segment,
  };
}
