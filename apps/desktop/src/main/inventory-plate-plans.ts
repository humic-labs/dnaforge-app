import {
  applyInventoryPlatePlanVersion,
  type InventoryState,
  type InventoryExecutionContext,
} from '@waypoint/domain-services';
import type { InventoryApplyPlatePlanVersionRequest } from '../shared/inventory-plate-plans';

export function applyNativeInventoryPlatePlanVersion(
  state: InventoryState,
  request: InventoryApplyPlatePlanVersionRequest,
  context: InventoryExecutionContext
) {
  const result = applyInventoryPlatePlanVersion(
    state,
    {
      ...request.choices,
      target: {
        projectId: request.project,
        inventoryId: request.inventoryId,
        present: state.revision !== 0,
        revision: state.revision,
      },
      expectedPlanDigest: request.expectedPlanDigest,
    },
    context
  );
  if (result.ok && result.state.revision !== state.revision + 1)
    throw Error('INVENTORY_DATA_INVALID: A committed plan save must append a new version.');
  return result;
}
