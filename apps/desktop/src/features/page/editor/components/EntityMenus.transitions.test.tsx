import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EntityDescriptor, EntityDiscoveryPage } from '../../../../shared/entity-discovery';
import type { SlashCommand } from '../lib/commands';
import type { SlashCommandMenuRef } from './SlashCommandMenu';
import type { MentionMenuRef } from './MentionMenu';

const native = vi.hoisted(() => ({ search: vi.fn(), resolve: vi.fn(), types: vi.fn() }));
vi.mock('../../../../platform', () => ({ platform: () => ({ entityDiscovery: native }) }));
import { EntitySlashCommandMenu } from './EntitySlashCommandMenu';
import { EntityLinkMenu } from './EntityLinkMenu';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import { useEntityViewHistory } from '../../../../services/recent-entity-views';

const commands: SlashCommand[] = [
  {
    name: 'heading',
    label: 'Heading 1',
    icon: 'H1',
    category: 'format',
    keywords: [],
    description: '',
  },
  { name: 'table', label: 'Table', icon: 'T', category: 'embed', keywords: [], description: '' },
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function entity(id: string, name: string): EntityDescriptor {
  return {
    id,
    name,
    type: 'sequence',
    source: 'project',
    namedTypeKey: 'type:sequence',
    iconKind: 'sequence',
    kindLabel: 'Sequence',
    path: `${id}.gb`,
    contentHash: null,
    objectUuid: null,
    registryKind: null,
    registryId: null,
    schemaId: null,
    projectId: 'repo-b',
    projectRoot: '/beta',
    projectName: 'Beta',
    archived: false,
  };
}
function page(items: EntityDescriptor[]): EntityDiscoveryPage {
  return {
    items,
    nextCursor: null,
    generation: 'one',
    coverage: { catalog: items.length, registry: 0, primers: 0, excluded: 0 },
  };
}
beforeEach(() => {
  native.search.mockReset();
  native.resolve.mockReset();
  native.types.mockReset().mockResolvedValue({ items: [] });
  useEntityViewHistory.setState({ views: [] });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

it.each(['pointer', 'keyboard'] as const)(
  'retains the Link an entity selection through asynchronous metadata and fresh command arrays (%s)',
  async (input) => {
    const pending = deferred<{ items: [] }>();
    native.types.mockReturnValue(pending.promise);
    const ref = createRef<SlashCommandMenuRef>();
    const command = vi.fn();
    const view = render(
      <EntitySlashCommandMenu ref={ref} query="" items={commands} command={command} />
    );
    const row = screen.getByRole('option', { name: /Link an entity/ });
    if (input === 'pointer') fireEvent.mouseEnter(row);
    else
      act(() => {
        ref.current!.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'ArrowRight' }) });
      });
    if (input === 'keyboard')
      act(() => {
        ref.current!.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'ArrowRight' }) });
      });
    expect(row).toHaveAttribute('data-active', 'true');
    await act(async () => pending.resolve({ items: [] }));
    expect(row).toHaveAttribute('data-active', 'true');
    view.rerender(
      <EntitySlashCommandMenu
        ref={ref}
        query=""
        items={commands.map((item) => ({ ...item }))}
        command={command}
      />
    );
    expect(row).toHaveAttribute('data-active', 'true');
    act(() => {
      ref.current!.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'Enter' }) });
    });
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ name: 'entity-link' }));
  }
);

it('retains result DOM while typing and cannot activate stale results during a pending search', async () => {
  const pending = deferred<EntityDiscoveryPage>();
  native.search
    .mockResolvedValueOnce(page([entity('target', 'Target')]))
    .mockReturnValueOnce(pending.promise);
  const command = vi.fn();
  const ref = createRef<MentionMenuRef>();
  const view = render(
    <EntityLinkMenu ref={ref} query="Tar" workspaceRoot={null} command={command} />
  );
  const row = await screen.findByRole('option', { name: /Target/ });
  fireEvent.mouseEnter(row);
  const popup = screen.getByTestId('mention-menu');
  view.rerender(<EntityLinkMenu ref={ref} query="Targ" workspaceRoot={null} command={command} />);
  expect(screen.getByTestId('mention-menu')).toBe(popup);
  expect(screen.getByRole('option', { name: /Target/ })).toBe(row);
  expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'true');
  expect(row).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(row);
  act(() => {
    ref.current!.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'Enter' }) });
  });
  expect(native.resolve).not.toHaveBeenCalled();
  expect(command).not.toHaveBeenCalled();
  await act(async () => pending.resolve(page([entity('target', 'Target')])));
  expect(screen.getByRole('option', { name: /Target/ })).toBe(row);
  expect(row).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'false');
});

it('clears retained results on a project scope change', async () => {
  const pending = deferred<EntityDiscoveryPage>();
  native.search
    .mockResolvedValueOnce(page([entity('other', 'Other project')]))
    .mockReturnValueOnce(pending.promise);
  render(<EntityLinkMenu query="Other" workspaceRoot="/beta" command={vi.fn()} />);
  await screen.findByRole('option', { name: /Other project/ });
  fireEvent.click(screen.getByRole('button', { name: 'Limit to this project' }));
  expect(screen.queryByRole('option', { name: /Other project/ })).toBeNull();
  await act(async () => pending.resolve(page([])));
});

it('uses an immediate shared row highlight without a color transition', () => {
  const sharedMenuCss = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../../packages/ui/components/src/menu/menu.css'),'utf8');
  expect(sharedMenuCss).toMatch(
    /\.wp-menu\[data-menu-surface='inline-workspace'\] \.wp-menu-row\s*\{\s*transition: none;/
  );
});

it('does not apply a pending insertion after query A changes to B and back to A', async () => {
  const pending = deferred<unknown>();
  native.search.mockResolvedValue(page([entity('target', 'Target')]));
  native.resolve.mockReturnValue(pending.promise);
  const command = vi.fn();
  const view = render(<EntityLinkMenu query="Target" workspaceRoot={null} command={command} />);
  fireEvent.click(await screen.findByRole('option', { name: /Target/ }));
  expect(native.resolve).toHaveBeenCalledOnce();
  view.rerender(<EntityLinkMenu query="Other" workspaceRoot={null} command={command} />);
  await act(async () => {});
  view.rerender(<EntityLinkMenu query="Target" workspaceRoot={null} command={command} />);
  await act(async () => {});
  await act(async () =>
    pending.resolve({
      items: [{ id: 'target', status: 'available', entity: entity('target', 'Target') }],
    })
  );
  expect(command).not.toHaveBeenCalled();
});

it('keeps the previous result rows present while the first typed character changes recents into search', async () => {
  useEntityViewHistory.setState({ views: [{ entityId: 'target', viewedAt: 1 }] });
  native.resolve.mockResolvedValue({
    items: [{ id: 'target', status: 'available', entity: entity('target', 'Target') }],
  });
  const pending = deferred<EntityDiscoveryPage>();
  native.search.mockReturnValue(pending.promise);
  const props = { workspaceRoot: null, command: vi.fn(), onTypes: vi.fn(), onRecent: vi.fn() };
  const view = render(<EntityLinkMenu {...props} query="" />);
  const row = await screen.findByRole('option', { name: /Target/ });
  view.rerender(<EntityLinkMenu {...props} query="T" />);
  expect(screen.getByRole('option', { name: /Target/ })).toBe(row);
  expect(row).toHaveAttribute('aria-disabled', 'true');
  await act(async () => pending.resolve(page([entity('target', 'Target')])));
  expect(screen.getByRole('option', { name: /Target/ })).toBe(row);
});

it('keeps keyboard selection until the pointer moves, including movement inside the previous row', async () => {
  native.search.mockResolvedValue(page([entity('a', 'Target A'), entity('b', 'Target B')]));
  const ref = createRef<MentionMenuRef>();
  render(<EntityLinkMenu ref={ref} query="Target" workspaceRoot={null} command={vi.fn()} />);
  const first = await screen.findByRole('option', { name: /Target A/ });
  const second = await screen.findByRole('option', { name: /Target B/ });
  fireEvent.mouseEnter(second, { clientX: 30, clientY: 64 });
  expect(second).toHaveAttribute('aria-selected', 'true');
  act(() => { ref.current!.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'ArrowUp' }) }); });
  fireEvent.mouseMove(second, { clientX: 30, clientY: 64 });
  expect(first).toHaveAttribute('aria-selected', 'true');
  fireEvent.mouseMove(second, { clientX: 31, clientY: 64 });
  expect(second).toHaveAttribute('aria-selected', 'true');
});
