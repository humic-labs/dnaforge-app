import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { DeepSharePreflight } from './preflight';

vi.mock('../desktop-sync-client', () => ({ createDesktopSyncClient: vi.fn() }));

import { publishReviewedDeepShare } from './publish';

const DIGEST = 'd'.repeat(64);

function preflight(overrides: Partial<DeepSharePreflight> = {}): DeepSharePreflight {
  const text = 'ATGC';
  return {
    workspace: {
      localId: 1,
      uuid: 'local-workspace',
      name: 'Project',
      path: '/managed/project',
      remoteWorkspaceId: 'dddddddd-dddd-dddd-dddd-ddddddddddd1',
      latestVersionId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1',
      latestVersionNumber: 4,
      latestVersionContentSha256: 'a'.repeat(64),
      sourceHeadSha: 'head-sha',
    },
    rootArtifactId: 'root',
    manifest: {
      rootArtifactId: 'root',
      artifacts: [{ id: 'root', type: 'sequence', name: 'Root', required: true }],
      relationships: [],
      files: [{ fileId: 'file-1', ownerArtifactId: 'root', role: 'primary' }],
      chats: [],
      omissions: [],
    },
    files: [
      {
        id: 'file-1',
        ownerArtifactId: 'root',
        relativePath: 'Root/root.fa',
        name: 'root.fa',
        role: 'primary',
        contentType: 'text/plain',
        sizeBytes: 4,
        sha256: createHash('sha256').update(text).digest('hex'),
        content: { encoding: 'utf8', text },
      },
    ],
    chats: [],
    conversationCandidates: [],
    digest: DIGEST,
    ...overrides,
  };
}

const request = {
  workspaceUuid: 'local-workspace',
  rootArtifactId: 'root',
  selectedArtifactIds: ['root'],
  selectedConversationIds: [],
  reviewedDigest: DIGEST,
};

describe('publishReviewedDeepShare', () => {
  it('forces sync, rebuilds the reviewed manifest, then publishes the exact bundle', async () => {
    const events: string[] = [];
    const rebuilt = preflight();
    const createDeepShare = vi.fn(async ({ bundle }: { bundle: { contentSha256: string } }) => {
      events.push('publish');
      return {
        workspaceId: rebuilt.workspace.remoteWorkspaceId,
        revisionPolicy: 'deep_bundle' as const,
        pinnedVersion: {
          id: rebuilt.workspace.latestVersionId!,
          versionNumber: 4,
          contentSha256: 'a'.repeat(64),
          createdAt: '2026-08-27T02:00:00Z',
        },
        bundle: {
          id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
          contentSha256: bundle.contentSha256,
        },
        share: {
          id: 'ffffffff-ffff-ffff-ffff-fffffffffff1',
          shortId: 'deep-short',
          url: 'https://dnaforge.com/d/deep-short#token=secret',
        },
      };
    });

    const result = await publishReviewedDeepShare({} as Database.Database, request, {
      forceSync: async () => {
        events.push('sync');
        return { ok: true };
      },
      buildPreflight: async () => {
        events.push('rebuild');
        return rebuilt;
      },
      client: { createDeepShare },
      appVersion: '0.8.0',
      now: () => '2026-08-27T02:30:00Z',
    });

    expect(events).toEqual(['sync', 'rebuild', 'publish']);
    expect(createDeepShare).toHaveBeenCalledWith({
      remoteWorkspaceId: rebuilt.workspace.remoteWorkspaceId,
      bundle: expect.objectContaining({
        schema: 'dnaforge.deep-share/v1',
        source: expect.objectContaining({
          pinnedVersionId: rebuilt.workspace.latestVersionId,
          pinnedVersionNumber: 4,
          pinnedVersionContentSha256: 'a'.repeat(64),
        }),
      }),
    });
    expect(result).toMatchObject({
      ok: true,
      shortId: 'deep-short',
      versionId: rebuilt.workspace.latestVersionId,
      bundleId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
    });
  });

  it('returns a refreshed manifest and creates no share when review became stale', async () => {
    const refreshed = preflight({ digest: 'e'.repeat(64) });
    const createDeepShare = vi.fn();

    const result = await publishReviewedDeepShare({} as Database.Database, request, {
      forceSync: async () => ({ ok: true }),
      buildPreflight: async () => refreshed,
      client: { createDeepShare },
      appVersion: '0.8.0',
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'MANIFEST_STALE',
      refreshedReview: { digest: refreshed.digest },
    });
    expect(createDeepShare).not.toHaveBeenCalled();
  });

  it('records the immediate Deep Share parent when publishing an imported fork', async () => {
    const rebuilt = preflight();
    const parent = {
      shareId: 'ffffffff-ffff-4fff-8fff-fffffffffff1',
      sourceArtifactId: 'sender-artifact',
      bundleContentSha256: 'b'.repeat(64),
    };
    const createDeepShare = vi.fn(async ({ bundle }: { bundle: { contentSha256: string } }) => ({
      workspaceId: rebuilt.workspace.remoteWorkspaceId,
      revisionPolicy: 'deep_bundle' as const,
      pinnedVersion: {
        id: rebuilt.workspace.latestVersionId!,
        versionNumber: 4,
        contentSha256: 'a'.repeat(64),
        createdAt: '2026-08-27T02:00:00Z',
      },
      bundle: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', contentSha256: bundle.contentSha256 },
      share: {
        id: 'ffffffff-ffff-4fff-8fff-fffffffffff2',
        shortId: 'deep-short',
        url: 'https://dnaforge.com/d/deep-short#token=secret',
      },
    }));

    await publishReviewedDeepShare({} as Database.Database, request, {
      forceSync: async () => ({ ok: true }),
      buildPreflight: async () => rebuilt,
      readParent: async () => parent,
      client: { createDeepShare },
      appVersion: '0.8.0',
    });

    expect(createDeepShare).toHaveBeenCalledWith({
      remoteWorkspaceId: rebuilt.workspace.remoteWorkspaceId,
      bundle: expect.objectContaining({ parent }),
    });
  });

  it('creates no bundle or link when forced sync fails', async () => {
    const buildPreflight = vi.fn();
    const createDeepShare = vi.fn();

    const result = await publishReviewedDeepShare({} as Database.Database, request, {
      forceSync: async () => ({ ok: false, message: 'Upload failed.' }),
      buildPreflight,
      client: { createDeepShare },
      appVersion: '0.8.0',
    });

    expect(result).toEqual({ ok: false, code: 'SYNC_FAILED', message: 'Upload failed.' });
    expect(buildPreflight).not.toHaveBeenCalled();
    expect(createDeepShare).not.toHaveBeenCalled();
  });
});
