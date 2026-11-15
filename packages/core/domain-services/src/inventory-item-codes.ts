import type {
  InventoryCommand,
  InventoryExecutionContext,
  InventoryItemCode,
  InventoryItemCodeResolution,
  InventoryState,
  InventoryTransition,
} from './inventory-types';
import { inventoryRecordIdExists } from './inventory-configuration';
import { InventoryValidationError, parseInventoryItemCodeQuery } from './inventory-validation';

type Failure = Extract<InventoryTransition, { ok: false }>;
type ItemCodeDraft = Omit<InventoryState, 'schema' | 'revision' | 'itemCodes'> & {
  readonly itemCodes: Record<string, InventoryItemCode>;
};
const refuse = (code: Failure['code'], message: string): Failure => ({ ok: false, code, message });

export function inventoryResolveItemCode(
  state: Pick<InventoryState, 'itemCodes'>,
  input: unknown
): InventoryItemCodeResolution {
  let query;
  try {
    query = parseInventoryItemCodeQuery(input);
  } catch (error) {
    if (!(error instanceof InventoryValidationError)) throw error;
    return { kind: 'invalid', message: error.message };
  }
  const matches = Object.values(state.itemCodes)
    .filter(
      (code) =>
        code.value === query.value &&
        (query.namespace === null || code.namespace === query.namespace)
    )
    .sort((a, b) =>
      a.namespace < b.namespace
        ? -1
        : a.namespace > b.namespace
          ? 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0
    )
    .map((code) => structuredClone(code));
  if (!matches.length) return { kind: 'not-found' };
  if (matches.length > 1) return { kind: 'ambiguous', matches };
  const match = matches[0];
  return match.lifecycle.kind === 'active'
    ? { kind: 'resolved', match }
    : { kind: 'retired', match };
}

export function applyInventoryItemCodeCommand(
  state: ItemCodeDraft,
  command: InventoryCommand,
  context: InventoryExecutionContext | undefined
): Failure | null | undefined {
  if (command.kind !== 'attach-item-code' && command.kind !== 'retire-item-code') return undefined;
  if (!context)
    return refuse('CONTEXT_REQUIRED', 'Item codes require trusted actor and clock context.');
  if (command.kind === 'retire-item-code') {
    const code = state.itemCodes[command.codeId];
    if (!code) return refuse('ITEM_CODE_NOT_FOUND', 'The item code does not exist.');
    if (code.lifecycle.kind === 'retired')
      return refuse('ITEM_CODE_RETIRED', 'The item code is already retired.');
    state.itemCodes[code.id] = {
      ...code,
      lifecycle: {
        kind: 'retired',
        at: context.at,
        by: { ...context.principal },
        reason: command.reason,
      },
    };
    return null;
  }
  if (inventoryRecordIdExists(state, command.id))
    return refuse('ID_ALREADY_EXISTS', 'That inventory identifier already exists.');
  const item =
    command.item.kind === 'storage'
      ? state.storage[command.item.id]
      : state.vessels[command.item.id];
  if (!item)
    return refuse(
      command.item.kind === 'storage' ? 'STORAGE_NOT_FOUND' : 'VESSEL_NOT_FOUND',
      'The item code target does not exist.'
    );
  if ('kind' in item && item.kind === 'fixed-well')
    return refuse(
      'FIXED_WELL_IMMUTABLE',
      'A permanent well uses its plate identity and coordinate.'
    );
  if (item.lifecycle === 'disposed')
    return refuse(
      command.item.kind === 'storage' ? 'STORAGE_DISPOSED' : 'VESSEL_DISPOSED',
      'New codes require an active physical item.'
    );
  const duplicate = Object.values(state.itemCodes).find(
    (code) => code.namespace === command.namespace && code.value === command.value
  );
  if (duplicate)
    return duplicate.item.kind === command.item.kind && duplicate.item.id === command.item.id
      ? refuse(
          'ITEM_CODE_ALREADY_ASSIGNED',
          'This exact code is already assigned to the item, including any retired history.'
        )
      : refuse(
          'ITEM_CODE_CONFLICT',
          'This exact code is permanently assigned to another physical item.'
        );
  state.itemCodes[command.id] = {
    id: command.id,
    namespace: command.namespace,
    value: command.value,
    item: { ...command.item },
    assignedAt: context.at,
    assignedBy: { ...context.principal },
    reason: command.reason,
    lifecycle: { kind: 'active' },
  };
  return null;
}

export function validateInventoryItemCodes(
  state: Pick<InventoryState, 'itemCodes' | 'storage' | 'vessels' | 'lastRecordedAt'>
): void {
  const tuples = new Set<string>();
  for (const code of Object.values(state.itemCodes)) {
    const tuple = JSON.stringify([code.namespace, code.value]);
    if (tuples.has(tuple))
      throw new TypeError(
        'An item code tuple can only be assigned once, including retired history.'
      );
    tuples.add(tuple);
    const item =
      code.item.kind === 'storage' ? state.storage[code.item.id] : state.vessels[code.item.id];
    if (!item || ('kind' in item && item.kind === 'fixed-well'))
      throw new TypeError('An item code requires an existing storage item or movable vessel.');
    if (code.assignedAt > state.lastRecordedAt)
      throw new TypeError('An item code assignment cannot exceed the recorded clock.');
    if (
      code.lifecycle.kind === 'retired' &&
      (code.lifecycle.at < code.assignedAt || code.lifecycle.at > state.lastRecordedAt)
    )
      throw new TypeError('An item code retirement must follow assignment and the recorded clock.');
  }
}
