// @vitest-environment jsdom
import { createRef } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/search', () => ({
  getEntityIcon: () => null,
}));

import { MentionMenu, type MentionMenuRef } from './MentionMenu';
import type { Entity, EntityGroup } from '../lib/search';

function entity(overrides: Partial<Entity> & Pick<Entity, 'id' | 'name' | 'type'>): Entity {
  return { path: null, contentHash: null, objectUuid: null, ...overrides };
}

const strains: EntityGroup = {
  key: 'registry:strain',
  label: 'Strain',
  source: 'registry',
  partial: true,
  items: Array.from({ length: 7 }, (_, index) =>
    entity({
      id: `strain-${index}`,
      name: `BL21 variant ${index}`,
      type: 'registry',
      registryKind: 'strain',
      registryId: `s00000${index}`,
    })
  ),
};

const sequences: EntityGroup = {
  key: 'sequence',
  label: 'Sequence',
  source: 'project',
  items: [
    entity({
      id: 'seq-1',
      name: 'pBL21.gb',
      type: 'sequence',
      path: 'sequences/pBL21.gb',
      contentHash: 'sha256:abc',
      objectUuid: 'uuid-1',
    }),
  ],
};

function key(ref: React.RefObject<MentionMenuRef | null>, name: string, shiftKey = false) {
  let handled = false;
  act(() => {
    handled = ref.current!.onKeyDown({
      event: new KeyboardEvent('keydown', { key: name, shiftKey }),
    });
  });
  return handled;
}

describe('notebook @ search menu', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the typed text in its search box and a filter for each kind found', () => {
    render(<MentionMenu items={[strains, sequences]} query="BL21" command={vi.fn()} />);

    expect(screen.getByTestId('mention-menu-query').textContent).toBe('BL21');
    expect(screen.getByTestId('mention-filter-all').textContent).toBe('All 8');
    expect(screen.getByTestId('mention-filter-registry:strain').textContent).toBe('Strain 7');
    expect(screen.getByTestId('mention-filter-sequence').textContent).toBe('Sequence 1');
    expect(screen.getByText('More matches: keep typing')).toBeTruthy();
  });

  it('shows five per kind until a kind is chosen, then shows them all', () => {
    const ref = createRef<MentionMenuRef>();
    render(<MentionMenu ref={ref} items={[strains, sequences]} query="BL21" command={vi.fn()} />);

    const strainGroup = screen.getByTestId('mention-group-registry:strain');
    expect(within(strainGroup).getAllByTestId('mention-menu-item')).toHaveLength(5);
    expect(screen.getByTestId('mention-more-registry:strain').textContent).toBe('2 more');

    expect(key(ref, 'Tab')).toBe(true);
    expect(screen.getByTestId('mention-filter-registry:strain').getAttribute('aria-selected')).toBe(
      'true'
    );
    expect(screen.getAllByTestId('mention-menu-item')).toHaveLength(7);
    expect(screen.queryByTestId('mention-group-sequence')).toBeNull();

    key(ref, 'Tab', true);
    expect(screen.getByTestId('mention-filter-all').getAttribute('aria-selected')).toBe('true');
  });

  it('inserts the same complete link whether an item is clicked or chosen with Enter', () => {
    const clicked = vi.fn();
    const { unmount } = render(
      <MentionMenu items={[sequences, strains]} query="BL21" command={clicked} />
    );
    fireEvent.click(screen.getAllByTestId('mention-menu-item')[0]);
    unmount();

    const entered = vi.fn();
    const ref = createRef<MentionMenuRef>();
    render(<MentionMenu ref={ref} items={[sequences, strains]} query="BL21" command={entered} />);
    key(ref, 'Enter');

    const expected = {
      entityType: 'sequence',
      entityId: 'seq-1',
      label: 'pBL21.gb',
      path: 'sequences/pBL21.gb',
      contentHash: 'sha256:abc',
      objectUuid: 'uuid-1',
      registryKind: null,
    };
    expect(clicked).toHaveBeenCalledWith(expected);
    expect(entered).toHaveBeenCalledWith(expected);
  });

  it('starts a new result list on its first row, never on a row left over from the previous list', () => {
    const command = vi.fn();
    const ref = createRef<MentionMenuRef>();
    const { rerender } = render(
      <MentionMenu ref={ref} items={[strains]} query="BL" command={command} />
    );
    fireEvent.mouseEnter(screen.getAllByTestId('mention-menu-item')[3]);
    const observer = new MutationObserver(() => {});
    observer.observe(screen.getByRole('listbox'), {
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-selected'],
      attributeOldValue: true,
    });

    rerender(<MentionMenu ref={ref} items={[sequences]} query="pBL21" command={command} />);
    const records = observer.takeRecords();
    observer.disconnect();

    const row = screen.getByTestId('mention-menu-item');
    expect(row.getAttribute('aria-selected')).toBe('true');
    expect(
      records.filter((record) => record.target === row && record.oldValue === 'false')
    ).toEqual([]);
    key(ref, 'Enter');
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'seq-1' }));
  });

  it('inserts a Registry record with its kind', () => {
    const command = vi.fn();
    const ref = createRef<MentionMenuRef>();
    render(<MentionMenu ref={ref} items={[strains]} query="BL21" command={command} />);

    key(ref, 'ArrowDown');
    key(ref, 'Enter');

    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'registry',
        entityId: 'strain-1',
        label: 'BL21 variant 1',
        registryKind: 'strain',
      })
    );
  });
});
