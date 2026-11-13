import { describe, expect, it } from 'vitest';

import type { Feature } from '../../../types';
import { featureTypeColor } from '../../../feature-colors';
import { webglAnnotationColorForMode } from '../shared/theme';
import {
  getColor,
  getThemedColor,
  hasDraftOutline,
  isCompositeFeature,
  isOutlineOnlyFeature,
  isSplicedFeature,
  isTranscript,
  normalizeAnnotationLayerTypes,
  stableSourceLane,
  stableSourceLaneAssignments,
} from './annotation-feature-semantics';

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 1,
    type: 'gene',
    start: 0,
    end: 10,
    direction: 'forward',
    displayName: 'feature',
    color: 0,
    lane: 0,
    ...overrides,
  };
}

describe('annotation feature semantics', () => {
  it('uses an explicit color and otherwise falls back to the feature-type palette', () => {
    const explicit = feature({ type: 'CDS', color: 0x123456 });
    const fallback = feature({ type: 'CDS', color: 0 });

    expect(getColor(explicit)).toBe(0x123456);
    expect(getColor(fallback)).toBe(featureTypeColor('CDS'));
    expect(getColor(feature({ type: 'unknown', color: 0 }))).toBe(featureTypeColor('unknown'));
    expect(getThemedColor(explicit, undefined)).toBe(0x123456);
    expect(getThemedColor(explicit, 'light')).toBe(0x123456);
    expect(getThemedColor(explicit, 'dark')).toBe(webglAnnotationColorForMode(0x123456, 'dark'));
  });

  it('keeps fill suppression distinct from the broader draft-outline sources', () => {
    expect(isOutlineOnlyFeature(feature({ outlineOnly: true }))).toBe(true);
    expect(isOutlineOnlyFeature(feature({ qualifiers: { source: 'pLannotate-draft' } }))).toBe(
      true
    );
    expect(
      isOutlineOnlyFeature(
        feature({
          qualifiers: { source: 'pLannotate-draft', status: 'accepted' },
        })
      )
    ).toBe(false);
    expect(isOutlineOnlyFeature(feature({ qualifiers: { source: 'annotation-draft' } }))).toBe(
      false
    );

    expect(
      hasDraftOutline(
        feature({
          qualifiers: { source: 'pLannotate-draft', status: 'accepted' },
        })
      )
    ).toBe(true);
    expect(hasDraftOutline(feature({ qualifiers: { source: 'annotation-draft' } }))).toBe(true);
    expect(hasDraftOutline(feature({ qualifiers: { source: 'orf-candidate-cds' } }))).toBe(true);
    expect(hasDraftOutline(feature({ qualifiers: { source: 'imported' } }))).toBe(false);
    expect(hasDraftOutline(feature())).toBe(false);
  });

  it('recognizes only joined multi-segment splice-container features', () => {
    const joined = {
      segments: [
        { start: 1, end: 5 },
        { start: 8, end: 12 },
      ],
      qualifiers: { _locationString: 'JOIN (1..5,8..12)' },
    };

    expect(isSplicedFeature(feature({ type: 'CDS', ...joined }))).toBe(true);
    expect(isSplicedFeature(feature({ type: 'mRNA', ...joined }))).toBe(true);
    expect(isSplicedFeature(feature({ type: 'transcript', ...joined }))).toBe(true);
    expect(isSplicedFeature(feature({ type: 'gene', ...joined }))).toBe(false);
    expect(
      isSplicedFeature(
        feature({
          type: 'CDS',
          segments: [{ start: 1, end: 5 }],
          qualifiers: joined.qualifiers,
        })
      )
    ).toBe(false);
    expect(
      isSplicedFeature(
        feature({
          type: 'CDS',
          segments: joined.segments,
          qualifiers: { _locationString: '1..12' },
        })
      )
    ).toBe(false);
  });

  it('dispatches composite geometry independently of biological source type', () => {
    const exons = [{ start: 1, end: 10 }];
    const cds = [{ start: 1, end: 10 }];

    expect(isTranscript(feature({ type: 'mRNA', exons, cds }))).toBe(true);
    expect(isTranscript(feature({ type: 'transcript', exons, cds }))).toBe(true);
    expect(isTranscript(feature({ type: 'ncRNA', exons, cds: [] }))).toBe(true);
    expect(isCompositeFeature(feature({ type: 'CDS', exons, cds }))).toBe(true);
    expect(isTranscript(feature({ type: 'CDS', exons, cds }))).toBe(false);
    expect(
      isTranscript(
        feature({ type: 'pseudogene', exons, cds: [], compositeKind: 'disrupted-locus' })
      )
    ).toBe(true);
    expect(isTranscript(feature({ type: 'pseudogene', exons, cds: [] }))).toBe(false);
    expect(isTranscript(feature({ type: 'gene', exons }))).toBe(false);
    expect(isTranscript(feature({ type: 'mRNA', exons: [], cds: [] }))).toBe(false);
    expect(isTranscript(feature({ type: 'mRNA' }))).toBe(false);
  });

  it('accepts non-negative parsed source lanes and rejects absent or overflow lanes', () => {
    expect(stableSourceLane(feature({ qualifiers: { _lane: '0' } }))).toBe(0);
    expect(stableSourceLane(feature({ qualifiers: { _lane: '17' } }))).toBe(17);
    expect(stableSourceLane(feature({ qualifiers: { _lane: '2-extra' } }))).toBe(2);
    expect(stableSourceLane(feature())).toBeNull();
    expect(stableSourceLane(feature({ qualifiers: { _lane: 'overflow' } }))).toBeNull();
    expect(stableSourceLane(feature({ qualifiers: { _lane: '-1' } }))).toBeNull();
    expect(stableSourceLane(feature({ qualifiers: { _lane: 'not-a-lane' } }))).toBeNull();
  });

  it('builds all-or-nothing index-keyed lane assignments', () => {
    expect(stableSourceLaneAssignments([])).toEqual(new Map());
    expect(
      stableSourceLaneAssignments([
        feature({ id: 99, qualifiers: { _lane: '3' } }),
        feature({ id: 7, qualifiers: { _lane: '1' } }),
      ])
    ).toEqual(
      new Map([
        [0, 3],
        [1, 1],
      ])
    );
    expect(
      stableSourceLaneAssignments([
        feature({ qualifiers: { _lane: '3' } }),
        feature({ qualifiers: { _lane: 'overflow' } }),
      ])
    ).toBeNull();
  });

  it('normalizes layer types to unique sorted non-empty ids', () => {
    expect(normalizeAnnotationLayerTypes(['mRNA', '', 'CDS', 'mRNA', 'gene'])).toEqual([
      'CDS',
      'gene',
      'mRNA',
    ]);
    expect(normalizeAnnotationLayerTypes([])).toEqual([]);
  });
});
