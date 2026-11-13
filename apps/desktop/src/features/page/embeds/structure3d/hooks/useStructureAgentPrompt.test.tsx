import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useStructureAgentPrompt } from './useStructureAgentPrompt';
import { useCanvasStore } from '../../../../canvas/public/store';

const ask = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../../../ai/public/ask-ai-about-structure-view', () => ({
  askAiAboutStructureView: ask,
}));

function Viewer({ id, selected = 0 }: { id: string; selected?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useStructureAgentPrompt({
    rootRef: ref,
    structureViewId: id,
    attrs: { source: 'pdb', sourceId: '6KX1' },
    selectedCount: selected,
    selectionInput: null,
    workspaceRoot: null,
    enabled: true,
  });
  return <div ref={ref} data-testid={id} data-structure-agent-host={id} />;
}

beforeEach(() => {
  ask.mockClear();
  useCanvasStore.setState({ focusedPanelId: 'protein-pane' });
  const rectangles = [new DOMRect(0, 0, 300, 200)];
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue(
    Object.assign(rectangles, { item: (index: number) => rectangles[index] ?? null })
  );
});

it('opens the normal agent picker from the active protein pane without a selection', async () => {
  render(
    <div data-panel-content="protein-pane">
      <Viewer id="view-1" />
    </div>
  );
  fireEvent.pointerDown(screen.getByTestId('view-1'));
  await act(async () => {
    fireEvent.keyDown(document, { key: '/' });
  });
  expect(ask).toHaveBeenCalledOnce();
  expect(ask).toHaveBeenCalledWith(
    expect.objectContaining({
      structureViewId: 'view-1',
      selection: null,
      sourcePanelId: 'protein-pane',
    })
  );
});

it('routes only the last touched visible viewer and leaves typing alone', async () => {
  render(
    <div data-panel-content="protein-pane">
      <Viewer id="view-1" />
      <Viewer id="view-2" />
      <input aria-label="Question" />
    </div>
  );
  fireEvent.pointerDown(screen.getByTestId('view-2'));
  await act(async () => {
    fireEvent.keyDown(document, { key: '/' });
  });
  expect(ask).toHaveBeenCalledOnce();
  expect(ask).toHaveBeenCalledWith(expect.objectContaining({ structureViewId: 'view-2' }));
  ask.mockClear();
  screen.getByRole('textbox', { name: 'Question' }).focus();
  await act(async () => {
    fireEvent.keyDown(document, { key: '/' });
  });
  expect(ask).not.toHaveBeenCalled();
});

it('does not silently discard a selection whose residue identities are unresolved', async () => {
  render(
    <div data-panel-content="protein-pane">
      <Viewer id="view-1" selected={3} />
    </div>
  );
  fireEvent.pointerDown(screen.getByTestId('view-1'));
  await act(async () => {
    fireEvent.keyDown(document, { key: '/' });
  });
  expect(ask).not.toHaveBeenCalled();
});

it('claims the active protein shortcut before an older sequence-view listener', async () => {
  const sequenceAsk = vi.fn();
  const olderListener = (event: KeyboardEvent) => {
    if (event.key === '/' && !event.defaultPrevented) {
      event.preventDefault();
      sequenceAsk();
    }
  };
  document.addEventListener('keydown', olderListener);
  try {
    render(
      <div data-panel-content="protein-pane">
        <Viewer id="view-1" />
      </div>
    );
    fireEvent.pointerDown(screen.getByTestId('view-1'));
    await act(async () => {
      fireEvent.keyDown(document, { key: '/' });
    });
    expect(ask).toHaveBeenCalledOnce();
    expect(sequenceAsk).not.toHaveBeenCalled();
  } finally {
    document.removeEventListener('keydown', olderListener);
  }
});
