import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANNOTATION_COLOR_MODE,
  normalizeAnnotationColorMode,
  resolveAnnotationDisplayStyle,
} from './annotation-display';

const promoter = { type: 'promoter', color: '#111111' };

describe('annotation display color resolver', () => {
  it('defaults to type colors instead of mutating through stored annotation color', () => {
    expect(resolveAnnotationDisplayStyle(promoter)).toEqual({
      color: '#22C55E',
      colorSource: 'auto-type',
    });
  });

  it('uses legacy annotation color only in the manual lens', () => {
    expect(resolveAnnotationDisplayStyle(promoter, { profile: { colorMode: 'manual' } })).toEqual({
      color: '#111111',
      colorSource: 'manual',
    });
  });

  it('lets future metadata facts override the legacy color in manual and imported lenses', () => {
    expect(
      resolveAnnotationDisplayStyle(promoter, {
        profile: { colorMode: 'manual' },
        colorFacts: { manualColor: '#222222' },
      })
    ).toEqual({ color: '#222222', colorSource: 'manual' });

    expect(
      resolveAnnotationDisplayStyle(promoter, {
        profile: { colorMode: 'imported' },
        colorFacts: { importedColor: '#333333' },
      })
    ).toEqual({ color: '#333333', colorSource: 'imported' });
  });

  it('preserves temporary render override colors such as pLannotate review gray', () => {
    expect(
      resolveAnnotationDisplayStyle(
        { type: 'CDS', color: '#e5e7eb' },
        {
          profile: { colorMode: 'auto-type' },
        }
      )
    ).toEqual({ color: '#e5e7eb', colorSource: 'render-override' });
  });

  it('normalizes unknown modes to the default lens', () => {
    expect(normalizeAnnotationColorMode('manual')).toBe('manual');
    expect(normalizeAnnotationColorMode('not-real')).toBe(DEFAULT_ANNOTATION_COLOR_MODE);
  });
});
