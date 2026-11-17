import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateTrackViewDocument } from '../../shared/track-view';
import { trackViewFixture } from '../../shared/track-view-fixture';
import { useCanvasStore } from '../canvas/store';
import { getTrackViewSession } from './track-view-control';
import { referenceSignature } from './bbi-reference-compatibility';
import { portableFingerprintFromIdentity } from './portable-genome-view-adapter';
import { managedRestoredTracks, trackViewRecoveryDocument } from './track-view-recovery-document';
const boundary = vi.hoisted(() => ({ save: vi.fn(), read: vi.fn() }));
vi.mock('./track-view-library', () => ({ saveTrackView: boundary.save }));
vi.mock('../../platform', async (original) => {
  const actual = await original<typeof import('../../platform')>();
  return { ...actual, platform: () => ({ contactSources: { read: boundary.read } }) };
});
vi.mock('../../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));

async function fixture() {
  const document = validateTrackViewDocument({
    ...trackViewFixture(),
    contactProjection: {
      kind: 'contact-matrix',
      project: '/source-project',
      source: {
        schema: 'dnaforge.contact-source.v1',
        path: 'measurements.contacts.json',
        sha256: 'c'.repeat(64),
        xReference: { id: 'pUC19', chrom: 'pUC19', length: 2686 },
        yReference: { id: 'other', chrom: 'other', length: 5000 },
      },
      camera: {
        projectionId: `measured:${'c'.repeat(64)}`,
        xStart: 100,
        xEnd: 800,
        yStart: 1000,
        yEnd: 4000,
      },
    },
  });
  const portableReference = {
    kind: 'workspace-reference' as const,
    entityId: document.reference.assemblyId,
    assemblyId: document.reference.assemblyId,
    contentFingerprint: `sha256:${'a'.repeat(64)}`,
    referenceSignature: await portableFingerprintFromIdentity(
      await referenceSignature([{ name: 'pUC19', length: 2686 }])
    ),
  };
  const tabId = useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: document.id,
    label: document.name,
    sequenceDocument: { kind: 'indexed-sequence', documentId: document.id },
    trackView: { document, revision: 'a'.repeat(64), path: '/project/view.json' },
  });
  const owner = getTrackViewSession(tabId)!;
  const capturePortableReference = vi.fn(async () => portableReference);
  owner.attachSource(Symbol(), {
    referenceName: 'Reference',
    readyForDirtyCheck: true,
    capture: () => document,
    capturePortableReference,
  });
  return { owner, document, portableReference, capturePortableReference };
}

beforeEach(() => {
  useCanvasStore.getState().closeAllTabs();
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    focusedPanelId: 'main',
  });
  vi.clearAllMocks();
  boundary.read.mockResolvedValue({});
  boundary.save.mockImplementation(async ({ document }) => ({
    saved: { document, revision: 'b'.repeat(64), path: '/project/view.json' },
  }));
});
afterEach(() => useCanvasStore.getState().closeAllTabs());

describe('native contact Track view save with portable reference capture', () => {
  it('validates its local scientific source and writes both cameras through the existing session', async () => {
    const { owner, document, portableReference, capturePortableReference } = await fixture();
    const result = await owner.save({
      mode: 'save',
      name: 'Measured contacts',
      expectedRevision: owner.inspect().revision,
    });
    expect(result.ok).toBe(true);
    expect(capturePortableReference).toHaveBeenCalledOnce();
    expect(boundary.read).toHaveBeenCalledExactlyOnceWith({
      project: '/source-project',
      source: document.contactProjection!.source,
    });
    expect(boundary.save.mock.calls[0][0].document).toMatchObject({
      portableReference,
      contactProjection: document.contactProjection,
    });
    const recovery = await trackViewRecoveryDocument({ ...document, portableReference });
    expect(recovery.reference).toEqual(portableReference);
    expect(
      managedRestoredTracks(
        { ...document, portableReference },
        { dataTracks: [], bamTracks: [], outcomes: [] }
      ).contactProjection
    ).toEqual(document.contactProjection);
  });

  it('does not write a view whose source project/hash is no longer available', async () => {
    const { owner, document, portableReference } = await fixture();
    boundary.read.mockRejectedValue(new Error('The contact source fingerprint changed.'));
    const result = await owner.save({
      mode: 'save',
      name: 'Changed source',
      expectedRevision: owner.inspect().revision,
    });
    expect(result.ok).toBe(false);
    expect(boundary.read).toHaveBeenCalledOnce();
    expect(boundary.save).not.toHaveBeenCalled();
    await expect(trackViewRecoveryDocument({ ...document, portableReference })).rejects.toThrow(
      'fingerprint changed'
    );
  });
});
