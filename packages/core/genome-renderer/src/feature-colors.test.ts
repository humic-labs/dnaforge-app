import { describe, expect, it } from 'vitest';

import {
  DARK_RNA_FAMILY_COLORS,
  DEFAULT_FEATURE_COLOR,
  TRANSCRIPT_COLORS,
  annotationTypeAccentColor,
  annotationTypeBadgeStyle,
  featureTypeColor,
  isTranscriptSourceType,
  rnaAccentColorForMode,
  rnaColorFamilyForType,
  transcriptColorForMode,
} from './feature-colors';
import { buildTranscriptGlyphBlocks } from './renderers/pixi/overview/transcript-glyph-vertices';
import {
  contrastTextColor,
  webglAnnotationColorForMode,
  webglThemeColorToCss,
  type WebGLThemeMode,
} from './renderers/pixi/shared/theme';

describe('indexed annotation color authority', () => {
  it('keeps the dark transcript palette visibly subdued against the dark canvas', () => {
    expect(TRANSCRIPT_COLORS.dark).toEqual({
      utr: 0x2c6790,
      exonThin: 0x335599,
      cdsThick: 0x2d37a9,
      intron: 0x475166,
      intronChevron: 0x566481,
      ncRnaExon: 0x7e3295,
    });
  });

  it('uses one dark jewel-tone family with a distinct accent for every RNA class', () => {
    expect(DARK_RNA_FAMILY_COLORS).toEqual({
      messenger: 0x2d37a9,
      longNonCoding: 0x6b319b,
      nonCoding: 0x7e3295,
      micro: 0x93348b,
      smallNucleolar: 0x523399,
      smallNuclear: 0x3d3597,
      transfer: 0x30838d,
      ribosomal: 0x328675,
    });
    expect(new Set(Object.values(DARK_RNA_FAMILY_COLORS)).size).toBe(8);
  });

  it.each([
    ['mRNA', 'messenger'],
    ['transcript', 'messenger'],
    ['lncRNA', 'longNonCoding'],
    ['lnc_RNA', 'longNonCoding'],
    ['ncRNA', 'nonCoding'],
    ['miRNA', 'micro'],
    ['snoRNA', 'smallNucleolar'],
    ['snRNA', 'smallNuclear'],
    ['tRNA', 'transfer'],
    ['rRNA', 'ribosomal'],
    ['misc_RNA', 'nonCoding'],
  ] as const)('maps %s onto the %s RNA color family', (type, family) => {
    expect(rnaColorFamilyForType(type)).toBe(family);
    expect(rnaAccentColorForMode(type, 'dark')).toBe(DARK_RNA_FAMILY_COLORS[family]);
  });

  it('keeps the existing light RNA semantics while changing only dark mode', () => {
    expect(rnaAccentColorForMode('mRNA', 'light')).toBe(TRANSCRIPT_COLORS.light.cdsThick);
    for (const type of ['lncRNA', 'ncRNA', 'miRNA', 'snoRNA', 'snRNA', 'tRNA', 'rRNA']) {
      expect(rnaAccentColorForMode(type, 'light')).toBe(TRANSCRIPT_COLORS.light.ncRnaExon);
    }
  });

  it.each([
    ['lncRNA', DARK_RNA_FAMILY_COLORS.longNonCoding],
    ['ncRNA', DARK_RNA_FAMILY_COLORS.nonCoding],
    ['miRNA', DARK_RNA_FAMILY_COLORS.micro],
    ['snoRNA', DARK_RNA_FAMILY_COLORS.smallNucleolar],
    ['snRNA', DARK_RNA_FAMILY_COLORS.smallNuclear],
    ['tRNA', DARK_RNA_FAMILY_COLORS.transfer],
    ['rRNA', DARK_RNA_FAMILY_COLORS.ribosomal],
  ] as const)('uses the %s family accent in both its dark glyph and badge', (type, expected) => {
    const [block] = buildTranscriptGlyphBlocks(
      [{ type, direction: 'forward', exons: [{ start: 1, end: 12 }] }],
      { getOffset: () => 0, halfHeight: 7, themeMode: 'dark', cdsDetail: 0 }
    );
    expect(block.color).toBe(expected);
    expect(annotationTypeBadgeStyle(type, 'dark').background).toBe(webglThemeColorToCss(expected));
  });

  it('keeps lncRNA aliases in the ncRNA color family', () => {
    expect(featureTypeColor('lncRNA')).toBe(featureTypeColor('ncRNA'));
    expect(featureTypeColor('lnc_RNA')).toBe(featureTypeColor('ncRNA'));
  });

  it('classifies transcript geometry by source type rather than child-range presence', () => {
    expect(isTranscriptSourceType('mRNA')).toBe(true);
    expect(isTranscriptSourceType('lnc_RNA')).toBe(true);
    expect(isTranscriptSourceType('transcript')).toBe(true);
    expect(isTranscriptSourceType('regulatory')).toBe(false);
    expect(isTranscriptSourceType('enhancer')).toBe(false);
  });

  it('resolves light badges from the same semantic palette as rendered features', () => {
    expect(annotationTypeBadgeStyle('mRNA', 'light')).toEqual({
      background: '#1d4ed8',
      color: '#ffffff',
      accent: '#1d4ed8',
    });
    expect(annotationTypeBadgeStyle('ncRNA', 'light')).toEqual({
      background: '#a855f7',
      color: '#ffffff',
      accent: '#a855f7',
    });
    expect(annotationTypeBadgeStyle('not-a-feature', 'light').background).toBe(
      webglThemeColorToCss(DEFAULT_FEATURE_COLOR)
    );
  });

  it.each([
    ['mRNA', true],
    ['transcript', true],
    ['tRNA', false],
    ['rRNA', false],
  ] as const)(
    'derives the %s badge background and contrast from its actual transcript glyph fill',
    (type, coding) => {
      for (const mode of ['light', 'dark'] as const satisfies readonly WebGLThemeMode[]) {
        const blocks = buildTranscriptGlyphBlocks(
          [
            {
              type,
              direction: 'forward',
              exons: [{ start: 1, end: 12 }],
              ...(coding ? { cds: [{ start: 1, end: 12 }] } : {}),
            },
          ],
          {
            getOffset: () => 0,
            halfHeight: 7,
            themeMode: mode,
            cdsDetail: 0,
          }
        );
        expect(blocks).toHaveLength(1);
        const renderedFill = blocks[0].color;
        expect(annotationTypeBadgeStyle(type, mode)).toEqual({
          background: webglThemeColorToCss(renderedFill),
          color: webglThemeColorToCss(contrastTextColor(renderedFill)),
          accent: webglThemeColorToCss(renderedFill),
        });
      }
    }
  );

  it('applies the renderer dark-theme transform instead of inventing a UI palette', () => {
    const expected = webglAnnotationColorForMode(featureTypeColor('enhancer'), 'dark');
    const style = annotationTypeBadgeStyle('enhancer', 'dark');

    expect(style.background).toBe(webglThemeColorToCss(expected));
    expect(style.background).not.toBe('#22c55e');
  });

  it('delegates transcript accents to the shared composite-glyph palette', () => {
    expect(annotationTypeAccentColor('mRNA', 'light')).toBe(TRANSCRIPT_COLORS.light.cdsThick);
    expect(annotationTypeAccentColor('lncRNA', 'dark')).toBe(DARK_RNA_FAMILY_COLORS.longNonCoding);
    expect(transcriptColorForMode('ncRnaExon', 'dark')).toBe(TRANSCRIPT_COLORS.dark.ncRnaExon);
    expect(transcriptColorForMode('ncRnaExon', 'dark')).not.toBe(
      webglAnnotationColorForMode(TRANSCRIPT_COLORS.dark.ncRnaExon, 'dark')
    );
  });
});
