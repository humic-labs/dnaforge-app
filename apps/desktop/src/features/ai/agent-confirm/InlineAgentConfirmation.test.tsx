import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { destructiveApprovalCard, InlineAgentConfirmationHost } from './InlineAgentConfirmation';
import { AgentApprovalCard } from './AgentApprovalCard';
import type { DestructiveFileConfirmRequest } from '../../../shared/agent-confirm-types';
import { useDestructiveConfirmStore } from './destructive-confirm-store';
import { useToastStore } from '../../../stores/toast-store';

const mockRespond = vi.hoisted(() => vi.fn());

vi.mock('../../../platform', () => ({
  platform: () => ({ agentConfirm: { respond: mockRespond } }),
}));

const baseRequest: DestructiveFileConfirmRequest = {
  requestId: 'req-1',
  toolName: 'Write',
  operation: 'Overwrite file',
  resolvedPath: '/Users/me/workspace/design.gb',
};

function InlineAgentConfirmation({
  request,
  onAllow,
  onDeny,
}: {
  request: DestructiveFileConfirmRequest;
  onAllow: () => void;
  onDeny: () => void;
}) {
  return (
    <AgentApprovalCard
      requestId={request.requestId}
      {...destructiveApprovalCard(request)}
      onChoose={(choice) => (choice === 'deny' ? onDeny() : choice === 'once' ? onAllow() : null)}
    />
  );
}

describe('InlineAgentConfirmation', () => {
  afterEach(() => {
    cleanup();
    useDestructiveConfirmStore.getState().clear();
    useToastStore.getState().clearToasts();
    mockRespond.mockClear();
  });

  it('stays inline in chat instead of taking over the window as a modal', () => {
    render(
      <div data-testid="chat-flow">
        <InlineAgentConfirmation request={baseRequest} onAllow={vi.fn()} onDeny={vi.fn()} />
        <textarea aria-label="Chat composer" />
      </div>
    );

    const prompt = screen.getByTestId('agent-confirm-inline');
    expect(screen.getByTestId('chat-flow')).toContainElement(prompt);
    expect(prompt).not.toHaveClass('fixed', 'inset-0');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(prompt).not.toHaveAttribute('aria-modal');
    expect(screen.getByLabelText('Chat composer')).toBeEnabled();
  });

  it('shows the resolved path + operation + names the AGENT as the actor', () => {
    render(<InlineAgentConfirmation request={baseRequest} onAllow={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByTestId('agent-confirm-path')).toHaveTextContent(
      '/Users/me/workspace/design.gb'
    );
    expect(screen.getByTestId('agent-confirm-inline')).toHaveTextContent(/assistant/i);
    expect(screen.getByTestId('agent-confirm-inline')).toHaveTextContent(/overwrite file/i);
  });

  it('for Bash, shows the command AND the resolved cwd', () => {
    render(
      <InlineAgentConfirmation
        request={{
          requestId: 'r',
          toolName: 'Bash',
          operation: 'Run shell command',
          resolvedPath: '/Users/me/workspace',
          command: 'rm -rf build',
          risk: 'destructive',
          riskSummary: 'This command can delete files or directories.',
        }}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />
    );
    expect(screen.getByTestId('agent-confirm-inline')).toHaveTextContent('rm -rf build');
    expect(screen.getByTestId('agent-confirm-path')).toHaveTextContent('/Users/me/workspace');
    expect(screen.getByTestId('agent-confirm-inline')).toHaveTextContent(/can delete files/i);
    expect(screen.getByTestId('agent-confirm-inline')).not.toHaveTextContent(
      /this will change files that already exist/i
    );
  });

  it('shows ProcessStart through the same supervised shell approval UI', () => {
    const command = `node -e "setInterval(() => {}, 1000)"`;
    render(
      <InlineAgentConfirmation
        request={{
          requestId: 'r-process-start',
          toolName: 'ProcessStart',
          operation: 'Run shell command',
          resolvedPath: '/Users/me/workspace',
          command,
          risk: 'unknown',
          riskSummary: 'DNAForge could not prove whether this command changes files.',
        }}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />
    );

    expect(screen.getByTestId('agent-confirm-inline')).toHaveTextContent(
      'The assistant wants to run a command'
    );
    expect(screen.getByTestId('agent-confirm-command')).toHaveTextContent(command);
    expect(screen.getByTestId('agent-confirm-path')).toHaveTextContent('/Users/me/workspace');
    expect(screen.getByTestId('agent-confirm-allow')).toHaveTextContent('Allow once');
  });

  it('states that an always-ask read-only command does not modify files', () => {
    render(
      <InlineAgentConfirmation
        request={{
          requestId: 'r-read',
          toolName: 'Bash',
          operation: 'Run read-only shell command',
          resolvedPath: '/Users/me/workspace',
          command: 'curl -s https://example.test',
          risk: 'read-only',
          riskSummary: 'This command reads data and does not modify files.',
        }}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />
    );
    expect(screen.getByTestId('agent-confirm-inline')).toHaveTextContent(
      /reads data and does not modify files/i
    );
    expect(screen.getByTestId('agent-confirm-allow')).toHaveTextContent(/allow once/i);
    expect(screen.getByTestId('agent-confirm-deny')).toHaveTextContent(/deny/i);
  });

  it('does not invent file-change claims for an unknown shell command', () => {
    render(
      <InlineAgentConfirmation
        request={{
          requestId: 'r-unknown',
          toolName: 'Bash',
          operation: 'Run shell command',
          resolvedPath: '/Users/me/workspace',
          command: 'custom-tool --opaque-mode',
          risk: 'unknown',
          riskSummary: 'DNAForge could not prove whether this command changes files.',
        }}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />
    );
    expect(screen.getByTestId('agent-confirm-inline')).toHaveTextContent(
      /could not prove whether this command changes files/i
    );
    expect(screen.getByTestId('agent-confirm-inline')).not.toHaveTextContent(
      /this will change files that already exist/i
    );
  });

  it('does not capture global Escape or Enter intended for the chat', () => {
    const onAllow = vi.fn();
    const onDeny = vi.fn();
    render(<InlineAgentConfirmation request={baseRequest} onAllow={onAllow} onDeny={onDeny} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onDeny).not.toHaveBeenCalled();
    expect(onAllow).not.toHaveBeenCalled();
  });

  it('does not resolve on window blur (the main-process timeout remains the fail-closed backstop)', () => {
    const onAllow = vi.fn();
    const onDeny = vi.fn();
    render(<InlineAgentConfirmation request={baseRequest} onAllow={onAllow} onDeny={onDeny} />);
    fireEvent.blur(window);
    expect(onDeny).not.toHaveBeenCalled();
    expect(onAllow).not.toHaveBeenCalled();
  });

  it('allows only through an explicit allow choice', () => {
    const onAllow = vi.fn();
    const onDeny = vi.fn();
    render(<InlineAgentConfirmation request={baseRequest} onAllow={onAllow} onDeny={onDeny} />);
    fireEvent.click(screen.getByTestId('agent-confirm-deny'));
    expect(onDeny).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('agent-confirm-allow'));
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  it('offers the five choices in order and names what Always allow covers', () => {
    render(
      <InlineAgentConfirmation
        request={{ ...baseRequest, rule: { key: 'write:/w', label: 'changes in My Project' } }}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />
    );
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      expect.stringContaining('Allow once'),
      expect.stringContaining('Allow for this chat'),
      expect.stringContaining('Always allow'),
      expect.stringContaining('Deny'),
      expect.stringContaining('Stop turn'),
    ]);
    expect(screen.getByTestId('agent-approval-choice-always')).toHaveTextContent(
      'changes in My Project'
    );
  });

  it('answers through the host with the chosen option', () => {
    useDestructiveConfirmStore.getState().present({ ...baseRequest, requestId: 'host-choice' });
    render(<InlineAgentConfirmationHost conversationId={null} scoped={false} isActive />);
    fireEvent.click(screen.getByTestId('agent-approval-choice-chat'));
    expect(mockRespond).toHaveBeenCalledWith('host-choice', { allow: true, choice: 'chat' });
  });

  it('keeps an owned request in its own chat when the docked chat is retargeted', () => {
    useDestructiveConfirmStore.getState().present({
      ...baseRequest,
      requestId: 'retargeted-request',
      conversationId: 'conversation-before-retarget',
    });

    const view = render(
      <>
        <InlineAgentConfirmationHost
          conversationId="conversation-before-retarget"
          scoped={false}
          isActive={false}
        />
        <InlineAgentConfirmationHost
          conversationId="conversation-after-retarget"
          scoped={false}
          isActive
        />
      </>
    );

    expect(screen.queryByTestId('agent-confirm-inline')).toBeNull();
    expect(mockRespond).not.toHaveBeenCalled();
    expect(useDestructiveConfirmStore.getState().request?.requestId).toBe('retargeted-request');

    view.rerender(
      <>
        <InlineAgentConfirmationHost
          conversationId="conversation-before-retarget"
          scoped={false}
          isActive
        />
        <InlineAgentConfirmationHost
          conversationId="conversation-after-retarget"
          scoped={false}
          isActive={false}
        />
      </>
    );

    expect(screen.getAllByTestId('agent-confirm-inline')).toHaveLength(1);
    expect(screen.queryByText(/started in another chat/i)).toBeNull();
    expect(screen.getByTestId('agent-confirm-allow')).toBeEnabled();
    expect(screen.getByTestId('agent-confirm-deny')).toBeEnabled();
  });

  it('prefers the visible owning chat over a focused fallback without duplicating controls', () => {
    useDestructiveConfirmStore.getState().present({
      ...baseRequest,
      requestId: 'scoped-owner-request',
      conversationId: 'scoped-owner',
    });

    render(
      <>
        <InlineAgentConfirmationHost conversationId="scoped-owner" scoped isActive />
        <InlineAgentConfirmationHost conversationId="focused-docked-chat" scoped={false} isActive />
      </>
    );

    expect(screen.getAllByTestId('agent-confirm-inline')).toHaveLength(1);
    expect(screen.queryByText(/started in another chat/i)).toBeNull();
  });

  it('keeps a pending request unresolved when its mounted chat merely loses focus', async () => {
    useDestructiveConfirmStore.getState().present({
      ...baseRequest,
      requestId: 'unfocused-chat-request',
      conversationId: 'conversation-still-open',
    });
    const view = render(
      <InlineAgentConfirmationHost
        conversationId="conversation-still-open"
        scoped={false}
        isActive
      />
    );

    view.rerender(
      <InlineAgentConfirmationHost
        conversationId="conversation-still-open"
        scoped={false}
        isActive={false}
      />
    );

    await Promise.resolve();
    expect(screen.queryByTestId('agent-confirm-inline')).toBeNull();
    expect(mockRespond).not.toHaveBeenCalled();
    expect(useDestructiveConfirmStore.getState().request?.requestId).toBe('unfocused-chat-request');
  });

  it('denies promptly with a visible explanation when the last inline chat closes', async () => {
    useDestructiveConfirmStore.getState().present({
      ...baseRequest,
      requestId: 'closed-chat-request',
      conversationId: 'conversation-being-closed',
    });
    const view = render(
      <InlineAgentConfirmationHost
        conversationId="conversation-being-closed"
        scoped={false}
        isActive
      />
    );

    view.unmount();

    await waitFor(() => {
      expect(mockRespond).toHaveBeenCalledWith('closed-chat-request', {
        allow: false,
        choice: 'deny',
      });
    });
    expect(useDestructiveConfirmStore.getState().request).toBeNull();
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      type: 'warning',
      message: 'Agent request denied because its chat was closed.',
    });
  });
});
