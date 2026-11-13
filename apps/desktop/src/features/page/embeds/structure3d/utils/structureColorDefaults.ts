import type { Structure3dColorMode, StructureVisualColorMode } from '../types';

import {
  normalizeStructureScoreColor,
  structureScoreState,
  type StructureScoreContext,
} from './structureScoreState';

export function defaultColorModeForStructure(
  attrs: StructureScoreContext | undefined
): Structure3dColorMode {
  return structureScoreState(attrs).colorMode === 'plddt' ? 'plddt' : 'chain';
}

export function resolveStructureVisualColorMode(
  mode: StructureVisualColorMode | undefined,
  attrs: StructureScoreContext | undefined
): Structure3dColorMode | undefined {
  if (!mode) return undefined;
  if (isStructureColorMode(mode)) return normalizeStructureScoreColor(mode, attrs);
  if (mode === 'source-default') return defaultColorModeForStructure(attrs);
  return undefined;
}

function isStructureColorMode(mode: StructureVisualColorMode): mode is Structure3dColorMode {
  return (
    mode === 'chain' ||
    mode === 'element' ||
    mode === 'plddt' ||
    mode === 'bfactor' ||
    mode === 'alphamissense'
  );
}
