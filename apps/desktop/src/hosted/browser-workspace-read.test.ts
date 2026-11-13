// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HostedBrowserWorkspaceReadError,
  loadHostedBrowserWorkspaceRead,
} from './browser-workspace-read';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
const resourceId = '33333333-3333-4333-8333-333333333333';

const projection = {
  workspace: { id: workspaceId, display_name: 'Project', owner_kind: 'personal' },
  version: {
    id: versionId,
    version_number: 4,
    content_sha256: 'a'.repeat(64),
    size_bytes: 8,
    file_count: 1,
    created_at: '2026-09-29T12:00:00.000Z',
  },
  files: [
    {
      path: 'sequences/example.gbk',
      resource_id: resourceId,
      content_sha256: 'b'.repeat(64),
      size_bytes: 8,
      content_type: 'application/genbank',
    },
  ],
};

describe('loadHostedBrowserWorkspaceRead', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requests the selected workspace revision through the same-origin proxy', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(projection), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadHostedBrowserWorkspaceRead({ workspaceId, versionId })).resolves.toEqual(
      projection
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/v1/hosted/browser/workspace?workspace_id=${workspaceId}&version_id=${versionId}`,
      expect.objectContaining({
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      })
    );
  });

  it('maps authentication and bounded-size refusals to actionable errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'workspace_snapshot_too_large' }), { status: 413 })
      )
    );

    await expect(loadHostedBrowserWorkspaceRead({ workspaceId })).rejects.toEqual(
      new HostedBrowserWorkspaceReadError(
        413,
        'workspace_snapshot_too_large',
        'This workspace is too large for a bounded browser read.'
      )
    );
  });

  it('rejects invalid identifiers before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      loadHostedBrowserWorkspaceRead({ workspaceId: 'not-a-uuid' })
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when the projection shape is not typed metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ workspace: {}, version: null, files: [] })))
    );

    await expect(loadHostedBrowserWorkspaceRead({ workspaceId })).rejects.toMatchObject({
      status: 502,
      code: 'BAD_RESPONSE',
    });
  });
});
