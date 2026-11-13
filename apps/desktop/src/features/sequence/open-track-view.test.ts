import { describe, expect, it, vi, beforeEach } from 'vitest';
import { validateTrackViewDocument, type SavedTrackView } from '../../shared/track-view';
import { trackViewFixture } from '../../shared/track-view-fixture';
import type { IndexedGenomeTabState } from '../../shared/indexed-genome';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  listHosted: vi.fn(),
  installHosted: vi.fn(),
  openAssembly: vi.fn(),
  recover: vi.fn(async (saved: SavedTrackView) => saved),
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    trackViews: { read: mocks.read },
    referenceAssets: { listHosted: mocks.listHosted, installHosted: mocks.installHosted },
  }),
}));
vi.mock('../canvas/public/store', () => ({ useCanvasStore: { getState: () => ({ panels: {} }) } }));
vi.mock('./openAssembly', () => ({ openAssembly: mocks.openAssembly }));
vi.mock('./track-view-library', () => ({ projectSavedTrackView: async () => undefined }));
vi.mock('./recover-scenario-track-view', () => ({ recoverScenarioTrackView: mocks.recover }));
import { assertTrackViewReference, openTrackView, openSavedTrackView } from './open-track-view';

function savedDocument() {
  const fixture = trackViewFixture();
  return validateTrackViewDocument({
    ...fixture,
    reference: {
      ...(fixture.reference as Record<string, unknown>),
      sequenceIdentity: 'a'.repeat(64),
      annotationIdentity: 'b'.repeat(64),
    },
  });
}
function referenceState(): IndexedGenomeTabState {
  const document = savedDocument();
  return {
    sourcePath: '/cache/reference.fa',
    sourceExt: 'fa',
    sourceSizeBytes: 2686,
    chrom: 'pUC19',
    assembly: {
      assemblyId: document.reference.assemblyId,
      displayName: document.reference.name,
      chromosomes: document.reference.chromosomes,
    },
    assemblyReferenceIdentity: {
      sequenceIdentity: 'a'.repeat(64),
      annotationIdentity: 'c'.repeat(64),
    },
    assemblyAnnotationTrackTypes: ['mRNA'],
  } as unknown as IndexedGenomeTabState;
}

beforeEach(() => vi.clearAllMocks());

describe('saved Track View reference compatibility', () => {
  it('runs source recovery for the direct file-opening entry point before opening the reference', async () => {
    mocks.recover.mockRejectedValueOnce(new Error('source recovery refused'));
    await expect(
      openSavedTrackView(
        {
          document: savedDocument(),
          path: '/project/View.dnaforge-track-view.json',
          workspaceRoot: '/project',
          revision: 'a'.repeat(64),
        },
        {}
      )
    ).rejects.toThrow('source recovery refused');
    expect(mocks.openAssembly).not.toHaveBeenCalled();
  });
  it('accepts an annotation revision and names removed tracks without changing the saved file', () => {
    const document = savedDocument();
    const before = JSON.stringify(document);
    const state = referenceState();
    assertTrackViewReference(document, state);
    expect(state.referenceAnnotationUpdateNotice).toContain('annotations were updated');
    expect(state.referenceAnnotationUpdateNotice).toContain('Removed tracks: gene');
    expect(JSON.stringify(document)).toBe(before);
  });

  it('refuses a changed sequence before mutating the open or saved view', () => {
    const document = savedDocument();
    const state = referenceState();
    state.assemblyReferenceIdentity = {
      sequenceIdentity: 'd'.repeat(64),
      annotationIdentity: 'c'.repeat(64),
    };
    const before = JSON.stringify({ document, state });
    expect(() => assertTrackViewReference(document, state)).toThrow('sequence has changed');
    expect(JSON.stringify({ document, state })).toBe(before);
  });

  it.each(['installed', 'cold'])(
    'opens a saved view against admitted products (%s)',
    async (cacheState) => {
      const document = savedDocument();
      const entry = {
        id: document.reference.assemblyId,
        name: document.reference.name,
        referenceIdentity: referenceState().assemblyReferenceIdentity,
        portableView: { trackTypes: ['mRNA'], assetGenerationsByTheme: { light: {} } },
      };
      mocks.read.mockResolvedValue({
        document,
        path: '/project/view.json',
        revision: 'e'.repeat(64),
      });
      mocks.listHosted.mockResolvedValue([{ id: entry.id }]);
      mocks.installHosted.mockResolvedValue({ status: 'ready', entry });
      if (cacheState === 'cold')
        mocks.installHosted.mockResolvedValueOnce({
          status: 'view-ready',
          entry: { ...entry, portableView: undefined },
        });
      mocks.openAssembly.mockResolvedValue('tab-1');
      expect(await openTrackView(document.id)).toBe('tab-1');
      expect(mocks.installHosted).toHaveBeenNthCalledWith(1, {
        catalogId: entry.id,
        themeMode: 'light',
        intent: 'open-view',
      });
      expect(mocks.installHosted).toHaveBeenCalledTimes(cacheState === 'cold' ? 2 : 1);
      if (cacheState === 'cold')
        expect(mocks.installHosted).toHaveBeenNthCalledWith(2, {
          catalogId: entry.id,
          themeMode: 'light',
          intent: 'require-ready',
        });
      expect(mocks.openAssembly).toHaveBeenCalledWith(
        entry,
        expect.objectContaining({
          restoreView: expect.objectContaining({
            annotationTrackTypes: ['mRNA'],
            indexedViewport: document.viewport,
            command: expect.objectContaining({
              orderedAnnotationTrackIds: ['mRNA'],
              visibleAnnotationTrackIds: ['mRNA'],
            }),
          }),
        })
      );
    }
  );
});
