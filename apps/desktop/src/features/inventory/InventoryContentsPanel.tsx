import { inventoryVesselContents } from '@waypoint/domain-services';
import { Button, Notice } from '../../components/ui';
import type { InventoryData } from './inventory-controller';
import { inventoryContentsLabel } from './inventory-contents-view';
import { inventoryPrincipalLabel, type InventoryDialog } from './inventory-view';

export function InventoryContentsPanel({
  data,
  vesselId,
  editable,
  onDialog,
}: {
  data: InventoryData;
  vesselId: string;
  editable: boolean;
  onDialog(dialog: InventoryDialog): void;
}) {
  const contents = inventoryVesselContents(data.state, vesselId);
  const vessel = data.state.vessels[vesselId];
  if (!contents || !vessel) return <Notice>Container contents are unavailable.</Notice>;
  const unresolved = contents.kind === 'unobserved' || contents.kind === 'unidentified';
  return (
    <section
      data-testid="inventory-contents"
      data-contents-state={contents.kind}
      className="space-y-3"
    >
      <h3 className="text-sm font-semibold">{inventoryContentsLabel(contents)}</h3>
      <p className="text-xs text-fg-muted">
        {contents.kind === 'declared-empty'
          ? 'This container is declared empty and has no stock record.'
          : contents.kind === 'identified'
            ? 'The linked stock identifies these contents, including zero or unknown quantities.'
            : contents.kind === 'unobserved'
              ? 'The contents have not been checked. Identify the contents or declare this container empty before adding material.'
              : 'Material is present but is not linked to a scientific record. Identify the existing contents before using stock.'}
      </p>
      {unresolved ? (
        <div className="space-y-1 text-xs">
          <p className="break-words">{contents.reason}</p>
          <p className="text-fg-muted">
            {inventoryPrincipalLabel(
              contents.by,
              data.availability?.principal ?? data.storageConditions.principal
            )}{' '}
            · {new Date(contents.at).toLocaleString()}
          </p>
        </div>
      ) : null}
      {contents.kind !== 'identified' && vessel.lifecycle === 'active' ? (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!editable}
            onClick={() => onDialog({ kind: 'contents', action: 'record', vesselId })}
          >
            Record contents status
          </Button>
          {unresolved ? (
            <>
              <Button
                disabled={!editable}
                onClick={() => onDialog({ kind: 'contents', action: 'identify', vesselId })}
              >
                Identify contents
              </Button>
              <Button
                disabled={!editable}
                onClick={() => onDialog({ kind: 'contents', action: 'empty', vesselId })}
              >
                Declare empty
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
