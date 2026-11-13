export function trackViewFixture(id = 'track-view-11111111'): Record<string, unknown> {
  return {
    schema: 'dnaforge.track-view.v3',
    kind: 'track-view',
    id,
    name: 'Genes',
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
    reference: {
      assemblyId: 'local-1234567890abcdef12345678',
      name: 'Custom reference',
      chromosomes: [{ chrom: 'pUC19', length: 2686 }],
      sourceFingerprint: null,
      inventoryFingerprint: null,
      bundleFingerprint: null,
    },
    viewport: { start0: 100, end0: 800 },
    scope: { kind: 'all' },
    annotation: {
      policy: { isoformMode: 'canonical', laneLimit: 2 },
      orderedTrackIds: ['gene'],
      visibilityByTrackId: { gene: false },
    },
    dataTracks: [],
    bamTracks: [],
  };
}
