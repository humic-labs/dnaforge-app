import { describe, expect, it } from 'vitest';
import {
  ENZYME_COLOR_PALETTE,
  ENZYME_COLOR_PALETTE_INT,
  assignEnzymeColors,
  enzymeColorAt,
  hexToEnzymeColorInt,
} from './enzyme-color-authority';

const LEGACY_WEBGL_INT_PALETTE = [
  0xe6194b, 0x3cb44b, 0x4363d8, 0xf58231, 0x911eb4, 0x0891b2, 0xf032e6, 0x65a30d, 0xdb2777,
  0x469990, 0x7c3aed, 0x9a6324, 0xca8a04, 0x800000, 0x059669, 0x808000, 0xc2410c, 0x000075,
];

describe('hexToEnzymeColorInt — the ONE hex→int converter', () => {
  it('converts #rrggbb to a 0xRRGGBB integer', () => {
    expect(hexToEnzymeColorInt('#e6194b')).toBe(0xe6194b);
    expect(hexToEnzymeColorInt('#000075')).toBe(0x000075);
    expect(hexToEnzymeColorInt('#ffffff')).toBe(0xffffff);
    expect(hexToEnzymeColorInt('#000000')).toBe(0x000000);
  });

  it('is case-insensitive (the palette mixes #9A6324 with lowercase entries)', () => {
    expect(hexToEnzymeColorInt('#9A6324')).toBe(0x9a6324);
    expect(hexToEnzymeColorInt('#9a6324')).toBe(0x9a6324);
  });

  it('expands #rgb shorthand', () => {
    expect(hexToEnzymeColorInt('#f0a')).toBe(0xff00aa);
  });

  it('drops the alpha byte on #rrggbbaa (RGB only), not the red byte', () => {
    expect(hexToEnzymeColorInt('#e6194bff')).toBe(0xe6194b);
    expect(hexToEnzymeColorInt('#00007580')).toBe(0x000075);
  });

  it('falls back to black on malformed input instead of a mangled value', () => {
    expect(hexToEnzymeColorInt('red')).toBe(0x000000);
    expect(hexToEnzymeColorInt('')).toBe(0x000000);
    expect(hexToEnzymeColorInt('#12')).toBe(0x000000);
    expect(hexToEnzymeColorInt('#zzzzzz')).toBe(0x000000);
  });
});

describe('ENZYME_COLOR_PALETTE_INT — both forms from one source', () => {
  it('has the same length as the hex palette', () => {
    expect(ENZYME_COLOR_PALETTE_INT).toHaveLength(ENZYME_COLOR_PALETTE.length);
  });

  it('reproduces the legacy WebGL int palette exactly (no repaint)', () => {
    expect(ENZYME_COLOR_PALETTE_INT).toEqual(LEGACY_WEBGL_INT_PALETTE);
  });
});

describe('enzymeColorAt — resolve both forms by active-set index', () => {
  it('returns the hex and its converted int for a given index', () => {
    const c = enzymeColorAt(0);
    expect(c.hex).toBe(ENZYME_COLOR_PALETTE[0]);
    expect(c.int).toBe(hexToEnzymeColorInt(ENZYME_COLOR_PALETTE[0]));
  });

  it('wraps modulo the palette length', () => {
    const len = ENZYME_COLOR_PALETTE.length;
    expect(enzymeColorAt(len)).toEqual(enzymeColorAt(0));
    expect(enzymeColorAt(len + 3)).toEqual(enzymeColorAt(3));
  });
});

describe('assignEnzymeColors — keyed by index in the ordered ACTIVE set (Option 1)', () => {
  it('assigns palette colors in order, no collisions among the first paletteLength enzymes', () => {
    const names = ['EcoRI', 'BamHI', 'HindIII'];
    const map = assignEnzymeColors(names);
    expect(map.get('EcoRI')).toEqual(enzymeColorAt(0));
    expect(map.get('BamHI')).toEqual(enzymeColorAt(1));
    expect(map.get('HindIII')).toEqual(enzymeColorAt(2));
    const ints = names.map((n) => map.get(n)!.int);
    expect(new Set(ints).size).toBe(3);
  });

  it('is order-dependent, not name-hashed: reordering the set reassigns colors', () => {
    const forward = assignEnzymeColors(['BamHI', 'EcoRI']);
    const reversed = assignEnzymeColors(['EcoRI', 'BamHI']);
    expect(forward.get('EcoRI')).toEqual(enzymeColorAt(1));
    expect(reversed.get('EcoRI')).toEqual(enzymeColorAt(0));
  });

  it('wraps past the palette length so a large active set never throws', () => {
    const len = ENZYME_COLOR_PALETTE.length;
    const names = Array.from({ length: len + 2 }, (_, i) => `enz${i}`);
    const map = assignEnzymeColors(names);
    expect(map.get(`enz${len}`)).toEqual(enzymeColorAt(0));
    expect(map.get(`enz${len + 1}`)).toEqual(enzymeColorAt(1));
  });
});
