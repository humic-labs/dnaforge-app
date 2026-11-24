import { useAuthStore } from '../stores/auth-store';
import { getEffectiveHostedRouteReadiness } from '../features/ai/assistant-hosts';
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { AiOnlyOutputBoundary, AiOnlyWorkbench } from './AiOnlyWorkbench';

it('keeps an existing notebook editor writable by programmatic operations while its output is inert', () => {
  const editor = new Editor({ extensions: [StarterKit], content: '<p>Initial observation</p>' });
  const mounted = render(
    <AiOnlyOutputBoundary conversation={false}>
      <div data-testid="notebook-host" />
    </AiOnlyOutputBoundary>
  );
  const host = screen.getByTestId('notebook-host');
  host.append(editor.view.dom);
  try {
    expect(host.parentElement?.inert).toBe(true);
    expect(editor.isEditable).toBe(true);
    act(() => {
      editor.commands.setContent('<p>Agent updated observation</p>');
    });
    expect(screen.getByText('Agent updated observation')).toBeTruthy();
    expect(host.parentElement?.inert).toBe(true);
    mounted.rerender(
      <AiOnlyOutputBoundary conversation>
        <div data-testid="conversation" />
      </AiOnlyOutputBoundary>
    );
    expect(screen.getByTestId('conversation').parentElement?.inert).toBe(false);
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
    <AiOnlyWorkbench onOpenChat={vi.fn()} onNewChat={vi.fn()}>
      <div />
    </AiOnlyWorkbench>
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
