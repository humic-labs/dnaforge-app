import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ search: vi.fn(), resolve: vi.fn(), types: vi.fn() }));
vi.mock('../../../../platform', () => ({ platform: () => ({ entityDiscovery: native }) }));

import { EntityLinkMenu } from './EntityLinkMenu';
import { EntitySlashCommandMenu } from './EntitySlashCommandMenu';
import { EntityPicker } from '../../embeds/EntityPicker';
import { useEntityViewHistory } from '../../../../services/recent-entity-views';

const molecularDocuments = {
  key: 'type:molecular-document',
  kind: 'type',
  label: 'Molecular documents',
  terms: ['molecular document', 'molecular documents', 'molecular'],
  filter: { namedTypeKey: 'type:molecular-document' },
  iconKind: 'molecular-document',
  count: 2,
};
const designs = {
  key: 'type:design',
  kind: 'type',
  label: 'Designs',
  terms: ['design', 'designs'],
  filter: { namedTypeKey: 'type:design' },
  iconKind: 'design',
  count: 9,
};
const primerShortcut = {
  key: 'role:primer',
  kind: 'shortcut',
  label: 'Primers',
  terms: ['primer', 'primers'],
  filter: { role: 'primer' },
  iconKind: 'primer',
  count: 24,
};
const target = {
  id: 'target',
  name: 'Target',
  type: 'registry',
  source: 'registry',
  kindLabel: 'Plasmid',
  path: null,
  contentHash: null,
  objectUuid: null,
  registryKind: 'plasmid',
  registryId: null,
  schemaId: null,
  projectId: null,
  projectRoot: null,
  projectName: null as string | null,
  archived: false,
};
const page = (items: unknown[]) => ({
  items,
  nextCursor: null,
  generation: 'named-types-fixture',
  coverage: { catalog: 0, registry: items.length, primers: 0, excluded: 0 },
});

beforeEach(() => {
  native.search.mockReset().mockResolvedValue(page([target]));
  native.resolve.mockReset().mockResolvedValue({ items: [] });
  native.types.mockReset().mockResolvedValue({
    items: [molecularDocuments, designs, primerShortcut],
  });
  useEntityViewHistory.setState({ views: [] });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

it('browses actual native types once and keeps the primer role out of the type list', async () => {
  const onBrowse = vi.fn();
  const command = vi.fn();
  render(
    <EntityLinkMenu
      query=""
      workspaceRoot={null}
      browseView
      onBrowse={onBrowse}
      command={command}
    />
  );
  const categories = await screen.findAllByTestId('mention-browse-category');
  expect(categories.map((row) => row.textContent)).toEqual(['Molecular documents', 'Designs']);
  for (const row of categories) {
    expect(row.querySelector('svg[data-direction="right"]')).toBeInTheDocument();
  }
  fireEvent.click(screen.getByRole('option', { name: 'Browse Molecular documents' }));
  expect(onBrowse).toHaveBeenCalledWith(
    expect.objectContaining({ filter: molecularDocuments.filter })
  );
  expect(command).not.toHaveBeenCalled();
  expect(screen.queryByRole('option', { name: /Structures|Other entities|Primers/ })).toBeNull();
});

it('keeps the primer role searchable without turning it into a second type', async () => {
  render(
    <EntityLinkMenu query="primer" workspaceRoot={null} onBrowse={vi.fn()} command={vi.fn()} />
  );
  expect(await screen.findByRole('option', { name: 'Browse Primers' })).toBeVisible();
});

it('lists populated native types in the initial Entity column with their original names and filters', async () => {
  const custom = {
    ...designs,
    key: 'schema:lot',
    label: 'QA Lots',
    filter: { namedTypeKey: 'schema:lot' },
  };
  native.types.mockResolvedValue({ items: [designs, molecularDocuments, custom, primerShortcut] });
  const command = vi.fn();
  render(<EntitySlashCommandMenu items={[]} query="" command={command} />);
  const column = within(screen.getByRole('group', { name: 'Entity' }));
  const row = await column.findByRole('option', { name: 'QA Lots' });
  const link = column.getByRole('option', { name: 'Link an entity' });
  expect(link).toHaveTextContent(/^@$/);
  expect(
    column
      .getAllByRole('option')
      .filter((button) => button !== link)
      .map((button) => button.textContent)
  ).toEqual(['Designs', 'Molecular documents', 'QA Lots']);
  fireEvent.click(row);
  expect(command).toHaveBeenCalledWith(
    expect.objectContaining({
      entityCategory: expect.objectContaining({
        key: custom.key,
        filter: custom.filter,
      }),
    })
  );
  expect(native.search).not.toHaveBeenCalled();
});

it('offers the named molecular-document slash command without a synthetic Structures group', async () => {
  render(<EntitySlashCommandMenu items={[]} query="molecular" command={vi.fn()} />);
  expect(await screen.findByRole('option', { name: 'Molecular documents' })).toBeVisible();
  expect(screen.queryByText('Link structures')).toBeNull();
});

it('does not invent a Structures slash category when native discovery has none', async () => {
  native.types.mockResolvedValue({ items: [] });
  render(<EntitySlashCommandMenu items={[]} query="structure" command={vi.fn()} />);
  await waitFor(() => expect(native.types).toHaveBeenCalledOnce());
  expect(screen.queryByText('Link structures')).toBeNull();
});

it('describes the global scope without inventing a library and preserves its native request', async () => {
  render(<EntityLinkMenu query="Target" workspaceRoot="/alpha" command={vi.fn()} />);
  expect(await screen.findByRole('option', { name: /Target/ })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Limit to this project' })).toHaveAttribute(
    'aria-pressed',
    'false'
  );
  expect(screen.queryByText('All entities')).toBeNull();
  expect(screen.queryByText('Link an entity')).toBeNull();
  expect(native.search).toHaveBeenCalledWith({
    query: 'Target',
    preferredProjectRoot: '/alpha',
    scope: {},
  });
  expect(screen.queryByText(/Local library/i)).toBeNull();
});

it.each([null, '   ', ' Alpha '])(
  'shows only a known trimmed project location in both pickers: %s',
  async (projectName) => {
    native.search.mockResolvedValue(page([{ ...target, projectName }]));
    const inline = render(<EntityLinkMenu query="Target" workspaceRoot={null} command={vi.fn()} />);
    const expected = projectName?.trim() ? 'TargetPlasmid · Alpha' : 'TargetPlasmid';
    expect(await screen.findByRole('option', { name: /Target/ })).toHaveTextContent(expected);
    expect(screen.getByRole('option', { name: /Target/ }).textContent).toBe(expected);
    inline.unmount();
    render(<EntityPicker label="entities" filter={{}} onSelect={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByRole('option', { name: /Target/ })).toHaveTextContent(expected);
    expect(screen.getByRole('option', { name: /Target/ }).textContent).toBe(expected);
    expect(screen.queryByText(/Local library/i)).toBeNull();
  }
);
