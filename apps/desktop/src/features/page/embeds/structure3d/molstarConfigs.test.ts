// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { CHAIN_COLOR_NUMBERS } from './types';
import {
  chainIdPaletteParams,
  contextChainPaletteParams,
  getColorParams,
  getColorTheme,
} from './molstarConfigs';
import { STRUCTURE_CONTEXT_MOLSTAR_COLOR } from './utils/structureRenderModel';

describe('MolStar structure color configuration', () => {
  it('uses a saturated non-gray chain palette for detailed chains', () => {
    expect(getColorTheme('chain')).toBe('chain-id');
    expect(getColorParams('chain')).toEqual(chainIdPaletteParams());
    expect(getColorParams('alphamissense')).toEqual(chainIdPaletteParams());
    expect(chainIdPaletteParams()).toEqual({
      asymId: 'auth',
      palette: {
        name: 'colors',
        params: { list: { kind: 'set', colors: [...CHAIN_COLOR_NUMBERS] } },
      },
    });
    expect(CHAIN_COLOR_NUMBERS).not.toContain(0x888888);
    expect(CHAIN_COLOR_NUMBERS).not.toContain(0x666666);
    expect(CHAIN_COLOR_NUMBERS).not.toContain(STRUCTURE_CONTEXT_MOLSTAR_COLOR);
  });

  it('keeps illustrative detail on the saturated chain-id style params', () => {
    expect(getColorTheme('chain', true)).toBe('illustrative');
    expect(getColorParams('chain', true)).toEqual({
      style: { name: 'chain-id', params: chainIdPaletteParams() },
    });
  });

  it('uses a single light gray palette for context chains', () => {
    expect(contextChainPaletteParams()).toEqual({
      asymId: 'auth',
      palette: {
        name: 'colors',
        params: { list: { kind: 'set', colors: [STRUCTURE_CONTEXT_MOLSTAR_COLOR] } },
      },
    });
  });
});
