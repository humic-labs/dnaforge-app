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
