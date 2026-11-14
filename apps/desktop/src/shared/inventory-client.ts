import type {
  InventoryAvailability,
  InventoryPrincipal,
  InventoryState,
} from '@waypoint/domain-services';
import type {
  InventoryExecuteRequest,
  InventoryHistoryRequest,
  InventoryOperationRequest,
  InventoryReadRequest,
  NativeInventoryExecution,
  NativeInventoryHistoryEntry,
  NativeInventoryReceipt,
} from './inventory-command';

export interface InventoryProject {
  readonly projectId: string;
  readonly name: string;
  readonly path: string;
  readonly pinned: boolean;
  readonly defaultInventoryId: string;
}

export interface InventoryMaterial {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly registryId: string | null;
}

export interface InventoryMaterialQuery {
  readonly project: string;
  readonly query: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface InventoryMaterialPage {
  readonly items: readonly InventoryMaterial[];
  readonly nextCursor: string | null;
}

export interface InventoryChanged {
  readonly projectId: string;
  readonly inventoryId: string;
  readonly revision: number;
  readonly operationId: string;
}

export interface InventoryAvailabilitySnapshot extends InventoryAvailability {
  readonly revision: number;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
}

export interface InventoryClient {
  projects(): Promise<readonly InventoryProject[]>;
  materials(input: InventoryMaterialQuery): Promise<InventoryMaterialPage>;
  inspect(input: InventoryReadRequest): Promise<InventoryState | null>;
  availability(input: InventoryReadRequest): Promise<InventoryAvailabilitySnapshot | null>;
  execute(input: InventoryExecuteRequest): Promise<NativeInventoryExecution>;
  operation(input: InventoryOperationRequest): Promise<NativeInventoryReceipt | null>;
  history(input: InventoryHistoryRequest): Promise<readonly NativeInventoryHistoryEntry[]>;
  onChanged(listener: (event: InventoryChanged) => void): () => void;
}

export function unavailableInventoryClient(): InventoryClient {
  const unavailable = async (): Promise<never> => {
    throw new Error('INVENTORY_OWNER_UNAVAILABLE: Inventory requires the connected desktop owner.');
  };
  return {
    projects: unavailable,
    materials: unavailable,
    inspect: unavailable,
    availability: unavailable,
    execute: async (request) => ({
      status: 'rejected',
      inventoryId: request.inventoryId,
      operationId: request.operationId,
      code: 'INVENTORY_OWNER_UNAVAILABLE',
      message: 'Inventory requires the connected desktop owner.',
    }),
    operation: unavailable,
    history: unavailable,
    onChanged: () => () => {},
  };
}

export type {
  InventoryExecuteRequest,
  InventoryHistoryRequest,
  InventoryOperationRequest,
  InventoryReadRequest,
  NativeInventoryExecution,
  NativeInventoryHistoryEntry,
  NativeInventoryReceipt,
} from './inventory-command';
