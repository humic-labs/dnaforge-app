// @vitest-environment jsdom
import { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/search', async (load) => ({
  ...(await load<typeof import('../lib/search')>()),
  getEntityIcon: () => null,
  getEntityCategoryIcon: () => null,
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

  it('keeps the typed query in the notebook rather than duplicating a search box or kind filters', () => {
    render(
      <MentionMenu
        items={[strains, sequences]}
        query="BL21"
        command={vi.fn()}
        nextCursor="next-page"
        onLoadMore={vi.fn()}
      />
    );
    expect(screen.queryByTestId('mention-menu-search')).toBeNull();
    expect(screen.queryByTestId('mention-menu-query')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('button', { name: /More results/i })).toBeTruthy();
  });

  it('shows the flat result list without hiding records behind a five-per-kind cap', () => {
    const command = vi.fn();
    const ref = createRef<MentionMenuRef>();
    render(<MentionMenu ref={ref} items={[strains, sequences]} query="BL21" command={command} />);
    expect(screen.getAllByTestId('mention-menu-item')).toHaveLength(8);
    expect(screen.queryByTestId('mention-more-registry:strain')).toBeNull();
    for (let index = 0; index < 6; index++) key(ref, 'ArrowDown');
    key(ref, 'Enter');
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'strain-6' }));
  });

  it('keeps an empty search empty without creating a made-up entity', () => {
    const command = vi.fn();
    const ref = createRef<MentionMenuRef>();
    render(<MentionMenu ref={ref} items={[]} query="Unknown entity" command={command} />);
    expect(screen.queryByRole('option')).toBeNull();
    expect(
      screen.getByText(/No (?:items to reference|entities found|matching entities)/i)
    ).toBeTruthy();
    key(ref, 'Enter');
    expect(command).not.toHaveBeenCalled();
    expect(screen.queryByText(/Create.*Unknown entity/)).toBeNull();
  });

  it('shows project details for same-named records and keeps the selected identity', () => {
    const command = vi.fn();
    const items: EntityGroup[] = [
      {
        ...sequences,
        items: [
          entity({
            id: 'seq-alpha',
            name: 'pUC19',
            type: 'sequence',
            projectId: 'alpha',
            projectName: 'Alpha',
            path: 'pUC19',
          }),
          entity({
            id: 'seq-beta',
            name: 'pUC19',
            type: 'sequence',
            projectId: 'beta',
            projectName: 'Beta',
            path: 'pUC19',
          }),
        ],
      },
    ];
    render(<MentionMenu items={items} query="pUC19" command={command} />);
    expect(
      screen.getAllByTestId('mention-menu-item-project').map((row) => row.textContent)
    ).toEqual(['Alpha', 'Beta']);
    fireEvent.click(screen.getAllByTestId('mention-menu-item')[1]);
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'seq-beta', projectId: 'beta', path: 'pUC19' })
    );
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

  it('keeps the active entity identity when existing search results reorder', () => {
    const command = vi.fn();
    const ref = createRef<MentionMenuRef>();
    const second = entity({
      id: 'seq-2',
      name: 'pBL21 second.gb',
      type: 'sequence',
      path: 'second.gb',
    });
    const third = entity({
      id: 'seq-3',
      name: 'pBL21 third.gb',
      type: 'sequence',
      path: 'third.gb',
    });
    const group = { ...sequences, items: [...sequences.items, second, third] };
    const { rerender } = render(
      <MentionMenu ref={ref} items={[group]} query="BL21" command={command} />
    );
    key(ref, 'ArrowDown');
    rerender(
      <MentionMenu
        ref={ref}
        items={[{ ...group, items: [third, ...sequences.items, second] }]}
        query="BL21"
        command={command}
      />
    );
    key(ref, 'Enter');
    expect(command).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ entityId: 'seq-2', path: 'second.gb' })
    );
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
