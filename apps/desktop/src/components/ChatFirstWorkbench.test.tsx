import { useAuthStore } from '../stores/auth-store';
import { getEffectiveHostedRouteReadiness } from '../features/ai/assistant-hosts';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ChatFirstOutputBoundary, ChatFirstWorkbench } from './ChatFirstWorkbench';
vi.mock('../lib/chat-first-input', async (original) => ({
  ...(await original<typeof import('../lib/chat-first-input')>()),
  CHAT_FIRST_INPUT: true,
}));

const workbenchProps = {
  projectName: 'Synthetic project',
  projectPickerOpen: false,
  onOpenProjects: vi.fn(),
  onOpenChat: vi.fn(),
  onBrowseFiles: vi.fn(),
  onImport: vi.fn(),
  documentActions: [],
};

it('leaves native editor controls and keyboard input available in the document pane', () => {
  const edit = vi.fn();
  render(
    <ChatFirstOutputBoundary conversation={false}>
      <button onClick={edit}>Save now</button>
      <textarea aria-label="Notes" />
    </ChatFirstOutputBoundary>
  );
  const notes = screen.getByRole('textbox', { name: 'Notes' });
  expect(notes.closest('[data-ai-input-region]')?.getAttribute('data-ai-input-region')).toBe(
    'manual'
  );
  fireEvent.change(notes, { target: { value: 'Edited observation' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save now' }));
  expect(notes).toHaveValue('Edited observation');
  expect(edit).toHaveBeenCalledOnce();
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
    <ChatFirstWorkbench {...workbenchProps}>
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

it('keeps project switching and document creation separate', async () => {
  const create = vi.fn();
  const openProjects = vi.fn();
  const mounted = render(
    <ChatFirstWorkbench
      {...workbenchProps}
      onOpenProjects={openProjects}
      documentActions={[{ id: 'notebook', label: 'New notebook…', onSelect: create }]}
    >
      <div />
    </ChatFirstWorkbench>
  );
  try {
    fireEvent.click(screen.getByRole('button', { name: /switch project/i }));
    expect(openProjects).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'New document', exact: true }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New notebook…' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
  } finally {
    mounted.unmount();
  }
});
