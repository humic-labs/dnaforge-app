import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPermissionPickers } from './ChatPermissionPickers';
import { useAISettingsStore } from '../../features/ai/settings';
import { useChatStore } from '../../features/ai/hooks/useChat';
import { createEmptyConversationState } from '../../features/ai/orchestration/chat-store-types';
import {
  CODEX_MENU,
  cliModeChoices,
  codexChoice,
  codexCustomProfileChoice,
  type AgentPermissionCatalog,
} from '../../shared/agent-permissions';

const CATALOG: AgentPermissionCatalog = {
  defaults: { claude: 'bypassPermissions', grok: 'auto', codex: ':danger-full-access' },
  options: {
    claude: cliModeChoices('claude', [
      'acceptEdits',
      'auto',
      'bypassPermissions',
      'manual',
      'dontAsk',
      'plan',
    ]),
    grok: cliModeChoices('grok', [
      'default',
      'acceptEdits',
      'auto',
      'dontAsk',
      'bypassPermissions',
      'plan',
    ]),
    codex: [...CODEX_MENU.map(codexChoice), codexCustomProfileChoice('lab', 'Lab folders only')],
  },
};

function optionNames(): string[] {
  return screen.getAllByRole('option').map((option) => option.textContent ?? '');
}

describe('ChatPermissionPickers', () => {
  const setAgentPermissions = vi.fn().mockResolvedValue(undefined);
  const loadPermissionCatalog = vi.fn().mockResolvedValue(CATALOG);

  beforeEach(() => {
    setAgentPermissions.mockClear();
    useAISettingsStore.setState({
      agentPermissions: {},
      permissionCatalog: CATALOG,
      loadPermissionCatalog,
      setAgentPermissions,
    });
    useChatStore.setState({
      _convStates: new Map([
        ['conv-a', { ...createEmptyConversationState(), permissions: { claude: 'plan' as const } }],
        ['conv-b', createEmptyConversationState()],
      ]),
    });
  });

  it('lists Claude Code modes by the names its status line shows', () => {
    render(
      <ChatPermissionPickers
        conversationId="conv-b"
        route={{ kind: 'cli', transport: 'claude-agent-sdk' }}
      />
    );
    const trigger = screen.getByTestId('chat-permission-mode-select');
    expect(trigger).toHaveAttribute('data-value', 'bypassPermissions');
    fireEvent.click(trigger);
    expect(optionNames()).toEqual([
      'Manual mode',
      'Accept edits',
      'Plan mode',
      'Bypass permissions',
      'Auto mode',
      "Don't ask",
    ]);
  });

  it('lists only the four Grok Build modes, by their Grok names', () => {
    render(
      <ChatPermissionPickers
        conversationId="conv-b"
        route={{ kind: 'cli', transport: 'grok-acp' }}
      />
    );
    const trigger = screen.getByTestId('chat-permission-mode-select');
    expect(trigger).toHaveAttribute('data-value', 'auto');
    fireEvent.click(trigger);
    expect(optionNames()).toEqual(['Normal', 'Plan', 'Auto-review', 'Always-Approve']);
  });

  it("gives Codex one dropdown matching Codex's own /permissions menu", () => {
    render(
      <ChatPermissionPickers
        conversationId="conv-b"
        route={{ kind: 'cli', transport: 'codex-sdk' }}
      />
    );
    const trigger = screen.getByTestId('chat-codex-permissions-select');
    expect(trigger).toHaveAttribute('data-value', ':danger-full-access');
    expect(trigger).toHaveTextContent('Full Access');
    fireEvent.click(trigger);
    expect(optionNames()).toEqual([
      'Ask for approval',
      'Approve for me',
      'Full Access',
      'Read Only',
      'lab',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'Ask for approval' }));
    expect(setAgentPermissions).toHaveBeenCalledWith({ codex: ':ask-for-approval' });
  });

  it('switches only this chat and the default for new chats', () => {
    render(
      <ChatPermissionPickers
        conversationId="conv-a"
        route={{ kind: 'cli', transport: 'claude-agent-sdk' }}
      />
    );
    const trigger = screen.getByTestId('chat-permission-mode-select');
    expect(trigger).toHaveAttribute('data-value', 'plan');

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: 'Manual mode' }));

    expect(useChatStore.getState()._convStates.get('conv-a')?.permissions?.claude).toBe('manual');
    expect(useChatStore.getState()._convStates.get('conv-b')?.permissions).toBeUndefined();
    expect(setAgentPermissions).toHaveBeenCalledWith({ claude: 'manual' });
  });

  it("shows the CLI's default when a chat's saved word is no longer offered", () => {
    useChatStore.setState({
      _convStates: new Map([
        ['conv-a', { ...createEmptyConversationState(), permissions: { claude: 'default' } }],
      ]),
    });
    render(
      <ChatPermissionPickers
        conversationId="conv-a"
        route={{ kind: 'cli', transport: 'claude-agent-sdk' }}
      />
    );
    expect(screen.getByTestId('chat-permission-mode-select')).toHaveAttribute(
      'data-value',
      'bypassPermissions'
    );
  });

  it('shows nothing for a direct API route', () => {
    const { container } = render(
      <ChatPermissionPickers
        conversationId="conv-b"
        route={{ kind: 'provider', provider: 'anthropic', model: 'claude-x' }}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing until the installed CLIs have been asked', () => {
    useAISettingsStore.setState({ permissionCatalog: null });
    const { container } = render(
      <ChatPermissionPickers
        conversationId="conv-b"
        route={{ kind: 'cli', transport: 'codex-sdk' }}
      />
    );
    expect(container).toBeEmptyDOMElement();
    expect(loadPermissionCatalog).toHaveBeenCalled();
  });
});
