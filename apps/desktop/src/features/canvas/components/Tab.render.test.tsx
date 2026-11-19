/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Tab, getTabIconForTab } from './Tab';
import { projectTabStripTab } from '../tab-menu-presentation';
import type { Tab as TabData } from '../types';
import { consumeSequenceTabCloseGesture } from '../../../shared/tab-close-gesture';

vi.mock('../dragStore', () => ({
  useDragStore: (selector: (state: unknown) => unknown) =>
    selector({
      isDragging: false,
      dropTargetPanelId: null,
      dropInsertIndex: null,
      dragTabId: null,
      startDrag: vi.fn(),
    }),
}));

function makeTab(overrides: Partial<TabData> = {}): TabData {
  return {
    id: 't1',
    type: 'page',
    entityId: 'p1',
    label: 'Page',
    ...overrides,
  };
}

function renderTab(overrides: Partial<TabData> = {}, props: Record<string, unknown> = {}) {
  const tab = makeTab(overrides);
  return render(
    <Tab
      tab={projectTabStripTab(tab)}
      panelId="main"
      index={0}
      isActive={false}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />
  );
}

describe('Tab — unsaved-edits indicator ', () => {
  afterEach(() => cleanup());

  it('renders a neutral (fg-muted) dirty dot — NOT the accent green', () => {
    renderTab({ isDirty: true });
    const dot = screen.getByTestId('tab-dirty-t1');
    expect(dot.className).toContain('bg-fg-muted');

    expect(dot.className).not.toContain('bg-accent');
  });

  it('does not render the dirty dot for a clean tab', () => {
    renderTab({ isDirty: false });
    expect(screen.queryByTestId('tab-dirty-t1')).toBeNull();
  });

  it('keeps the close button in the same slot as the dirty dot (no extra width)', () => {
    renderTab({ isDirty: true });
    const dot = screen.getByTestId('tab-dirty-t1');
    const closeBtn = screen.getByTestId('tab-close-t1');

    expect(dot.parentElement).toBe(closeBtn.parentElement);
  });

  it('still exposes a working close button', () => {
    const onClose = vi.fn();
    renderTab({ isDirty: true }, { onClose });
    fireEvent.click(screen.getByTestId('tab-close-t1'));
    expect(onClose).toHaveBeenCalledWith('t1');
  });

  it('does not publish a sequence close token before the owner commits the close', () => {
    const onClose = vi.fn();
    renderTab({ id: 'sequence-tab', type: 'sequence' }, { onClose });

    fireEvent.click(screen.getByTestId('tab-close-sequence-tab'));

    expect(onClose).toHaveBeenCalledWith('sequence-tab');
    expect(consumeSequenceTabCloseGesture('sequence-tab')).toBeUndefined();
  });

  it('does not render the indicator while the tab is being renamed', () => {
    renderTab({ isDirty: true }, { isEditing: true });
    expect(screen.queryByTestId('tab-dirty-t1')).toBeNull();
    expect(screen.queryByTestId('tab-close-t1')).toBeNull();
  });

  it('the dirty dot is non-interactive (pointer-events-none) so it cannot block the × click', () => {
    renderTab({ isDirty: true });
    expect(screen.getByTestId('tab-dirty-t1').className).toContain('pointer-events-none');
  });

  it('exposes the dirty state to assistive tech (role=img + aria-label)', () => {
    renderTab({ isDirty: true });
    const dot = screen.getByTestId('tab-dirty-t1');
    expect(dot.getAttribute('role')).toBe('img');
    expect(dot.getAttribute('aria-label')).toBe('Unsaved changes');
  });

  it('the dirty dot fades out on hover so the × can take over', () => {
    renderTab({ isDirty: true });
    expect(screen.getByTestId('tab-dirty-t1').className).toContain('group-hover:opacity-0');
  });

  it('dirty tab: × hidden at rest, revealed on hover', () => {
    renderTab({ isDirty: true }, { isActive: true });
    const btn = screen.getByTestId('tab-close-t1').className;
    expect(btn).toContain('opacity-0');
    expect(btn).toContain('group-hover:opacity-100');
  });

  it('clean active tab: × shown at rest', () => {
    renderTab({ isDirty: false }, { isActive: true });
    expect(screen.getByTestId('tab-close-t1').className).toContain('opacity-60');
  });

  it('clean inactive tab: × revealed only on hover', () => {
    renderTab({ isDirty: false }, { isActive: false });
    const btn = screen.getByTestId('tab-close-t1').className;
    expect(btn).toContain('opacity-0');
    expect(btn).toContain('group-hover:opacity-60');
  });
});

describe('Tab — icon per tab type ', () => {
  afterEach(cleanup);

  it('keeps the indexed-sequence icon for a presentation caller', () => {
    const tab = makeTab({
      type: 'sequence',
      sequenceDocument: { kind: 'indexed-sequence', documentId: 'assembly:grch38' },
    });
    render(getTabIconForTab(projectTabStripTab(tab)));
    expect(document.querySelector('[data-icon="genome-assembly"]')).toBeInTheDocument();
    expect(document.querySelector('[data-icon="biology-file"]')).not.toBeInTheDocument();
  });

  it.each(['chat', 'page', 'design', 'file', 'text', 'html', 'structure'] as const)(
    'renders a real <svg> icon, not an emoji glyph, for tab type %s',
    (type) => {
      renderTab({ type });
      const icon = document.querySelector('svg');
      expect(icon).toBeInTheDocument();
    }
  );

  it('uses the shared chromosome-stack icon for an indexed-genome sequence tab', () => {
    renderTab({
      type: 'sequence',
      sequenceDocument: {
        kind: 'indexed-sequence',
        documentId: 'assembly:grch38',
      },
    });

    expect(document.querySelector('[data-icon="genome-assembly"]')).toBeInTheDocument();
    expect(document.querySelector('[data-icon="biology-file"]')).not.toBeInTheDocument();
  });

  it('uses the chromosome-stack icon for a legacy restored indexed-genome tab', () => {
    renderTab({
      type: 'sequence',
      indexedGenome: { chrom: 'chr1' } as TabData['indexedGenome'],
    });

    expect(document.querySelector('[data-icon="genome-assembly"]')).toBeInTheDocument();
  });

  it('keeps the biology-file icon for an ordinary sequence tab', () => {
    renderTab({ type: 'sequence' });

    expect(document.querySelector('[data-icon="biology-file"]')).toBeInTheDocument();
    expect(document.querySelector('[data-icon="genome-assembly"]')).not.toBeInTheDocument();
  });
});

describe('Tab title extension default ', () => {
  afterEach(() => cleanup());

  it('describes external preview tabs without adding visible text beside the filename', () => {
    renderTab({
      type: 'file',
      label: 'collection.fasta',
      sourceFileView: { path: '/lab/collection.fasta', format: 'fasta', location: 'external' },
    });
    const tab = screen.getByRole('tab');
    expect(tab).toHaveAccessibleDescription('Read-only preview. Not imported.');
    expect(tab.textContent).toBe(screen.getByTestId('tab-label-t1').textContent);
  });

  it('hides a recognized extension on any tab type that does not opt out', () => {
    renderTab({ type: 'structure', label: '1FS0.pdb' });
    expect(screen.getByTestId('tab-label-t1')).toHaveTextContent(/^1FS0$/);
  });

  it('keeps the raw label for tab types that opt out', () => {
    renderTab({ type: 'chat', label: 'Compare 1FS0.pdb' });
    expect(screen.getByTestId('tab-label-t1')).toHaveTextContent('Compare 1FS0.pdb');
  });

  it('retains the full scientific name of a Registry record', () => {
    renderTab({ type: 'record', label: 'Control.faa' });
    expect(screen.getByTestId('tab-label-t1')).toHaveTextContent(/^Control\.faa$/);
  });
});
