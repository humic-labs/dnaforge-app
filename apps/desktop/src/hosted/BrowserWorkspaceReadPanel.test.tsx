import { withUserMessage } from '@waypoint/user-messages';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserWorkspaceReadPanel } from './BrowserWorkspaceReadPanel';
import {
  createHostedBrowserProposal,
  decideHostedBrowserProposal,
  executeHostedBrowserProposal,
  loadHostedBrowserProposal,
} from './browser-proposal';
import { askHostedBrowserQuestion } from './browser-question';
import { loadHostedBrowserWorkspaceRead } from './browser-workspace-read';

vi.mock('./browser-workspace-read', async () => {
  const actual = await vi.importActual<typeof import('./browser-workspace-read')>(
    './browser-workspace-read'
  );
  return { ...actual, loadHostedBrowserWorkspaceRead: vi.fn() };
});
vi.mock('./browser-proposal', async () => {
  const actual = await vi.importActual<typeof import('./browser-proposal')>('./browser-proposal');
  return {
    ...actual,
    createHostedBrowserProposal: vi.fn(),
    decideHostedBrowserProposal: vi.fn(),
    executeHostedBrowserProposal: vi.fn(),
    loadHostedBrowserProposal: vi.fn(),
  };
});
vi.mock('./browser-question', async () => {
  const actual = await vi.importActual<typeof import('./browser-question')>('./browser-question');
  return { ...actual, askHostedBrowserQuestion: vi.fn() };
});

const readMock = vi.mocked(loadHostedBrowserWorkspaceRead);
const createProposalMock = vi.mocked(createHostedBrowserProposal);
const decideProposalMock = vi.mocked(decideHostedBrowserProposal);
const executeProposalMock = vi.mocked(executeHostedBrowserProposal);
const loadProposalMock = vi.mocked(loadHostedBrowserProposal);
const askQuestionMock = vi.mocked(askHostedBrowserQuestion);
const target = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  displayName: 'Shared project',
};

afterEach(() => {
  readMock.mockReset();
  createProposalMock.mockReset();
  decideProposalMock.mockReset();
  executeProposalMock.mockReset();
  loadProposalMock.mockReset();
  askQuestionMock.mockReset();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe('BrowserWorkspaceReadPanel', () => {
  it('shows the bounded browser boundary and renders a bounded projection', async () => {
    readMock.mockResolvedValue({
      workspace: {
        id: target.workspaceId,
        display_name: target.displayName,
        owner_kind: 'personal',
      },
      version: {
        id: '22222222-2222-4222-8222-222222222222',
        version_number: 3,
        content_sha256: 'a'.repeat(64),
        size_bytes: 2_048,
        file_count: 1,
        created_at: '2026-09-29T12:00:00.000Z',
      },
      files: [
        {
          path: 'sequences/example.gbk',
          resource_id: '33333333-3333-4333-8333-333333333333',
          content_sha256: 'b'.repeat(64),
          size_bytes: 2_048,
          content_type: 'application/genbank',
        },
      ],
    });
    const onClose = vi.fn();
    render(<BrowserWorkspaceReadPanel target={target} versionId="version-3" onClose={onClose} />);

    expect(
      screen.getByText('Metadata read · one bounded effect with explicit approval')
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect current workspace' }));

    await waitFor(() => expect(screen.getByTestId('hosted-browser-read-result')).toBeVisible());
    expect(screen.getByText('Revision 3')).toBeVisible();
    expect(screen.getByText('sequences/example.gbk')).toBeVisible();
    expect(screen.getByText(/Object bytes were not returned/)).toBeVisible();
    expect(readMock).toHaveBeenCalledWith({
      workspaceId: target.workspaceId,
      versionId: 'version-3',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close browser workspace read' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('records and denies a revision-bound proposal without implying an effect', async () => {
    readMock.mockResolvedValue({
      workspace: {
        id: target.workspaceId,
        display_name: target.displayName,
        owner_kind: 'personal',
      },
      version: {
        id: '22222222-2222-4222-8222-222222222222',
        version_number: 3,
        content_sha256: 'a'.repeat(64),
        size_bytes: 2_048,
        file_count: 1,
        created_at: '2026-09-29T12:00:00.000Z',
      },
      files: [],
    });
    createProposalMock.mockResolvedValue({
      proposal_id: '33333333-3333-4333-8333-333333333333',
      workspace_id: target.workspaceId,
      version_id: '22222222-2222-4222-8222-222222222222',
      version_sha256: 'a'.repeat(64),
      tool_name: 'workspace.metadata_read',
      arguments: { include: ['metadata'] },
      arguments_sha256: 'b'.repeat(64),
      created_at: '2026-09-29T12:00:00.000Z',
      expires_at: '2026-09-29T12:05:00.000Z',
      decision: null,
      decided_at: null,
      status: 'pending',
    });
    decideProposalMock.mockResolvedValue({
      proposal_id: '33333333-3333-4333-8333-333333333333',
      workspace_id: target.workspaceId,
      version_id: '22222222-2222-4222-8222-222222222222',
      version_sha256: 'a'.repeat(64),
      tool_name: 'workspace.metadata_read',
      arguments: { include: ['metadata'] },
      arguments_sha256: 'b'.repeat(64),
      created_at: '2026-09-29T12:00:00.000Z',
      expires_at: '2026-09-29T12:05:00.000Z',
      decision: 'denied',
      decided_at: '2026-09-29T12:01:00.000Z',
      status: 'denied',
    });
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000000' });
    render(<BrowserWorkspaceReadPanel target={target} versionId={null} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Inspect current workspace' }));
    await waitFor(() => expect(screen.getByTestId('hosted-browser-read-result')).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: 'Record read proposal' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Deny decision' })).toBeVisible()
    );
    expect(createProposalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: target.workspaceId,
        versionId: '22222222-2222-4222-8222-222222222222',
        versionSha256: 'a'.repeat(64),
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Deny decision' }));
    await waitFor(() =>
      expect(screen.getByTestId('hosted-browser-proposal-terminal')).toHaveTextContent('denied')
    );
    expect(decideProposalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: '33333333-3333-4333-8333-333333333333',
        decision: 'deny',
      })
    );
    expect(screen.getByText(/No effect was executed/)).toBeVisible();
  });

  it('discloses the complete sequence package before approval and in its receipt', async () => {
    const versionId = '22222222-2222-4222-8222-222222222222';
    const productPath = 'vectors/vector_%/vector.gb';
    const removedPaths = [
      'vectors/vector_%/.forge/plasmid.json',
      productPath,
      'vectors/vector_%/reads/check.ab1',
      'vectors/vector_%/assets/notes.txt',
    ];
    const paths = [...removedPaths, 'vectors/vector_AA/vector.gb'];
    readMock.mockResolvedValue({
      workspace: {
        id: target.workspaceId,
        display_name: target.displayName,
        owner_kind: 'personal',
      },
      version: {
        id: versionId,
        version_number: 3,
        content_sha256: 'a'.repeat(64),
        size_bytes: paths.length,
        file_count: paths.length,
        created_at: '2026-09-29T12:00:00.000Z',
      },
      files: paths.map((path, index) => ({
        path,
        resource_id: `33333333-3333-4333-8333-33333333333${index}`,
        content_sha256: 'b'.repeat(64),
        size_bytes: 1,
        content_type: 'application/octet-stream',
      })),
    });
    const pending = {
      proposal_id: '44444444-4444-4444-8444-444444444444',
      workspace_id: target.workspaceId,
      version_id: versionId,
      version_sha256: 'a'.repeat(64),
      tool_name: 'workspace.file_remove' as const,
      arguments: { path: productPath },
      arguments_sha256: 'c'.repeat(64),
      created_at: '2026-09-29T12:00:00.000Z',
      expires_at: '2026-09-29T12:05:00.000Z',
      decision: null,
      decided_at: null,
      status: 'pending' as const,
      execution: null,
    };
    const approved = { ...pending, status: 'approved' as const, decision: 'approved' as const };
    createProposalMock.mockResolvedValue(pending);
    decideProposalMock.mockResolvedValue(approved);
    executeProposalMock.mockResolvedValue({
      ...approved,
      execution: {
        status: 'completed',
        claim_id: '55555555-5555-4555-8555-555555555555',
        receipt_id: '66666666-6666-4666-8666-666666666666',
        claimed_at: '2026-09-29T12:01:01.000Z',
        completed_at: '2026-09-29T12:01:02.000Z',
        effect_receipt_sha256: 'd'.repeat(64),
        result: {
          removed_path: productPath,
          removed_paths: removedPaths,
          removed_package_root: 'vectors/vector_%',
          publish_status: 'ready',
        },
      },
    });
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000000' });
    render(<BrowserWorkspaceReadPanel target={target} versionId={versionId} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect current workspace' }));
    const button = await screen.findByRole('button', {
      name: `Propose remove ${productPath} · entire sequence package`,
    });
    fireEvent.click(button);
    const scope = await screen.findByTestId('hosted-browser-removal-scope');
    expect(scope).toHaveTextContent('entire sequence package vectors/vector_% (4 files)');
    expect(scope).toHaveTextContent('metadata, product, and attachments');
    expect(scope).not.toHaveTextContent('vector_AA');
    expect(decideProposalMock).not.toHaveBeenCalled();
    expect(executeProposalMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve removal' }));
    const receipt = await screen.findByTestId('hosted-browser-mutation-receipt');
    expect(receipt).toHaveTextContent('Entire sequence package vectors/vector_% removed (4 files)');
    expect(executeProposalMock).toHaveBeenCalledTimes(1);
  });

  it('does not offer removal when the inspected file list is incomplete', async () => {
    readMock.mockResolvedValue({
      workspace: {
        id: target.workspaceId,
        display_name: target.displayName,
        owner_kind: 'personal',
      },
      version: {
        id: '22222222-2222-4222-8222-222222222222',
        version_number: 3,
        content_sha256: 'a'.repeat(64),
        size_bytes: 2,
        file_count: 2,
        created_at: '2026-09-29T12:00:00.000Z',
      },
      files: [
        {
          path: 'vectors/example/example.gb',
          resource_id: '33333333-3333-4333-8333-333333333333',
          content_sha256: 'b'.repeat(64),
          size_bytes: 1,
          content_type: 'application/genbank',
        },
      ],
    });
    render(<BrowserWorkspaceReadPanel target={target} versionId={null} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect current workspace' }));
    expect(await screen.findByText(/inspected file list is incomplete/)).toBeVisible();
    expect(screen.queryByTestId('hosted-browser-remove-propose')).toBeNull();
    expect(createProposalMock).not.toHaveBeenCalled();
  });

  it('runs the bounded browser read-question rehearsal without implying a model turn', async () => {
    readMock.mockResolvedValue({
      workspace: {
        id: target.workspaceId,
        display_name: target.displayName,
        owner_kind: 'personal',
      },
      version: {
        id: '22222222-2222-4222-8222-222222222222',
        version_number: 3,
        content_sha256: 'a'.repeat(64),
        size_bytes: 2_048,
        file_count: 1,
        created_at: '2026-09-29T12:00:00.000Z',
      },
      files: [],
    });
    askQuestionMock.mockResolvedValue({
      status: 'read_observation',
      question: 'What files are in this workspace?',
      tool_name: 'workspace.metadata_read',
      arguments: {
        workspace_id: target.workspaceId,
        version_id: '22222222-2222-4222-8222-222222222222',
        include: ['metadata'],
      },
      idempotency_key: 'question-1',
      workspace: {
        workspace: {
          id: target.workspaceId,
          display_name: target.displayName,
          owner_kind: 'personal',
        },
        version: {
          id: '22222222-2222-4222-8222-222222222222',
          version_number: 3,
          content_sha256: 'a'.repeat(64),
          size_bytes: 2_048,
          file_count: 1,
          created_at: '2026-09-29T12:00:00.000Z',
        },
        files: [],
      },
    });
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000000' });
    render(<BrowserWorkspaceReadPanel target={target} versionId={null} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Inspect current workspace' }));
    await waitFor(() => expect(screen.getByTestId('hosted-browser-read-result')).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: 'Ask: what files are here?' }));
    await waitFor(() =>
      expect(screen.getByTestId('hosted-browser-question-result')).toHaveTextContent(
        'Project overview'
      )
    );
    expect(screen.getByTestId('hosted-browser-question-result')).not.toHaveTextContent(
      'workspace.metadata_read'
    );
    expect(askQuestionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: target.workspaceId,
        versionId: '22222222-2222-4222-8222-222222222222',
        question: 'What files are in this workspace?',
      })
    );
    expect(screen.getByText(/not a model turn/)).toBeVisible();
  });

  it('surfaces a gateway refusal without implying a successful read', async () => {
    readMock.mockRejectedValue(
      withUserMessage(
        new Error('The browser-safe workspace read is unavailable.'),
        'validation.compatible.37'
      )
    );
    render(<BrowserWorkspaceReadPanel target={target} versionId={null} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Inspect current workspace' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('unavailable'));
    expect(screen.queryByTestId('hosted-browser-read-result')).toBeNull();
  });

  it('reuses the effect idempotency key after an ambiguous response and offers recovery', async () => {
    readMock.mockResolvedValue({
      workspace: {
        id: target.workspaceId,
        display_name: target.displayName,
        owner_kind: 'personal',
      },
      version: {
        id: '22222222-2222-4222-8222-222222222222',
        version_number: 3,
        content_sha256: 'a'.repeat(64),
        size_bytes: 2_048,
        file_count: 1,
        created_at: '2026-09-29T12:00:00.000Z',
      },
      files: [
        {
          path: 'sequences/example.gbk',
          resource_id: '33333333-3333-4333-8333-333333333333',
          content_sha256: 'b'.repeat(64),
          size_bytes: 2_048,
          content_type: 'application/genbank',
        },
      ],
    });
    const pendingProposal = {
      proposal_id: '44444444-4444-4444-8444-444444444444',
      workspace_id: target.workspaceId,
      version_id: '22222222-2222-4222-8222-222222222222',
      version_sha256: 'a'.repeat(64),
      tool_name: 'workspace.file_remove' as const,
      arguments: { path: 'sequences/example.gbk' },
      arguments_sha256: 'c'.repeat(64),
      created_at: '2026-09-29T12:00:00.000Z',
      expires_at: '2026-09-29T12:05:00.000Z',
      decision: null,
      decided_at: null,
      status: 'pending' as const,
      execution: null,
    };
    const approvedProposal = {
      ...pendingProposal,
      decision: 'approved' as const,
      decided_at: '2026-09-29T12:01:00.000Z',
      status: 'approved' as const,
    };
    const completedProposal = {
      ...approvedProposal,
      execution: {
        status: 'completed' as const,
        claim_id: '55555555-5555-4555-8555-555555555555',
        receipt_id: '66666666-6666-4666-8666-666666666666',
        claimed_at: '2026-09-29T12:01:01.000Z',
        completed_at: '2026-09-29T12:01:02.000Z',
        effect_receipt_sha256: 'd'.repeat(64),
        result: { removed_path: 'sequences/example.gbk', publish_status: 'ready' },
      },
    };
    createProposalMock.mockResolvedValue(pendingProposal);
    decideProposalMock.mockResolvedValue(approvedProposal);
    executeProposalMock
      .mockRejectedValueOnce(new Error('connection closed after commit'))
      .mockResolvedValueOnce(completedProposal);
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000000' });
    render(<BrowserWorkspaceReadPanel target={target} versionId={null} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Inspect current workspace' }));
    await waitFor(() => expect(screen.getByTestId('hosted-browser-read-result')).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: 'Propose remove sequences/example.gbk' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Approve removal' })).toBeVisible()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve removal' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry approved removal' })).toBeVisible()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry approved removal' }));
    await waitFor(() =>
      expect(screen.getByTestId('hosted-browser-mutation-receipt')).toBeVisible()
    );

    expect(executeProposalMock).toHaveBeenCalledTimes(2);
    expect(executeProposalMock.mock.calls[0]?.[0].idempotencyKey).toBe(
      executeProposalMock.mock.calls[1]?.[0].idempotencyKey
    );
    expect(executeProposalMock.mock.calls[0]?.[0].idempotencyKey).toBe(
      'browser-effect-00000000-0000-4000-8000-000000000000'
    );
  });

  it('reuses the decision idempotency key when a decision response is lost', async () => {
    readMock.mockResolvedValue({
      workspace: {
        id: target.workspaceId,
        display_name: target.displayName,
        owner_kind: 'personal',
      },
      version: {
        id: '22222222-2222-4222-8222-222222222222',
        version_number: 3,
        content_sha256: 'a'.repeat(64),
        size_bytes: 2_048,
        file_count: 1,
        created_at: '2026-09-29T12:00:00.000Z',
      },
      files: [
        {
          path: 'sequences/example.gbk',
          resource_id: '33333333-3333-4333-8333-333333333333',
          content_sha256: 'b'.repeat(64),
          size_bytes: 2_048,
          content_type: 'application/genbank',
        },
      ],
    });
    const pendingProposal = {
      proposal_id: '44444444-4444-4444-8444-444444444444',
      workspace_id: target.workspaceId,
      version_id: '22222222-2222-4222-8222-222222222222',
      version_sha256: 'a'.repeat(64),
      tool_name: 'workspace.file_remove' as const,
      arguments: { path: 'sequences/example.gbk' },
      arguments_sha256: 'c'.repeat(64),
      created_at: '2026-09-29T12:00:00.000Z',
      expires_at: '2026-09-29T12:05:00.000Z',
      decision: null,
      decided_at: null,
      status: 'pending' as const,
      execution: null,
    };
    const deniedProposal = {
      ...pendingProposal,
      decision: 'denied' as const,
      decided_at: '2026-09-29T12:01:00.000Z',
      status: 'denied' as const,
    };
    createProposalMock.mockResolvedValue(pendingProposal);
    decideProposalMock
      .mockRejectedValueOnce(new Error('connection closed after commit'))
      .mockResolvedValueOnce(deniedProposal);
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000000' });
    render(<BrowserWorkspaceReadPanel target={target} versionId={null} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Inspect current workspace' }));
    await waitFor(() => expect(screen.getByTestId('hosted-browser-read-result')).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: 'Propose remove sequences/example.gbk' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deny removal' })).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: 'Deny removal' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deny removal' })).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: 'Deny removal' }));
    await waitFor(() =>
      expect(screen.getByTestId('hosted-browser-mutation-terminal')).toHaveTextContent('denied')
    );

    expect(decideProposalMock).toHaveBeenCalledTimes(2);
    expect(decideProposalMock.mock.calls[0]?.[0].idempotencyKey).toBe(
      decideProposalMock.mock.calls[1]?.[0].idempotencyKey
    );
    expect(decideProposalMock.mock.calls[0]?.[0].idempotencyKey).toBe(
      'browser-decision-deny-00000000-0000-4000-8000-000000000000'
    );
  });

  it('does not restore a mutation proposal from a different accepted revision', async () => {
    const currentVersionId = '22222222-2222-4222-8222-222222222222';
    readMock.mockResolvedValue({
      workspace: {
        id: target.workspaceId,
        display_name: target.displayName,
        owner_kind: 'personal',
      },
      version: {
        id: currentVersionId,
        version_number: 4,
        content_sha256: 'a'.repeat(64),
        size_bytes: 2_048,
        file_count: 1,
        created_at: '2026-09-29T12:00:00.000Z',
      },
      files: [
        {
          path: 'sequences/current.gbk',
          resource_id: '33333333-3333-4333-8333-333333333333',
          content_sha256: 'b'.repeat(64),
          size_bytes: 2_048,
          content_type: 'application/genbank',
        },
      ],
    });
    loadProposalMock.mockResolvedValue({
      proposal_id: '44444444-4444-4444-8444-444444444444',
      workspace_id: target.workspaceId,
      version_id: '55555555-5555-4555-8555-555555555555',
      version_sha256: 'c'.repeat(64),
      tool_name: 'workspace.file_remove',
      arguments: { path: 'sequences/old.gbk' },
      arguments_sha256: 'd'.repeat(64),
      created_at: '2026-09-29T12:00:00.000Z',
      expires_at: '2026-09-29T12:05:00.000Z',
      decision: null,
      decided_at: null,
      status: 'pending',
      execution: null,
    });
    window.localStorage.setItem(
      `dnaforge.hosted.browser.mutation-proposal.${target.workspaceId}.${currentVersionId}`,
      '44444444-4444-4444-8444-444444444444'
    );
    render(
      <BrowserWorkspaceReadPanel target={target} versionId={currentVersionId} onClose={vi.fn()} />
    );

    await waitFor(() =>
      expect(loadProposalMock).toHaveBeenCalledWith('44444444-4444-4444-8444-444444444444')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Inspect current workspace' }));
    await waitFor(() => expect(screen.getByTestId('hosted-browser-read-result')).toBeVisible());
    expect(
      screen.getByRole('button', { name: 'Propose remove sequences/current.gbk' })
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Deny removal' })).toBeNull();
    expect(
      window.localStorage.getItem(
        `dnaforge.hosted.browser.mutation-proposal.${target.workspaceId}.${currentVersionId}`
      )
    ).toBeNull();
  });

  it('renders a durable terminal outcome after reloading a proposal', async () => {
    const currentVersionId = '22222222-2222-4222-8222-222222222222';
    readMock.mockResolvedValue({
      workspace: {
        id: target.workspaceId,
        display_name: target.displayName,
        owner_kind: 'personal',
      },
      version: {
        id: currentVersionId,
        version_number: 4,
        content_sha256: 'a'.repeat(64),
        size_bytes: 2_048,
        file_count: 1,
        created_at: '2026-09-29T12:00:00.000Z',
      },
      files: [
        {
          path: 'sequences/current.gbk',
          resource_id: '33333333-3333-4333-8333-333333333333',
          content_sha256: 'b'.repeat(64),
          size_bytes: 2_048,
          content_type: 'application/genbank',
        },
      ],
    });
    loadProposalMock.mockResolvedValue({
      proposal_id: '44444444-4444-4444-8444-444444444444',
      workspace_id: target.workspaceId,
      version_id: currentVersionId,
      version_sha256: 'a'.repeat(64),
      tool_name: 'workspace.file_remove',
      arguments: { path: 'sequences/current.gbk' },
      arguments_sha256: 'd'.repeat(64),
      created_at: '2026-09-29T12:00:00.000Z',
      expires_at: '2026-09-29T12:05:00.000Z',
      decision: 'approved',
      decided_at: '2026-09-29T12:01:00.000Z',
      status: 'approved',
      execution: {
        status: 'failed',
        outcome_id: '55555555-5555-4555-8555-555555555555',
        error_code: 'stale_proposal',
        recorded_at: '2026-09-29T12:01:01.000Z',
      },
    });
    window.localStorage.setItem(
      `dnaforge.hosted.browser.mutation-proposal.${target.workspaceId}.${currentVersionId}`,
      '44444444-4444-4444-8444-444444444444'
    );
    render(
      <BrowserWorkspaceReadPanel target={target} versionId={currentVersionId} onClose={vi.fn()} />
    );

    await waitFor(() =>
      expect(loadProposalMock).toHaveBeenCalledWith('44444444-4444-4444-8444-444444444444')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Inspect current workspace' }));
    await waitFor(() => expect(screen.getByTestId('hosted-browser-read-result')).toBeVisible());
    expect(screen.getByTestId('hosted-browser-mutation-outcome')).toHaveTextContent(
      'Durable execution outcome failed (stale_proposal)'
    );
    expect(screen.queryByRole('button', { name: 'Retry approved removal' })).toBeNull();
  });

  it('restores a completed effect receipt after the workspace advances to a new revision', async () => {
    const currentVersionId = '22222222-2222-4222-8222-222222222222';
    readMock.mockResolvedValue({
      workspace: {
        id: target.workspaceId,
        display_name: target.displayName,
        owner_kind: 'personal',
      },
      version: {
        id: currentVersionId,
        version_number: 4,
        content_sha256: 'a'.repeat(64),
        size_bytes: 2_048,
        file_count: 1,
        created_at: '2026-09-29T12:00:00.000Z',
      },
      files: [
        {
          path: 'sequences/current.gbk',
          resource_id: '33333333-3333-4333-8333-333333333333',
          content_sha256: 'b'.repeat(64),
          size_bytes: 2_048,
          content_type: 'application/genbank',
        },
      ],
    });
    loadProposalMock.mockResolvedValue({
      proposal_id: '44444444-4444-4444-8444-444444444444',
      workspace_id: target.workspaceId,
      version_id: '55555555-5555-4555-8555-555555555555',
      version_sha256: 'c'.repeat(64),
      tool_name: 'workspace.file_remove',
      arguments: { path: 'sequences/old.gbk' },
      arguments_sha256: 'd'.repeat(64),
      created_at: '2026-09-29T12:00:00.000Z',
      expires_at: '2026-09-29T12:05:00.000Z',
      decision: 'approved',
      decided_at: '2026-09-29T12:01:00.000Z',
      status: 'approved',
      execution: {
        status: 'completed',
        claim_id: '66666666-6666-4666-8666-666666666666',
        receipt_id: '77777777-7777-4777-8777-777777777777',
        claimed_at: '2026-09-29T12:01:01.000Z',
        completed_at: '2026-09-29T12:01:02.000Z',
        effect_receipt_sha256: 'e'.repeat(64),
        result: { removed_path: 'sequences/old.gbk', publish_status: 'ready' },
      },
    });
    window.localStorage.setItem(
      `dnaforge.hosted.browser.mutation-terminal.${target.workspaceId}`,
      '44444444-4444-4444-8444-444444444444'
    );
    render(
      <BrowserWorkspaceReadPanel target={target} versionId={currentVersionId} onClose={vi.fn()} />
    );

    await waitFor(() =>
      expect(loadProposalMock).toHaveBeenCalledWith('44444444-4444-4444-8444-444444444444')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Inspect current workspace' }));
    await waitFor(() => expect(screen.getByTestId('hosted-browser-read-result')).toBeVisible());
    expect(screen.getByTestId('hosted-browser-mutation-receipt')).toHaveTextContent(
      'removed sequences/old.gbk'
    );
  });

  it('does not invent a project target when no workspace is active', () => {
    render(<BrowserWorkspaceReadPanel target={null} versionId={null} onClose={vi.fn()} />);

    expect(screen.getByText('Open a project before inspecting it.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Inspect current workspace' })).toBeNull();
  });
});
