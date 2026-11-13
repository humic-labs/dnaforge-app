import { describe, expect, it } from 'vitest';

import { trackBindingId } from '@waypoint/genome-data/annotation-catalog';

import { catalogTrackLabels } from './SequenceAnnotationCatalogTrackLabels';

const hoverTrack = (
  trackId: string,
  kind: 'terminator' | 'promoter',
  evidence: 'measured' | 'computed'
) => ({
  trackId,
  bindingId: trackBindingId(trackId.split(':')[0]),
  kind,
  sourceLabel: `${kind} source`,
  evidence,
  licenseSpdx: 'CC0-1.0',
  attribution: 'attribution',
  indexByStrand: { '+': [], '-': [] } as never,
});

describe('catalogTrackLabels', () => {
  it('places one label at the top of each drawn track band, offset by the map host', () => {
    const labels = catalogTrackLabels({
      tracks: [
        hoverTrack('terminators:terminator-hairpin', 'terminator', 'measured'),
        hoverTrack('promoters:promoter-arrow', 'promoter', 'computed'),
      ],
      bounds: {
        'terminators:terminator-hairpin': { topPx: 310, heightPx: 32 },
        'promoters:promoter-arrow': { topPx: 274, heightPx: 36 },
      },
      hostOffset: { left: 10, top: 40 },
    });
    expect(labels).toEqual([
      {
        trackId: 'terminators:terminator-hairpin',
        topPx: 351,
        leftPx: 16,
        kindLabel: 'Terminators',
        sourceLabel: 'terminator source',
        evidenceLabel: 'Measured',
      },
      {
        trackId: 'promoters:promoter-arrow',
        topPx: 315,
        leftPx: 16,
        kindLabel: 'Promoters',
        sourceLabel: 'promoter source',
        evidenceLabel: 'Computed',
      },
    ]);
  });

  it('skips tracks with no band yet', () => {
    expect(
      catalogTrackLabels({
        tracks: [hoverTrack('terminators:terminator-hairpin', 'terminator', 'measured')],
        bounds: { 'terminators:terminator-hairpin': { topPx: 0, heightPx: 0 } },
        hostOffset: { left: 0, top: 0 },
      })
    ).toEqual([]);
  });
});
