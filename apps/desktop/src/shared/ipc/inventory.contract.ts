import { defineGroup, event, invoke } from './contract';
import type { InventoryEquipmentCatalogEntry, InventoryState } from '@waypoint/domain-services';
import type {
  InventoryChanged,
  InventoryCatalogQuery,
  InventoryAvailabilitySnapshot,
  InventoryExecuteRequest,
  InventoryHistoryRequest,
  InventoryMaterialPage,
  InventoryMaterialQuery,
  InventoryOperationRequest,
  InventoryProject,
  InventoryReadRequest,
  NativeInventoryExecution,
  NativeInventoryHistoryEntry,
  NativeInventoryReceipt,
} from '../inventory-client';

export const inventoryContract = defineGroup('inventory', {
  projects: invoke<[], readonly InventoryProject[]>(),
  catalog: invoke<[request: InventoryCatalogQuery], readonly InventoryEquipmentCatalogEntry[]>(),
  materials: invoke<[request: InventoryMaterialQuery], InventoryMaterialPage>(),
  inspect: invoke<[request: InventoryReadRequest], InventoryState | null>(),
  availability: invoke<[request: InventoryReadRequest], InventoryAvailabilitySnapshot | null>(),
  execute: invoke<[request: InventoryExecuteRequest], NativeInventoryExecution>(),
  operation: invoke<[request: InventoryOperationRequest], NativeInventoryReceipt | null>(),
  history: invoke<[request: InventoryHistoryRequest], readonly NativeInventoryHistoryEntry[]>(),
  onChanged: event<[event: InventoryChanged]>().channel('inventory:changed'),
});
