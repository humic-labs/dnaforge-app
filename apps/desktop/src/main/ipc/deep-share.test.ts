import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
  ipcRenderer: {},
}));

vi.mock('../deep-share/publish', () => ({
  publishReviewedDeepShare: vi.fn(),
  toDeepShareReview: vi.fn((preflight: { digest: string }) => ({
    workspace: { uuid: 'workspace-1', name: 'Project', remoteWorkspaceId: 'remote-1' },
    rootArtifactId: 'root',
    rootArtifact: { id: 'root', type: 'sequence', name: 'Root' },
    manifest: { artifacts: [] },
    files: [],
    chats: [],
    conversationCandidates: [],
    digest: preflight.digest,
  })),
}));

import { registerDeepShareHandlers } from './deep-share';
import { publishReviewedDeepShare } from '../deep-share/publish';

function invoke(channel: string, value?: unknown) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing handler ${channel}`);
  return handler({}, value);
}

describe('Deep Share IPC', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  it('registers preflight, publish, and cancel with strict request parsing', async () => {
    const buildPreflight = vi.fn(async () => ({ digest: 'd'.repeat(64) }));
    registerDeepShareHandlers({
      getDb: () => ({}) as never,
      forceSync: vi.fn(async () => ({ ok: true })),
      appVersion: '0.8.0',
      buildPreflight: buildPreflight as never,
    });

    expect([...handlers.keys()].sort()).toEqual([
      'deepShare:cancel',
      'deepShare:preflight',
      'deepShare:publish',
    ]);
    await expect(
      invoke('deepShare:preflight', {
        workspaceUuid: '../private',
        rootArtifactId: 'root',
        selectedConversationIds: [],
      })
    ).resolves.toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    await expect(
      invoke('deepShare:preflight', {
        workspaceUuid: 'workspace-1',
        rootArtifactId: 'root',
        selectedConversationIds: [],
        storagePath: '/private/object.json',
      })
    ).resolves.toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    expect(buildPreflight).not.toHaveBeenCalled();
  });

  it('passes only parsed selections and reviewed digest to main-process publication', async () => {
    vi.mocked(publishReviewedDeepShare).mockResolvedValue({
      ok: false,
      code: 'MANIFEST_STALE',
      message: 'Refresh.',
    });
    const forceSync = vi.fn(async () => ({ ok: true }));
    registerDeepShareHandlers({
      getDb: () => ({ db: true }) as never,
      forceSync,
      appVersion: '0.8.0',
    });

    const request = {
      workspaceUuid: 'workspace-1',
      rootArtifactId: 'root',
      selectedArtifactIds: ['root'],
      selectedConversationIds: ['chat-1'],
      reviewedDigest: 'd'.repeat(64),
    };
    await expect(invoke('deepShare:publish', request)).resolves.toMatchObject({
      ok: false,
      code: 'MANIFEST_STALE',
    });
    expect(publishReviewedDeepShare).toHaveBeenCalledWith(
      { db: true },
      request,
      expect.objectContaining({ forceSync, appVersion: '0.8.0' })
    );
    await expect(invoke('deepShare:cancel')).resolves.toEqual({ ok: true });
  });
});
