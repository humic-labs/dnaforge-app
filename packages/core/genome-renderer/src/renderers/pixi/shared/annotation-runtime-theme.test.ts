import { describe, expect, it } from 'vitest';

import {
  DARK_RNA_FAMILY_COLORS,
  TRANSCRIPT_COLORS,
  rnaCanonicalSourceColor,
} from '../../../feature-colors';
import { DARK_ANNOTATION_LIGHTNESS_SCALE, webglAnnotationColorForMode } from './theme';
import {
  INDEXED_ANNOTATION_COLOR_BASIS_THEME,
  INDEXED_ANNOTATION_RUNTIME_THEME_GLSL,
  indexedAnnotationColorForRuntimeTheme,
  indexedAnnotationRuntimeThemeUniforms,
} from './annotation-runtime-theme';

function channels(color: number): readonly [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

function colorFromChannels(red: number, green: number, blue: number): number {
  return (red << 16) | (green << 8) | blue;
}

function maximumChannelDelta(left: number, right: number): number {
  const leftChannels = channels(left);
  const rightChannels = channels(right);
  return Math.max(
    ...leftChannels.map((channel, index) => Math.abs(channel - rightChannels[index]))
  );
}

describe('indexed annotation runtime theme projection', () => {
  it('keeps one immutable light-basis artifact while theme remains presentation state', () => {
    expect(INDEXED_ANNOTATION_COLOR_BASIS_THEME).toBe('light');
    expect(indexedAnnotationRuntimeThemeUniforms('enhancer', 'light')).toEqual({
      themeDark: 0,
      transcriptPalette: 0,
      rnaPalette: 0,
    });
    expect(indexedAnnotationRuntimeThemeUniforms('enhancer', 'dark')).toEqual({
      themeDark: 1,
      transcriptPalette: 0,
      rnaPalette: 0,
    });
  });

  it('assigns every RNA class a stable, distinct runtime palette id', () => {
    const ids = ['mRNA', 'lncRNA', 'ncRNA', 'miRNA', 'snoRNA', 'snRNA', 'tRNA', 'rRNA'].map(
      (trackType) => indexedAnnotationRuntimeThemeUniforms(trackType, 'dark').rnaPalette
    );
    expect(ids.every((id) => id > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('projects ordinary source RGB and transcript roles through the shared palette authority', () => {
    const enhancer = 0x22c55e;
    expect(indexedAnnotationColorForRuntimeTheme(enhancer, 'enhancer', 'light')).toBe(enhancer);
    expect(indexedAnnotationColorForRuntimeTheme(enhancer, 'enhancer', 'dark')).toBe(
      webglAnnotationColorForMode(enhancer, 'dark')
    );
    expect(
      indexedAnnotationColorForRuntimeTheme(TRANSCRIPT_COLORS.light.cdsThick, 'mRNA', 'dark')
    ).toBe(TRANSCRIPT_COLORS.dark.cdsThick);
    expect(
      indexedAnnotationColorForRuntimeTheme(TRANSCRIPT_COLORS.light.ncRnaExon, 'lnc_RNA', 'dark')
    ).toBe(DARK_RNA_FAMILY_COLORS.longNonCoding);
  });

  it('keeps filtered transcript pixels continuous beside an exact palette color', () => {
    const exactCanonical = TRANSCRIPT_COLORS.light.cdsThick;
    const [red, green, blue] = channels(exactCanonical);
    const filteredCanonical = colorFromChannels(red, green, blue + 1);
    const exactDark = indexedAnnotationColorForRuntimeTheme(exactCanonical, 'mRNA', 'dark');
    const filteredDark = indexedAnnotationColorForRuntimeTheme(filteredCanonical, 'mRNA', 'dark');

    expect(maximumChannelDelta(filteredDark, exactDark)).toBeLessThanOrEqual(2);
  });

  it.each([
    ['mRNA', DARK_RNA_FAMILY_COLORS.messenger],
    ['lncRNA', DARK_RNA_FAMILY_COLORS.longNonCoding],
    ['ncRNA', DARK_RNA_FAMILY_COLORS.nonCoding],
    ['miRNA', DARK_RNA_FAMILY_COLORS.micro],
    ['snoRNA', DARK_RNA_FAMILY_COLORS.smallNucleolar],
    ['snRNA', DARK_RNA_FAMILY_COLORS.smallNuclear],
    ['tRNA', DARK_RNA_FAMILY_COLORS.transfer],
    ['rRNA', DARK_RNA_FAMILY_COLORS.ribosomal],
  ] as const)('projects canonical %s pixels onto its dark RNA-family accent', (type, expected) => {
    expect(indexedAnnotationColorForRuntimeTheme(rnaCanonicalSourceColor(type), type, 'dark')).toBe(
      expected
    );
  });

  it('emits both runtime branches and every transcript palette pair into one GLSL source', () => {
    expect(INDEXED_ANNOTATION_RUNTIME_THEME_GLSL).toContain('themeDark');
    expect(INDEXED_ANNOTATION_RUNTIME_THEME_GLSL).toContain('transcriptPalette');
    expect(INDEXED_ANNOTATION_RUNTIME_THEME_GLSL).toContain(
      `* ${DARK_ANNOTATION_LIGHTNESS_SCALE.toFixed(9)}`
    );
    for (const color of Object.values(TRANSCRIPT_COLORS.light)) {
      const channel = ((color >> 16) & 0xff) / 255;
      expect(INDEXED_ANNOTATION_RUNTIME_THEME_GLSL).toContain(channel.toFixed(9));
    }
    for (const color of Object.values(TRANSCRIPT_COLORS.dark)) {
      const channel = ((color >> 16) & 0xff) / 255;
      expect(INDEXED_ANNOTATION_RUNTIME_THEME_GLSL).toContain(channel.toFixed(9));
    }
  });
});
