/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProteinSequenceContextMenu } from './ProteinSequenceContextMenu';

afterEach(cleanup);

function renderMenu(overrides: Partial<ComponentProps<typeof ProteinSequenceContextMenu>> = {}) {
  const props = {
    x: 10,
    y: 10,
    isOpen: true,
    onClose: vi.fn(),
    hasSelection: false,
    onCopySequence: vi.fn(),
    onBacktranslate: vi.fn(),
    onAskAI: vi.fn(),
    onViewStructure: vi.fn(),
    onPredictStructure: vi.fn(),
    ...overrides,
  };
  render(<ProteinSequenceContextMenu {...props} />);
  return props;
}

describe('ProteinSequenceContextMenu', () => {
  it('renders nothing when closed', () => {
    renderMenu({ isOpen: false });
    expect(screen.queryByTestId('protein-sequence-context-menu')).toBeNull();
  });

  it('shows the five actions when open', () => {
    renderMenu();
    expect(screen.getByTestId('protein-menu-copy-sequence')).toBeTruthy();
    expect(screen.getByTestId('protein-menu-backtranslate')).toBeTruthy();
    expect(screen.getByTestId('protein-menu-view-structure')).toBeTruthy();
    expect(screen.getByTestId('protein-menu-ask-ai')).toBeTruthy();
    expect(screen.getByTestId('protein-menu-predict-structure').textContent).toBe(
      'Predict Structure…'
    );
  });

  it('keeps copy available while readonly legacy data has no scientific or reference actions', () => {
    const props = renderMenu({ readOnly: true });
    for (const action of ['backtranslate', 'view-structure', 'predict-structure', 'ask-ai'])
      expect(screen.queryByTestId(`protein-menu-${action}`)).toBeNull();
    fireEvent.click(screen.getByTestId('protein-menu-copy-sequence'));
    expect(props.onCopySequence).toHaveBeenCalledTimes(1);
  });

  it('labels actions as scoped to "Selection" when hasSelection is true', () => {
    renderMenu({ hasSelection: true });
    expect(screen.getByTestId('protein-menu-copy-sequence').textContent).toBe('Copy Selection');
  });

  it('labels actions as scoped to "Sequence" when nothing is selected', () => {
    renderMenu({ hasSelection: false });
    expect(screen.getByTestId('protein-menu-copy-sequence').textContent).toBe('Copy Sequence');
  });

  it('clicking an item fires the action AND closes the menu', () => {
    const props = renderMenu();
    fireEvent.click(screen.getByTestId('protein-menu-backtranslate'));
    expect(props.onBacktranslate).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the menu', () => {
    const props = renderMenu();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking outside the menu closes it', () => {
    const props = renderMenu();
    fireEvent.mouseDown(document.body);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
  it('Predict Structure calls its handler', () => {
    const props = renderMenu();
    fireEvent.click(screen.getByTestId('protein-menu-predict-structure'));
    expect(props.onPredictStructure).toHaveBeenCalledTimes(1);
  });
});
