import type { InventoryAmount } from './inventory-amount';
import { normalizeInventoryAmount } from './inventory-amount';
import { assertInventoryActorScope } from './inventory-actor-scope';
import type {
  InventoryOrganizationAction,
  InventoryOrganizationExecutionContext,
  InventoryOrganizationTarget,
} from './inventory-organization-types';
import { applyInventoryParsedCommandBatch } from './inventory-state';
import {
  createInventoryState,
  MAX_INVENTORY_BATCH_COMMANDS,
  type InventoryCommand,
  type InventoryState,
  type InventoryTransition,
} from './inventory-types';
import {
  InventoryValidationError,
  parseInventoryCommand,
  parseInventoryCommandBatch,
  parseInventoryReason,
  parseInventoryOrganizationExecutionContext,
  parseInventoryState,
} from './inventory-validation';

function row(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InventoryValidationError('An organization action object is required.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)))
    throw new InventoryValidationError(`Expected exactly these action fields: ${keys.join(', ')}.`);
  return record;
}
function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_INVENTORY_BATCH_COMMANDS)
    throw new InventoryValidationError('A bounded organization setup list is required.');
  return value;
}
export function parseInventoryOrganizationAction(value: unknown): InventoryOrganizationAction {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InventoryValidationError('An organization action is required.');
  if (Reflect.get(value, 'kind') !== 'bootstrap') {
    const command = parseInventoryCommand(value);
    if (
      command.kind !== 'consume' &&
      command.kind !== 'move-storage' &&
      command.kind !== 'move-vessel'
    )
      throw new InventoryValidationError('This command is not an organization inventory action.');
    if (command.kind === 'consume' && normalizeInventoryAmount(command.quantity).value === '0')
      throw new InventoryValidationError('Consumption requires a positive amount.');
    return command;
  }
  const input = row(value, ['kind', 'reason', 'storage', 'vessels', 'stocks']);
  const reason = parseInventoryReason(input.reason);
  const storage = list(input.storage).map((value) => {
    const command = parseInventoryCommand(value);
    if (command.kind !== 'create-layout-storage')
      throw new InventoryValidationError('Setup requires storage definitions.');
    return command;
  });
  const vessels = list(input.vessels).map((value) => {
    const command = parseInventoryCommand(value);
    if (command.kind !== 'create-vessel')
      throw new InventoryValidationError('Setup requires vessel definitions.');
    return command;
  });
  const stocks = list(input.stocks).map((value) => {
    const input = row(value, ['id', 'vesselId', 'materialId', 'quantity', 'quality']);
    const quantity = row(input.quantity, ['value', 'unit']);
    const command = parseInventoryCommand({
      ...input,
      kind: 'receive-stock',
      quantity: { kind: 'known', ...quantity },
    });
    if (
      command.kind !== 'receive-stock' ||
      command.quantity.kind !== 'known' ||
      normalizeInventoryAmount(command.quantity).value === '0'
    )
      throw new InventoryValidationError('Setup stock requires a positive known quantity.');
    const amount: InventoryAmount = { value: command.quantity.value, unit: command.quantity.unit };
    return {
      id: command.id,
      vesselId: command.vesselId,
      materialId: command.materialId,
      quantity: amount,
      quality: command.quality,
    };
  });
  const count = storage.length + vessels.length + stocks.length;
  if (count < 1 || count > MAX_INVENTORY_BATCH_COMMANDS)
    throw new InventoryValidationError('Organization setup exceeds the command bounds.');
  return { kind: 'bootstrap', reason, storage, vessels, stocks };
}

export function applyInventoryOrganizationAction(
  state: InventoryState | null,
  input: {
    readonly target: InventoryOrganizationTarget;
    readonly expectedRevision: number;
    readonly action: InventoryOrganizationAction;
    readonly context: InventoryOrganizationExecutionContext;
    readonly admittedMaterialIds: readonly string[];
  }
): InventoryTransition {
  try {
    const context = parseInventoryOrganizationExecutionContext(input.context);
    const target = row(input.target, ['kind', 'orgId', 'inventoryId']);
    if (
      target.kind !== 'organization-inventory' ||
      target.orgId !== context.authority.orgId ||
      target.inventoryId !== context.authority.inventoryId
    )
      throw new InventoryValidationError(
        'The organization authority does not match the inventory target.'
      );
    const action = parseInventoryOrganizationAction(input.action);
    const previous = state === null ? createInventoryState() : parseInventoryState(state);
    assertInventoryActorScope(previous, input.target);
    if (state === null && action.kind !== 'bootstrap')
      return {
        ok: false,
        code: 'INVALID_INVENTORY_INPUT',
        message: 'An organization inventory requires explicit setup.',
      };
    let commands: readonly InventoryCommand[];
    if (action.kind === 'bootstrap') {
      if (
        previous.revision !== 0 ||
        previous.origin.kind !== 'native' ||
        Object.values(previous).some(
          (value) =>
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.keys(value).length > 0 &&
            value !== previous.origin
        )
      )
        return {
          ok: false,
          code: 'INVALID_INVENTORY_INPUT',
          message: 'Organization setup requires an empty revision zero inventory.',
        };
      if (
        !Array.isArray(input.admittedMaterialIds) ||
        action.stocks.some((stock) => !input.admittedMaterialIds.includes(stock.materialId))
      )
        return {
          ok: false,
          code: 'INVALID_INVENTORY_INPUT',
          message: 'Setup materials require organization admission.',
        };
      commands = [
        ...action.storage,
        ...action.vessels,
        ...action.stocks.map((stock) => ({
          ...stock,
          kind: 'receive-stock' as const,
          quantity: { kind: 'known' as const, ...stock.quantity },
        })),
      ];
    } else commands = [action];
    const batch = parseInventoryCommandBatch({
      expectedRevision: input.expectedRevision,
      commands,
    });
    const result = applyInventoryParsedCommandBatch(previous, batch, context);
    if (result.ok) assertInventoryActorScope(result.state, input.target);
    return result;
  } catch (error) {
    if (error instanceof TypeError)
      return { ok: false, code: 'INVALID_INVENTORY_INPUT', message: error.message };
    throw error;
  }
}
