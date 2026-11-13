import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FullChatView,
  getFullChatViewHarness,
  resetFullChatViewHarness,
} from './FullChatView.test-harness';
import { WorkspaceMain } from './workspace/WorkspaceMain';

vi.mock('../features/home/HomeWorkbench', () => ({
  HomeWorkbench: () => <button>Home action</button>,
}));
vi.mock('../features/home/RecentlyEditedLoader', () => ({ RecentlyEditedLoader: () => null }));

describe('chat history belongs to the visible workspace', () => {
  beforeEach(() => {
    resetFullChatViewHarness();
    localStorage.clear();
  });

  it('finishes a pending new conversation without reviving hidden history or taking focus', async () => {
    const { mockChatState } = getFullChatViewHarness();
    let complete!: (id: string) => void;
    mockChatState.newConversation.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        })
    );
    const onConversationIdChange = vi.fn();
    const workspace = (hidden: boolean) => (
      <WorkspaceMain
        occluded={false}
        workspaceTakeoverActive={hidden}
        emptyFilesHomeActive={false}
        homeViewActive={hidden}
        homeWorkbenchActive={hidden}
        explorerInset={0}
        explorer={
          <FullChatView
            workspacePath="/workspace"
            onConversationIdChange={onConversationIdChange}
          />
        }
        settings={null}
        home={{}}
      />
    );
    const view = render(workspace(false));
    fireEvent.mouseEnter(screen.getByTestId('ai-history-launcher'));
    fireEvent.click(screen.getByTestId('ai-new-conversation-button'));
    expect(mockChatState.newConversation).toHaveBeenCalledTimes(1);
    view.rerender(workspace(true));
    const homeAction = screen.getByRole('button', { name: 'Home action' });
    homeAction.focus();
    await act(async () => {
      complete('created-in-background');
    });
    expect(onConversationIdChange).toHaveBeenCalledWith('created-in-background');
    expect(homeAction).toHaveFocus();
    expect(screen.queryByTestId('ai-history-launcher')).not.toBeInTheDocument();
    view.rerender(workspace(false));
    expect(screen.getByTestId('ai-history-launcher')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-history-panel')).not.toBeInTheDocument();
  });

  for (const departure of ['takeover', 'empty-home', 'occluded'] as const) {
    for (const mode of ['collapsed', 'hover', 'focus', 'pinned'] as const) {
      it(`releases ${mode} history during ${departure} and preserves the chat on return`, () => {
        const onPinnedLayoutChange = vi.fn();
        const workspace = (hidden: boolean) => (
          <WorkspaceMain
            occluded={hidden && departure === 'occluded'}
            workspaceTakeoverActive={hidden && departure === 'takeover'}
            emptyFilesHomeActive={hidden && departure === 'empty-home'}
            homeViewActive={hidden}
            homeWorkbenchActive={hidden}
            explorerInset={0}
            explorer={
              <FullChatView
                workspacePath="/workspace"
                onHistoryPinnedChange={onPinnedLayoutChange}
              />
            }
            settings={null}
            home={{}}
          />
        );
        const view = render(workspace(false));
        fireEvent.change(screen.getByTestId('ai-input'), { target: { value: 'Keep this draft' } });
        const launcher = screen.getByTestId('ai-history-launcher');
        if (mode === 'hover') fireEvent.mouseEnter(launcher);
        if (mode === 'focus') fireEvent.focus(screen.getByTestId('ai-history-button'));
        if (mode === 'pinned') fireEvent.click(screen.getByTestId('ai-history-button'));
        if (mode !== 'collapsed')
          expect(screen.getByTestId('ai-history-panel')).toBeInTheDocument();

        view.rerender(workspace(true));
        expect(screen.queryByTestId('ai-history-launcher')).not.toBeInTheDocument();
        expect(screen.queryByTestId('ai-history-panel')).not.toBeInTheDocument();
        expect(document.querySelector('[data-history-pinned="true"]')).toBeNull();
        expect(onPinnedLayoutChange).toHaveBeenLastCalledWith(false);

        view.rerender(workspace(false));
        expect(screen.getByTestId('ai-input')).toHaveValue('Keep this draft');
        expect(screen.getByTestId('ai-history-launcher')).toBeInTheDocument();
        expect(screen.queryByTestId('ai-history-panel')).not.toBeInTheDocument();
        expect(onPinnedLayoutChange).toHaveBeenLastCalledWith(false);
      });
    }
  }
});
