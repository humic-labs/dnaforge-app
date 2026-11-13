// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Tab } from './Tab';
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
