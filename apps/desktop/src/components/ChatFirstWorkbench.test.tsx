import { installChatFirstHumanInputGuard } from '../lib/chat-first-input';
import { useAuthStore } from '../stores/auth-store';
import { getEffectiveHostedRouteReadiness } from '../features/ai/assistant-hosts';
import React from 'react';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { ChatFirstOutputBoundary, ChatFirstWorkbench } from './ChatFirstWorkbench';
vi.mock('../lib/chat-first-input', async (original) => ({
  ...(await original<typeof import('../lib/chat-first-input')>()),
  CHAT_FIRST_INPUT: true,
}));

it('keeps an existing notebook editor writable by programmatic operations while its output is in inspection mode', () => {
  const editor = new Editor({ extensions: [StarterKit], content: '<p>Initial observation</p>' });
  const mounted = render(
    <ChatFirstOutputBoundary conversation={false}>
      <div data-testid="notebook-host" />
    </ChatFirstOutputBoundary>
  );
  const host = screen.getByTestId('notebook-host');
  host.append(editor.view.dom);
  try {
    expect(host.parentElement?.getAttribute('data-ai-input-region')).toBe('output');
    expect(editor.isEditable).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Edit', exact: true }));
    expect(host.parentElement?.getAttribute('data-ai-input-region')).toBe('manual');
    fireEvent.click(screen.getByRole('button', { name: 'Done editing' }));
    act(() => {
      editor.commands.setContent('<p>Agent updated observation</p>');
    });
    expect(screen.getByText('Agent updated observation')).toBeTruthy();
    expect(host.parentElement?.getAttribute('data-ai-input-region')).toBe('output');
    mounted.rerender(
      <ChatFirstOutputBoundary conversation>
        <div data-testid="conversation" />
      </ChatFirstOutputBoundary>
    );
    expect(
      screen.getByTestId('conversation').parentElement?.getAttribute('data-ai-input-region')
    ).toBe('conversation');
  } finally {
    editor.destroy();
    mounted.unmount();
  }
});

it('resolves auth readiness without mounting the ordinary account button', async () => {
  const savedApi = window.electronAPI;
  const prior = useAuthStore.getState();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      auth: {
        onAuthStateChanged: () => () => {},
        getState: async () => ({ status: 'signed-out' }),
      },
    },
  });
  useAuthStore.setState({ initialized: false, hydrated: false, state: { status: 'signed-out' } });
  const mounted = render(
    <ChatFirstWorkbench onOpenChat={vi.fn()} onNewChat={vi.fn()}>
      <div />
    </ChatFirstWorkbench>
  );
  try {
    await waitFor(() => expect(useAuthStore.getState().hydrated).toBe(true));
    const current = useAuthStore.getState();
    expect(
      getEffectiveHostedRouteReadiness('checking', current.hydrated, current.state.status)
    ).toBe('needs-login');
  } finally {
    mounted.unmount();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: savedApi });
    useAuthStore.setState(prior);
  }
});

it('keeps essential Add actions reachable through a portalled menu under the input guard', async () => {
  const create = vi.fn();
  const dispose = installChatFirstHumanInputGuard(document);
  const mounted = render(
    <ChatFirstWorkbench
      onOpenChat={vi.fn()}
      onNewChat={vi.fn()}
      actions={[
        { id: 'notebook', label: 'New notebook…', onSelect: create },
        { id: 'import', label: 'Import file…', onSelect: vi.fn() },
      ]}
    >
      <div />
    </ChatFirstWorkbench>
  );
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Add', exact: true }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New notebook…' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
  } finally {
    mounted.unmount();
    dispose();
  }
});
