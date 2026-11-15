import { useEffect, useState } from 'react';
import { Button, Notice } from '../../components/ui';
import type {
  InventoryCatalogState,
  InventoryController,
  InventoryControllerState,
  InventoryData,
} from './inventory-controller';
import type { InventoryDialog } from './inventory-view';
import type { InventoryPhysicalDialogKind } from './inventory-physical-view';
import { InventorySetup, type InventorySetupView } from './InventorySetup';
import { InventoryPhysicalTypeForm } from './InventoryPhysicalTypeForm';
import { InventoryEquipmentRecipeForm } from './InventoryEquipmentRecipeForm';
import { InventoryRecipeInstallForm } from './InventoryRecipeInstallForm';
import { InventoryConfigurationForm } from './InventoryConfigurationForm';
import { InventoryGeometryForm } from './InventoryGeometryForm';
import { InventoryFitEvidenceForm } from './InventoryFitEvidenceForm';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import { InventoryCatalogLifecycleForm } from './InventoryCatalogLifecycleForm';
import { InventoryCatalogPreview } from './InventoryCatalogPreview';

export function InventoryPhysicalWorkspace({
  dialog,
  data,
  controller,
  status,
  catalog,
  onDialog,
  onClose,
}: {
  dialog: InventoryPhysicalDialogKind;
  data: InventoryData;
  controller: InventoryController;
  status: InventoryControllerState;
  catalog: InventoryCatalogState;
  onDialog(dialog: InventoryDialog): void;
  onClose(): void;
}) {
  const [setupView, setSetupView] = useState<InventorySetupView>({ tab: 'types', query: '' });
  useEffect(() => {
    if (dialog.kind === 'install-catalog' || dialog.kind === 'catalog-preview')
      void controller.loadCatalog(data.project.projectId);
  }, [dialog.kind, controller, data.project.projectId]);
  const setup = () => onDialog({ kind: 'setup' });
  if (dialog.kind === 'setup')
    return (
      <InventorySetup
        data={data}
        controller={controller}
        status={status}
        catalog={catalog}
        view={setupView}
        onViewChange={setSetupView}
        onDialog={onDialog}
        onClose={onClose}
      />
    );
  if (dialog.kind === 'physical-type')
    return (
      <InventoryPhysicalTypeForm
        key={dialog.versionId ?? 'new'}
        data={data}
        source={dialog.versionId ? data.state.typeVersions[dialog.versionId] : undefined}
        controller={controller}
        status={status}
        onClose={setup}
      />
    );
  if (dialog.kind === 'catalog-lifecycle')
    return (
      <InventoryCatalogLifecycleForm
        key={`${dialog.target.kind}:${dialog.target.versionId}:${dialog.action}`}
        data={data}
        target={dialog.target}
        action={dialog.action}
        controller={controller}
        status={status}
        onClose={setup}
      />
    );
  if (dialog.kind === 'equipment-recipe')
    return (
      <InventoryEquipmentRecipeForm
        key={dialog.versionId ?? 'new'}
        data={data}
        source={dialog.versionId ? data.state.recipeVersions[dialog.versionId] : undefined}
        controller={controller}
        status={status}
        onClose={setup}
      />
    );
  if (dialog.kind === 'install-recipe')
    return (
      <InventoryRecipeInstallForm
        key={dialog.versionId}
        data={data}
        recipeVersionId={dialog.versionId}
        controller={controller}
        status={status}
        onClose={onClose}
      />
    );
  if (dialog.kind === 'install-catalog' || dialog.kind === 'catalog-preview') {
    const entry =
      catalog.kind === 'ready' && catalog.projectId === data.project.projectId
        ? catalog.entries.find((entry) => entry.id === dialog.catalogId)
        : undefined;
    return entry ? (
      dialog.kind === 'catalog-preview' ? (
        <InventoryCatalogPreview
          key={entry.id}
          data={data}
          entry={entry}
          controller={controller}
          status={status}
          onClose={setup}
        />
      ) : (
        <InventoryRecipeInstallForm
          key={entry.id}
          data={data}
          entry={entry}
          controller={controller}
          status={status}
          onClose={onClose}
        />
      )
    ) : (
      <InventoryPhysicalDialog
        title={dialog.kind === 'catalog-preview' ? 'Catalog update preview' : 'Add equipment'}
        controller={controller}
        status={status}
        onClose={setup}
      >
        <Notice tone={catalog.kind === 'failed' ? 'error' : 'neutral'}>
          {catalog.kind === 'failed' ? catalog.message : 'Loading equipment catalog…'}
        </Notice>
        <Button onClick={() => void controller.loadCatalog(data.project.projectId)}>
          Retry catalog
        </Button>
      </InventoryPhysicalDialog>
    );
  }
  if (dialog.kind === 'physical-configuration')
    return (
      <InventoryConfigurationForm
        key={dialog.item.id}
        data={data}
        item={dialog.item}
        controller={controller}
        status={status}
        onClose={onClose}
      />
    );
  if (dialog.kind === 'physical-geometry')
    return (
      <InventoryGeometryForm
        key={dialog.item.id}
        data={data}
        item={dialog.item}
        controller={controller}
        status={status}
        onClose={onClose}
      />
    );
  return (
    <InventoryFitEvidenceForm
      key={dialog.item.id}
      data={data}
      item={dialog.item}
      controller={controller}
      status={status}
      onClose={onClose}
    />
  );
}
