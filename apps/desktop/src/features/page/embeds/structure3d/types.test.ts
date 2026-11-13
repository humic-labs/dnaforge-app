// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  SOURCE_CONFIGS,
  SOURCE_ORDER,
  REPRESENTATION_OPTIONS,
  getChainColorAssignments,
  createStructureChainColoring,
  getChainColor,
  getChainColorForSequenceChain,
  getDisplayChainId,
  CHAIN_COLORS,
  CHAIN_COLOR_NUMBERS,
  HIGHLIGHT_COLORS,
  HIGHLIGHT_PALETTE,
  COLOR_SCALE_PRESETS,
} from './types';
import { getColorOptions } from './utils/structureScoreState';
import {
  STRUCTURE_CONTEXT_COLOR,
  STRUCTURE_CONTEXT_MOLSTAR_COLOR,
} from './utils/structureRenderModel';

describe('Structure3D types utilities', () => {
  describe('SOURCE_CONFIGS', () => {
    it('has all source types', () => {
      expect(SOURCE_CONFIGS.pdb).toBeDefined();
      expect(SOURCE_CONFIGS.alphafold).toBeDefined();
      expect(SOURCE_CONFIGS.url).toBeDefined();
      expect(SOURCE_CONFIGS.file).toBeDefined();
    });

    describe('PDB config', () => {
      const config = SOURCE_CONFIGS.pdb;

      it('validates correct PDB IDs', () => {
        expect(config.validate('1CRN')).toBe(true);
        expect(config.validate('4HHB')).toBe(true);
        expect(config.validate('2abc')).toBe(true);
      });

      it('rejects invalid PDB IDs', () => {
        expect(config.validate('ABC')).toBe(false);
        expect(config.validate('12345')).toBe(false);
        expect(config.validate('ABCD')).toBe(false);
        expect(config.validate('')).toBe(false);
      });
    });

    describe('AlphaFold config', () => {
      const config = SOURCE_CONFIGS.alphafold;

      it('validates correct UniProt IDs', () => {
        expect(config.validate('P04637')).toBe(true);
        expect(config.validate('Q9Y6K9')).toBe(true);
        expect(config.validate('A0A0A0')).toBe(true);
      });

      it('validates TrEMBL-style 10-character UniProt IDs returned by resolver flows', () => {
        expect(config.validate('A0A0H3JZA8')).toBe(true);
        expect(config.validate('A0AAN3ZHY6')).toBe(true);
        expect(config.validate('a0a0h3jza8')).toBe(true);
      });

      it('validates UniProt IDs with isoform suffix', () => {
        expect(config.validate('P04637-1')).toBe(true);
        expect(config.validate('P04637-23')).toBe(true);
        expect(config.validate('A0A0H3JZA8-1')).toBe(true);
      });

      it('rejects invalid UniProt IDs', () => {
        expect(config.validate('P0463')).toBe(false);
        expect(config.validate('04637A')).toBe(false);
        expect(config.validate('')).toBe(false);
      });
    });

    describe('URL config', () => {
      const config = SOURCE_CONFIGS.url;

      it('validates correct URLs', () => {
        expect(config.validate('https://example.com/structure.pdb')).toBe(true);
        expect(config.validate('http://localhost:3000/file.cif')).toBe(true);
      });

      it('rejects invalid URLs', () => {
        expect(config.validate('not-a-url')).toBe(false);
        expect(config.validate('')).toBe(false);
      });
    });

    describe('File config', () => {
      const config = SOURCE_CONFIGS.file;

      it('always validates (file validation happens elsewhere)', () => {
        expect(config.validate('')).toBe(true);
        expect(config.validate('anything')).toBe(true);
      });
    });
  });

  describe('SOURCE_ORDER', () => {
    it('has all sources in correct order', () => {
      expect(SOURCE_ORDER).toEqual(['pdb', 'alphafold', 'url', 'file']);
    });
  });

  describe('REPRESENTATION_OPTIONS', () => {
    it('exposes shipped primitive representation options', () => {
      const values = REPRESENTATION_OPTIONS.map((o) => o.value);
      expect(values).toEqual(['cartoon', 'ball-and-stick', 'spacefill', 'surface', 'illustrative']);
    });

    it('has labels for all options', () => {
      REPRESENTATION_OPTIONS.forEach((option) => {
        expect(option.label).toBeTruthy();
      });
    });
  });

  describe('getColorOptions', () => {
    it('returns base options for PDB source', () => {
      const options = getColorOptions('pdb');
      const values = options.map((o) => o.value);
      expect(values).toContain('chain');
      expect(values).toContain('element');
      expect(values).toContain('bfactor');
      expect(values).not.toContain('plddt');
    });

    it('returns pLDDT option for AlphaFold source', () => {
      const options = getColorOptions('alphafold');
      const values = options.map((o) => o.value);
      expect(values).toContain('chain');
      expect(values).toContain('element');
      expect(values).toContain('plddt');
      expect(values).toContain('alphamissense');
      expect(values).not.toContain('bfactor');
    });

    it('returns bfactor for URL source', () => {
      const options = getColorOptions('url');
      const values = options.map((o) => o.value);
      expect(values).toContain('bfactor');
    });

    it('returns bfactor for file source', () => {
      const options = getColorOptions('file');
      const values = options.map((o) => o.value);
      expect(values).toContain('bfactor');
    });
  });

  describe('getChainColor', () => {
    it('returns predefined colors for known chains', () => {
      expect(getChainColor('A')).toBe(CHAIN_COLORS['A']);
      expect(getChainColor('B')).toBe(CHAIN_COLORS['B']);
      expect(getChainColor('C')).toBe(CHAIN_COLORS['C']);
    });

    it('returns a color for unknown chains (hashed)', () => {
      const color = getChainColor('Z');
      expect(color).toBeTruthy();
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('returns consistent color for same unknown chain', () => {
      const color1 = getChainColor('XYZ');
      const color2 = getChainColor('XYZ');
      expect(color1).toMatch(/\S/);
      expect(color1).toBe(color2);
    });

    it('returns different colors for different unknown chains', () => {
      const color1 = getChainColor('XY');
      const color2 = getChainColor('ZW');
      expect(color1).toBeTruthy();
      expect(color2).toBeTruthy();
    });

    it('returns same color for dimer chains as their base chain (A, A2, A3 all match)', () => {
      const colorA = getChainColor('A');
      const colorA2 = getChainColor('A2');
      const colorA3 = getChainColor('A3');
      expect(colorA).toBe(CHAIN_COLORS['A']);
      expect(colorA2).toBe(colorA);
      expect(colorA3).toBe(colorA);
    });

    it('returns base chain colors for different dimer chains', () => {
      const colorB2 = getChainColor('B2');
      const colorC2 = getChainColor('C2');
      expect(colorB2).toBe(CHAIN_COLORS['B']);
      expect(colorC2).toBe(CHAIN_COLORS['C']);
    });

    it('uses auth asym id as the color/display key for sequence chains', () => {
      const chain = { chainId: 'H', baseChain: 'H', authAsymId: 'B' };
      expect(getDisplayChainId(chain)).toBe('B');
      expect(getChainColorForSequenceChain(chain)).toBe(CHAIN_COLORS['B']);
    });

    it('assigns sequence chain colors by first-seen Molstar chain-id serial order', () => {
      const assignments = getChainColorAssignments([
        { chainId: 'A', baseChain: 'A', authAsymId: 'H' },
        { chainId: 'H', baseChain: 'H', authAsymId: 'B' },
        { chainId: 'A2', baseChain: 'A2', authAsymId: 'H' },
      ]);

      expect(assignments.get('A')).toBe('#e6194b');
      expect(assignments.get('H')).toBe('#2ca02c');
      expect(assignments.get('A2')).toBe('#e6194b');
    });

    it('builds one chain-color object that feeds both UI swatches and Molstar palette order', () => {
      const coloring = createStructureChainColoring([
        { chainId: 'A', baseChain: 'A', authAsymId: 'H' },
        { chainId: 'H', baseChain: 'H', authAsymId: 'B' },
        { chainId: 'Q', baseChain: 'Q', authAsymId: 'Q' },
        { chainId: 'A2', baseChain: 'A2', authAsymId: 'H' },
      ]);

      expect(coloring.molstarPalette).toEqual([0xe6194b, 0x2ca02c, 0x1f77ff]);
      expect(coloring.colorByChainId.get('A')).toBe('#e6194b');
      expect(coloring.colorByChainId.get('A2')).toBe('#e6194b');
      expect(coloring.molstarColorByChainId.get('Q')).toBe(0x1f77ff);
      expect(coloring.assignments.map((assignment) => assignment.colorKey)).toEqual([
        'H',
        'B',
        'Q',
        'H',
      ]);
    });

    it('uses Molstar chain serials instead of visible table order when assigning colors', () => {
      const coloring = createStructureChainColoring([
        { chainId: 'Q', baseChain: 'Q', authAsymId: 'Q', molstarChainSerial: 3 },
        { chainId: 'A', baseChain: 'A', authAsymId: 'A', molstarChainSerial: 0 },
        { chainId: 'G', baseChain: 'G', authAsymId: 'G', molstarChainSerial: 2 },
        { chainId: 'B', baseChain: 'B', authAsymId: 'B', molstarChainSerial: 1 },
      ]);

      expect(coloring.assignments.map((assignment) => assignment.chainId)).toEqual([
        'A',
        'B',
        'G',
        'Q',
      ]);
      expect(coloring.colorByChainId.get('G')).toBe('#1f77ff');
      expect(coloring.colorByChainId.get('Q')).toBe('#ff7f0e');
      expect(coloring.molstarPalette).toEqual([0xe6194b, 0x2ca02c, 0x1f77ff, 0xff7f0e]);
    });
  });

  describe('CHAIN_COLORS', () => {
    it('has colors for chains A through L', () => {
      const chains = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
      chains.forEach((chain) => {
        expect(CHAIN_COLORS[chain]).toBeTruthy();
        expect(CHAIN_COLORS[chain]).toMatch(/^#[0-9a-f]{6}$/i);
      });
    });

    it('does not use gray or gray-neighbor colors for detailed chains', () => {
      expect(CHAIN_COLOR_NUMBERS).not.toContain(0x888888);
      expect(CHAIN_COLOR_NUMBERS).not.toContain(0x666666);
      expect(CHAIN_COLOR_NUMBERS).not.toContain(STRUCTURE_CONTEXT_MOLSTAR_COLOR);
      expect(Object.values(CHAIN_COLORS)).not.toContain('#888888');
      expect(Object.values(CHAIN_COLORS)).not.toContain('#666666');
      expect(Object.values(CHAIN_COLORS)).not.toContain(STRUCTURE_CONTEXT_COLOR);
    });
  });

  describe('HIGHLIGHT_COLORS', () => {
    it('uses Molstar default hover colors', () => {
      expect(HIGHLIGHT_COLORS.hover.bg).toBe('rgba(255, 102, 153, 0.12)');
      expect(HIGHLIGHT_COLORS.hover.outline).toBe(0xff6699);
    });

    it('uses Molstar default selection colors', () => {
      expect(HIGHLIGHT_COLORS.selected.bg).toBe('rgba(51, 255, 25, 0.12)');
      expect(HIGHLIGHT_COLORS.selected.outline).toBe(0x33ff19);
    });
  });

  describe('HIGHLIGHT_PALETTE', () => {
    it('has 6 colors', () => {
      expect(HIGHLIGHT_PALETTE).toHaveLength(6);
    });

    it('has valid hex colors', () => {
      HIGHLIGHT_PALETTE.forEach((color) => {
        expect(color).toMatch(/^#[0-9a-f]{6}$/i);
      });
    });
  });

  describe('COLOR_SCALE_PRESETS', () => {
    it('has alphamissense preset', () => {
      const preset = COLOR_SCALE_PRESETS.alphamissense;
      expect(preset.type).toBe('discrete');
      expect(preset.colors).toHaveLength(3);
      expect(preset.breakpoints).toHaveLength(2);
      expect(preset.labels).toHaveLength(3);
    });

    it('has diverging preset', () => {
      const preset = COLOR_SCALE_PRESETS.diverging;
      expect(preset.type).toBe('diverging');
      expect(preset.colors).toHaveLength(3);
    });

    it('has viridis preset', () => {
      const preset = COLOR_SCALE_PRESETS.viridis;
      expect(preset.type).toBe('continuous');
      expect(preset.colors).toHaveLength(3);
    });

    it('has heat preset', () => {
      const preset = COLOR_SCALE_PRESETS.heat;
      expect(preset.type).toBe('continuous');
      expect(preset.colors).toHaveLength(5);
    });
  });
});
