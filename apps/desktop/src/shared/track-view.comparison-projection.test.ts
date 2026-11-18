import { describe, expect, it } from 'vitest';
import { parseTrackViewDocument, serializeTrackViewDocument } from './track-view';
import { trackViewFixture } from './track-view-fixture';
import type { ComparisonProjectionViewState } from './comparison-source';
import { trackViewMatchesSavedConfiguration } from '../features/sequence/track-view-configuration';

const comparison: ComparisonProjectionViewState = {
  kind: 'aligned-genomes',
  project: '/project',
  source: {
    schema: 'dnaforge.comparison-source.v1',
    path: 'alignment.paf',
    sha256: 'a'.repeat(64),
    targetReference: { id: 'pUC19', chrom: 'pUC19', length: 2686 },
    queryReference: { id: 'query', chrom: 'query', length: 3000 },
  },
  camera: { projectionId: `comparison:${'a'.repeat(64)}`, startColumn: 700, endColumn: 3200 },
};

describe('native comparison saved view', () => {
  it('persists the exact source and projected camera without scientific blocks or a false bp clamp', () => {
    const text = serializeTrackViewDocument({
      ...trackViewFixture(),
      comparisonProjection: comparison,
    });
    expect(parseTrackViewDocument(text).comparisonProjection).toEqual(comparison);
    expect(text).not.toContain('blocks');
    expect(text).not.toContain('segments');
  });

  it('detects a projected-camera change when the biological viewport is unchanged', () => {
    const saved = { ...trackViewFixture(), comparisonProjection: comparison };
    expect(trackViewMatchesSavedConfiguration(saved, saved)).toBe(true);
    expect(
      trackViewMatchesSavedConfiguration(
        {
          ...saved,
          comparisonProjection: {
            ...comparison,
            camera: { ...comparison.camera!, startColumn: 800 },
          },
        },
        saved
      )
    ).toBe(false);
  });

  it('refuses a mismatched target accession/length or a camera from a different source revision', () => {
    for (const changed of [
      {
        ...comparison,
        source: {
          ...comparison.source,
          targetReference: { id: 'other', chrom: 'other', length: 2686 },
        },
      },
      {
        ...comparison,
        source: {
          ...comparison.source,
          targetReference: { id: 'pUC19', chrom: 'pUC19', length: 2687 },
        },
      },
      {
        ...comparison,
        camera: { ...comparison.camera!, projectionId: `comparison:${'b'.repeat(64)}` },
      },
    ])
      expect(() =>
        serializeTrackViewDocument({ ...trackViewFixture(), comparisonProjection: changed })
      ).toThrow();
  });

  it('refuses simultaneous orthogonal and aligned coordinate projections', () => {
    expect(() =>
      serializeTrackViewDocument({
        ...trackViewFixture(),
        comparisonProjection: comparison,
        contactProjection: {
          kind: 'contact-matrix',
          project: '/project',
          source: {
            schema: 'dnaforge.contact-source.v1',
            path: 'contacts.json',
            sha256: 'c'.repeat(64),
            xReference: comparison.source.targetReference,
            yReference: comparison.source.queryReference,
          },
        },
      })
    ).toThrow('only one native coordinate projection');
  });
});
