import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { applyInventoryCommandBatch, createInventoryState } from '@waypoint/domain-services';
import { unavailableInventoryClient } from '../../shared/inventory-client';
import { InventoryController, type InventoryData } from './inventory-controller';
import { InventoryLabelForm } from './InventoryLabelForm';

const output = vi.hoisted(() => ({
  dialog: { save: vi.fn() },
  fs: { writeTextFileAtomic: vi.fn(), readTextFile: vi.fn() },
}));
vi.mock('../../platform', () => ({ platform: () => output }));

it('uses the chosen media through the shared read client and exposes a native rendering refusal', async () => {
  const principal = { kind: 'local-profile' as const, profileKey: 'synthetic' };
  const result = applyInventoryCommandBatch(
    createInventoryState(),
    {
      expectedRevision: 0,
      commands: [
        { kind: 'create-vessel', id: 'tube', name: 'Tube', placement: { kind: 'unplaced' } },
        {
          kind: 'attach-item-code',
          id: 'code',
          namespace: 'lab',
          value: ' 00123aBc ',
          item: { kind: 'vessel', id: 'tube' },
          reason: 'Synthetic code',
        },
      ],
    },
    { at: 1, principal, authority: principal }
  );
  if (!result.ok) throw new Error(result.message);
  const data: InventoryData = {
    project: {
      projectId: 'project',
      defaultInventoryId: 'inventory',
      name: 'Synthetic project',
      path: '/synthetic',
      pinned: true,
    },
    state: result.state,
    history: [],
    availability: null,
  };
  const prepareLabel = vi.fn(async () => {
    throw new Error('The exact text does not fit this label.');
  });
  const controller = new InventoryController(
    { ...unavailableInventoryClient(), prepareLabel },
    { read: () => [], write: () => {} }
  );
  const onClose = vi.fn();
  render(
    <InventoryLabelForm
      codeId="code"
      data={data}
      controller={controller}
      status={{ kind: 'ready', data }}
      onClose={onClose}
    />
  );
  fireEvent.click(screen.getByRole('combobox', { name: 'Label size' }));
  fireEvent.click(screen.getByRole('option', { name: '80 × 50 mm · 300 dpi' }));
  fireEvent.click(screen.getByRole('button', { name: 'Render label' }));
  expect(await screen.findByTestId('inventory-label-render-error')).toHaveTextContent(
    'The exact text does not fit this label.'
  );
  expect(prepareLabel).toHaveBeenCalledWith({
    project: 'project',
    inventoryId: 'inventory',
    codeId: 'code',
    mediaProfileId: 'qr-80x50-300dpi',
  });
  expect(output.dialog.save).not.toHaveBeenCalled();
  expect(output.fs.writeTextFileAtomic).not.toHaveBeenCalled();
  expect(screen.getByTestId('inventory-label-export')).toHaveAttribute(
    'data-export-state',
    'not-exported'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledOnce();
  controller.dispose();
});
