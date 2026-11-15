import type {
  InventoryCatalogEligibility,
  InventoryCatalogTarget,
  InventoryCatalogVersionStatus,
} from '@waypoint/domain-services';
import { Button, Notice } from '../../components/ui';
import type { InventoryData } from './inventory-controller';
import type { InventoryDialog } from './inventory-view';

export function inventoryCatalogStatusAt(
  data: InventoryData,
  target: InventoryCatalogTarget
): InventoryCatalogVersionStatus | undefined {
  const catalog = data.availability?.physical.catalog;
  return target.kind === 'type-version'
    ? catalog?.typeVersions[target.versionId]
    : catalog?.recipeVersions[target.versionId];
}

export function inventoryCatalogTargetLabel(data: InventoryData, target: InventoryCatalogTarget) {
  const version =
    target.kind === 'type-version'
      ? data.state.typeVersions[target.versionId]
      : data.state.recipeVersions[target.versionId];
  return version ? `${version.name} · v${version.version}` : target.versionId;
}

export function inventoryCatalogVersionLabel(
  name: string,
  version: number,
  status: InventoryCatalogVersionStatus | undefined
) {
  return `${name} · v${version} · ${
    status ? (status.relationship === 'current' ? 'Current' : 'Superseded') : 'Status unavailable'
  }${status ? ` · ${status.selection.kind === 'available' ? 'Available' : 'Retired'}` : ''}`;
}

export function inventoryCatalogBlockerText(
  data: InventoryData,
  blocker: Extract<InventoryCatalogEligibility, { kind: 'blocked' }>['blockers'][number]
): string {
  if (blocker.code === 'CATALOG_VERSION_RETIRED')
    return `${inventoryCatalogTargetLabel(data, blocker.target)} is retired.`;
  return `Retired component types: ${blocker.typeVersionIds
    .map((versionId) => inventoryCatalogTargetLabel(data, { kind: 'type-version', versionId }))
    .join('; ')}.`;
}

export function InventoryCatalogEligibilityNotice({
  data,
  eligibility,
}: {
  data: InventoryData;
  eligibility: InventoryCatalogEligibility | null | undefined;
}) {
  if (eligibility?.kind === 'selectable') return null;
  return (
    <Notice tone="warning">
      <div data-testid="inventory-catalog-eligibility" className="space-y-1">
        {eligibility?.kind === 'blocked' ? (
          eligibility.blockers.map((blocker, index) => (
            <p key={index} data-catalog-blocker={blocker.code}>
              {inventoryCatalogBlockerText(data, blocker)}
            </p>
          ))
        ) : (
          <p>The catalog selection status is unavailable.</p>
        )}
      </div>
    </Notice>
  );
}

export function InventoryCatalogVersionState({
  status,
}: {
  status: InventoryCatalogVersionStatus | undefined;
}) {
  return (
    <div
      data-testid="inventory-catalog-version-state"
      data-version-id={status?.target.versionId}
      data-relationship={status?.relationship}
      data-selection={status?.selection.kind}
      className="space-y-1 text-xs"
    >
      <p className="font-medium">
        {status
          ? `${status.relationship === 'current' ? 'Current' : 'Superseded'} · ${
              status.selection.kind === 'available' ? 'Available' : 'Retired'
            }`
          : 'Selection status unavailable'}
      </p>
      {status?.selection.kind === 'retired' ? (
        <>
          <p>Retirement reason: {status.selection.reason}</p>
          <p className="text-fg-muted">Retired {new Date(status.selection.at).toLocaleString()}</p>
        </>
      ) : null}
    </div>
  );
}

export function InventoryCatalogVersionActions({
  data,
  target,
  editable,
  onDialog,
}: {
  data: InventoryData;
  target: InventoryCatalogTarget;
  editable: boolean;
  onDialog(dialog: InventoryDialog): void;
}) {
  const status = inventoryCatalogStatusAt(data, target);
  return (
    <>
      {status?.actions.retire ? (
        <Button
          disabled={!editable}
          onClick={() => onDialog({ kind: 'catalog-lifecycle', target, action: 'retire' })}
        >
          Retire version
        </Button>
      ) : null}
      {status?.actions.restore ? (
        <Button
          disabled={!editable}
          onClick={() => onDialog({ kind: 'catalog-lifecycle', target, action: 'restore' })}
        >
          Restore version
        </Button>
      ) : null}
    </>
  );
}
