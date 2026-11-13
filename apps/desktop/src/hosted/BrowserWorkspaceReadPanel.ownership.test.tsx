// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserWorkspaceReadPanel } from './BrowserWorkspaceReadPanel';
const ports = vi.hoisted(() => ({ read: vi.fn(), question: vi.fn() }));
vi.mock('./browser-workspace-read', () => ({
  loadHostedBrowserWorkspaceRead: ports.read,
  HostedBrowserWorkspaceReadError: class extends Error {},
}));
vi.mock('./browser-question', () => ({
  askHostedBrowserQuestion: ports.question,
  HostedBrowserQuestionError: class extends Error {},
}));
vi.mock('./browser-proposal', () => ({
  createHostedBrowserProposal: vi.fn(),
  decideHostedBrowserProposal: vi.fn(),
  executeHostedBrowserProposal: vi.fn(),
  loadHostedBrowserProposal: vi.fn(),
  HostedBrowserProposalError: class extends Error {},
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const target = { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'Project A' };
const oldVersion = '11111111-1111-4111-8111-111111111111';
const newVersion = '22222222-2222-4222-8222-222222222222';
function projection(versionId: string, version: number) {
  return {
    workspace: { id: target.workspaceId, display_name: target.displayName, owner_kind: 'personal' },
    version: {
      id: versionId,
      version_number: version,
      content_sha256: 'a'.repeat(64),
      size_bytes: 4,
      file_count: 1,
      created_at: '2026-11-01T00:00:00Z',
    },
    files: [
      {
        path: `revision-${version}.txt`,
        resource_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        content_sha256: 'b'.repeat(64),
        size_bytes: 4,
        content_type: 'text/plain',
      },
    ],
  };
}
describe('hosted preview request ownership', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.localStorage.clear();
  });
  it.each(['success', 'failure'] as const)(
    'discards old-revision %s after the accepted revision changes',
    async (outcome) => {
      const read = deferred<ReturnType<typeof projection>>();
      ports.read.mockReturnValue(read.promise);
      const { rerender } = render(
        <BrowserWorkspaceReadPanel
          target={target}
          versionId={oldVersion}
          onClose={() => undefined}
        />
      );
      fireEvent.click(screen.getByTestId('hosted-browser-read-inspect'));
      expect(ports.read).toHaveBeenCalledWith({
        workspaceId: target.workspaceId,
        versionId: oldVersion,
      });
      rerender(
        <BrowserWorkspaceReadPanel
          target={target}
          versionId={newVersion}
          onClose={() => undefined}
        />
      );
      await act(async () => {
        if (outcome === 'success') read.resolve(projection(oldVersion, 1));
        else read.reject(new Error('retired failure'));
      });
      expect(screen.queryByTestId('hosted-browser-read-result')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByTestId('hosted-browser-read-inspect')).toHaveTextContent(
        'Inspect current workspace'
      );
    }
  );
  it('keeps the new revision preview when its older inspection finishes last', async () => {
    const oldRead = deferred<ReturnType<typeof projection>>();
    ports.read
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValueOnce(projection(newVersion, 2));
    const { rerender } = render(
      <BrowserWorkspaceReadPanel target={target} versionId={oldVersion} onClose={() => undefined} />
    );
    fireEvent.click(screen.getByTestId('hosted-browser-read-inspect'));
    rerender(
      <BrowserWorkspaceReadPanel target={target} versionId={newVersion} onClose={() => undefined} />
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('hosted-browser-read-inspect'));
    });
    expect(screen.getByText('Revision 2')).toBeVisible();
    await act(async () => {
      oldRead.resolve(projection(oldVersion, 1));
    });
    expect(screen.getByText('Revision 2')).toBeVisible();
    expect(screen.queryByText('revision-1.txt')).toBeNull();
  });
});
