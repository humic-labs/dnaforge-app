// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  RESIDUE_BOX_SLACK_PX,
  RESIDUE_GLYPH_ADVANCE_PX,
  residueLabelWidthCss,
  residueLabelWidthPx,
} from './residueLabelLayout';

describe('residueLabelWidthPx', () => {
  it('keeps a single-character monomer at exactly the historical 7px', () => {
    for (const label of ['M', 'A', 'W', 'G', 'U', 'X']) {
      expect(residueLabelWidthPx(label)).toBe(7);
    }
  });

  it('gives a two-character deoxynucleotide room for both characters', () => {
    for (const label of ['dA', 'dT', 'dG', 'dC']) {
      expect(residueLabelWidthPx(label)).toBe(13);
      expect(residueLabelWidthPx(label)).toBeGreaterThan(label.length * RESIDUE_GLYPH_ADVANCE_PX);
    }
  });

  it('scales to three- and five-character chemical-component ids', () => {
    expect(residueLabelWidthPx('HEM')).toBe(19);
    expect(residueLabelWidthPx('NAG')).toBe(19);
    expect(residueLabelWidthPx('A1B2C')).toBe(31);
  });

  it('never returns less than a one-character box, even for an empty label', () => {
    expect(residueLabelWidthPx('')).toBe(7);
  });

  it('is strictly increasing in label length, so a longer label can never get a narrower box', () => {
    const widths = ['A', 'dA', 'HEM', 'ABCD', 'A1B2C'].map(residueLabelWidthPx);
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]).toBeGreaterThan(widths[i - 1]);
    }
  });

  it('always leaves at least the declared slack beyond the drawn glyphs', () => {
    for (const label of ['A', 'dA', 'HEM', 'A1B2C']) {
      const ink = label.length * RESIDUE_GLYPH_ADVANCE_PX;
      expect(residueLabelWidthPx(label) - ink).toBe(RESIDUE_BOX_SLACK_PX);
    }
  });

  it('renders as a CSS pixel length', () => {
    expect(residueLabelWidthCss('M')).toBe('7px');
    expect(residueLabelWidthCss('dA')).toBe('13px');
  });
});
