export const ASSEMBLY_PRIMER_HANDLE_VISUAL_CONTRACT_ID = 'assembly-primer-handle-v1';

export interface AssemblyPrimerHandleVisual {
  readonly contractId: typeof ASSEMBLY_PRIMER_HANDLE_VISUAL_CONTRACT_ID;
  readonly hitWidthPx: number;
  readonly hitHeightPx: number;
  readonly guideLengthPx: number;
  readonly guideWidthPx: number;
  readonly guideDashPx: number;
  readonly guideGapPx: number;
  readonly gripWidthPx: number;
  readonly gripHeightPx: number;
  readonly gripRadiusPx: number;
  readonly gripBorderWidthPx: number;
  readonly strokeColor: number;
  readonly guideColor: number;
  readonly gripFillColor: number;
  readonly gripBorderColor: number;
  readonly strokeColorCss: string;
  readonly guideColorCss: string;
  readonly gripFillColorCss: string;
  readonly gripBorderColorCss: string;
}

export interface AssemblyPrimerHandlePoint {
  readonly x: number;
  readonly y: number;
}

export interface AssemblyPrimerHandleGeometry {
  readonly anchor: AssemblyPrimerHandlePoint;
  readonly guideEnd: AssemblyPrimerHandlePoint;
  readonly gripCenter: AssemblyPrimerHandlePoint;
  readonly hitCenter: AssemblyPrimerHandlePoint;
  readonly angle: number;
}

interface AssemblyPrimerHandleColors {
  readonly strokeColor: number;
  readonly guideColor: number;
  readonly gripFillColor: number;
  readonly gripBorderColor: number;
}

export const ASSEMBLY_PRIMER_HANDLE_METRICS = Object.freeze({
  hitWidthPx: 28,
  hitHeightPx: 22,
  guideLengthPx: 13,
  guideWidthPx: 1,
  guideDashPx: 2,
  guideGapPx: 3,
  gripWidthPx: 16,
  gripHeightPx: 7,
  gripRadiusPx: 5,
  gripBorderWidthPx: 1,
});

const LIGHT_COLORS: AssemblyPrimerHandleColors = {
  strokeColor: 0x686663,
  guideColor: 0xa8a6a2,
  gripFillColor: 0xc4c3c2,
  gripBorderColor: 0x757471,
};

const DARK_COLORS: AssemblyPrimerHandleColors = {
  strokeColor: 0xa9a7a3,
  guideColor: 0x67635c,
  gripFillColor: 0x4e4c4a,
  gripBorderColor: 0x9c9a97,
};

function colorToCss(color: number): string {
  const red = (color >> 16) & 0xff;
  const green = (color >> 8) & 0xff;
  const blue = color & 0xff;
  return `rgb(${red}, ${green}, ${blue})`;
}

function createVisual(colors: AssemblyPrimerHandleColors): AssemblyPrimerHandleVisual {
  return Object.freeze({
    contractId: ASSEMBLY_PRIMER_HANDLE_VISUAL_CONTRACT_ID,
    ...ASSEMBLY_PRIMER_HANDLE_METRICS,
    ...colors,
    strokeColorCss: colorToCss(colors.strokeColor),
    guideColorCss: colorToCss(colors.guideColor),
    gripFillColorCss: colorToCss(colors.gripFillColor),
    gripBorderColorCss: colorToCss(colors.gripBorderColor),
  });
}

const LIGHT_VISUAL = createVisual(LIGHT_COLORS);
const DARK_VISUAL = createVisual(DARK_COLORS);

export function assemblyPrimerHandleVisualForMode(
  mode: 'light' | 'dark' | undefined
): AssemblyPrimerHandleVisual {
  return mode === 'dark' ? DARK_VISUAL : LIGHT_VISUAL;
}

export function assemblyPrimerHandleGeometry(input: {
  anchorX: number;
  anchorY: number;
  angle: number;
}): AssemblyPrimerHandleGeometry {
  const normalX = -Math.sin(input.angle);
  const normalY = Math.cos(input.angle);
  const pointAlongNormal = (distance: number): AssemblyPrimerHandlePoint => ({
    x: input.anchorX + normalX * distance,
    y: input.anchorY + normalY * distance,
  });
  const guideEnd = pointAlongNormal(ASSEMBLY_PRIMER_HANDLE_METRICS.guideLengthPx);
  return {
    anchor: { x: input.anchorX, y: input.anchorY },
    guideEnd,
    gripCenter: pointAlongNormal(
      ASSEMBLY_PRIMER_HANDLE_METRICS.guideLengthPx + ASSEMBLY_PRIMER_HANDLE_METRICS.gripHeightPx / 2
    ),
    hitCenter: guideEnd,
    angle: input.angle,
  };
}

export function assemblyPrimerHandleContainsPoint(
  geometry: AssemblyPrimerHandleGeometry,
  point: AssemblyPrimerHandlePoint
): boolean {
  const dx = point.x - geometry.hitCenter.x;
  const dy = point.y - geometry.hitCenter.y;
  const tangentX = Math.cos(geometry.angle);
  const tangentY = Math.sin(geometry.angle);
  const normalX = -tangentY;
  const normalY = tangentX;
  const localX = dx * tangentX + dy * tangentY;
  const localY = dx * normalX + dy * normalY;
  return (
    Math.abs(localX) <= ASSEMBLY_PRIMER_HANDLE_METRICS.hitWidthPx / 2 &&
    Math.abs(localY) <= ASSEMBLY_PRIMER_HANDLE_METRICS.hitHeightPx / 2
  );
}
