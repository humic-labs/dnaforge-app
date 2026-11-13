import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ScientificAcceptedDocumentRevision,
  ScientificWorkspaceSubmitResult,
} from '@waypoint/domain-services';

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  begin: vi.fn(),
  end: vi.fn(),
  reconcile: vi.fn(),
  read: vi.fn(),
}));
vi.mock('../platform', () => ({
  platform: () => ({
    fs: { beginWorkspaceMutation: mocks.begin, endWorkspaceMutation: mocks.end },
    scientificObjects: { submit: mocks.submit },
  }),
}));
vi.mock('../db/workspace-catalog', () => ({
  resolveWorkspaceScope: async () => 'workspace:1',
  findWorkspaceRootForPath: () => '/w',
}));
vi.mock('../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ folders: [] }) },
}));
vi.mock('./reconcile-accepted-workspace', () => ({
  reconcileAcceptedWorkspaceAfterFilesChanged: mocks.reconcile,
}));
vi.mock('../features/scientific-document/services/read-scientific-text', () => ({
  readScientificText: mocks.read,
}));
import {
  publishNativeArtifact,
  NativeArtifactPublicationPendingError,
} from './publish-native-artifact';

const before: ScientificAcceptedDocumentRevision = {
  kind: 'accepted-object',
  resourceId: 'p',
  resourceRevisionId: `rr_${'a'.repeat(64)}`,
  workspaceVersionId: `wv_${'b'.repeat(64)}`,
  contentSha256: 'c'.repeat(64),
  sequenceEditParentEventId: null,
};
const after: ScientificAcceptedDocumentRevision = {
  ...before,
  resourceRevisionId: `rr_${'d'.repeat(64)}`,
  workspaceVersionId: `wv_${'e'.repeat(64)}`,
};
const result: ScientificWorkspaceSubmitResult = {
  operationId: 'prepared',
  replayed: false,
  currentHead: after.workspaceVersionId,
  receipt: { outcome: 'changed', version: after.workspaceVersionId },
  accepted: after,
  delivery: { kind: 'complete' },
};
const input = () => ({
  workspaceRoot: '/w',
  artifactPath: '/w/p.primer.json',
  resourceId: 'p',
  prior: { ...before },
  representation: { format: 'primer-v2' as const, text: 'captured native bytes' },
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.begin.mockResolvedValue('owned-token');
  mocks.end.mockResolvedValue(undefined);
  mocks.submit.mockResolvedValue(result);
  mocks.reconcile.mockResolvedValue(undefined);
  mocks.read.mockResolvedValue({ content: 'captured native bytes', acceptedRevision: after });
});

describe('native artifact publication owner', () => {
  it('uses a fresh matching projection receipt while retaining reconstruction for replay or mismatched authority', async () => {
    mocks.submit.mockResolvedValue({ ...result, nativeProjectionComplete: true });
    await expect(publishNativeArtifact(input())).resolves.toEqual(after);
    expect(mocks.reconcile).toHaveBeenLastCalledWith(
      expect.objectContaining({ nativeProjectionComplete: true })
    );
    mocks.submit.mockResolvedValue({ ...result, replayed: true, nativeProjectionComplete: true });
    await expect(publishNativeArtifact(input())).resolves.toEqual(after);
    expect(mocks.reconcile.mock.calls.at(-1)?.[0]).not.toHaveProperty('nativeProjectionComplete');
    mocks.submit.mockResolvedValue({
      ...result,
      currentHead: before.workspaceVersionId,
      nativeProjectionComplete: true,
    });
    await expect(publishNativeArtifact(input())).resolves.toEqual(after);
    expect(mocks.reconcile.mock.calls.at(-1)?.[0]).not.toHaveProperty('nativeProjectionComplete');
  });
  it('publishes a new identity against the captured namespace head without requiring an earlier resource revision', async () => {
    await expect(
      publishNativeArtifact({
        ...input(),
        prior: null,
        expectedHead: before.workspaceVersionId,
      })
    ).resolves.toEqual(after);
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          expectedHead: before.workspaceVersionId,
          source: expect.objectContaining({ expectedRevisionId: null }),
        }),
      })
    );
    expect(mocks.reconcile).toHaveBeenCalledOnce();
  });

  it('freezes the captured proposal, holds the capability through reconstruction, and only then returns its accepted authority', async () => {
    let finish!: () => void;
    mocks.reconcile.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const supplied = input();
    const saving = publishNativeArtifact(supplied);
    supplied.representation.text = 'later unsubmitted edit';
    supplied.prior.resourceRevisionId = `rr_${'f'.repeat(64)}`;
    await vi.waitFor(() => expect(mocks.reconcile).toHaveBeenCalledOnce());
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationToken: 'owned-token',
        request: expect.objectContaining({
          expectedHead: before.workspaceVersionId,
          source: {
            kind: 'native-artifact',
            expectedRevisionId: before.resourceRevisionId,
            entry: {
              resourceId: 'p',
              path: 'p.primer.json',
              representation: {
                format: 'primer-v2',
                text: 'captured native bytes',
              },
            },
          },
        }),
      })
    );
    expect(mocks.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: '/w',
        mutationToken: 'owned-token',
        assertCurrent: expect.any(Function),
      })
    );
    expect(mocks.end).not.toHaveBeenCalled();
    finish();
    await expect(saving).resolves.toEqual(after);
    expect(mocks.end).toHaveBeenCalledWith('owned-token');
  });

  it('reports durable authority on blocked delivery or failed reconstruction and always releases its capability', async () => {
    mocks.submit.mockResolvedValueOnce({
      ...result,
      delivery: {
        kind: 'blocked',
        versionId: after.workspaceVersionId,
        error: 'external working edit',
      },
    });
    await expect(publishNativeArtifact(input())).rejects.toMatchObject({
      name: 'NativeArtifactPublicationPendingError',
      accepted: after,
      message: expect.stringContaining('external working edit'),
    });
    expect(mocks.reconcile).not.toHaveBeenCalled();
    mocks.reconcile.mockRejectedValueOnce(new Error('projection unavailable'));
    await expect(publishNativeArtifact(input())).rejects.toMatchObject({
      accepted: after,
      message: expect.stringContaining('projection unavailable'),
    });
    expect(mocks.end).toHaveBeenCalledTimes(2);
  });

  it('refuses to report success if another artifact version is current after reconstruction', async () => {
    mocks.read.mockResolvedValue({ content: 'a later accepted edit', acceptedRevision: before });
    await expect(publishNativeArtifact(input())).rejects.toBeInstanceOf(
      NativeArtifactPublicationPendingError
    );
    expect(mocks.end).toHaveBeenCalledOnce();
  });
});
