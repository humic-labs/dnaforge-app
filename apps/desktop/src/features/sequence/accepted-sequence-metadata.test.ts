// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeGenBank } from '@waypoint/sequence-utils';
import { buildSequencePackageDocument } from '../../db/sequence-package';
import { acceptedSequenceMetadataOwner } from './accepted-sequence-metadata';
import { useSequenceStore } from './store';
import type { ScientificAcceptedDocumentRevision } from '@waypoint/domain-services';
import type { ResolvedManagedSequenceDocument } from './managed-sequence-repository-types';

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  commit: vi.fn(),
  read: vi.fn(),
}));
vi.mock('../../platform', () => ({
  platform: () => ({ scientificObjects: { submit: mocks.submit } }),
}));
vi.mock('../../services/workspace-mutation-transaction', () => ({
  withRendererWorkspaceMutation: (_root: string, operation: (token: string) => unknown) =>
    operation('metadata-owner-token'),
}));
vi.mock('../../services/reconcile-accepted-workspace', () => ({
  reconcileAcceptedWorkspaceAfterFilesChanged: async () => undefined,
}));
vi.mock('../workspace/public/git', () => ({ gitCommitPaths: mocks.commit }));
vi.mock('../scientific-document/public/read-scientific-text', () => ({
  readScientificText: mocks.read,
}));

const id = 'accepted-metadata-sequence';
const root = '/workspace/metadata-save';
const packageRoot = `${root}/sequence`;
const oldAccepted: ScientificAcceptedDocumentRevision = {
  kind: 'accepted-object',
  resourceId: id,
  resourceRevisionId: `rr_${'a'.repeat(64)}`,
  workspaceVersionId: `wv_${'b'.repeat(64)}`,
  contentSha256: 'c'.repeat(64),
  sequenceEditParentEventId: null,
};
const publishedAccepted: ScientificAcceptedDocumentRevision = {
  ...oldAccepted,
  resourceRevisionId: `rr_${'d'.repeat(64)}`,
  workspaceVersionId: `wv_${'e'.repeat(64)}`,
  contentSha256: 'f'.repeat(64),
};
const original = {
  id,
  name: 'Original',
  sequence: '',
  length: 0,
  circular: false,
  annotations: [],
  metadata: {},
};

function metadataFixture() {
  const document = buildSequencePackageDocument({
    id,
    name: original.name,
    product: { file: 'sequence.gb', topology: 'linear' },
  });
  const current: ResolvedManagedSequenceDocument = {
    ref: { kind: 'managed-sequence', packageId: id, packageRoot },
    document,
    productPath: `${packageRoot}/sequence.gb`,
    accepted: {
      workspaceRoot: root,
      workspace: 'workspace:1' as NonNullable<
        ResolvedManagedSequenceDocument['accepted']
      >['workspace'],
      head: oldAccepted.workspaceVersionId,
      productRevisionId: oldAccepted.resourceRevisionId,
      packageRevisionId: `rr_${'1'.repeat(64)}`,
    },
  };
  const next = { ...document, name: 'Renamed' };
  const refreshed = {
    ...current,
    document: next,
    accepted: { ...current.accepted!, head: publishedAccepted.workspaceVersionId },
  };
  vi.spyOn(acceptedSequenceMetadataOwner, 'load')
    .mockResolvedValueOnce(current)
    .mockResolvedValueOnce(refreshed);
  mocks.submit.mockResolvedValue({
    receipt: { outcome: 'changed', version: publishedAccepted.workspaceVersionId },
    currentHead: publishedAccepted.workspaceVersionId,
    delivery: { kind: 'complete' },
  });
  mocks.read.mockResolvedValue({
    content: serializeGenBank({ ...original, name: 'Renamed' }),
    acceptedRevision: publishedAccepted,
  });
  let release!: () => void;
  mocks.commit.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  return { current, next, release: () => release() };
}

describe('accepted metadata publication preserves the live sequence draft', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    useSequenceStore.getState().clearAll();
    useSequenceStore.getState().setSequence(id, original, oldAccepted);
  });

  it.each(['typing', 'annotation'] as const)(
    'keeps %s begun while Metadata Save waits for its Git publication',
    async (edit) => {
      const fixture = metadataFixture();
      const saving = acceptedSequenceMetadataOwner.save(fixture.current, fixture.next, {});
      await vi.waitFor(() => expect(mocks.commit).toHaveBeenCalledOnce());
      if (edit === 'typing') {
        useSequenceStore.getState().dispatchEdit(id, { type: 'INSERT', text: 'AATGCCGTTA' });
      } else {
        useSequenceStore.getState().addAnnotation(id, {
          name: 'new feature',
          type: 'misc_feature',
          start: 1,
          end: 1,
          direction: 1,
        });
      }
      const draft = useSequenceStore.getState().drafts[id];
      const revision = useSequenceStore.getState().getVersion(id);
      fixture.release();
      await expect(saving).resolves.toMatchObject({ name: 'Renamed' });

      const state = useSequenceStore.getState();
      expect(state.drafts[id]).toBe(draft);
      expect(state.getVersion(id)).toBe(revision);
      expect(state.dirtyPaths[id]).toBe(true);
      expect(state.sequences[id].name).toBe('Renamed');
      if (edit === 'typing') expect(state.sequences[id].sequence).toBe('AATGCCGTTA');
      else
        expect(state.sequences[id].annotations).toContainEqual(
          expect.objectContaining({ name: 'new feature' })
        );
      expect(state.savedSequences[id].sequence).toBe('');
      const capture = state.captureForSave(id)!;
      expect(capture.draftBaseline.sequence).toBe('');
      expect(capture.accepted).toMatchObject({
        expectedHead: publishedAccepted.workspaceVersionId,
        expectedRevisionId: publishedAccepted.resourceRevisionId,
        baseline: {
          head: publishedAccepted.workspaceVersionId,
          revisionId: publishedAccepted.resourceRevisionId,
        },
      });
    }
  );

  it('does not replace a newer authoritative load that completed during publication', async () => {
    const fixture = metadataFixture();
    const saving = acceptedSequenceMetadataOwner.save(fixture.current, fixture.next, {});
    await vi.waitFor(() => expect(mocks.commit).toHaveBeenCalledOnce());
    useSequenceStore
      .getState()
      .setSequence(id, { ...original, name: 'Newer', sequence: 'GG', length: 2 });
    const newer = useSequenceStore.getState().sequences[id];
    fixture.release();
    await saving;
    expect(useSequenceStore.getState().sequences[id]).toBe(newer);
  });

  it('completes an annotated package rename when the accepted product is unchanged', async () => {
    const annotations = [
      {
        id: 'native-feature',
        name: 'Native feature',
        type: 'misc_feature',
        start: 1,
        end: 5,
        direction: 1 as const,
        qualifiers: { note: ['Retained native feature'] },
      },
    ];
    const annotated = { ...original, sequence: 'AATGCCGTTA', length: 10, annotations };
    useSequenceStore.getState().setSequence(id, annotated, oldAccepted);
    const fixture = metadataFixture();
    mocks.read.mockResolvedValue({
      content: serializeGenBank(annotated),
      acceptedRevision: {
        ...publishedAccepted,
        resourceRevisionId: oldAccepted.resourceRevisionId,
      },
    });
    const saving = acceptedSequenceMetadataOwner.save(fixture.current, fixture.next, {});
    await vi.waitFor(() => expect(mocks.commit).toHaveBeenCalledOnce());
    fixture.release();

    await expect(saving).resolves.toMatchObject({ name: 'Renamed' });
    const state = useSequenceStore.getState();
    expect(state.sequences[id].name).toBe('Renamed');
    expect(state.savedSequences[id].name).toBe('Renamed');
    expect(state.savedSequences[id].annotations).toBe(annotations);
    expect(state.sequences[id].annotations).toBe(annotations);
    expect(state.isDirty(id)).toBe(false);
    expect(state.acceptedRevisions[id]).toMatchObject({
      resourceRevisionId: oldAccepted.resourceRevisionId,
      workspaceVersionId: publishedAccepted.workspaceVersionId,
    });
  });

  it('refuses changed product annotations during metadata completion', async () => {
    const annotated = {
      ...original,
      sequence: 'AATGCCGTTA',
      length: 10,
      annotations: [
        {
          id: 'native-feature',
          name: 'Native feature',
          type: 'misc_feature',
          start: 1,
          end: 5,
          direction: 1 as const,
        },
      ],
    };
    useSequenceStore.getState().setSequence(id, annotated, oldAccepted);
    const fixture = metadataFixture();
    mocks.read.mockResolvedValue({
      content: serializeGenBank({
        ...annotated,
        annotations: [{ ...annotated.annotations[0], start: 2 }],
      }),
      acceptedRevision: publishedAccepted,
    });
    const saving = acceptedSequenceMetadataOwner.save(fixture.current, fixture.next, {});
    await vi.waitFor(() => expect(mocks.commit).toHaveBeenCalledOnce());
    fixture.release();

    await expect(saving).rejects.toThrow('Metadata publication cannot replace sequence edits.');
    expect(useSequenceStore.getState().savedSequences[id]).toBe(annotated);
    expect(useSequenceStore.getState().acceptedRevisions[id]).toBe(oldAccepted);
  });

  it('still refuses Metadata Save when the sequence was already dirty', async () => {
    const fixture = metadataFixture();
    useSequenceStore.getState().dispatchEdit(id, { type: 'INSERT', text: 'AA' });
    await expect(
      acceptedSequenceMetadataOwner.save(fixture.current, fixture.next, {})
    ).rejects.toThrow('Save or discard sequence edits');
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(useSequenceStore.getState().sequences[id].sequence).toBe('AA');
  });
});
