// @vitest-environment jsdom
import { createRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ search: vi.fn(), types: vi.fn() }));
vi.mock('../../../../platform', () => ({ platform: () => ({ entityDiscovery: mocks }) }));
import { MentionMenu, type MentionMenuRef } from '../components/MentionMenu';
import { discoverEntityLinkTypes, matchingEntityLinkCategories, searchEntities } from './search';
const specimen = {
  key: 'schema:schema-specimen',
  label: 'Patient specimen',
  terms: ['specimen', 'patient specimen'],
  filter: { namedTypeKey: 'schema:schema-specimen' },
  iconKind: 'record',
  kind: 'type',
  count: 3,
};
const notebook = {
  key: 'type:notebook',
  label: 'Notebooks',
  terms: ['notebook', 'notebooks'],
  filter: { namedTypeKey: 'type:notebook' },
  iconKind: 'notebook',
  kind: 'type',
  count: 2,
};
const primerShortcut = {
  key: 'role:primer',
  label: 'Primer',
  terms: ['primer', 'primers'],
  filter: { role: 'primer' },
  iconKind: 'primer',
  kind: 'shortcut',
  count: 1,
};
beforeEach(() => {
  mocks.types.mockReset().mockResolvedValue({ items: [specimen, notebook, primerShortcut] });
  mocks.search.mockReset().mockResolvedValue({
    items: [],
    nextCursor: null,
    generation: 'generation',
    coverage: { catalog: 0, registry: 0, primers: 0, excluded: 0 },
  });
  Element.prototype.scrollIntoView = vi.fn();
});
it('browses populated native named types while keeping the primer-use shortcut search-only', async () => {
  const types = await discoverEntityLinkTypes();
  expect(types.map((category) => ({ key: category.key, browse: category.browse }))).toEqual([
    { key: specimen.key, browse: true },
    { key: notebook.key, browse: true },
    { key: primerShortcut.key, browse: false },
  ]);
  expect(types).toContainEqual(
    expect.objectContaining({
      key: specimen.key,
      label: specimen.label,
      filter: { namedTypeKey: 'schema:schema-specimen' },
      browse: true,
    })
  );
});
it('sends the selected Registry schema identity to the native search owner before pagination', async () => {
  await searchEntities('tumor', '/lab/alpha', { schemaId: 'schema-specimen' }, { limit: 25 });
  expect(mocks.search).toHaveBeenCalledExactlyOnceWith({
    query: 'tumor',
    preferredProjectRoot: '/lab/alpha',
    filter: { schemaId: 'schema-specimen' },
    limit: 25,
  });
});
it('uses the shared primer role rather than treating every oligo as a primer', async () => {
  await searchEntities('', '/lab/alpha', { role: 'primer' });
  expect(mocks.search).toHaveBeenCalledExactlyOnceWith({
    query: '',
    preferredProjectRoot: '/lab/alpha',
    filter: { role: 'primer' },
  });
});
it('never inserts a fake entity when a name has no matches', () => {
  const command = vi.fn();
  const ref = createRef<MentionMenuRef>();
  render(<MentionMenu ref={ref} items={[]} query="unlisted entity" command={command} />);
  act(() => {
    ref.current!.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'Enter' }) });
  });
  expect(command).not.toHaveBeenCalled();
  expect(screen.queryByText('Create "unlisted entity"')).toBeNull();
});
it('offers the primer shortcut after direct name results without inserting the shortcut as an entity', async () => {
  const categories = await discoverEntityLinkTypes();
  const browse = vi.fn(),
    command = vi.fn();
  const ref = createRef<MentionMenuRef>();
  render(
    <MentionMenu
      ref={ref}
      items={[
        {
          key: 'primer',
          label: 'Primer',
          source: 'project',
          items: [{ id: 'named-primer', type: 'primer', name: 'primer' }],
        },
      ]}
      query="primer"
      categories={categories}
      onBrowse={browse}
      command={command}
    />
  );
  act(() => {
    ref.current!.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'Enter' }) });
  });
  expect(command).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'named-primer' }));
  expect(screen.getByRole('option', { name: 'Browse Primer' })).toBeTruthy();
});
it('matches the saved named type without changing its exact filter', async () => {
  const types = await discoverEntityLinkTypes();
  expect(matchingEntityLinkCategories(types, 'specimen')).toEqual([
    expect.objectContaining({ key: specimen.key, filter: specimen.filter }),
  ]);
});
