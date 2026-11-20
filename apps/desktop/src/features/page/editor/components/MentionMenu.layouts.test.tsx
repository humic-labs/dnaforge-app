import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MentionMenu } from './MentionMenu';
import type { EntityGroup, EntityLinkCategory } from '../lib/search';

const category: EntityLinkCategory = {
  key: 'primer',
  label: 'Primer',
  terms: ['primer'],
  filter: { role: 'primer' },
  iconKind: 'primer',
};
const items: EntityGroup[] = [
  {
    key: 'recently-viewed',
    label: 'Recently viewed',
    source: 'project',
    items: Array.from({ length: 7 }, (_, i) => ({
      id: `viewed-${i}`,
      name: `Viewed notebook ${i}`,
      type: 'page',
    })),
  },
];
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

it('places browse first and shows at most four recent entities without comparison controls', () => {
  render(
    <MentionMenu
      items={items}
      query=""
      command={vi.fn()}
      categories={[category]}
      onTypes={vi.fn()}
      onBrowse={vi.fn()}
      onRecent={vi.fn()}
    />
  );
  expect(screen.getAllByRole('option').map((element) => element.dataset.testid)).toEqual([
    'mention-browse-types',
    'mention-menu-item',
    'mention-menu-item',
    'mention-menu-item',
    'mention-menu-item',
    'mention-recently-viewed',
  ]);
  expect(screen.queryByRole('group', { name: 'Picker layout comparison' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Picker layout/ })).toBeNull();
  expect(
    screen.getAllByTestId('mention-menu-section').map((element) => element.textContent)
  ).toEqual(['Recently viewed']);
});

it('opens all recently viewed without inserting a reference', () => {
  const onRecent = vi.fn();
  const command = vi.fn();
  render(
    <MentionMenu items={items} query="" command={command} onTypes={vi.fn()} onRecent={onRecent} />
  );
  fireEvent.click(screen.getByRole('option', { name: 'All recently viewed' }));
  expect(onRecent).toHaveBeenCalledOnce();
  expect(command).not.toHaveBeenCalled();
});

it('keeps all typed name matches selectable without a recents preview limit', () => {
  const command = vi.fn();
  render(
    <MentionMenu
      items={items}
      query="Viewed"
      command={command}
      categories={[category]}
      onBrowse={vi.fn()}
    />
  );
  expect(screen.getAllByTestId('mention-menu-item')).toHaveLength(7);
  fireEvent.click(screen.getAllByTestId('mention-menu-item')[6]);
  expect(command).toHaveBeenCalledWith(
    expect.objectContaining({ entityId: 'viewed-6', entityType: 'page' })
  );
});
