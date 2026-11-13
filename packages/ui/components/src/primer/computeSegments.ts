import type { GibsonPrimerSegments, GoldenGatePrimerSegments, PrimerSegment } from './types';

export const PRIMER_SVG_CONSTANTS = {
  CHAR_WIDTH: 6.8,
  BOX_HEIGHT: 16,
  ARROW_HEIGHT: 6,
  ARROW_WIDTH: 15,
  PBS_OPACITY: 0.2,
  OVERHANG_OPACITY: 0.25,
  STROKE_WIDTH: 1.5,
  DASH_ARRAY: '3,3',
} as const;

export const PRIMER_PADDING = {
  GOLDEN_GATE: 3,
  GIBSON: 3,
} as const;

export interface PrimerPathConfig {
  x: number;
  y: number;
  width: number;
  height: number;
  arrowHeight: number;
  arrowWidth: number;
  direction: 'forward' | 'reverse';
  closePath?: boolean;
  hasAdjacentRegion?: boolean;
}

export function buildPbsPath(config: PrimerPathConfig): string {
  const {
    x,
    y,
    width,
    height,
    arrowHeight,
    arrowWidth,
    direction,
    closePath = true,
    hasAdjacentRegion = false,
  } = config;

  if (direction === 'forward') {
    const path = `
      M ${x} ${y}
      L ${x + width - arrowWidth} ${y}
      L ${x + width - arrowWidth} ${y - arrowHeight}
      L ${x + width} ${y}
      L ${x + width} ${y + height}
      L ${x} ${y + height}
    `;
    return closePath && !hasAdjacentRegion ? path + ' Z' : path.trim();
  } else {
    if (hasAdjacentRegion) {
      const path = `
        M ${x} ${y}
        L ${x + width} ${y}
        M ${x + width} ${y + height}
        L ${x + arrowWidth} ${y + height}
        L ${x + arrowWidth} ${y + height + arrowHeight}
        L ${x} ${y + height}
        L ${x} ${y}
      `;
      return path.trim();
    } else {
      const path = `
        M ${x} ${y}
        L ${x + width} ${y}
        L ${x + width} ${y + height}
        L ${x + arrowWidth} ${y + height}
        L ${x + arrowWidth} ${y + height + arrowHeight}
        L ${x} ${y + height}
      `;
      return closePath ? path + ' Z' : path.trim();
    }
  }
}

export function buildHorizontalBordersPath(
  x: number,
  y: number,
  width: number,
  height: number
): string {
  return `M ${x} ${y} L ${x + width} ${y} M ${x} ${y + height} L ${x + width} ${y + height}`;
}

export function buildCleavedBorderPath(
  x: number,
  y: number,
  width: number,
  height: number,
  direction: 'forward' | 'reverse'
): string {
  if (direction === 'forward') {
    return `M ${x + width} ${y} L ${x} ${y} L ${x} ${y + height} L ${x + width} ${y + height}`;
  } else {
    return `M ${x} ${y} L ${x + width} ${y} L ${x + width} ${y + height} L ${x} ${y + height}`;
  }
}

export interface GibsonPrimerInput {
  direction: 'forward' | 'reverse';
  overhangSequence: string;
  spacerSequence: string;
  pbsSequence: string;
}

export function computeGibsonSegments(input: GibsonPrimerInput): GibsonPrimerSegments {
  const { direction, overhangSequence, spacerSequence, pbsSequence } = input;
  const charWidth = PRIMER_SVG_CONSTANTS.CHAR_WIDTH;
  const padding = PRIMER_PADDING.GIBSON;

  const overhangLength = overhangSequence.length;
  const spacerLength = spacerSequence.length;

  if (spacerLength > 0 && spacerLength > overhangLength) {
    if (process.env.NODE_ENV === 'development') {
      console.error(
        `[computeGibsonSegments] Invalid state: spacerLength (${spacerLength}) > overhangLength (${overhangLength})`
      );
    }
  }

  const homologySequence =
    spacerLength > 0 && spacerLength < overhangLength
      ? overhangSequence.slice(0, overhangLength - spacerLength)
      : spacerLength === 0
        ? overhangSequence
        : '';
  const actualSpacerSequence = spacerLength > 0 ? overhangSequence.slice(-spacerLength) : '';

  const homologyWidth =
    homologySequence.length > 0 ? homologySequence.length * charWidth + padding : 0;
  const spacerWidth = actualSpacerSequence.length * charWidth;
  const pbsWidth = pbsSequence.length * charWidth + padding;
  const totalWidth = homologyWidth + spacerWidth + pbsWidth;

  const homologySegment: PrimerSegment | null =
    homologySequence.length > 0
      ? { sequence: homologySequence, width: homologyWidth, colorType: 'homology' }
      : null;

  const spacerSegment: PrimerSegment | null =
    actualSpacerSequence.length > 0
      ? { sequence: actualSpacerSequence, width: spacerWidth, colorType: 'spacer' }
      : null;

  const pbsSegment: PrimerSegment = {
    sequence: pbsSequence,
    width: pbsWidth,
    colorType: 'pbs',
  };

  return {
    type: 'gibson',
    direction,
    homology: homologySegment,
    spacer: spacerSegment,
    pbs: pbsSegment,
    totalWidth,
  };
}

export interface GoldenGatePrimerInput {
  direction: 'forward' | 'reverse';
  padding5prime: string;
  enzymeSite: string;
  spacer: string;
  overhang4bp: string;
  literalExtra: string;
  pbsSequence: string;
  alignOffset?: number;
}

export function computeGoldenGateSegments(input: GoldenGatePrimerInput): GoldenGatePrimerSegments {
  const {
    direction,
    padding5prime,
    enzymeSite,
    spacer,
    overhang4bp,
    literalExtra,
    pbsSequence,
    alignOffset = 0,
  } = input;
  const charWidth = PRIMER_SVG_CONSTANTS.CHAR_WIDTH;
  const padding = PRIMER_PADDING.GOLDEN_GATE;

  const pad5Width = padding5prime.length * charWidth + padding;
  const enzymeWidth = enzymeSite.length * charWidth;
  const spacerWidth = spacer.length * charWidth;
  const cleavedTotalWidth = pad5Width + enzymeWidth + spacerWidth;

  const oh4bpWidth = overhang4bp.length * charWidth;
  const extraWidth = literalExtra.length * charWidth;
  const overhangTotalWidth = oh4bpWidth + extraWidth;

  const pbsWidth = pbsSequence.length * charWidth + padding;

  const totalWidth = alignOffset + cleavedTotalWidth + overhangTotalWidth + pbsWidth;

  let topCutX: number;
  let bottomCutX: number;

  if (direction === 'forward') {
    topCutX = alignOffset + cleavedTotalWidth;
    bottomCutX = topCutX + oh4bpWidth;
  } else {
    bottomCutX = alignOffset + pbsWidth + extraWidth;
    topCutX = bottomCutX + oh4bpWidth;
  }

  return {
    type: 'goldengate',
    direction,
    cleaved: {
      padding5prime: { sequence: padding5prime, width: pad5Width, colorType: 'cleaved' },
      enzymeSite: { sequence: enzymeSite, width: enzymeWidth, colorType: 'cleaved' },
      spacer: { sequence: spacer, width: spacerWidth, colorType: 'cleaved' },
      totalWidth: cleavedTotalWidth,
    },
    overhang: {
      overhang4bp: { sequence: overhang4bp, width: oh4bpWidth, colorType: 'overhang4bp' },
      literalExtra:
        literalExtra.length > 0
          ? { sequence: literalExtra, width: extraWidth, colorType: 'literalExtra' }
          : null,
      totalWidth: overhangTotalWidth,
    },
    pbs: { sequence: pbsSequence, width: pbsWidth, colorType: 'pbs' },
    topCutX,
    bottomCutX,
    totalWidth,
    alignOffset,
  };
}

export function reverseString(s: string): string {
  return s.split('').reverse().join('');
}
