import { describe, expect, it } from 'vitest';
import {
  GOLDEN_GATE_JUNCTION_VISUAL,
  canonicalGoldenGateEnzymeName,
  goldenGateOverhangLengthForEnzymeName,
  isGoldenGateEnzymeName,
  resolveGoldenGateJunctionVisual,
} from './golden-gate';

describe('Golden Gate enzyme capabilities', () => {
  it('defines one renderer-neutral junction appearance contract', () => {
    expect(GOLDEN_GATE_JUNCTION_VISUAL).toMatchObject({
      scarLengthBp: 4,
      primer: {
        scarBaseColorHex: '#DC2626',
        scarBaseColorPixi: 0xdc2626,
      },
      productScar: {
        fillColorHex: '#FFA500',
        fillColorPixi: 0xffa500,
        fillAlpha: 0.25,
      },
      cutLine: { widthPx: 1 },
      identityLabel: {
        fontWeight: 400,
        monospaceCharacterWidthEm: 0.6,
        lightBackgroundColorPixi: 0xffffff,
        lightBackgroundAlpha: 0.9,
        lightBackgroundCss: 'rgba(255, 255, 255, 0.9)',
      },
    });
  });

  it('projects one canonical junction identity and wrapped scar range for both viewers', () => {
    expect(
      resolveGoldenGateJunctionVisual(
        {
          start: 96,
          direction: 'forward',
          cutPositionInOverhang: 2,
          enzymeName: 'BsaI',
          junctionIndex: 3,
        },
        100
      )
    ).toEqual({
      scarStart: 98,
      scarEnd: 2,
      scarEndUnwrapped: 102,
      scarLengthBp: 4,
      identityLabel: 'BsaI J4',
    });
  });

  it('rejects reverse, suppressed, and non-cut primers as junction visual sources', () => {
    const base = { start: 10, direction: 'forward' as const, cutPositionInOverhang: 1 };
    expect(resolveGoldenGateJunctionVisual({ ...base, direction: 'reverse' }, 100)).toBeNull();
    expect(
      resolveGoldenGateJunctionVisual({ ...base, suppressCutSiteRendering: true }, 100)
    ).toBeNull();
    expect(resolveGoldenGateJunctionVisual({ ...base, cutPositionInOverhang: 0 }, 100)).toBeNull();
  });

  it('recognizes canonical Golden Gate enzymes', () => {
    expect(isGoldenGateEnzymeName('BsaI')).toBe(true);
    expect(isGoldenGateEnzymeName('BbsI')).toBe(true);
    expect(isGoldenGateEnzymeName('BsmBI')).toBe(true);
    expect(isGoldenGateEnzymeName('SapI')).toBe(true);
  });

  it('canonicalizes supported isoschizomer-style names used by the virtual digest UI', () => {
    expect(canonicalGoldenGateEnzymeName('BpiI')).toBe('BbsI');
    expect(canonicalGoldenGateEnzymeName('Esp3I')).toBe('BsmBI');
  });

  it('does not silently map ordinary restriction enzymes to a Golden Gate enzyme', () => {
    expect(canonicalGoldenGateEnzymeName('EcoRI')).toBeUndefined();
    expect(canonicalGoldenGateEnzymeName('AatII + BsaI')).toBeUndefined();
  });

  it('keeps SapI as the 3 bp Golden Gate overhang exception', () => {
    expect(goldenGateOverhangLengthForEnzymeName('BsaI')).toBe(4);
    expect(goldenGateOverhangLengthForEnzymeName('BpiI')).toBe(4);
    expect(goldenGateOverhangLengthForEnzymeName('SapI')).toBe(3);
  });
});
