// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  referenceViewCompatibility,
  reconcileReferenceAnnotationTracks,
  savedReferenceContentIdentity,
  restoredReferenceAnnotationVisibility,
} from './reference-view-compatibility';

const before = { sequenceIdentity: 'a'.repeat(64), annotationIdentity: 'b'.repeat(64) };
const after = { ...before, annotationIdentity: 'c'.repeat(64) };

describe('reference updates and saved view compatibility', () => {
  it('accepts annotation changes and refuses different bases even with the same chromosome lengths', () => {
    expect(referenceViewCompatibility(before, after)).toEqual({
      compatible: true,
      annotationsUpdated: true,
    });
    expect(
      referenceViewCompatibility(before, { ...after, sequenceIdentity: 'd'.repeat(64) })
    ).toEqual({ compatible: false, annotationsUpdated: false });
    expect(referenceViewCompatibility(before, before)).toEqual({
      compatible: true,
      annotationsUpdated: false,
    });
  });

  it('retains order and explicit visibility by ID, names dropped tracks, and gives new tracks their defaults', () => {
    expect(
      reconcileReferenceAnnotationTracks(
        {
          orderedTrackIds: ['retired', 'gene', 'CDS'],
          visibilityByTrackId: { retired: true, gene: false, CDS: true },
        },
        ['CDS', 'gene', 'new-track']
      )
    ).toEqual({
      orderedTrackIds: ['gene', 'CDS', 'new-track'],
      visibilityByTrackId: { gene: false, CDS: true },
      removedTrackIds: ['retired'],
      notice:
        "This reference's annotations were updated since this view was saved. Removed tracks: retired.",
    });
  });

  it('resolves legacy version facts after the version files have been collected and fails closed on unknown inventories', () => {
    const history = [
      {
        ...before,
        bundleFingerprint: 'e'.repeat(64),
        assetGenerations: [
          { sourceFingerprint: 'f'.repeat(24), inventoryFingerprint: '1'.repeat(64) },
        ],
      },
    ];
    const saved = {
      bundleFingerprint: 'e'.repeat(64),
      sourceFingerprint: 'f'.repeat(24),
      inventoryFingerprint: '1'.repeat(64),
    };
    expect(savedReferenceContentIdentity(saved, history)).toMatchObject(before);
    expect(
      savedReferenceContentIdentity({ ...saved, inventoryFingerprint: '2'.repeat(64) }, history)
    ).toBeNull();
  });

  it('keeps explicit hidden settings while applying ordinary defaults to introduced tracks', () => {
    expect(
      restoredReferenceAnnotationVisibility({ mRNA: false }, ['mRNA', 'genomic DNA', 'enhancer'])
    ).toEqual([]);
    expect(restoredReferenceAnnotationVisibility({ CDS: false }, ['CDS', 'mRNA'])).toEqual([
      'mRNA',
    ]);
  });

  it('drops invisible and unordered retired settings and never duplicates a track', () => {
    const result = reconcileReferenceAnnotationTracks(
      { orderedTrackIds: ['gene', 'gene'], visibilityByTrackId: { hidden: false } },
      ['gene', 'CDS']
    );
    expect(result.orderedTrackIds).toEqual(['gene', 'CDS']);
    expect(result.removedTrackIds).toEqual(['hidden']);
    expect(result.visibilityByTrackId).toEqual({});
  });
});
