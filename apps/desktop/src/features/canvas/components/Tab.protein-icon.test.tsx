// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Tab, getTabIconForTab } from './Tab';
import type { Tab as TabData } from '../types';

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

function makeProteinTab(): TabData {
  return { id: 't1', type: 'protein', entityId: 'aa000001', label: 'mioC' };
}

describe('Tab — protein type icon', () => {
  it('renders the protein glyph when the saved entity uses the record editor', () => {
    const { container } = render(
      <>
        {getTabIconForTab({
          id: 'protein-record-tab',
          type: 'record',
          label: 'Saved protein',
          isDirty: false,
          isIndexedSequence: false,
          iconContext: { kind: 'protein' },
        })}
      </>
    );
    expect(container.querySelector('svg[data-file-type-icon="structure"]')).toHaveAttribute(
      'data-entity-color-family',
      'protein'
    );
    expect(container.querySelector('svg[data-file-type-icon="text"]')).toBeNull();
  });

  it('renders the approved structure SVG, not the emoji fallback', () => {
    const { container } = render(
      <Tab
        tab={makeProteinTab()}
        panelId="main"
        index={0}
        isActive={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const proteinGlyph = container.querySelector('svg[data-file-type-icon="structure"]');
    expect(proteinGlyph).not.toBeNull();
    expect(container.textContent).not.toContain('⛓️');
  });
});
