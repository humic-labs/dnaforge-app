import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trackViewFixture } from '../../shared/track-view-fixture';
import { validateTrackViewDocument } from '../../shared/track-view';
import {
  PORTABLE_GENOME_VIEW_SCHEMA,
  serializePortableGenomeViewDocument,
  type PortableGenomeViewDocument,
} from '@waypoint/genome-data';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  readTrackView: vi.fn(),
  readFileBounded: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    dialog: { open: mocks.open },
    trackViews: { read: mocks.readTrackView },
    fs: { readFileBounded: mocks.readFileBounded },
  }),
}));

import { chooseGenomeViewFile, readGenomeViewFile } from './genome-view-file';

describe('Open view file', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.open.mockResolvedValue(null);
  });

  it('offers the canonical saved view and legacy portable view in one picker', async () => {
    await expect(chooseGenomeViewFile()).resolves.toBeNull();
    expect(mocks.open).toHaveBeenCalledWith({
      title: 'Open DNAForge genome view',
      filters: [
        {
          name: 'DNAForge genome views',
          extensions: ['dnaforge-track-view.json', 'dnaforge-genome-view.json'],
        },
      ],
    });
  });

  it('opens a canonical managed file through the library so its identity and revision survive', async () => {
    const path = '/tmp/review.dnaforge-track-view.json';
    const document = validateTrackViewDocument(trackViewFixture());
    const saved = { path, revision: 'a'.repeat(64), document };
    mocks.open.mockResolvedValue(path);
    mocks.readTrackView.mockResolvedValue(saved);

    await expect(chooseGenomeViewFile()).resolves.toEqual({ kind: 'track-view', saved });
    expect(mocks.readTrackView).toHaveBeenCalledWith(path);
    expect(mocks.readFileBounded).not.toHaveBeenCalled();
  });

  it('opens a Registry saved-view ID through the same managed library', async () => {
    const document = validateTrackViewDocument(trackViewFixture());
    const saved = {
      path: '/project/review.dnaforge-track-view.json',
      revision: 'a'.repeat(64),
      document,
    };
    mocks.readTrackView.mockResolvedValue(saved);

    await expect(readGenomeViewFile(document.id)).resolves.toEqual({ kind: 'track-view', saved });
    expect(mocks.readTrackView).toHaveBeenCalledWith(document.id);
    expect(mocks.readFileBounded).not.toHaveBeenCalled();
  });

  it('continues to read a legacy portable file through its strict parser', async () => {
    const path = '/tmp/review.dnaforge-genome-view.json';
    const document: PortableGenomeViewDocument = {
      schema: PORTABLE_GENOME_VIEW_SCHEMA,
      kind: 'indexed-genome-view',
      id: 'view-review',
      name: 'Review',
      provenance: {
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        createdBy: { kind: 'user' },
      },
      reference: {
        kind: 'hosted-reference',
        catalogId: 'hg38',
        assemblyId: 'hg38',
        bundleFingerprint: 'a'.repeat(64),
        sourceFingerprint: 'b'.repeat(24),
        inventoryFingerprint: 'c'.repeat(64),
      },
      viewport: { kind: 'all' },
      annotation: {
        policy: { isoformMode: 'canonical', laneLimit: null },
        orderedTrackIds: [],
        visibilityByTrackId: {},
      },
      tracks: [],
    };
    mocks.open.mockResolvedValue(path);
    mocks.readFileBounded.mockResolvedValue(
      new TextEncoder().encode(serializePortableGenomeViewDocument(document))
    );

    await expect(chooseGenomeViewFile()).resolves.toEqual({
      kind: 'legacy-portable-view',
      saved: { filePath: path, document },
    });
    expect(mocks.readTrackView).not.toHaveBeenCalled();
  });

  it('refuses a file whose suffix is neither supported view format', async () => {
    mocks.open.mockResolvedValue('/tmp/unrelated.json');
    await expect(chooseGenomeViewFile()).rejects.toThrow('Choose a DNAForge genome view file');
    expect(mocks.readTrackView).not.toHaveBeenCalled();
    expect(mocks.readFileBounded).not.toHaveBeenCalled();
  });
});
