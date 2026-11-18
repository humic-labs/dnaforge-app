import { useState } from 'react';
import { EditorView } from '@codemirror/view';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { CodeEditor } from '../../../components/CodeEditor';
import { CommandScopeProvider } from '../../../commands/CommandScopeProvider';
import { installPresentationInput } from '../../../presentation/browser-input';
import { useCanvasStore } from '../store';
import type { Tab } from '../types';
import { CanvasLayout } from './CanvasLayout';

vi.mock('./PanelContent', () => ({
  PanelContent: ({ tab }: { tab: Tab }) => <DocumentEditor tab={tab} />,
}));
vi.mock('../../page/public/embeds/structure3d/molstar/cache', () => ({
  getPaneRendererHostCacheKey: (key: string) => key,
  acquireCachedViewerLease: vi.fn(),
  releaseCachedViewerLease: vi.fn(),
}));
vi.mock('../../../lib/workflow-telemetry', () => ({ observeWorkflowAction: vi.fn() }));
vi.mock('@waypoint/genome-renderer/react', async () => ({
  HiddenMapIdlePolicyContext: (await import('react')).createContext('host-retained'),
}));
vi.mock('../../memory-pressure/public', async (original) => ({
  ...(await original<typeof import('../../memory-pressure/public')>()),
  useMemoryPressureMonitoring: vi.fn(),
}));

function DocumentEditor({ tab }: { tab: Tab }) {
  const [value, setValue] = useState(`Document: ${tab.label}`);
  const [wordWrap, setWordWrap] = useState(true);
  return (
    <div>
      <button type="button" onClick={() => setWordWrap((enabled) => !enabled)}>
        Toggle word wrap
      </button>
      <CodeEditor
        value={value}
        onChange={setValue}
        language="plaintext"
        darkMode={false}
        showLineNumbers
        wordWrap={wordWrap}
        ariaLabel={tab.label}
      />
      <span data-testid="document-status">{value.length} characters</span>
    </div>
  );
}

function press(target: HTMLElement, reverse = false) {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    code: 'Tab',
    ctrlKey: true,
    shiftKey: reverse,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
}

function click(target: HTMLElement) {
  fireEvent.pointerDown(target);
  fireEvent.mouseDown(target);
  fireEvent.mouseUp(target);
  fireEvent.click(target);
}

const rangeClientRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [new DOMRect(0, 0, 100, 20)],
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  if (rangeClientRects) Object.defineProperty(Range.prototype, 'getClientRects', rangeClientRects);
  else Reflect.deleteProperty(Range.prototype, 'getClientRects');
});
beforeEach(() => useCanvasStore.getState().reset());
afterEach(() => {
  cleanup();
  useCanvasStore.getState().reset();
});

it.each(['vertical', 'horizontal'] as const)(
  'cycles tabs in the clicked %s pane from a real code editor and retains both documents',
  (direction) => {
    const store = useCanvasStore.getState();
    const left = ['left-one.txt', 'left-two.txt'].map((label) =>
      store.openTab('main', { type: 'text', entityId: `/pane-shortcuts/${label}`, label })
    );
    const rightPanel = store.splitPanel('main', direction);
    const right = ['right-one.txt', 'right-two.txt'].map((label) =>
      store.openTab(rightPanel, { type: 'text', entityId: `/pane-shortcuts/${label}`, label })
    );
    store.focusPanel('main');
    const dispose = installPresentationInput(document);
    try {
      render(
        <CommandScopeProvider>
          <CanvasLayout />
        </CommandScopeProvider>
      );
      const leftPane = screen
        .getAllByTestId('panel-main')
        .find((element) => element.hasAttribute('data-panel-focused'))!;
      const rightPane = screen
        .getAllByTestId(`panel-${rightPanel}`)
        .find((element) => element.hasAttribute('data-panel-focused'))!;
      const rightEditor = within(rightPane).getByRole('textbox', { name: 'right-two.txt' });
      click(rightEditor);
      act(() => rightEditor.focus());

      expect(rightPane).toHaveAttribute('data-panel-focused', 'true');
      expect(rightEditor).toHaveFocus();
      press(rightEditor);
      expect(within(rightPane).getByTestId(`tab-${right[0]}`)).toHaveAttribute(
        'aria-selected',
        'true'
      );
      expect(within(leftPane).getByTestId(`tab-${left[1]}`)).toHaveAttribute(
        'aria-selected',
        'true'
      );
      const firstRightEditor = within(rightPane).getByRole('textbox', { name: 'right-one.txt' });
      act(() => firstRightEditor.focus());
      press(firstRightEditor, true);
      expect(within(rightPane).getByRole('textbox', { name: 'right-two.txt' })).toBe(rightEditor);
      expect(rightEditor).toHaveTextContent('Document: right-two.txt');

      const leftStatus = within(leftPane).getByTestId('document-status');
      click(leftStatus);
      expect(leftPane).toHaveAttribute('data-panel-focused', 'true');
      press(leftStatus, true);
      expect(within(leftPane).getByTestId(`tab-${left[0]}`)).toHaveAttribute(
        'aria-selected',
        'true'
      );
      press(within(leftPane).getByTestId('document-status'));
      expect(within(leftPane).getByTestId(`tab-${left[1]}`)).toHaveAttribute(
        'aria-selected',
        'true'
      );

      const wrap = within(rightPane).getByRole('button', { name: 'Toggle word wrap' });
      click(wrap);
      expect(rightPane).toHaveAttribute('data-panel-focused', 'true');
      press(wrap);
      expect(within(rightPane).getByTestId(`tab-${right[0]}`)).toHaveAttribute(
        'aria-selected',
        'true'
      );

      const leftEditor = within(leftPane).getByRole('textbox', { name: 'left-two.txt' });
      click(leftEditor);
      act(() => leftEditor.focus());
      expect(leftPane).toHaveAttribute('data-panel-focused', 'true');
      expect(leftEditor).toHaveFocus();
      const view = EditorView.findFromDOM(leftEditor)!;
      act(() => {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: 'Editing still works' },
        });
      });
      expect(leftEditor).toHaveTextContent('Editing still works');
      expect(within(rightPane).getByRole('textbox', { name: 'right-one.txt' })).toHaveTextContent(
        'Document: right-one.txt'
      );
      expect(within(leftPane).getByTestId('document-status')).toHaveTextContent('19 characters');
    } finally {
      dispose();
    }
  }
);
