import { presentationOwner } from '../../presentation/ownership';
import { WorkspaceCommandProvider as CommandScopeProvider } from '../../test/document-save-commands';
import { webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./telemetry', () => ({
  claimPdfRead: () => ({ emit: () => true, cancel: () => {} }),
  subscribePdfRead: () => () => {},
}));
vi.mock('../../platform', () => ({
  platform: () => ({ fs: { readFile: async () => new Uint8Array([37, 80, 68, 70]) } }),
}));
vi.mock('./usePdfSourceWatcher', () => ({ usePdfSourceWatcher: () => {} }));
vi.mock('./runtime', () => ({
  beginPdfLoad: () => ({
    result: Promise.resolve({ numPages: 2 }),
    workerFailure: new Promise(() => {}),
    destroy: async () => {},
  }),
}));
vi.mock('./PdfPage', () => ({ PdfPage: () => null }));
vi.mock('../ai/hooks/useChat', () => ({ useChatStore: { getState: () => ({}) } }));

import { COMMAND_IDS, COMMAND_SCOPES, useCommandHandler, useCommandScope } from '../../commands';
import { useAppShortcutActions } from '../../keyboard/useAppShortcutActions';
import { useCanvasStore } from '../canvas/public/store';
import { PdfTab } from './PdfTab';

function AppShortcuts() {
  useAppShortcutActions(() => {});
  return null;
}

function SidebarFocus() {
  const scope = useCommandScope(COMMAND_SCOPES.sidebarFileTree);
  return <button {...scope.eventHandlers}>Files</button>;
}

function ResetProbe({ onReset }: { onReset: () => void }) {
  useCommandScope(COMMAND_SCOPES.tabPdf, { claimOnMount: true });
  useCommandHandler(COMMAND_IDS.pdfResetZoom, onReset, { scope: COMMAND_SCOPES.tabPdf });
  return null;
}

function press(key: string, target: EventTarget = document.body) {
  return fireEvent.keyDown(target, {
    key,
    ...(/Mac|iPhone|iPad/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
  });
}

function openPdf(panelId = 'main', name = 'first.pdf') {
  return useCanvasStore.getState().openTab(panelId, {
    type: 'pdf',
    entityId: `/workspace/${name}`,
    label: name,
  });
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  useCanvasStore.getState().reset();
});

afterEach(() => vi.unstubAllGlobals());

describe('PDF zoom command ownership', () => {
  it('zooms in when a shifted equals shortcut retains its physical key value', async () => {
    const tabId = openPdf();
    render(
      <CommandScopeProvider>
        <PdfTab filePath="/workspace/first.pdf" tabId={tabId} />
      </CommandScopeProvider>
    );
    await screen.findByTestId('pdf-tab');
    fireEvent.keyDown(document.body, {
      key: '=',
      code: 'Equal',
      shiftKey: true,
      ...(/Mac|iPhone|iPad/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
    });
    expect(screen.getByText('120%')).toBeVisible();
  });

  it('clamps keyboard zoom to toolbar limits and consumes shortcuts at either limit', async () => {
    const tabId = openPdf();
    render(
      <CommandScopeProvider>
        <PdfTab filePath="/workspace/first.pdf" tabId={tabId} />
      </CommandScopeProvider>
    );
    await screen.findByTestId('pdf-tab');
    for (let index = 0; index < 20; index += 1) expect(press('=')).toBe(false);
    expect(screen.getByText('250%')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Zoom in', exact: true })).toBeDisabled();
    for (let index = 0; index < 20; index += 1) expect(press('-')).toBe(false);
    expect(screen.getByText('50%')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Zoom out', exact: true })).toBeDisabled();
  });

  it('leaves an inactive PDF unchanged', async () => {
    const tabId = openPdf();
    render(
      <CommandScopeProvider>
        <PdfTab filePath="/workspace/first.pdf" tabId={tabId} isActive={false} />
      </CommandScopeProvider>
    );
    await screen.findByTestId('pdf-tab');
    expect(press('=')).toBe(true);
    expect(screen.getByText('100%')).toBeVisible();
  });

  it('reclaims keyboard zoom after returning from the file tree', async () => {
    const tabId = openPdf();
    render(
      <CommandScopeProvider>
        <SidebarFocus />
        <PdfTab filePath="/workspace/first.pdf" tabId={tabId} />
      </CommandScopeProvider>
    );
    await screen.findByTestId('pdf-tab');
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Files' }));
    press('=');
    expect(screen.getByText('100%')).toBeVisible();
    fireEvent.mouseDown(screen.getByTestId('pdf-viewport'));
    press('=');
    expect(screen.getByText('120%')).toBeVisible();
  });

  it('zooms only the focused active PDF across split panels', async () => {
    const first = openPdf();
    const right = useCanvasStore.getState().splitPanel('main', 'vertical');
    const second = openPdf(right, 'second.pdf');
    useCanvasStore.getState().focusPanel('main');
    render(
      <CommandScopeProvider>
        <PdfTab filePath="/workspace/first.pdf" tabId={first} />
        <PdfTab filePath="/workspace/second.pdf" tabId={second} />
      </CommandScopeProvider>
    );
    await waitFor(() => expect(screen.getAllByTestId('pdf-tab')).toHaveLength(2));
    const [firstPdf, secondPdf] = screen
      .getAllByTestId('pdf-tab')
      .map((element) => within(element));
    press('=');
    expect(firstPdf.getByText('120%')).toBeVisible();
    expect(secondPdf.getByText('100%')).toBeVisible();
    act(() => useCanvasStore.getState().focusPanel(right));
    press('=');
    expect(firstPdf.getByText('120%')).toBeVisible();
    expect(secondPdf.getByText('120%')).toBeVisible();
  });

  it('resets the PDF without selecting the last tab or dispatching either zoom twice', async () => {
    const first = openPdf();
    openPdf('main', 'second.pdf');
    useCanvasStore.getState().setActiveTab('main', first);
    render(
      <CommandScopeProvider>
        <AppShortcuts />
        <PdfTab filePath="/workspace/first.pdf" tabId={first} />
      </CommandScopeProvider>
    );
    await screen.findByTestId('pdf-tab');
    press('=');
    expect(screen.getByText('120%')).toBeVisible();
    press('0');
    expect(screen.getByText('100%')).toBeVisible();
    expect(useCanvasStore.getState().panels.main.activeTabId).toBe(first);
  });

  it('retains the last-tab shortcut outside PDFs', () => {
    const first = useCanvasStore.getState().openTab('main', {
      type: 'text',
      entityId: '/workspace/first.txt',
      label: 'first.txt',
    });
    const last = useCanvasStore.getState().openTab('main', {
      type: 'text',
      entityId: '/workspace/second.txt',
      label: 'second.txt',
    });
    useCanvasStore.getState().setActiveTab('main', first);
    render(
      <CommandScopeProvider>
        <AppShortcuts />
      </CommandScopeProvider>
    );
    press('0');
    expect(useCanvasStore.getState().panels.main.activeTabId).toBe(last);
  });

  it.each([false, true])('dispatches reset once when global shortcuts mount later: %s', (later) => {
    const onReset = vi.fn();
    const view = render(
      <CommandScopeProvider>
        <ResetProbe onReset={onReset} />
        {!later && <AppShortcuts />}
      </CommandScopeProvider>
    );
    if (later) {
      view.rerender(
        <CommandScopeProvider>
          <ResetProbe onReset={onReset} />
          <AppShortcuts />
        </CommandScopeProvider>
      );
    }
    press('0');
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it.each(['input', 'textarea', 'editable', 'terminal', 'modal'])(
    'does not zoom or reset through a %s surface',
    async (surface) => {
      const tabId = openPdf();
      render(
        <CommandScopeProvider>
          <AppShortcuts />
          <PdfTab filePath="/workspace/first.pdf" tabId={tabId} />
        </CommandScopeProvider>
      );
      await screen.findByTestId('pdf-tab');
      press('=');
      expect(screen.getByText('120%')).toBeVisible();
      const target = document.createElement(
        surface === 'input' || surface === 'textarea' ? surface : 'div'
      );
      if (surface === 'editable') target.setAttribute('contenteditable', 'true');
      if (surface === 'terminal') target.setAttribute('data-terminal-surface', '');
      if (surface === 'modal') {
        target.setAttribute('aria-modal', 'true');
        presentationOwner.dispatch({
          type: 'attach',
          id: 'test-modal',
          parentId: 'workspace',
          active: true,
          capture: 'modal',
        });
      }
      document.body.append(target);
      try {
        press('=', target);
        press('0', target);
        expect(screen.getByText('120%')).toBeVisible();
      } finally {
        if (surface === 'modal') presentationOwner.dispatch({ type: 'dispose', id: 'test-modal' });
        target.remove();
      }
    }
  );
});
