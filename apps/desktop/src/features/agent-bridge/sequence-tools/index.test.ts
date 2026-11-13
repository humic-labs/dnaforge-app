import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSeqListAnnotations } from './index';

const { loadSequence, findTab } = vi.hoisted(() => ({
  loadSequence: vi.fn(),
  findTab: vi.fn(),
}));

vi.mock('../../canvas/public/store', () => ({
  useCanvasStore: { getState: () => ({ findTab }) },
}));

vi.mock('../../ai/public/tools/path-utils', () => ({
  loadSequenceDocumentBiologyFile: loadSequence,
  normalizeSequenceDocumentId: (id: string) => id.replace('waypoint://sequence/', ''),
}));

vi.mock('../../ai/public/tools/get-sequence', () => ({
  sequenceResourceUri: () => 'fixture-sequence-resource',
}));

describe('saved sequence annotation discovery', () => {
  const folders = [{ name: 'Source controls', path: '/owned/source-controls' }];

  beforeEach(() => {
    vi.clearAllMocks();
    findTab.mockReturnValue(null);
    loadSequence.mockResolvedValue({
      documentId: 'managed-chromosome-v',
      biology: {
        format: 'genbank',
        features: [
          { type: 'source', start: 1, end: 576874 },
          {
            displayName: 'RAD51',
            type: 'CDS',
            start: 349980,
            end: 351182,
            direction: 'forward',
            qualifiers: { gene: ['RAD51'], locus_tag: ['YER095W'] },
          },
        ],
      },
    });
  });

  it('reads exact annotations in a mounted document without requiring an editor tab', async () => {
    const result = await handleSeqListAnnotations(
      { documentId: 'managed-chromosome-v', kind: 'CDS', filter: { locusTag: 'YER095W' } },
      { folders }
    );

    expect(result).toMatchObject({
      ok: true,
      documentId: 'managed-chromosome-v',
      coordinateSystem: 'one_based_inclusive',
      annotationCount: 2,
      total: 1,
      annotations: [
        { rawIndex: 1, geneName: 'RAD51', locusTag: 'YER095W', start: 349980, end: 351182 },
      ],
    });
    expect(loadSequence).toHaveBeenCalledWith('managed-chromosome-v', folders);
    expect(findTab).not.toHaveBeenCalled();
  });

  it('retains the owning-project lookup failure', async () => {
    loadSequence.mockRejectedValue(
      new Error('The exact document is outside the mounted projects.')
    );
    await expect(
      handleSeqListAnnotations({ documentId: 'unmounted-document' }, { folders })
    ).rejects.toThrow('outside the mounted projects');
    expect(findTab).not.toHaveBeenCalled();
  });
});
