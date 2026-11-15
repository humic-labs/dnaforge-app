import { useState, type FormEvent } from 'react';
import type { InventoryCatalogTarget } from '@waypoint/domain-services';
import { Notice, TextArea } from '../../components/ui';
import type {
  InventoryController,
  InventoryControllerState,
  InventoryData,
} from './inventory-controller';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import { PhysicalField } from './InventoryPhysicalControls';
import {
  inventoryCatalogStatusAt,
  inventoryCatalogTargetLabel,
  InventoryCatalogVersionState,
} from './InventoryCatalogSelection';

export function InventoryCatalogLifecycleForm({
  data,
  target,
  action,
  controller,
  status,
  onClose,
}: {
  data: InventoryData;
  target: InventoryCatalogTarget;
  action: 'retire' | 'restore';
  controller: InventoryController;
  status: InventoryControllerState;
  onClose(): void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const version = inventoryCatalogStatusAt(data, target);
  const allowed = Boolean(version?.actions[action]);
  const title = action === 'retire' ? 'Retire catalog version' : 'Restore catalog version';
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (!allowed) throw new Error('This catalog transition is no longer available.');
      if (
        await controller.submit(
          [
            {
              kind: action === 'retire' ? 'retire-catalog-version' : 'restore-catalog-version',
              target,
              reason: reason.trim(),
            },
          ],
          title
        )
      )
        onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the catalog change.');
    }
  }
  return (
    <InventoryPhysicalDialog
      title={title}
      subtitle={inventoryCatalogTargetLabel(data, target)}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
      disabled={!allowed}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <InventoryCatalogVersionState status={version} />
      <Notice>
        {action === 'retire'
          ? 'Retirement prevents new selection of this exact version. Installed items keep their versions and remain usable.'
          : 'Restore this exact version for new selection. Component types retain their own availability.'}
      </Notice>
      <PhysicalField label="Reason">
        <TextArea
          aria-label="Reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
        />
      </PhysicalField>
    </InventoryPhysicalDialog>
  );
}
