export const VIEWPORT_BRACKET_STROKE = 1.875;
export const VIEWPORT_BRACKET_ARM = 3;
export const VIEWPORT_BRACKET_HALF_HEIGHT = 4.2;

export const VIEWPORT_BRACKET_MID_GAP = VIEWPORT_BRACKET_STROKE + 0.5;

export const VIEWPORT_BRACKET_COLLAPSED_WIDTH = VIEWPORT_BRACKET_ARM;

export const VIEWPORT_BRACKET_COLLAPSED_ARM = Math.max(
  0,
  (VIEWPORT_BRACKET_COLLAPSED_WIDTH - VIEWPORT_BRACKET_MID_GAP) / 2
);

export const VIEWPORT_BRACKET_COLLAPSE_BELOW = VIEWPORT_BRACKET_COLLAPSED_WIDTH;

export type ViewportBracketKind = 'pair' | 'collapsed';

export interface ViewportBracketPaint {
  kind: ViewportBracketKind;
  anchorBp: number;
  spineTangent: number;
  inward: 1 | -1;
  arm: number;
}

export interface ViewportBracketSpanLayout {
  kind: ViewportBracketKind;
  drawnWidth: number;
  arm: number;
}

export function viewportRangeLengthBp(
  start: number,
  end: number,
  genomeLength: number,
  circular: boolean
): number {
  if (end >= start) return end - start;
  if (circular) return genomeLength - start + end;
  return Math.abs(end - start);
}

export function viewportRangeMidpointBp(
  start: number,
  end: number,
  genomeLength: number,
  circular: boolean
): number {
  const mid = start + viewportRangeLengthBp(start, end, genomeLength, circular) / 2;
  if (!circular || genomeLength <= 0) return mid;
  return ((mid % genomeLength) + genomeLength) % genomeLength;
}

export function viewportBracketSpanLayout(spanPx: number): ViewportBracketSpanLayout {
  const drawnWidth = Math.max(spanPx, VIEWPORT_BRACKET_COLLAPSED_WIDTH);
  const arm = Math.min(
    VIEWPORT_BRACKET_ARM,
    Math.max(0, (drawnWidth - VIEWPORT_BRACKET_MID_GAP) / 2)
  );
  return {
    kind: spanPx < VIEWPORT_BRACKET_COLLAPSED_WIDTH ? 'collapsed' : 'pair',
    drawnWidth,
    arm,
  };
}

export function viewportBracketKind(spanPx: number): ViewportBracketKind {
  return viewportBracketSpanLayout(spanPx).kind;
}

export function viewportBracketPaints(args: {
  start: number;
  end: number;
  genomeLength: number;
  circular: boolean;
  pixelsPerBp: number;
}): ViewportBracketPaint[] {
  const spanPx =
    viewportRangeLengthBp(args.start, args.end, args.genomeLength, args.circular) *
    Math.max(args.pixelsPerBp, 0);
  const { kind, drawnWidth, arm } = viewportBracketSpanLayout(spanPx);
  if (kind === 'pair') {
    return [
      {
        kind,
        anchorBp: args.start,
        spineTangent: 0,
        inward: 1,
        arm,
      },
      {
        kind,
        anchorBp: args.end,
        spineTangent: 0,
        inward: -1,
        arm,
      },
    ];
  }
  const half = drawnWidth / 2;
  const mid = viewportRangeMidpointBp(args.start, args.end, args.genomeLength, args.circular);
  return [
    {
      kind,
      anchorBp: mid,
      spineTangent: -half,
      inward: 1,
      arm,
    },
    {
      kind,
      anchorBp: mid,
      spineTangent: half,
      inward: -1,
      arm,
    },
  ];
}
