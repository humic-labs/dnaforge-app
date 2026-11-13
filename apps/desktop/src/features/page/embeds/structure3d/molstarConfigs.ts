import type { MolstarColorMode, MolstarRepresentation } from './molstar/viewerTypes';
import { CHAIN_COLOR_NUMBERS } from './types';
import { STRUCTURE_CONTEXT_MOLSTAR_COLOR } from './utils/structureRenderModel';

const CHAIN_COLOR = 'chain-id';
const ELEMENT_COLOR = 'element-symbol';
const UNCERTAINTY_COLOR = 'uncertainty';

export function chainIdPaletteParams(
  paletteColors: readonly number[] = CHAIN_COLOR_NUMBERS
): Record<string, unknown> {
  return {
    asymId: 'auth',
    palette: {
      name: 'colors',
      params: { list: { kind: 'set', colors: [...paletteColors] } },
    },
  };
}

const CONTEXT_CHAIN_PALETTE = [STRUCTURE_CONTEXT_MOLSTAR_COLOR];

export function contextChainPaletteParams(): Record<string, unknown> {
  return {
    asymId: 'auth',
    palette: {
      name: 'colors',
      params: { list: { kind: 'set', colors: CONTEXT_CHAIN_PALETTE } },
    },
  };
}

export function getColorTheme(colorMode: MolstarColorMode, forIllustrative = false): string {
  if (colorMode === 'element') return ELEMENT_COLOR;
  if (colorMode === 'plddt' || colorMode === 'bfactor') return UNCERTAINTY_COLOR;
  if (colorMode === 'alphamissense') return CHAIN_COLOR;
  return forIllustrative ? 'illustrative' : CHAIN_COLOR;
}

export function getColorParams(
  colorMode: MolstarColorMode,
  forIllustrative = false,
  chainPaletteColors?: readonly number[]
): Record<string, unknown> {
  if (colorMode === 'element') return {};
  if (colorMode === 'plddt')
    return {
      domain: [50, 90],
      list: { kind: 'interpolate', colors: [0x0053d6, 0x65cbf3, 0xffdb13, 0xff7d45] },
    };
  if (colorMode === 'bfactor') return { domain: [0, 100] };
  if (colorMode === 'alphamissense') return chainIdPaletteParams(chainPaletteColors);
  return forIllustrative
    ? { style: { name: 'chain-id', params: chainIdPaletteParams(chainPaletteColors) } }
    : chainIdPaletteParams(chainPaletteColors);
}

export function getMolstarColorThemeSpec(
  colorMode: MolstarColorMode,
  forIllustrative = false,
  chainPaletteColors?: readonly number[]
): { colorTheme: string; colorParams: Record<string, unknown> } {
  return {
    colorTheme: getColorTheme(colorMode, forIllustrative),
    colorParams: getColorParams(colorMode, forIllustrative, chainPaletteColors),
  };
}

export interface RepresentationConfig {
  type: string;
  typeParams: Record<string, unknown>;
  colorTheme: string;
  colorParams: Record<string, unknown>;
  sizeTheme: string;
}

export function getPolymerConfig(
  representation: MolstarRepresentation,
  colorMode: MolstarColorMode,
  chainPaletteColors?: readonly number[]
): RepresentationConfig {
  const colorSpec = getMolstarColorThemeSpec(
    colorMode,
    representation === 'illustrative',
    chainPaletteColors
  );
  const { colorTheme, colorParams } = colorSpec;

  const configs: Record<MolstarRepresentation, RepresentationConfig> = {
    cartoon: {
      type: 'cartoon',
      typeParams: { quality: 'auto', sizeFactor: 0.2 },
      colorTheme,
      colorParams,
      sizeTheme: 'uniform',
    },
    'ball-and-stick': {
      type: 'ball-and-stick',
      typeParams: { quality: 'auto', sizeFactor: 0.15, sizeAspectRatio: 2 / 3 },
      colorTheme,
      colorParams,
      sizeTheme: 'physical',
    },
    surface: {
      type: 'molecular-surface',
      typeParams: { quality: 'auto', resolution: 2, probeRadius: 1.4 },
      colorTheme,
      colorParams,
      sizeTheme: 'physical',
    },
    spacefill: {
      type: 'spacefill',
      typeParams: { quality: 'auto', sizeFactor: 1 },
      colorTheme,
      colorParams,
      sizeTheme: 'physical',
    },
    illustrative: {
      type: 'spacefill',
      typeParams: { quality: 'auto', sizeFactor: 1, ignoreLight: true },
      colorTheme,
      colorParams,
      sizeTheme: 'physical',
    },
  };

  return configs[representation] || configs['cartoon'];
}

export interface LigandConfig {
  type: string;
  typeParams: Record<string, unknown>;
}

export function getLigandConfig(representation: MolstarRepresentation): LigandConfig {
  const configs: Record<MolstarRepresentation, LigandConfig> = {
    cartoon: {
      type: 'ball-and-stick',
      typeParams: { quality: 'auto', sizeFactor: 0.2 },
    },
    'ball-and-stick': {
      type: 'ball-and-stick',
      typeParams: { quality: 'auto', sizeFactor: 0.15, sizeAspectRatio: 2 / 3 },
    },
    surface: {
      type: 'ball-and-stick',
      typeParams: { quality: 'auto', sizeFactor: 0.2 },
    },
    spacefill: {
      type: 'ball-and-stick',
      typeParams: { quality: 'auto', sizeFactor: 0.2 },
    },
    illustrative: {
      type: 'ball-and-stick',
      typeParams: { quality: 'auto', sizeFactor: 0.2 },
    },
  };

  return configs[representation] || configs['cartoon'];
}

export function getIonSizeFactor(representation: MolstarRepresentation): number {
  return representation === 'spacefill' || representation === 'illustrative' ? 1 : 0.6;
}

export function getIonTypeParams(representation: MolstarRepresentation): Record<string, unknown> {
  const sizeFactor = getIonSizeFactor(representation);
  return representation === 'illustrative'
    ? { quality: 'auto', sizeFactor, ignoreLight: true }
    : { quality: 'auto', sizeFactor };
}

export function getWaterTypeParams(
  representation: MolstarRepresentation,
  showWater: boolean
): Record<string, unknown> {
  const alpha = showWater ? 0.6 : 0.0;
  return representation === 'illustrative'
    ? { quality: 'auto', sizeFactor: 0.5, ignoreLight: true, alpha }
    : { quality: 'auto', sizeFactor: 0.5, alpha };
}

export const ILLUSTRATIVE_POSTPROCESSING = {
  occlusion: {
    name: 'on',
    params: {
      samples: 32,
      multiScale: { name: 'off', params: {} },
      radius: 5,
      bias: 0.8,
      blurKernelSize: 15,
      blurDepthBias: 0.5,
      resolutionScale: 1,
      color: 0x000000,
      transparentThreshold: 0.4,
    },
  },
  outline: {
    name: 'on',
    params: {
      scale: 1,
      threshold: 0.33,
      color: 0x000000,
      includeTransparent: true,
    },
  },
  shadow: { name: 'off', params: {} },
} as const;

export const ILLUSTRATIVE_AMBIENT = 1.0;
