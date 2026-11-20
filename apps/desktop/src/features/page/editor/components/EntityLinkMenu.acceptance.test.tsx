import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityDescriptor, EntityDiscoveryPage } from '../../../../shared/entity-discovery';

const native = vi.hoisted(() => ({ search: vi.fn(), resolve: vi.fn(), types: vi.fn() }));
vi.mock('../../../../platform', () => ({ platform: () => ({ entityDiscovery: native }) }));

import { EntityLinkMenu } from './EntityLinkMenu';
import { useEntityViewHistory } from '../../../../services/recent-entity-views';

function entity(id: string, name = id): EntityDescriptor {
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
function page(items: EntityDescriptor[], nextCursor: string | null = null): EntityDiscoveryPage {
  return {
    items,
    nextCursor,
    generation: 'generation-1',
    coverage: { catalog: items.length, registry: 0, primers: 0, excluded: 0 },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  native.search.mockReset().mockResolvedValue(page([entity('target', 'Target')]));
  native.resolve.mockReset().mockResolvedValue({
    items: [{ id: 'target', status: 'available', entity: entity('target', 'Target') }],
    generation: 'generation-1',
    coverage: { catalog: 1, registry: 0, primers: 0, excluded: 0 },
  });
  native.types.mockReset().mockResolvedValue({ items: [] });
  useEntityViewHistory.setState({ views: [] });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe('entity picker native-service boundary', () => {
  it('passes exact query, scope and filters to one owner and resolves the selected ID before insertion', async () => {
    const command = vi.fn();
    render(
      <EntityLinkMenu
        query="Target"
        workspaceRoot="/beta"
        activeCategory={{
          key: 'sequence',
          label: 'Sequences',
          terms: ['sequence'],
          filter: { entityTypes: ['sequence'] },
          iconKind: 'sequence',
        }}
        command={command}
      />
    );
    fireEvent.click(await screen.findByRole('option', { name: /Target/ }));
    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(native.search).toHaveBeenCalledWith({
      query: 'Target',
      preferredProjectRoot: '/beta',
      filter: { entityTypes: ['sequence'] },
      scope: {},
    });
    expect(native.resolve).toHaveBeenCalledWith({
      ids: ['target'],
      scope: {},
    });
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'target', projectId: 'repo-b', path: 'target.gb' })
    );
  });

  it('retains the query and makes no insertion when exact resolution fails', async () => {
    const command = vi.fn();
    native.resolve.mockResolvedValue({ items: [{ id: 'target', status: 'unavailable' }] });
    render(<EntityLinkMenu query="Target" workspaceRoot={null} command={command} />);
    fireEvent.click(await screen.findByRole('option', { name: /Target/ }));
    expect(await screen.findByText(/no longer available/i)).toBeVisible();
    expect(command).not.toHaveBeenCalled();
  });

  it('discards an older search response after the user changes the query', async () => {
    const old = deferred<EntityDiscoveryPage>();
    native.search
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(page([entity('new', 'New target')]));
    const view = render(<EntityLinkMenu query="Old" workspaceRoot={null} command={vi.fn()} />);
    view.rerender(<EntityLinkMenu query="New" workspaceRoot={null} command={vi.fn()} />);
    expect(await screen.findByRole('option', { name: /New target/ })).toBeVisible();
    await act(async () => {
      old.resolve(page([entity('old', 'Old target')]));
    });
    expect(screen.queryByRole('option', { name: /Old target/ })).toBeNull();
  });

  it.each(['query', 'unmount'] as const)(
    'does not insert a late resolution after %s changes',
    async (change) => {
      const pending = deferred<any>();
      native.resolve.mockReturnValue(pending.promise);
      const command = vi.fn();
      const view = render(<EntityLinkMenu query="Target" workspaceRoot={null} command={command} />);
      fireEvent.click(await screen.findByRole('option', { name: /Target/ }));
      if (change === 'query')
        view.rerender(<EntityLinkMenu query="Changed" workspaceRoot={null} command={command} />);
      else view.unmount();
      await act(async () =>
        pending.resolve({
          items: [{ id: 'target', status: 'available', entity: entity('target', 'Target') }],
        })
      );
      expect(command).not.toHaveBeenCalled();
    }
  );

  it('exposes continuation and an explicit refresh after the inventory changes', async () => {
    native.search
      .mockResolvedValueOnce(page([entity('first', 'First')], 'cursor-1'))
      .mockRejectedValueOnce(new Error('ENTITY_DISCOVERY_REFRESH_REQUIRED: inventory changed'))
      .mockResolvedValueOnce(page([entity('fresh', 'Fresh')]));
    render(<EntityLinkMenu query="item" workspaceRoot={null} command={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /load more|more results/i }));
    expect(await screen.findByText(/Entities changed/i)).toBeVisible();
    expect(native.search.mock.calls[1][0]).toMatchObject({ query: 'item', cursor: 'cursor-1' });
    fireEvent.click(screen.getByRole('button', { name: /refresh|retry/i }));
    expect(await screen.findByRole('option', { name: /Fresh/ })).toBeVisible();
    expect(native.search.mock.calls[2][0]).not.toHaveProperty('cursor');
  });

  it('shows a retryable query error instead of claiming no matches', async () => {
    native.search.mockRejectedValue(new Error('native query unavailable'));
    render(<EntityLinkMenu query="Target" workspaceRoot={null} command={vi.fn()} />);
    expect(await screen.findByText(/Could not load entities/i)).toBeVisible();
    expect(screen.queryByText(/No matching|No results/i)).toBeNull();
    expect(screen.getByRole('button', { name: /retry|refresh/i })).toBeVisible();
  });
});
