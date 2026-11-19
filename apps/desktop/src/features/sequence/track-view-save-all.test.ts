import { afterEach, expect, it, vi } from 'vitest';
import { saveAllUnsavedWork } from '../../shared/dirty-reporter';
import {
  validateTrackViewDocument,
  type SavedTrackView,
  type SaveTrackViewRequest,
} from '../../shared/track-view';
import { trackViewFixture } from '../../shared/track-view-fixture';
import { useCanvasStore } from '../canvas/store';
import { referenceSignature } from './bbi-reference-compatibility';
import { portableFingerprintFromIdentity } from './portable-genome-view-adapter';
import { getTrackViewSession } from './track-view-control';

const { write } = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('./track-view-library', () => ({ saveTrackView: write }));
vi.mock('./save-all-sequences', () => ({ saveAllDirtySequences: async () => ({ failed: [] }) }));
vi.mock('./sequence-document-client', () => ({ getNativeSequenceDocumentClient: () => null }));
vi.mock('../../platform', async (original) => ({
  ...(await original<typeof import('../../platform')>()),
  platform: () => ({}),
}));

function openDraft(id: string, start0: number) {
  const document = validateTrackViewDocument({
    ...trackViewFixture(),
    viewport: { start0, end0: 2000 },
  });
  const entityId = `reference-${id}`;
  const tabId = useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId,
    label: document.reference.name,
    sequenceDocument: { kind: 'indexed-sequence', documentId: entityId },
  });
  const session = getTrackViewSession(tabId)!;
  const source = Symbol(tabId);
  const capturePortableReference = vi.fn(async () => ({
    kind: 'workspace-reference' as const,
    entityId: document.reference.assemblyId,
    assemblyId: document.reference.assemblyId,
    contentFingerprint: `sha256:${'c'.repeat(64)}`,
    referenceSignature: await portableFingerprintFromIdentity(
      await referenceSignature([{ name: 'pUC19', length: 2686 }])
    ),
  }));
  session.attachSource(source, {
    referenceName: document.reference.name,
    readyForDirtyCheck: true,
    capture: () => document,
    capturePortableReference,
  });
  return { session, source, document };
}

function saved(request: SaveTrackViewRequest): { saved: SavedTrackView } {
  const document = validateTrackViewDocument(request.document);
  return {
    saved: {
      document,
      path: `/personal/${document.id}.dnaforge-track-view.json`,
      revision: 'b'.repeat(64),
    },
  };
}

afterEach(() => {
  useCanvasStore.getState().closeAllTabs('main');
  write.mockReset();
});

it('Save All writes both unnamed, unmounted Track views with their own viewports and reference identities', async () => {
  const first = openDraft('first', 5);
  first.session.detachSource(first.source);
  const second = openDraft('second', 10);
  second.session.detachSource(second.source);
  useCanvasStore
    .getState()
    .openTab('main', { type: 'text', entityId: '/other.txt', label: 'Other' });
  write.mockImplementation(async (request: SaveTrackViewRequest) => saved(request));

  const saving = saveAllUnsavedWork();
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
  await saving;

  const requests = write.mock.calls.map(([request]) => ({
    document: validateTrackViewDocument(request.document),
    destination: request.destination,
  }));
  expect(new Set(requests.map(({ document }) => document.id)).size).toBe(2);
  expect(requests.map(({ document }) => document.viewport.start0).sort((a, b) => a - b)).toEqual([
    5, 10,
  ]);
  for (const { document, destination } of requests) {
    expect(destination).toBeUndefined();
    expect(document.name).toBe('Custom reference view');
    expect(document.portableReference?.assemblyId).toBe(first.document.reference.assemblyId);
  }
  expect(first.session.isDirty()).toBe(false);
  expect(second.session.isDirty()).toBe(false);
});

it.each(['partially loaded', 'explicitly cleared'])(
  'saves a %s background Track view before its renderer first mounts',
  async (mode) => {
    const document = validateTrackViewDocument({
      ...trackViewFixture(),
      bamTracks: [
        {
          trackId: 'local-reads',
          label: 'Reads',
          visible: true,
          coverageCutoffDepth: 20,
          source: { bamPath: '/project/reads.bam', indexPath: '/project/reads.bam.bai' },
        },
      ],
      primerBindings: [
        {
          id: 'binding',
          primerId: 'primer',
          primerName: 'Marker',
          primerBases: 'ATCG',
          chrom: 'pUC19',
          start0: 10,
          end0: 14,
          strand: '+',
          source: 'attached',
        },
      ],
      userAnnotations: [
        {
          id: 'annotation',
          chrom: 'pUC19',
          annotation: { name: 'Mark', type: 'gene', start: 10, end: 14, direction: 1 },
        },
      ],
    });
    const viewport = { start0: 750, end0: 1250 };
    const scope = { kind: 'locus' as const, chrom: 'pUC19', start: 750, end: 1250 };
    const state = useCanvasStore.getState();
    const tabId = state.openTab('main', {
      type: 'sequence',
      entityId: document.id,
      label: document.name,
      sequenceDocument: { kind: 'indexed-sequence', documentId: document.id },
      trackView: { document, path: '/project/genes.json', revision: 'a'.repeat(64) },
      isDirty: true,
      indexedGenome: {
        sourcePath: '/project/pUC19.fa',
        sourceSizeBytes: 2686,
        sourceMtimeMs: 0,
        sourceExt: 'fa',
        chrom: 'pUC19',
        scope,
        assembly: {
          assemblyId: document.reference.assemblyId,
          displayName: document.reference.name,
          chromosomes: [],
        },
        ...(mode === 'explicitly cleared'
          ? { dataTracks: [], bamTracks: [], primerBindings: [], userAnnotations: [] }
          : {}),
      },
      viewState: { indexedViewport: viewport },
    });
    state.openTab('main', { type: 'text', entityId: '/other.txt', label: 'Other' });
    write.mockImplementation(async (request: SaveTrackViewRequest) => saved(request));
    await saveAllUnsavedWork();
    expect(write).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        document: expect.objectContaining({ id: document.id, viewport, scope }),
      })
    );
    const savedDraft = validateTrackViewDocument(write.mock.calls[0][0].document);
    for (const field of ['bamTracks', 'primerBindings', 'userAnnotations'] as const)
      expect(savedDraft[field] ?? []).toEqual(mode === 'explicitly cleared' ? [] : document[field]);
    expect(
      useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === tabId)?.isDirty
    ).toBe(false);
  }
);

it('Save All waits for the active Track view write and reuses its result', async () => {
  const { session } = openDraft('writing', 55);
  const finish = Promise.withResolvers<void>();
  write.mockImplementation(async (request: SaveTrackViewRequest) => {
    await finish.promise;
    return saved(request);
  });
  const human = session.saveHuman('Chosen name');
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
  const all = saveAllUnsavedWork();
  const settlement = vi.fn();
  void all.then(
    () => settlement(true),
    () => settlement(false)
  );
  await Promise.resolve();
  finish.resolve();
  await expect(human).resolves.toMatchObject({ ok: true });
  await expect(all).resolves.toBeUndefined();
  expect(settlement).toHaveBeenCalledExactlyOnceWith(true);
  expect(write).toHaveBeenCalledOnce();
});

it('Save All honors an open first-save picker and its chosen destination', async () => {
  const { session } = openDraft('choosing', 100);
  session.beginNaming('save');
  write.mockImplementation(async (request: SaveTrackViewRequest) => saved(request));
  const all = saveAllUnsavedWork();
  await Promise.resolve();
  expect(session.getSnapshot().kind).toBe('naming');
  expect(write).not.toHaveBeenCalled();
  const destination = {
    workspaceRoot: '/project',
    path: '/project/Selected.dnaforge-track-view.json',
  };
  await expect(session.saveHuman('Selected', destination)).resolves.toMatchObject({ ok: true });
  await expect(all).resolves.toBeUndefined();
  expect(write).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      document: expect.objectContaining({ name: 'Selected' }),
      destination,
    })
  );
});
