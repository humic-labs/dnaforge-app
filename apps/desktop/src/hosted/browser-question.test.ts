// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostedBrowserQuestionError, askHostedBrowserQuestion } from './browser-question';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
const observation = {
  status: 'read_observation' as const,
  question: 'What files are here?',
  tool_name: 'workspace.metadata_read' as const,
  arguments: { workspace_id: workspaceId, version_id: versionId, include: ['metadata'] as const },
  idempotency_key: 'question-1',
  workspace: {
    workspace: { id: workspaceId, display_name: 'Project', owner_kind: 'personal' as const },
    version: {
      id: versionId,
      version_number: 1,
      content_sha256: 'a'.repeat(64),
      size_bytes: 8,
      file_count: 0,
      created_at: '2026-09-29T12:00:00.000Z',
    },
    files: [],
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('hosted browser question client', () => {
  it('posts a typed read question through the same-origin proxy', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(observation), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      askHostedBrowserQuestion({
        workspaceId,
        versionId,
        question: 'What files are here?',
        idempotencyKey: 'question-1',
      })
    ).resolves.toEqual(observation);
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/hosted/browser/question',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      })
    );
  });

  it('rejects malformed observations and stale authentication without fabricating a result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ error: 'invalid_access_token' }), { status: 401 })
      )
    );
    await expect(
      askHostedBrowserQuestion({
        workspaceId,
        versionId,
        question: 'What files are here?',
        idempotencyKey: 'question-2',
      })
    ).rejects.toEqual(
      new HostedBrowserQuestionError(
        401,
        'invalid_access_token',
        'Sign in again before asking a browser workspace question.'
      )
    );
  });

  it('rejects invalid identifiers before network egress', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      askHostedBrowserQuestion({
        workspaceId: 'not-a-uuid',
        versionId,
        question: 'What files are here?',
        idempotencyKey: 'question-3',
      })
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
