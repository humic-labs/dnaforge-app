export function positionToAngle(position: number, totalLength: number): number {
  const fraction = (position - 1) / totalLength;
  return fraction * 2 * Math.PI - Math.PI / 2;
}

export function angleToPoint(
  angle: number,
  radius: number,
  centerX: number,
  centerY: number
): { x: number; y: number } {
  return {
    x: centerX + radius * Math.cos(angle),
    y: centerY + radius * Math.sin(angle),
  };
}

export function createArcPath(
  startAngle: number,
  endAngle: number,
  innerRadius: number,
  outerRadius: number,
  centerX: number,
  centerY: number
): string {
  let sweepAngle = endAngle - startAngle;
  if (sweepAngle < 0) {
    sweepAngle += 2 * Math.PI;
  }

  const largeArcFlag = sweepAngle > Math.PI ? 1 : 0;

  const outerStart = angleToPoint(startAngle, outerRadius, centerX, centerY);
  const outerEnd = angleToPoint(endAngle, outerRadius, centerX, centerY);
  const innerStart = angleToPoint(startAngle, innerRadius, centerX, centerY);
  const innerEnd = angleToPoint(endAngle, innerRadius, centerX, centerY);

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${innerStart.x} ${innerStart.y}`,
    'Z',
  ].join(' ');
}

export function createArrowPath(
  angle: number,
  radius: number,
  centerX: number,
  centerY: number,
  arrowSize: number,
  direction: 'forward' | 'reverse'
): string {
  const point = angleToPoint(angle, radius, centerX, centerY);

  const tangentAngle = angle + Math.PI / 2;

  const dir = direction === 'forward' ? 1 : -1;

  const tipX = point.x + dir * arrowSize * Math.cos(tangentAngle);
  const tipY = point.y + dir * arrowSize * Math.sin(tangentAngle);

  const baseOffset = arrowSize * 0.6;
  const perpAngle = tangentAngle + Math.PI / 2;

  const base1X = point.x + baseOffset * Math.cos(perpAngle);
  const base1Y = point.y + baseOffset * Math.sin(perpAngle);
  const base2X = point.x - baseOffset * Math.cos(perpAngle);
  const base2Y = point.y - baseOffset * Math.sin(perpAngle);

  return `M ${tipX} ${tipY} L ${base1X} ${base1Y} L ${base2X} ${base2Y} Z`;
}

export function getMidpointAngle(startAngle: number, endAngle: number): number {
  let midAngle = (startAngle + endAngle) / 2;

  if (endAngle < startAngle) {
    midAngle = (startAngle + endAngle + 2 * Math.PI) / 2;
    if (midAngle > Math.PI) {
      midAngle -= 2 * Math.PI;
    }
  }

  return midAngle;
}

export function getLabelPosition(
  startAngle: number,
  endAngle: number,
  radius: number,
  centerX: number,
  centerY: number,
  labelOffset: number = 15
): { x: number; y: number; angle: number; anchor: 'start' | 'middle' | 'end' } {
  const midAngle = getMidpointAngle(startAngle, endAngle);
  const labelRadius = radius + labelOffset;

  const point = angleToPoint(midAngle, labelRadius, centerX, centerY);

  let anchor: 'start' | 'middle' | 'end' = 'middle';
  const normalizedAngle = ((midAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

  if (normalizedAngle > Math.PI / 4 && normalizedAngle < (3 * Math.PI) / 4) {
    anchor = 'start';
  } else if (normalizedAngle > (5 * Math.PI) / 4 && normalizedAngle < (7 * Math.PI) / 4) {
    anchor = 'end';
  }

  const angleDegrees = (midAngle * 180) / Math.PI;

  return { x: point.x, y: point.y, angle: angleDegrees, anchor };
}

export function calculateTickPositions(totalLength: number, interval: number): number[] {
  const positions: number[] = [];

  positions.push(1);

  for (let pos = interval; pos < totalLength; pos += interval) {
    positions.push(pos);
  }

  return positions;
}

export function formatPosition(position: number): string {
  if (position >= 1000) {
    const kb = position / 1000;
    return `${kb % 1 === 0 ? kb : kb.toFixed(1)} kb`;
  }
  return `${position} bp`;
}
