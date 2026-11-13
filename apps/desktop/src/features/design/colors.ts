import {
  getAssemblyColorScheme,
  type AssemblyColorSchemeId,
  type FragmentColor,
} from './color-schemes';
import { getActiveAssemblyColorScheme } from './color-scheme-store';

export {
  ASSEMBLY_COLOR_SCHEME_OPTIONS,
  ASSEMBLY_COLOR_SCHEMES,
  DEFAULT_ASSEMBLY_COLOR_SCHEME,
  getAssemblyColorScheme,
  resolveAssemblyColorSchemeId,
  type AssemblyColorScheme,
  type AssemblyColorSchemeId,
  type FragmentColor,
} from './color-schemes';

export const EMPTY_PART_COLOR = '#9ca3af';
const EMPTY_PART_FRAGMENT_COLOR: FragmentColor = {
  hex: EMPTY_PART_COLOR,
  text: 'text-gray-500 dark:text-gray-400',
  bg: 'bg-gray-500/10',
};

export const ASSEMBLY_SPACER_COLOR = '#8b95a1';
export const ASSEMBLY_SEGMENT_RAIL_WIDTH = 3;
export const ASSEMBLY_RULER_PROVENANCE_STROKE_WIDTH = 2;
export const ASSEMBLY_BACKBONE_PROVENANCE_STROKE_WIDTH = 5.25;
export const ASSEMBLY_BACKBONE_PROVENANCE_HOVER_STROKE_WIDTH = 7;
export const ASSEMBLY_PROVENANCE_STROKE_ALPHA = 1;
const ASSEMBLY_VISUAL_NEUTRAL_MIX = '#64748b';
const ASSEMBLY_VISUAL_NEUTRAL_MIX_AMOUNT = 0;
const ASSEMBLY_CARD_SURFACE_ALPHA = 0.24;

export type AssemblySegmentSurface = 'fragment' | 'neutral';

export interface AssemblyProvenanceStrokeStyle {
  color: string;
  strokeWidth: number;
  alpha: number;
  themeStableColor: true;
}

interface RegionColorInput {
  colorIndex?: number;
  isPlaceholder?: boolean;
}

function activeScheme(schemeId?: AssemblyColorSchemeId): AssemblyColorSchemeId {
  return schemeId ?? getActiveAssemblyColorScheme();
}

export function getFragmentColor(
  fragmentIndex: number,
  schemeId?: AssemblyColorSchemeId
): FragmentColor {
  const colors = getAssemblyColorScheme(activeScheme(schemeId)).colors;
  const index = ((fragmentIndex % colors.length) + colors.length) % colors.length;
  return colors[index];
}

export function getFragmentHex(fragmentIndex: number, schemeId?: AssemblyColorSchemeId): string {
  return getFragmentColor(fragmentIndex, schemeId).hex;
}

export function getFragmentColorForRegion(
  region: RegionColorInput | undefined,
  fallbackIndex: number,
  schemeId?: AssemblyColorSchemeId
): FragmentColor {
  if (region?.isPlaceholder) return EMPTY_PART_FRAGMENT_COLOR;
  return getFragmentColor(region?.colorIndex ?? fallbackIndex, schemeId);
}

export function getFragmentHexForRegion(
  region: RegionColorInput | undefined,
  fallbackIndex: number,
  schemeId?: AssemblyColorSchemeId
): string {
  return getFragmentColorForRegion(region, fallbackIndex, schemeId).hex;
}

function parseHexRgb(hex: string): [number, number, number] {
  const normalized = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return [156, 163, 175];
  return [
    parseInt(normalized.slice(0, 2), 16),
    parseInt(normalized.slice(2, 4), 16),
    parseInt(normalized.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b
    .toString(16)
    .padStart(2, '0')}`;
}

export function mixHexColors(baseHex: string, mixHex: string, mixAmount: number): string {
  const amount = Math.max(0, Math.min(1, mixAmount));
  const [baseR, baseG, baseB] = parseHexRgb(baseHex);
  const [mixR, mixG, mixB] = parseHexRgb(mixHex);
  return rgbToHex(
    Math.round(baseR * (1 - amount) + mixR * amount),
    Math.round(baseG * (1 - amount) + mixG * amount),
    Math.round(baseB * (1 - amount) + mixB * amount)
  );
}

export function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = parseHexRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function getAssemblyVisualizationHex(baseHex: string): string {
  return mixHexColors(baseHex, ASSEMBLY_VISUAL_NEUTRAL_MIX, ASSEMBLY_VISUAL_NEUTRAL_MIX_AMOUNT);
}

export function getAssemblyVisualizationHexForRegion(
  region: RegionColorInput | undefined,
  fallbackIndex: number,
  schemeId?: AssemblyColorSchemeId
): string {
  return getAssemblyVisualizationHex(getFragmentHexForRegion(region, fallbackIndex, schemeId));
}

export function getAssemblyPartRailColor(baseHex: string): string {
  return getAssemblyVisualizationHex(baseHex);
}

export function getAssemblySegmentRailColor(
  surface: AssemblySegmentSurface,
  baseHex: string
): string {
  return surface === 'fragment' ? getAssemblyPartRailColor(baseHex) : ASSEMBLY_SPACER_COLOR;
}

export function getAssemblyPartSurfaceColor(baseHex: string): string {
  return hexToRgba(getAssemblyVisualizationHex(baseHex), ASSEMBLY_CARD_SURFACE_ALPHA);
}

export function getAssemblyBackboneProvenanceStyle(
  baseHex: string,
  options: { hovered?: boolean } = {}
): AssemblyProvenanceStrokeStyle {
  return {
    color: options.hovered
      ? mixHexColors(getAssemblyVisualizationHex(baseHex), '#ffffff', 0.25)
      : getAssemblyVisualizationHex(baseHex),
    strokeWidth: options.hovered
      ? ASSEMBLY_BACKBONE_PROVENANCE_HOVER_STROKE_WIDTH
      : ASSEMBLY_BACKBONE_PROVENANCE_STROKE_WIDTH,
    alpha: ASSEMBLY_PROVENANCE_STROKE_ALPHA,
    themeStableColor: true,
  };
}

export function getAssemblyBackboneProvenanceStyleForRegion(
  region: RegionColorInput | undefined,
  fallbackIndex: number,
  options: { hovered?: boolean } = {},
  schemeId?: AssemblyColorSchemeId
): AssemblyProvenanceStrokeStyle {
  return getAssemblyBackboneProvenanceStyle(
    getFragmentHexForRegion(region, fallbackIndex, schemeId),
    options
  );
}

export function getAssemblySpacerProvenanceStyle(): AssemblyProvenanceStrokeStyle {
  return {
    color: ASSEMBLY_SPACER_COLOR,
    strokeWidth: ASSEMBLY_BACKBONE_PROVENANCE_STROKE_WIDTH,
    alpha: ASSEMBLY_PROVENANCE_STROKE_ALPHA,
    themeStableColor: true,
  };
}
