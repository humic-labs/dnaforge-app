import { userMessage } from '@waypoint/user-messages';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DeepShareReview } from '../../shared/deep-share-ipc';
import { DeepShareManifestDialog } from './DeepShareManifestDialog';

const review: DeepShareReview = {
  workspace: { uuid: 'workspace-1', name: 'Project', remoteWorkspaceId: 'remote-1' },
  rootArtifactId: 'root',
  rootArtifact: { id: 'root', type: 'sequence', name: 'pUC19' },
  manifest: {
    rootArtifactId: 'root',
    artifacts: [
      { id: 'root', type: 'sequence', name: 'pUC19', required: true },
      { id: 'primer', type: 'primer', name: 'Primer A', required: false },
    ],
    relationships: [
      { sourceArtifactId: 'primer', relation: 'binds_to_sequence', targetArtifactId: 'root' },
    ],
    files: [{ fileId: 'file-1', ownerArtifactId: 'root', role: 'primary' }],
    chats: [{ conversationId: 'chat-1', title: 'Design notes' }],
    omissions: [
      { code: 'UNCONFIRMED_RELATION', subject: 'root', detail: 'Suggestion was not confirmed.' },
    ],
  },
  files: [
    {
      id: 'file-1',
      ownerArtifactId: 'root',
      relativePath: 'pUC19/pUC19.gb',
      name: 'pUC19.gb',
      role: 'primary',
      contentType: 'text/plain',
      sizeBytes: 2048,
      sha256: 'a'.repeat(64),
    },
  ],
  chats: [
    {
      id: 'chat-1',
      title: 'Design notes',
      createdAt: '2026-08-27T01:00:00Z',
      updatedAt: '2026-08-27T01:10:00Z',
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          content: 'Use the confirmed primer pair.',
          createdAt: '2026-08-27T01:10:00Z',
          references: [{ artifactId: 'root', artifactType: 'sequence', label: 'pUC19' }],
        },
      ],
    },
  ],
  conversationCandidates: [
    {
      id: 'chat-1',
      title: 'Design notes',
      createdAt: 1,
      updatedAt: 2,
      exactReferenceCount: 1,
    },
    {
      id: 'chat-2',
      title: 'Unselected chat',
      createdAt: 3,
      updatedAt: 4,
      exactReferenceCount: 0,
    },
  ],
  digest: 'd'.repeat(64),
};

describe('DeepShareManifestDialog', () => {
  it('shows exact reviewed artifacts, file hashes, omissions, and selected portable chat', () => {
    render(
      <DeepShareManifestDialog
        review={review}
        selectedArtifactIds={new Set(['root', 'primer'])}
        selectedConversationIds={new Set(['chat-1'])}
        busy={false}
        error={null}
        onToggleArtifact={vi.fn()}
        onToggleConversation={vi.fn()}
        onPublish={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByTestId('deep-share-dialog')).toHaveClass('z-[10000]');
    expect(screen.getByText(/Anyone with the link/)).toBeInTheDocument();
    expect(screen.getByLabelText('Include pUC19')).toBeDisabled();
    expect(screen.getByLabelText('Include Primer A')).toBeChecked();
    expect(screen.getByText('pUC19/pUC19.gb')).toBeInTheDocument();
    expect(screen.getByText(new RegExp('sha256 ' + 'a'.repeat(64)))).toBeInTheDocument();
    expect(screen.getByText(userMessage('sharing.omittedContent'))).toBeInTheDocument();
    expect(screen.getByText('Use the confirmed primer pair.')).toBeInTheDocument();
    expect(screen.getByLabelText('Include conversation Unselected chat')).not.toBeChecked();
  });

  it('requires explicit publish and reports selection toggles', () => {
    const onToggleArtifact = vi.fn();
    const onToggleConversation = vi.fn();
    const onPublish = vi.fn();
    render(
      <DeepShareManifestDialog
        review={review}
        selectedArtifactIds={new Set(['root', 'primer'])}
        selectedConversationIds={new Set()}
        busy={false}
        error={null}
        onToggleArtifact={onToggleArtifact}
        onToggleConversation={onToggleConversation}
        onPublish={onPublish}
        onCancel={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText('Include Primer A'));
    fireEvent.click(screen.getByLabelText('Include conversation Design notes'));
    expect(onToggleArtifact).toHaveBeenCalledWith('primer');
    expect(onToggleConversation).toHaveBeenCalledWith('chat-1');
    expect(onPublish).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByTestId('deep-share-publish'));
    expect(onPublish).toHaveBeenCalledTimes(1);
  });
});
