import { describe, expect, it, vi } from 'vitest';
import type { Feature } from '@waypoint/genome-renderer';
import type { ParsedPlasmid } from '../../types';
import { commitWebGLFeatureRange, focusWebGLFeature } from './webgl-feature-selection';

const feature: Feature = {
  id: 7,
  type: 'CDS',
  start: 100,
  end: 200,
  direction: 'forward',
  displayName: 'cds',
  color: 0x3b82f6,
  lane: 0,
};

const primer: ParsedPlasmid['primers'][0] = {
  id: 'primer-a',
  name: 'primer-a',
  start: 300,
  end: 320,
  direction: 'forward',
  bases: 'A'.repeat(20),
  tm: 60,
  gc: 50,
  mismatches: [],
  hasExplicitSequence: false,
};

function baseContext(overrides: Partial<Parameters<typeof commitWebGLFeatureRange>[0]> = {}) {
  return {
    featureId: 7,
    featureById: new Map([[feature.id, feature]]),
    primerByRenderId: new Map<number, ParsedPlasmid['primers'][0]>([[1_000_000_000, primer]]),
    genomeLength: 1000,
    ...overrides,
  };
}

describe('WebGL feature selection policy', () => {
  it('single-clicking a regular annotation clears parent highlight instead of selecting its range', () => {
    const onFeatureSelect = vi.fn();

    focusWebGLFeature(baseContext({ onFeatureSelect }));

    expect(onFeatureSelect).toHaveBeenCalledOnce();
    expect(onFeatureSelect).toHaveBeenCalledWith(null);
  });

  it('double-clicking a regular annotation commits its inclusive range', () => {
    const onFeatureSelect = vi.fn();

    commitWebGLFeatureRange(baseContext({ onFeatureSelect }));

    expect(onFeatureSelect).toHaveBeenCalledOnce();
    expect(onFeatureSelect).toHaveBeenCalledWith({ start: 100, end: 199 });
  });

  it('single-clicking a primer keeps primer click behavior', () => {
    const onFeatureSelect = vi.fn();
    const onPrimerClick = vi.fn();

    focusWebGLFeature(
      baseContext({
        featureId: 1_000_000_000,
        onFeatureSelect,
        onPrimerClick,
      })
    );

    expect(onPrimerClick).toHaveBeenCalledWith(primer);
    expect(onFeatureSelect).not.toHaveBeenCalled();
  });

  it('falls back to primer range selection when no primer click handler is installed', () => {
    const onFeatureSelect = vi.fn();

    focusWebGLFeature(
      baseContext({
        featureId: 1_000_000_000,
        onFeatureSelect,
      })
    );

    expect(onFeatureSelect).toHaveBeenCalledWith({ start: 300, end: 319 });
  });
});
