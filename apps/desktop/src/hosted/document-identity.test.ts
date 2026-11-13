// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { hostedDocumentIdentity } from './document-identity';

const { state } = vi.hoisted(() => ({ state: vi.fn() }));
vi.mock('./controller', () => ({ hostedWorkspaceSessionController: { getState: state } }));
const workspaceId = '11111111-1111-4111-8111-111111111111';

function session(localRevisionId?: string) {
  return {
    activeWorkspaceId: workspaceId,
    workspaces: [{ workspaceId, clientWorkspaceId: 'client' }],
    snapshot: {
      workspaceId,
      revisionId: 'accepted',
      revisionNumber: 4,
      localRevisionId,
      files: [{ path: 'sequence.gb', resourceId: 'file', contentSha256: 'a'.repeat(64) }],
    },
  };
}

describe('hosted document identity', () => {
  it('labels pending bytes as a local revision, never an accepted version', () => {
    state.mockReturnValue(session('draft'));
    expect(hostedDocumentIdentity(`/hosted/${workspaceId}/sequence.gb`)).toMatchObject({
      revisionId: '',
      acceptedBaseRevisionId: 'accepted',
      revisionNumber: 4,
      localRevisionId: 'draft',
    });
    state.mockReturnValue(session());
    expect(hostedDocumentIdentity(`/hosted/${workspaceId}/sequence.gb`)).toMatchObject({
      revisionId: 'accepted',
      acceptedBaseRevisionId: 'accepted',
      localRevisionId: null,
    });
  });
  it('never borrows the active workspace identity for another workspace path', () => {
    state.mockReturnValue(session());
    expect(
      hostedDocumentIdentity('/hosted/22222222-2222-4222-8222-222222222222/sequence.gb')
    ).toBeNull();
  });
});
