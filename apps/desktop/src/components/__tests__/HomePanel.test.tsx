import { userMessage } from '@waypoint/user-messages';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { HomePanel } from '../HomePanel';
import {
  publishRecentlyEditedSnapshot,
  resetRecentlyEditedSnapshotForTests,
  type RecentlyEditedItem,
} from '../../features/home/recently-edited';

function seedRecentlyEdited(items: RecentlyEditedItem[]) {
  publishRecentlyEditedSnapshot(items);
}

const mockNewConversation = vi.fn();
const mockSendMessage = vi.fn();
vi.mock('../../features/ai/hooks/useChat', () => ({
  useChatStore: {
    getState: () => ({
      newConversation: mockNewConversation,
      sendMessage: mockSendMessage,
    }),
  },
}));

const mockPrepareHostedContribution = vi.fn();
vi.mock('../../features/ai/hosted-gateway', () => ({
  prepareHostedContribution: (...args: unknown[]) => mockPrepareHostedContribution(...args),
}));

const { buildIdentity } = vi.hoisted(() => ({
  buildIdentity: { kind: 'release', version: '1.0.0', sourceCommit: null, sourceModified: false },
}));
vi.mock('../../lib/app-build', () => ({ APP_BUILD: buildIdentity }));

const mockGetReleaseNote = vi.fn();
vi.mock('../../lib/release-notes', () => ({
  getReleaseNote: (...args: unknown[]) => mockGetReleaseNote(...args),
}));

const mockRouteControls: {
  activeAssistantRoute:
    | { kind: 'provider'; provider: 'openai'; model: string }
    | { kind: 'hosted'; tier: 'auto' | 'deep' };
  activeRouteNeedsConfiguration: boolean;
  activeRouteSendBlocked: boolean;
  activeDirectApiNeedsKey: boolean;
  activeCliNeedsLogin: boolean;
  activeRouteChecking: boolean;
  renderAssistantRouteSelector: () => null;
  renderModelControls: () => null;
  renderRunningRouteStatus: () => null;
  renderRouteConfigurationPrompt: () => null;
  renderRouteCheckingStatus: () => null;
  renderConnectAiModal: () => null;
} = {
  activeAssistantRoute: { kind: 'provider', provider: 'openai', model: 'gpt-4o' },
  activeRouteNeedsConfiguration: false,
  activeRouteSendBlocked: false,
  activeDirectApiNeedsKey: false,
  activeCliNeedsLogin: false,
  activeRouteChecking: false,
  renderAssistantRouteSelector: () => null,
  renderModelControls: () => null,
  renderRunningRouteStatus: () => null,
  renderRouteConfigurationPrompt: () => null,
  renderRouteCheckingStatus: () => null,
  renderConnectAiModal: () => null,
};
const mockUseChatRouteControls = vi.fn();
vi.mock('../../features/ai/hooks/useChatRouteControls', () => ({
  useChatRouteControls: (...args: unknown[]) => {
    mockUseChatRouteControls(...args);
    return mockRouteControls;
  },
}));

const mockFocusPanel = vi.fn();
const mockSetActiveTab = vi.fn();
const mockCanvasState = {
  panels: {} as Record<
    string,
    {
      id: string;
      tabs: Array<{
        id: string;
        type: string;
        entityId: string;
        label: string;
        sequenceDocument?: { kind: 'indexed-sequence'; documentId: string };
      }>;
    }
  >,
  focusPanel: mockFocusPanel,
  setActiveTab: mockSetActiveTab,
};
vi.mock('../../features/canvas/store', () => {
  const useCanvasStore = (selector: (state: typeof mockCanvasState) => unknown) =>
    selector(mockCanvasState);
  useCanvasStore.getState = () => mockCanvasState;
  return { useCanvasStore };
});

describe('HomePanel', () => {
  beforeEach(() => {
    resetRecentlyEditedSnapshotForTests();
    mockNewConversation.mockReset().mockResolvedValue('conv-1');
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      'conv-1' as `${string}-${string}-${string}-${string}-${string}`
    );
    mockSendMessage
      .mockReset()
      .mockImplementation(
        async (
          _content: string,
          _workspacePath: string | null,
          conversationId: string,
          _referenceIds: string[],
          options?: { onStarted?: (startedConversationId: string) => void }
        ) => {
          options?.onStarted?.(conversationId);
          return 'started';
        }
      );
    buildIdentity.kind = 'release';
    mockGetReleaseNote.mockReset().mockReturnValue(null);
    mockPrepareHostedContribution.mockReset().mockResolvedValue({ started: true, error: null });
    mockRouteControls.activeAssistantRoute = {
      kind: 'provider',
      provider: 'openai',
      model: 'gpt-4o',
    };
    mockRouteControls.activeRouteNeedsConfiguration = false;
    mockRouteControls.activeRouteSendBlocked = false;
    mockRouteControls.activeDirectApiNeedsKey = false;
    mockRouteControls.activeCliNeedsLogin = false;
    mockCanvasState.panels = {};
    mockFocusPanel.mockReset();
    mockSetActiveTab.mockReset();
    mockUseChatRouteControls.mockReset();
  });

  it('renders a DNAForge-branded heading using the real green/gold wordmark', () => {
    render(<HomePanel />);
    const heading = screen.getByTestId('home-heading');
    expect(heading.tagName).toBe('H1');
    expect(screen.getByText('DNA')).toHaveStyle({ color: '#1f7a4f', fontWeight: '750' });
    expect(screen.getByText('FORGE')).toHaveStyle({ color: '#fbbf24', fontWeight: '750' });
    expect(heading).toHaveClass('uppercase');
  });

  it('does not render a Your Workspaces / import-workspace section', () => {
    render(<HomePanel />);
    expect(screen.queryByTestId('workspace-library')).not.toBeInTheDocument();
    expect(screen.queryByText(/your workspaces/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('workspace-library-import')).not.toBeInTheDocument();
  });

  describe('Open tabs / Recently edited — side-by-side layout', () => {
    it('renders both lists inside a shared side-by-side grid container', async () => {
      mockCanvasState.panels = {
        p1: { id: 'p1', tabs: [{ id: 't1', type: 'sequence', entityId: '/a.gb', label: 'a.gb' }] },
      };
      seedRecentlyEdited([
        {
          id: 'page-1',
          title: 'Lab notes',
          workspaceRoot: '/ws/lab',
          workspaceName: 'Lab',
          updatedAt: 1000,
          open: { kind: 'entity' as const, tabType: 'page' as const, entityId: 'page-1' },
        },
      ]);

      render(<HomePanel />);

      await waitFor(() => {
        expect(screen.getByText('Lab notes')).toBeInTheDocument();
      });
      const openTabsHeading = screen.getByText(/open tabs/i);
      const recentlyEditedHeading = screen.getByText(/recently edited/i);
      const grid = openTabsHeading.closest('.grid');
      expect(grid).not.toBeNull();
      expect(grid).toContainElement(recentlyEditedHeading);
    });
  });

  describe('Open tabs', () => {
    it('renders an Open tabs section listing open tabs', () => {
      mockCanvasState.panels = {
        p1: {
          id: 'p1',
          tabs: [
            { id: 't1', type: 'sequence', entityId: '/ws/lab/pUC19.gb', label: 'pUC19.gb' },
            { id: 't2', type: 'chat', entityId: 'conv-1', label: 'New Chat' },
          ],
        },
      };
      render(<HomePanel />);
      expect(screen.getByText(/open tabs/i)).toBeInTheDocument();
      expect(screen.getByText('pUC19.gb')).toBeInTheDocument();
      expect(screen.getByText('New Chat')).toBeInTheDocument();
    });

    it('uses the chromosome-stack icon only for indexed-genome sequence tabs', () => {
      mockCanvasState.panels = {
        p1: {
          id: 'p1',
          tabs: [
            {
              id: 'indexed',
              type: 'sequence',
              entityId: 'assembly:grch38',
              label: 'GRCh38',
              sequenceDocument: {
                kind: 'indexed-sequence',
                documentId: 'assembly:grch38',
              },
            },
            {
              id: 'plasmid',
              type: 'sequence',
              entityId: '/workspace/pUC19.gb',
              label: 'pUC19',
            },
          ],
        },
      };

      render(<HomePanel />);

      expect(
        screen.getByTestId('home-open-tab-indexed').querySelector('[data-icon="genome-assembly"]')
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('home-open-tab-plasmid').querySelector('[data-icon="biology-file"]')
      ).toBeInTheDocument();
    });

    it('does not render the Open tabs section when there are no open tabs', () => {
      mockCanvasState.panels = { p1: { id: 'p1', tabs: [] } };
      render(<HomePanel />);
      expect(screen.queryByText(/open tabs/i)).not.toBeInTheDocument();
    });

    it('lists open tabs across multiple panels (a split view)', () => {
      mockCanvasState.panels = {
        p1: { id: 'p1', tabs: [{ id: 't1', type: 'sequence', entityId: '/a.gb', label: 'a.gb' }] },
        p2: {
          id: 'p2',
          tabs: [{ id: 't2', type: 'design', entityId: 'design-1', label: 'Assembly' }],
        },
      };
      render(<HomePanel />);
      expect(screen.getByText('a.gb')).toBeInTheDocument();
      expect(screen.getByText('Assembly')).toBeInTheDocument();
    });

    it('clicking an open tab focuses its panel/tab and navigates to Explorer', () => {
      const onNavigateToExplorer = vi.fn();
      mockCanvasState.panels = {
        p1: { id: 'p1', tabs: [{ id: 't1', type: 'sequence', entityId: '/a.gb', label: 'a.gb' }] },
      };
      render(<HomePanel onNavigateToExplorer={onNavigateToExplorer} />);
      fireEvent.click(screen.getByText('a.gb'));
      expect(mockFocusPanel).toHaveBeenCalledWith('p1');
      expect(mockSetActiveTab).toHaveBeenCalledWith('p1', 't1');
      expect(onNavigateToExplorer).toHaveBeenCalled();
    });

    it('does not throw clicking an open tab when onNavigateToExplorer is not provided', () => {
      mockCanvasState.panels = {
        p1: { id: 'p1', tabs: [{ id: 't1', type: 'sequence', entityId: '/a.gb', label: 'a.gb' }] },
      };
      render(<HomePanel />);
      expect(() => fireEvent.click(screen.getByText('a.gb'))).not.toThrow();
    });
  });

  describe('Recently Edited snapshot ', () => {
    const item = {
      id: 'page-1',
      title: 'Lab notes',
      workspaceRoot: '/ws/lab',
      workspaceName: 'Lab',
      updatedAt: 1000,
      open: { kind: 'entity' as const, tabType: 'page' as const, entityId: 'page-1' },
    };

    it('shows snapshot items immediately, including after unmount/remount', () => {
      seedRecentlyEdited([item]);
      const { unmount } = render(<HomePanel />);
      expect(screen.getByText('Lab notes')).toBeInTheDocument();
      unmount();

      render(<HomePanel />);
      expect(screen.getByText('Lab notes')).toBeInTheDocument();
      expect(screen.getByTestId('home-recently-edited-list')).toBeInTheDocument();
    });

    it('renders Ask AI even when Recently Edited is empty', () => {
      render(<HomePanel />);
      expect(screen.getByTestId('ai-input')).toBeInTheDocument();
      expect(screen.queryByText(/recently edited/i)).not.toBeInTheDocument();
    });
  });

  describe('Recently Edited', () => {
    it('renders items returned by getRecentlyEdited, and clicking one calls onOpenRecentlyEdited', async () => {
      const item = {
        id: 'page-1',
        title: 'Lab notes',
        workspaceRoot: '/ws/lab',
        workspaceName: 'Lab',
        updatedAt: 1000,
        open: { kind: 'entity' as const, tabType: 'page' as const, entityId: 'page-1' },
      };
      seedRecentlyEdited([item]);
      const onOpenRecentlyEdited = vi.fn();

      render(<HomePanel onOpenRecentlyEdited={onOpenRecentlyEdited} />);

      await waitFor(() => {
        expect(screen.getByText(/recently edited/i)).toBeInTheDocument();
      });
      expect(screen.getByText('Lab notes')).toBeInTheDocument();
      expect(screen.getByText('Lab')).toBeInTheDocument();

      await act(async () => fireEvent.click(screen.getByText('Lab notes')));
      expect(onOpenRecentlyEdited).toHaveBeenCalledWith(item);
    });

    it('shows the entity icon supplied by the open target instead of guessing from its title', async () => {
      seedRecentlyEdited([
        {
          id: 'page-1',
          title: 'Lab notes',
          workspaceRoot: '/ws/lab',
          workspaceName: 'Lab',
          updatedAt: 1000,
          open: { kind: 'entity', tabType: 'page', entityId: 'page-1' },
        },
      ]);

      render(<HomePanel />);

      const row = await screen.findByTestId('home-recently-edited-page-1');
      expect(row.querySelector('svg[data-tab-type-icon="page"]')).not.toBeNull();
    });

    it('immediately marks a pending open and prevents duplicate opens until it settles', async () => {
      const item = {
        id: 'page-1',
        title: 'Lab notes',
        workspaceRoot: '/ws/lab',
        workspaceName: 'Lab',
        updatedAt: 1000,
        open: { kind: 'entity' as const, tabType: 'page' as const, entityId: 'page-1' },
      };
      seedRecentlyEdited([item]);
      let finishOpen!: () => void;
      const pendingOpen = new Promise<void>((resolve) => {
        finishOpen = resolve;
      });
      const onOpenRecentlyEdited = vi.fn(() => pendingOpen);
      const onNavigateToExplorer = vi.fn();

      render(
        <HomePanel
          onOpenRecentlyEdited={onOpenRecentlyEdited}
          onNavigateToExplorer={onNavigateToExplorer}
        />
      );

      const row = await screen.findByTestId('home-recently-edited-page-1');
      fireEvent.click(row);

      expect(row).toBeDisabled();
      expect(row).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByText('Opening…')).toBeInTheDocument();
      fireEvent.click(row);
      expect(onOpenRecentlyEdited).toHaveBeenCalledTimes(1);

      await act(async () => finishOpen());
      await waitFor(() => expect(row).not.toBeDisabled());
      expect(row).toHaveAttribute('aria-busy', 'false');
      expect(onNavigateToExplorer).toHaveBeenCalledTimes(1);
    });

    it('keeps Home visible when opening a recent item reports failure', async () => {
      seedRecentlyEdited([
        {
          id: 'page-1',
          title: 'Lab notes',
          workspaceRoot: '/ws/lab',
          workspaceName: 'Lab',
          updatedAt: 1000,
          open: { kind: 'entity', tabType: 'page', entityId: 'page-1' },
        },
      ]);
      const onNavigateToExplorer = vi.fn();

      render(
        <HomePanel
          onOpenRecentlyEdited={async () => false}
          onNavigateToExplorer={onNavigateToExplorer}
        />
      );

      const row = await screen.findByTestId('home-recently-edited-page-1');
      await act(async () => fireEvent.click(row));

      expect(row).not.toBeDisabled();
      expect(onNavigateToExplorer).not.toHaveBeenCalled();
    });

    it('does not steal focus after Home unmounts while a recent item is still opening', async () => {
      seedRecentlyEdited([
        {
          id: 'page-1',
          title: 'Lab notes',
          workspaceRoot: '/ws/lab',
          workspaceName: 'Lab',
          updatedAt: 1000,
          open: { kind: 'entity', tabType: 'page', entityId: 'page-1' },
        },
      ]);
      let finishOpen!: () => void;
      const pendingOpen = new Promise<void>((resolve) => {
        finishOpen = resolve;
      });
      const onNavigateToExplorer = vi.fn();
      const { unmount } = render(
        <HomePanel
          onOpenRecentlyEdited={() => pendingOpen}
          onNavigateToExplorer={onNavigateToExplorer}
        />
      );

      fireEvent.click(await screen.findByTestId('home-recently-edited-page-1'));
      unmount();
      await act(async () => finishOpen());

      expect(onNavigateToExplorer).not.toHaveBeenCalled();
    });

    it('makes the Recently Edited list a flexible, internally scrollable region', async () => {
      const items = Array.from({ length: 8 }, (_, i) => ({
        id: `item-${i}`,
        title: `File ${i}.gb`,
        workspaceRoot: '/ws/lab',
        workspaceName: 'Lab',
        updatedAt: 1000 - i,
        open: { kind: 'file' as const, path: `/ws/lab/file-${i}.gb`, tabType: 'sequence' as const },
      }));
      seedRecentlyEdited(items);

      render(<HomePanel />);

      const list = await screen.findByTestId('home-recently-edited-list');
      expect(list).toHaveClass('flex-1');
      expect(list).toHaveClass('min-h-0');
      expect(list).toHaveClass('overflow-y-auto');
    });

    it('does not throw clicking a Recently Edited row when onOpenRecentlyEdited is not provided', async () => {
      const item = {
        id: 'page-1',
        title: 'Lab notes',
        workspaceRoot: '/ws/lab',
        workspaceName: 'Lab',
        updatedAt: 1000,
        open: { kind: 'entity' as const, tabType: 'page' as const, entityId: 'page-1' },
      };
      seedRecentlyEdited([item]);

      render(<HomePanel />);

      await waitFor(() => {
        expect(screen.getByText('Lab notes')).toBeInTheDocument();
      });
      expect(() => fireEvent.click(screen.getByText('Lab notes'))).not.toThrow();
    });

    it('omits the secondary workspace label when the item has no workspaceName', async () => {
      const item = {
        id: 'page-2',
        title: 'Orphaned notes',
        workspaceRoot: '/ws/orphan',
        workspaceName: undefined,
        updatedAt: 1000,
        open: { kind: 'entity' as const, tabType: 'page' as const, entityId: 'page-2' },
      };
      seedRecentlyEdited([item]);

      render(<HomePanel />);

      await waitFor(() => {
        expect(screen.getByText('Orphaned notes')).toBeInTheDocument();
      });
      expect(screen.queryByText('undefined')).not.toBeInTheDocument();
    });

    it('hides the file extension in the label and renders a file-type icon, matching the file tree', async () => {
      const item = {
        id: 'seq-1',
        title: 'pUC19.gb',
        workspaceRoot: '/ws/lab',
        workspaceName: 'Lab',
        updatedAt: 1000,
        open: { kind: 'file' as const, path: '/ws/lab/pUC19.gb', tabType: 'sequence' as const },
      };
      seedRecentlyEdited([item]);

      render(<HomePanel />);

      await waitFor(() => {
        expect(screen.getByText('pUC19')).toBeInTheDocument();
      });
      expect(screen.queryByText('pUC19.gb')).not.toBeInTheDocument();
      const iconSvg = screen.getByTestId('home-recently-edited-seq-1').querySelector('svg');
      expect(iconSvg).toBeInTheDocument();
      expect(iconSvg).not.toHaveAttribute('data-file-type-icon');
    });

    it('leaves a non-file-shaped title (a notebook/entity name) unchanged', async () => {
      const item = {
        id: 'page-1',
        title: 'Q3 planning notes',
        workspaceRoot: '/ws/lab',
        workspaceName: 'Lab',
        updatedAt: 1000,
        open: { kind: 'entity' as const, tabType: 'page' as const, entityId: 'page-1' },
      };
      seedRecentlyEdited([item]);

      render(<HomePanel />);

      await waitFor(() => {
        expect(screen.getByText('Q3 planning notes')).toBeInTheDocument();
      });
      const iconSvg = screen.getByTestId('home-recently-edited-page-1').querySelector('svg');
      expect(iconSvg).toBeInTheDocument();
    });

    it('omits the Recently Edited section when there is nothing to show', async () => {
      seedRecentlyEdited([]);
      render(<HomePanel />);
      await waitFor(() => {
        expect(screen.getByText('What can I help with?')).toBeInTheDocument();
      });
      expect(screen.queryByText(/recently edited/i)).not.toBeInTheDocument();
    });
  });

  describe('Ask AI', () => {
    it('renders the shared empty-state composer inside the pinned Ask AI footer', () => {
      render(<HomePanel />);
      expect(screen.getByText('What can I help with?')).toBeInTheDocument();
      expect(screen.getByTestId('home-ask-ai-footer')).toContainElement(
        screen.getByTestId('ai-input')
      );
    });

    it('sends the message directly on the new conversation and hands the exact conversationId to onAskAI', async () => {
      const onAskAI = vi.fn();
      render(<HomePanel onAskAI={onAskAI} />);

      fireEvent.change(screen.getByTestId('ai-input'), {
        target: { value: 'What changed in this design?' },
      });
      fireEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledWith(
          'What changed in this design?',
          null,
          'conv-1',
          [],
          expect.objectContaining({ onStarted: expect.any(Function) })
        );
      });
      expect(onAskAI).toHaveBeenCalledWith('conv-1');
    });

    it('pressing Enter (no Shift) sends, exactly like clicking Send', async () => {
      const onAskAI = vi.fn();
      render(<HomePanel onAskAI={onAskAI} />);

      const input = screen.getByTestId('ai-input');
      fireEvent.change(input, { target: { value: 'What changed in this design?' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        expect(onAskAI).toHaveBeenCalledWith('conv-1');
      });
      expect(mockSendMessage).toHaveBeenCalledWith(
        'What changed in this design?',
        null,
        'conv-1',
        [],
        expect.objectContaining({ onStarted: expect.any(Function) })
      );
    });

    it('Shift+Enter does not send (allows a newline)', () => {
      const onAskAI = vi.fn();
      render(<HomePanel onAskAI={onAskAI} />);
      const input = screen.getByTestId('ai-input');
      fireEvent.change(input, { target: { value: 'line one' } });
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
      expect(mockNewConversation).not.toHaveBeenCalled();
      expect(onAskAI).not.toHaveBeenCalled();
    });

    it('does not submit an empty prompt', () => {
      const onAskAI = vi.fn();
      render(<HomePanel onAskAI={onAskAI} />);
      expect(screen.getByTestId('chat-send-button')).toBeDisabled();
      expect(mockNewConversation).not.toHaveBeenCalled();
      expect(onAskAI).not.toHaveBeenCalled();
    });

    it('does not submit a whitespace-only prompt', () => {
      const onAskAI = vi.fn();
      render(<HomePanel onAskAI={onAskAI} />);
      fireEvent.change(screen.getByTestId('ai-input'), {
        target: { value: '   ' },
      });
      expect(screen.getByTestId('chat-send-button')).toBeDisabled();
      expect(mockNewConversation).not.toHaveBeenCalled();
      expect(onAskAI).not.toHaveBeenCalled();
    });

    it('does not start a conversation when onAskAI is not provided, even with a non-empty prompt', () => {
      render(<HomePanel />);
      fireEvent.change(screen.getByTestId('ai-input'), {
        target: { value: 'What changed in this design?' },
      });
      fireEvent.click(screen.getByTestId('chat-send-button'));
      expect(mockNewConversation).not.toHaveBeenCalled();
    });

    it('leaves the typed prompt in place, does not hand off, and surfaces an error when start rejects', async () => {
      const onAskAI = vi.fn();
      mockSendMessage.mockRejectedValue(new Error('sqlite write failed'));
      render(<HomePanel onAskAI={onAskAI} />);

      fireEvent.change(screen.getByTestId('ai-input'), {
        target: { value: 'What changed in this design?' },
      });
      fireEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
      expect(mockNewConversation).not.toHaveBeenCalled();
      expect(onAskAI).not.toHaveBeenCalled();
      expect(screen.getByTestId('ai-input')).toHaveValue('What changed in this design?');
      await waitFor(() => {
        expect(screen.getByTestId('ai-error')).toHaveTextContent(userMessage('assistant.failed'));
      });
    });

    it('lets runChatTurn own Hosted contribution and keeps the draft on Not now', async () => {
      mockRouteControls.activeAssistantRoute = { kind: 'hosted', tier: 'auto' };
      mockSendMessage.mockResolvedValue('not_started');
      const onAskAI = vi.fn();
      render(<HomePanel onAskAI={onAskAI} />);

      fireEvent.change(screen.getByTestId('ai-input'), {
        target: { value: 'Read this workspace' },
      });
      fireEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
      expect(mockSendMessage).toHaveBeenCalledWith(
        'Read this workspace',
        null,
        'conv-1',
        [],
        expect.objectContaining({
          onStarted: expect.any(Function),
          onNotStarted: expect.any(Function),
        })
      );
      expect(mockPrepareHostedContribution).not.toHaveBeenCalled();
      expect(mockNewConversation).not.toHaveBeenCalled();
      expect(onAskAI).not.toHaveBeenCalled();
      expect(screen.getByTestId('ai-input')).toHaveValue('Read this workspace');
    });

    it('creates no Home conversation and shows the policy error when Hosted admission fails', async () => {
      mockRouteControls.activeAssistantRoute = { kind: 'hosted', tier: 'deep' };
      mockSendMessage.mockImplementation(async (...args: unknown[]) => {
        const options = args[4] as { onNotStarted?: (error: string) => void };
        options.onNotStarted?.('DNAForge AI could not load the current contribution policy.');
        return 'not_started';
      });
      const onAskAI = vi.fn();
      render(<HomePanel onAskAI={onAskAI} />);

      fireEvent.change(screen.getByTestId('ai-input'), {
        target: { value: 'Explain this construct' },
      });
      fireEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => {
        expect(screen.getByTestId('ai-error')).toHaveTextContent(
          'DNAForge AI could not load the current contribution policy.'
        );
      });
      expect(mockPrepareHostedContribution).not.toHaveBeenCalled();
      expect(mockNewConversation).not.toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalledWith(
        'Explain this construct',
        null,
        'conv-1',
        [],
        expect.objectContaining({
          onStarted: expect.any(Function),
          onNotStarted: expect.any(Function),
        })
      );
      expect(onAskAI).not.toHaveBeenCalled();
      expect(screen.getByTestId('ai-input')).toHaveValue('Explain this construct');
    });

    it('uses one runChatTurn-owned Hosted gate instead of a renderer preflight', async () => {
      mockRouteControls.activeAssistantRoute = { kind: 'hosted', tier: 'auto' };
      const onAskAI = vi.fn();
      render(<HomePanel onAskAI={onAskAI} />);

      fireEvent.change(screen.getByTestId('ai-input'), {
        target: { value: 'Use the actual hosted model' },
      });
      fireEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => expect(onAskAI).toHaveBeenCalledWith('conv-1'));
      expect(mockPrepareHostedContribution).not.toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalledWith(
        'Use the actual hosted model',
        null,
        'conv-1',
        [],
        expect.objectContaining({ onStarted: expect.any(Function) })
      );
    });

    it('hands off to onAskAI without waiting for sendMessage to finish the full turn', async () => {
      const onAskAI = vi.fn();
      let resolveSend: () => void = () => {};
      mockSendMessage.mockImplementation(
        (
          _content: string,
          _workspacePath: string | null,
          conversationId: string,
          _referenceIds: string[],
          options?: { onStarted?: (startedConversationId: string) => void }
        ) => {
          options?.onStarted?.(conversationId);
          return new Promise<void>((resolve) => {
            resolveSend = resolve;
          });
        }
      );
      render(<HomePanel onAskAI={onAskAI} />);

      fireEvent.change(screen.getByTestId('ai-input'), {
        target: { value: 'What changed in this design?' },
      });
      fireEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => {
        expect(onAskAI).toHaveBeenCalledWith('conv-1');
      });
      expect(mockSendMessage).toHaveBeenCalledWith(
        'What changed in this design?',
        null,
        'conv-1',
        [],
        expect.objectContaining({ onStarted: expect.any(Function) })
      );
      resolveSend();
    });

    it('does not hand off or clear the Home draft until runChatTurn reports a durable start', async () => {
      const onAskAI = vi.fn();
      let resolveSend: (value: 'started' | 'not_started') => void = () => {};
      mockSendMessage.mockReturnValue(
        new Promise<'started' | 'not_started'>((resolve) => {
          resolveSend = resolve;
        })
      );
      render(<HomePanel onAskAI={onAskAI} />);

      fireEvent.change(screen.getByTestId('ai-input'), {
        target: { value: 'Keep this draft until admission succeeds' },
      });
      fireEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
      expect(onAskAI).not.toHaveBeenCalled();
      expect(screen.getByTestId('ai-input')).toHaveValue(
        'Keep this draft until admission succeeds'
      );

      const sendArgs = mockSendMessage.mock.calls[0];
      const conversationId = sendArgs[2] as string;
      const options = sendArgs[4] as
        | { onStarted?: (startedConversationId: string) => void }
        | undefined;
      expect(options?.onStarted).toEqual(expect.any(Function));
      options?.onStarted?.(conversationId);

      await waitFor(() => expect(onAskAI).toHaveBeenCalledWith(conversationId));
      expect(screen.getByTestId('ai-input')).toHaveValue('');
      resolveSend('started');
    });

    it('catches (does not throw) when sendMessage rejects after the handoff already happened', async () => {
      const onAskAI = vi.fn();
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockSendMessage.mockImplementation(
        (
          _content: string,
          _workspacePath: string | null,
          conversationId: string,
          _referenceIds: string[],
          options?: { onStarted?: (startedConversationId: string) => void }
        ) => {
          options?.onStarted?.(conversationId);
          return Promise.reject(new Error('turn failed after handoff'));
        }
      );
      render(<HomePanel onAskAI={onAskAI} />);

      fireEvent.change(screen.getByTestId('ai-input'), {
        target: { value: 'What changed in this design?' },
      });
      fireEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => {
        expect(onAskAI).toHaveBeenCalledWith('conv-1');
      });
      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[HomePanel] Ask AI send failed:',
          expect.any(Error)
        );
      });
      consoleErrorSpy.mockRestore();
    });

    it('disables sending when the active route needs configuration', () => {
      mockRouteControls.activeRouteNeedsConfiguration = true;
      mockRouteControls.activeRouteSendBlocked = true;
      mockRouteControls.activeDirectApiNeedsKey = true;
      render(<HomePanel onAskAI={vi.fn()} />);
      fireEvent.change(screen.getByTestId('ai-input'), { target: { value: 'hello' } });
      expect(screen.getByTestId('chat-send-button')).toBeDisabled();
    });

    it('does not send via Enter either when the active route needs configuration', () => {
      mockRouteControls.activeRouteNeedsConfiguration = true;
      mockRouteControls.activeRouteSendBlocked = true;
      mockRouteControls.activeDirectApiNeedsKey = true;
      const onAskAI = vi.fn();
      render(<HomePanel onAskAI={onAskAI} />);
      const input = screen.getByTestId('ai-input');
      fireEvent.change(input, { target: { value: 'hello' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(mockNewConversation).not.toHaveBeenCalled();
      expect(onAskAI).not.toHaveBeenCalled();
    });

    it('blocks click and Enter while a first-run route is unresolved', () => {
      mockRouteControls.activeRouteNeedsConfiguration = false;
      mockRouteControls.activeRouteSendBlocked = true;
      const onAskAI = vi.fn();
      render(<HomePanel onAskAI={onAskAI} />);
      const input = screen.getByTestId('ai-input');
      fireEvent.change(input, { target: { value: 'hello' } });

      expect(screen.getByTestId('chat-send-button')).toBeDisabled();
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(onAskAI).not.toHaveBeenCalled();
    });

    it('seeds the new conversation onto the currently open workspace, not hardcoded null', async () => {
      const onAskAI = vi.fn();
      render(<HomePanel onAskAI={onAskAI} workspacePath="/Users/dev/my-workspace" />);
      fireEvent.change(screen.getByTestId('ai-input'), { target: { value: 'hello' } });
      fireEvent.click(screen.getByTestId('chat-send-button'));
      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledWith(
          'hello',
          '/Users/dev/my-workspace',
          'conv-1',
          [],
          expect.objectContaining({ onStarted: expect.any(Function) })
        );
      });
    });

    it('seeds null when no workspace is open (workspacePath omitted)', async () => {
      const onAskAI = vi.fn();
      render(<HomePanel onAskAI={onAskAI} />);
      fireEvent.change(screen.getByTestId('ai-input'), { target: { value: 'hello' } });
      fireEvent.click(screen.getByTestId('chat-send-button'));
      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledWith(
          'hello',
          null,
          'conv-1',
          [],
          expect.objectContaining({ onStarted: expect.any(Function) })
        );
      });
    });

    it('does not start a second conversation from a rapid double-send while the first is still in flight', async () => {
      const onAskAI = vi.fn();
      let resolveFirst: (value: 'started') => void = () => {};
      mockSendMessage.mockReturnValue(
        new Promise<'started'>((resolve) => {
          resolveFirst = resolve;
        })
      );
      render(<HomePanel onAskAI={onAskAI} />);
      const input = screen.getByTestId('ai-input');
      fireEvent.change(input, { target: { value: 'hello' } });
      const sendButton = screen.getByTestId('chat-send-button');

      fireEvent.click(sendButton);
      fireEvent.click(sendButton);
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(mockSendMessage).toHaveBeenCalledTimes(1);

      const options = mockSendMessage.mock.calls[0][4] as {
        onStarted?: (startedConversationId: string) => void;
      };
      options.onStarted?.('conv-1');
      resolveFirst('started');
      await waitFor(() => {
        expect(onAskAI).toHaveBeenCalledTimes(1);
      });
      expect(onAskAI).toHaveBeenCalledWith('conv-1');
    });

    it('does not call onAskAI (navigate/focus-steal) if Home unmounts before the send resolves', async () => {
      const onAskAI = vi.fn();
      let resolveSend: (value: 'started') => void = () => {};
      mockSendMessage.mockReturnValue(
        new Promise<'started'>((resolve) => {
          resolveSend = resolve;
        })
      );
      const { unmount } = render(<HomePanel onAskAI={onAskAI} />);
      fireEvent.change(screen.getByTestId('ai-input'), { target: { value: 'hello' } });
      fireEvent.click(screen.getByTestId('chat-send-button'));

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      const options = mockSendMessage.mock.calls[0][4] as {
        onStarted?: (startedConversationId: string) => void;
      };
      unmount();
      options.onStarted?.('conv-1');
      resolveSend('started');

      expect(onAskAI).not.toHaveBeenCalled();
    });

    it('does not misreport a send failure when only the onAskAI handoff throws', async () => {
      const onAskAI = vi.fn(() => {
        throw new Error('retargetChatTab exploded');
      });
      render(<HomePanel onAskAI={onAskAI} />);

      fireEvent.change(screen.getByTestId('ai-input'), {
        target: { value: 'What changed in this design?' },
      });
      fireEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledWith(
          'What changed in this design?',
          null,
          'conv-1',
          [],
          expect.objectContaining({ onStarted: expect.any(Function) })
        );
      });
      expect(onAskAI).toHaveBeenCalledWith('conv-1');
      expect(screen.queryByTestId('ai-error')).not.toBeInTheDocument();
    });

    it('threads onConfigureHost/onOpenAssistantSources into useChatRouteControls', () => {
      const onConfigureHost = vi.fn();
      const onOpenAssistantSources = vi.fn();
      render(
        <HomePanel
          onConfigureHost={onConfigureHost}
          onOpenAssistantSources={onOpenAssistantSources}
        />
      );
      expect(mockUseChatRouteControls).toHaveBeenCalledWith(
        expect.objectContaining({ onConfigureHost, onOpenAssistantSources })
      );
    });
  });

  describe("What's New", () => {
    it.each(['development', 'local', 'test', 'unknown'])(
      'does not claim a new release for %s',
      (kind) => {
        buildIdentity.kind = kind;
        mockGetReleaseNote.mockReturnValue({ date: '2026-07-16', highlights: ['Fixed things'] });
        render(<HomePanel onViewReleaseNotes={vi.fn()} />);
        expect(screen.queryByTestId('home-whats-new')).not.toBeInTheDocument();
      }
    );
    it('shows a quiet release-notes line when a release note exists for the running version', () => {
      mockGetReleaseNote.mockReturnValue({ date: '2026-07-16', highlights: ['Fixed things'] });
      const onViewReleaseNotes = vi.fn();
      render(<HomePanel onViewReleaseNotes={onViewReleaseNotes} />);
      const link = screen.getByTestId('home-whats-new');
      expect(link).toBeInTheDocument();
      fireEvent.click(link);
      expect(onViewReleaseNotes).toHaveBeenCalled();
      expect(onViewReleaseNotes).toHaveBeenCalledWith(link);
    });

    it('omits the line when there is no release note for the running version', () => {
      mockGetReleaseNote.mockReturnValue(null);
      render(<HomePanel onViewReleaseNotes={vi.fn()} />);
      expect(screen.queryByTestId('home-whats-new')).not.toBeInTheDocument();
    });

    it('omits the line when a release note exists but onViewReleaseNotes is not provided', () => {
      mockGetReleaseNote.mockReturnValue({ date: '2026-07-16', highlights: ['Fixed things'] });
      render(<HomePanel />);
      expect(screen.queryByTestId('home-whats-new')).not.toBeInTheDocument();
    });
  });
});
