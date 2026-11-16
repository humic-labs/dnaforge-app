import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryAvailability,
  inventoryStorageConditionsProjection,
  type InventoryCommand,
} from '@waypoint/domain-services';
import type { InventoryControllerSnapshot, InventoryData } from './inventory-controller';

const current = vi.hoisted(() => ({ snapshot: null as unknown as InventoryControllerSnapshot }));
vi.mock('./inventory-controller', async (original) => {
  const actual = await original<typeof import('./inventory-controller')>();
  return {
    ...actual,
    InventoryController: class {
      subscribe = () => () => {};
      getSnapshot = () => current.snapshot;
      open = async () => {};
      refresh = async () => {};
      hasLabelSnapshot = () => false;
    },
  };
});
vi.mock('../../platform', () => ({ platform: () => ({ inventory: {} }) }));

import { InventoryPanel } from './InventoryPanel';
import { InventoryContentsPanel } from './InventoryContentsPanel';

const principal = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) };

function prepare(unobserved = false, pinned = false) {
  const commands: InventoryCommand[] = [
    {
      kind: 'create-layout-storage',
      id: 'plate',
      name: 'Physical plate',
      layout: { kind: 'fixed-well', rows: 1, columns: 1 },
      placement: { kind: 'root' },
    },
  ];
  const created = applyInventoryCommandBatch(
    createInventoryState(),
    { expectedRevision: 0, commands },
    { at: 1000, principal, authority: principal }
  );
  if (!created.ok) throw new Error(created.message);
  let state = created.state;
  const vesselId = Object.keys(state.vessels)[0];
  if (unobserved) {
    const marked = applyInventoryCommandBatch(
      state,
      {
        expectedRevision: state.revision,
        commands: [
          {
            kind: 'record-vessel-contents',
            vesselId,
            knowledge: 'unobserved',
            reason: 'This well was not captured',
          },
        ],
      },
      { at: 1001, principal, authority: principal }
    );
    if (!marked.ok) throw new Error(marked.message);
    state = marked.state;
  }
  const project = {
    projectId: 'project',
    defaultInventoryId: 'inventory',
    name: 'Owned project',
    path: '/synthetic',
    pinned,
  };
  const data: InventoryData = {
    project,
    state,
    history: [],
    availability: {
      ...inventoryAvailability(state, principal, 1002),
      revision: state.revision,
      asOf: 1002,
      principal,
    },
    storageConditions: {
      ...inventoryStorageConditionsProjection(state, { asOf: 1002, freshnessMaxAgeMs: null }),
      projectId: project.projectId,
      inventoryId: project.defaultInventoryId,
      revision: state.revision,
      principal,
    },
  };
  current.snapshot = {
    status: { kind: 'ready', data },
    projects: [project],
    catalog: { kind: 'idle' },
    itemCodeLookup: { kind: 'idle' },
  };
  return { vesselId, data };
}

it('opens an empty permanent well for inspection before an explicit receiving action', () => {
  prepare();
  render(<InventoryPanel />);
  fireEvent.click(screen.getByRole('treeitem'));
  fireEvent.click(screen.getByRole('button', { name: 'Position A1, Declared empty' }));
  const drawer = screen.getByTestId('inventory-detail-drawer');
  expect(within(drawer).getByTestId('inventory-contents')).toHaveAttribute(
    'data-contents-state',
    'declared-empty'
  );
  expect(
    within(drawer).getByRole('button', { name: 'Record contents status', exact: true })
  ).toBeEnabled();
  expect(within(drawer).getByRole('button', { name: 'Receive stock', exact: true })).toBeEnabled();
  expect(within(drawer).queryByRole('button', { name: 'Move', exact: true })).toBeNull();
  expect(
    within(drawer).queryByRole('button', { name: 'Dispose container', exact: true })
  ).toBeNull();
  expect(within(drawer).queryByRole('button', { name: 'Check out', exact: true })).toBeNull();
});

it('opens an unresolved permanent well with identification instead of receiving', () => {
  prepare(true);
  render(<InventoryPanel />);
  fireEvent.click(screen.getByRole('treeitem'));
  fireEvent.click(screen.getByRole('button', { name: 'Position A1, Contents unobserved' }));
  const drawer = screen.getByTestId('inventory-detail-drawer');
  expect(within(drawer).getByTestId('inventory-contents')).toHaveAttribute(
    'data-contents-state',
    'unobserved'
  );
  expect(within(drawer).getByRole('button', { name: 'Receive stock', exact: true })).toBeDisabled();
  expect(
    within(drawer).getByRole('button', { name: 'Identify contents', exact: true })
  ).toBeEnabled();
  expect(within(drawer).queryByRole('button', { name: 'Move', exact: true })).toBeNull();
});

it('allows a read-only user to inspect a permanent well without declaration or independent custody actions', () => {
  prepare(true, true);
  render(<InventoryPanel />);
  fireEvent.click(screen.getByRole('treeitem'));
  const tile = screen.getByRole('button', { name: 'Position A1, Contents unobserved' });
  expect(tile).toBeEnabled();
  fireEvent.click(tile);
  const drawer = screen.getByTestId('inventory-detail-drawer');
  expect(within(drawer).getByTestId('inventory-contents')).toHaveAttribute(
    'data-contents-state',
    'unobserved'
  );
  expect(
    within(drawer).getByRole('button', { name: 'Identify contents', exact: true })
  ).toBeDisabled();
  expect(
    within(drawer).getByRole('button', { name: 'Record contents status', exact: true })
  ).toBeDisabled();
  expect(within(drawer).queryByRole('button', { name: 'Check out', exact: true })).toBeNull();
});

it('identifies the current native desktop as the contents declaration actor', () => {
  prepare(true);
  render(<InventoryPanel />);
  fireEvent.click(screen.getByRole('treeitem'));
  fireEvent.click(screen.getByRole('button', { name: 'Position A1, Contents unobserved' }));
  const contents = screen.getByTestId('inventory-contents');
  expect(within(contents).getByText(/^This desktop profile/)).toBeVisible();
  expect(within(contents).queryByText(/^Another desktop profile/)).toBeNull();
});

it('uses the verified storage-conditions principal when availability is absent', () => {
  const { data, vesselId } = prepare(true);
  render(
    <InventoryContentsPanel
      data={{ ...data, availability: null }}
      vesselId={vesselId}
      editable={false}
      onDialog={vi.fn()}
    />
  );
  expect(screen.getByText(/^This desktop profile/)).toBeVisible();
});

it('keeps another local profile distinct from the current native principal', () => {
  const { data, vesselId } = prepare(true);
  const vessel = data.state.vessels[vesselId];
  if (vessel.contentsKnowledge.kind === 'recorded')
    throw new Error('Expected unresolved contents fixture.');
  const other = {
    ...data,
    state: {
      ...data.state,
      vessels: {
        ...data.state.vessels,
        [vesselId]: {
          ...vessel,
          contentsKnowledge: {
            ...vessel.contentsKnowledge,
            by: { kind: 'local-profile' as const, profileKey: 'b'.repeat(64) },
          },
        },
      },
    },
  };
  render(
    <InventoryContentsPanel data={other} vesselId={vesselId} editable={false} onDialog={vi.fn()} />
  );
  expect(screen.getByText(/^Another desktop profile/)).toBeVisible();
  expect(screen.queryByText(/^This desktop profile/)).toBeNull();
});

it('keeps imported attribution even when its original profile key matches the current desktop', () => {
  const { data, vesselId } = prepare(true);
  const vessel = data.state.vessels[vesselId];
  if (vessel.contentsKnowledge.kind === 'recorded')
    throw new Error('Expected unresolved contents fixture.');
  const imported = {
    ...data,
    state: {
      ...data.state,
      vessels: {
        ...data.state.vessels,
        [vesselId]: {
          ...vessel,
          contentsKnowledge: {
            ...vessel.contentsKnowledge,
            by: {
              kind: 'imported' as const,
              principal,
              source: {
                archiveSha256: `sha256:${'c'.repeat(64)}`,
                projectId: 'source-project',
                inventoryId: 'source-inventory',
                revision: 2,
              },
            },
          },
        },
      },
    },
  };
  render(
    <InventoryContentsPanel
      data={imported}
      vesselId={vesselId}
      editable={false}
      onDialog={vi.fn()}
    />
  );
  expect(screen.getByText(/^Imported desktop profile/)).toBeVisible();
  expect(screen.queryByText(/^This desktop profile/)).toBeNull();
  expect(screen.queryByText(/^Another desktop profile/)).toBeNull();
});
