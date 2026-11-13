import { hexToEnzymeColorInt } from './enzyme-color-authority';

export type CanonicalGoldenGateEnzyme = 'BsaI' | 'BbsI' | 'BsmBI' | 'SapI';

export interface GoldenGateEnzymeCapability {
  name: string;
  canonical: CanonicalGoldenGateEnzyme;
  overhangLength: number;
}

function hexWithAlpha(hex: string, alpha: number): string {
  const rgb = hexToEnzymeColorInt(hex);
  const red = (rgb >> 16) & 0xff;
  const green = (rgb >> 8) & 0xff;
  const blue = rgb & 0xff;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

const PRIMER_PBS_HEX = '#8B5CF6';
const PRIMER_OVERHANG_HEX = '#D97706';
const SCAR_BASE_HEX = '#DC2626';
const CLEAVED_HEX = '#6B7280';
const PRODUCT_SCAR_HEX = '#FFA500';
const PRODUCT_SCAR_HOVER_HEX = '#FF8C00';
const LABEL_LIGHT_HEX = '#FFFFFF';
const LABEL_LIGHT_HOVER_HEX = '#DCDCDC';
const LABEL_DARK_HEX = '#282828';
const LABEL_DARK_HOVER_HEX = '#3C3C3C';
const LABEL_BACKGROUND_ALPHA = 0.9;
const LABEL_HOVER_BACKGROUND_ALPHA = 0.95;

export const GOLDEN_GATE_JUNCTION_VISUAL = {
  scarLengthBp: 4,
  primer: {
    defaultPbsColorHex: PRIMER_PBS_HEX,
    defaultPbsColorPixi: hexToEnzymeColorInt(PRIMER_PBS_HEX),
    defaultOverhangColorHex: PRIMER_OVERHANG_HEX,
    defaultOverhangColorPixi: hexToEnzymeColorInt(PRIMER_OVERHANG_HEX),
    scarBaseColorHex: SCAR_BASE_HEX,
    scarBaseColorPixi: hexToEnzymeColorInt(SCAR_BASE_HEX),
    cleavedColorHex: CLEAVED_HEX,
    cleavedColorPixi: hexToEnzymeColorInt(CLEAVED_HEX),
    scarBaseFontWeight: 900,
    pbsFillAlpha: 0.08,
    retainedFillAlpha: 0.25,
    cleavedFillAlpha: 0.15,
    spacerFillAlpha: 0.15,
    segmentStrokeWidthPx: 1.5,
    segmentDashPx: [3, 3] as const,
  },
  productScar: {
    fillColorHex: PRODUCT_SCAR_HEX,
    fillColorPixi: hexToEnzymeColorInt(PRODUCT_SCAR_HEX),
    fillAlpha: 0.25,
    fillCss: hexWithAlpha(PRODUCT_SCAR_HEX, 0.25),
    hoverStrokeColorHex: PRODUCT_SCAR_HOVER_HEX,
    hoverStrokeColorPixi: hexToEnzymeColorInt(PRODUCT_SCAR_HOVER_HEX),
    hoverStrokeAlpha: 0.8,
    hoverStrokeCss: hexWithAlpha(PRODUCT_SCAR_HOVER_HEX, 0.8),
    hoverStrokeWidthPx: 2,
  },
  cutLine: {
    widthPx: 1,
    hoverWidthPx: 2.5,
  },
  identityLabel: {
    fontSizePx: 9,
    fontWeight: 400,
    hoverFontWeight: 700,
    monospaceCharacterWidthEm: 0.6,
    horizontalPaddingPx: 3,
    verticalPaddingPx: 2,
    gapPx: 4,
    connectorDashPx: [2, 2] as const,
    connectorWidthPx: 0.75,
    hoverConnectorWidthPx: 1.5,
    borderWidthPx: 1,
    hoverBorderWidthPx: 2,
    lightBackgroundColorPixi: hexToEnzymeColorInt(LABEL_LIGHT_HEX),
    lightBackgroundAlpha: LABEL_BACKGROUND_ALPHA,
    lightBackgroundCss: hexWithAlpha(LABEL_LIGHT_HEX, LABEL_BACKGROUND_ALPHA),
    lightHoverBackgroundColorPixi: hexToEnzymeColorInt(LABEL_LIGHT_HOVER_HEX),
    lightHoverBackgroundAlpha: LABEL_HOVER_BACKGROUND_ALPHA,
    lightHoverBackgroundCss: hexWithAlpha(LABEL_LIGHT_HOVER_HEX, LABEL_HOVER_BACKGROUND_ALPHA),
    darkBackgroundColorPixi: hexToEnzymeColorInt(LABEL_DARK_HEX),
    darkBackgroundAlpha: LABEL_BACKGROUND_ALPHA,
    darkBackgroundCss: hexWithAlpha(LABEL_DARK_HEX, LABEL_BACKGROUND_ALPHA),
    darkHoverBackgroundColorPixi: hexToEnzymeColorInt(LABEL_DARK_HOVER_HEX),
    darkHoverBackgroundAlpha: LABEL_HOVER_BACKGROUND_ALPHA,
    darkHoverBackgroundCss: hexWithAlpha(LABEL_DARK_HOVER_HEX, LABEL_HOVER_BACKGROUND_ALPHA),
  },
} as const;

export interface GoldenGateJunctionVisualSource {
  start: number;
  direction: 'forward' | 'reverse';
  cutPositionInOverhang?: number;
  enzymeName?: string;
  suppressCutSiteRendering?: boolean;
  scarAbsolutePosition?: number;
  junctionIndex?: number;
}

export interface GoldenGateJunctionVisualModel {
  scarStart: number;
  scarEnd: number;
  scarEndUnwrapped: number;
  scarLengthBp: number;
  identityLabel: string | null;
}

function positiveModulo(value: number, modulo: number): number {
  return ((value % modulo) + modulo) % modulo;
}

export function resolveGoldenGateJunctionVisual(
  source: GoldenGateJunctionVisualSource,
  sequenceLength: number
): GoldenGateJunctionVisualModel | null {
  if (
    !Number.isFinite(sequenceLength) ||
    sequenceLength <= 0 ||
    source.direction !== 'forward' ||
    source.cutPositionInOverhang === undefined ||
    source.cutPositionInOverhang <= 0 ||
    source.suppressCutSiteRendering
  ) {
    return null;
  }

  const rawScarStart = source.scarAbsolutePosition ?? source.start + source.cutPositionInOverhang;
  const scarStart = positiveModulo(rawScarStart, sequenceLength);
  const scarLengthBp = GOLDEN_GATE_JUNCTION_VISUAL.scarLengthBp;
  const scarEndUnwrapped = scarStart + scarLengthBp;
  const junctionSuffix = source.junctionIndex === undefined ? '' : ` J${source.junctionIndex + 1}`;

  return {
    scarStart,
    scarEnd: positiveModulo(scarEndUnwrapped, sequenceLength),
    scarEndUnwrapped,
    scarLengthBp,
    identityLabel: source.enzymeName ? `${source.enzymeName}${junctionSuffix}` : null,
  };
}

export function primersForSequenceDisplay<T extends { isScarMarkerOnly?: boolean }>(
  primers: T[],
  showPrimers: boolean
): T[] {
  return showPrimers ? primers : primers.filter((primer) => primer.isScarMarkerOnly);
}

export const GOLDEN_GATE_ENZYME_CAPABILITIES = [
  { name: 'BsaI', canonical: 'BsaI', overhangLength: 4 },
  { name: 'BbsI', canonical: 'BbsI', overhangLength: 4 },
  { name: 'BpiI', canonical: 'BbsI', overhangLength: 4 },
  { name: 'BsmBI', canonical: 'BsmBI', overhangLength: 4 },
  { name: 'Esp3I', canonical: 'BsmBI', overhangLength: 4 },
  { name: 'SapI', canonical: 'SapI', overhangLength: 3 },
] as const satisfies readonly GoldenGateEnzymeCapability[];

const GOLDEN_GATE_CAPABILITY_BY_NAME = new Map<string, GoldenGateEnzymeCapability>(
  GOLDEN_GATE_ENZYME_CAPABILITIES.map((capability) => [capability.name, capability])
);

export const GOLDEN_GATE_ENZYME_NAMES = GOLDEN_GATE_ENZYME_CAPABILITIES.map(
  (capability) => capability.name
);

export function getGoldenGateEnzymeCapability(
  enzymeName: string | null | undefined
): GoldenGateEnzymeCapability | undefined {
  if (!enzymeName) return undefined;
  return GOLDEN_GATE_CAPABILITY_BY_NAME.get(enzymeName);
}

export function isGoldenGateEnzymeName(
  enzymeName: string | null | undefined
): enzymeName is string {
  return getGoldenGateEnzymeCapability(enzymeName) !== undefined;
}

export function canonicalGoldenGateEnzymeName(
  enzymeName: string | null | undefined
): CanonicalGoldenGateEnzyme | undefined {
  return getGoldenGateEnzymeCapability(enzymeName)?.canonical;
}

export function goldenGateOverhangLengthForEnzymeName(
  enzymeName: string | null | undefined
): number | undefined {
  return getGoldenGateEnzymeCapability(enzymeName)?.overhangLength;
}
