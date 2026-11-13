import type { AssemblyWorkbenchEditableField } from './AssemblyWorkbenchContract';

export type AssemblyWorkbenchEditInteractionKind = 'field-handle' | 'source-register';

export interface AssemblyWorkbenchEditTransaction {
  id: string;
  field: AssemblyWorkbenchEditableField;
  interactionKind: AssemblyWorkbenchEditInteractionKind;
  startClientX: number;
  startValue: number;
  pxPerBase: number;
  dragScale: number;
  latestClientX: number;
  latestVisualOffsetPx: number;
  latestValue: number;
}

export interface AssemblyWorkbenchEditTransactionUpdate {
  transaction: AssemblyWorkbenchEditTransaction;
  visualOffsetChanged: boolean;
  snappedValueChanged: boolean;
}

export function beginAssemblyWorkbenchEditTransaction(input: {
  field: AssemblyWorkbenchEditableField;
  interactionKind: AssemblyWorkbenchEditInteractionKind;
  startClientX: number;
  pxPerBase: number;
  dragScale: number;
}): AssemblyWorkbenchEditTransaction {
  const startValue = numericFieldValue(input.field);
  return {
    id: `${input.interactionKind}:${input.field.id}`,
    field: input.field,
    interactionKind: input.interactionKind,
    startClientX: input.startClientX,
    startValue,
    pxPerBase: normalizePxPerBase(input.pxPerBase),
    dragScale: input.dragScale,
    latestClientX: input.startClientX,
    latestVisualOffsetPx: 0,
    latestValue: startValue,
  };
}

export function updateAssemblyWorkbenchEditTransaction(
  transaction: AssemblyWorkbenchEditTransaction,
  clientX: number
): AssemblyWorkbenchEditTransactionUpdate {
  const latestVisualOffsetPx = clampVisualOffsetPx(transaction, clientX - transaction.startClientX);
  const latestValue = fieldValueForVisualOffset(transaction, latestVisualOffsetPx);
  return {
    transaction: {
      ...transaction,
      latestClientX: clientX,
      latestVisualOffsetPx,
      latestValue,
    },
    visualOffsetChanged: latestVisualOffsetPx !== transaction.latestVisualOffsetPx,
    snappedValueChanged: latestValue !== transaction.latestValue,
  };
}

export function cancelAssemblyWorkbenchEditTransaction(
  transaction: AssemblyWorkbenchEditTransaction
): AssemblyWorkbenchEditTransaction {
  return {
    ...transaction,
    latestClientX: transaction.startClientX,
    latestVisualOffsetPx: 0,
    latestValue: transaction.startValue,
  };
}

export function fieldValueForVisualOffset(
  transaction: AssemblyWorkbenchEditTransaction,
  visualOffsetPx: number
): number {
  const baseDelta = (visualOffsetPx / transaction.pxPerBase) * transaction.dragScale;
  return clampEditableFieldValue(transaction.field, transaction.startValue + baseDelta);
}

export function clampEditableFieldValue(
  field: AssemblyWorkbenchEditableField,
  value: number
): number {
  const rounded = Math.round(value);
  if (!field.range) return rounded;
  return Math.max(field.range.min, Math.min(field.range.max, rounded));
}

export function sourceRegisterDragScaleForField(field: AssemblyWorkbenchEditableField): number {
  if (field.kind !== 'sourceContributionBoundary') return 1;
  return -1;
}

function numericFieldValue(field: AssemblyWorkbenchEditableField): number {
  if (field.units !== 'bp' || typeof field.value !== 'number') {
    throw new Error(`Editable field ${field.id} is not a numeric bp field.`);
  }
  return clampEditableFieldValue(field, field.value);
}

function clampVisualOffsetPx(
  transaction: AssemblyWorkbenchEditTransaction,
  visualOffsetPx: number
): number {
  const range = transaction.field.range;
  if (!range) return visualOffsetPx;
  const minDx =
    ((range.min - transaction.startValue) / transaction.dragScale) * transaction.pxPerBase;
  const maxDx =
    ((range.max - transaction.startValue) / transaction.dragScale) * transaction.pxPerBase;
  return Math.max(Math.min(minDx, maxDx), Math.min(Math.max(minDx, maxDx), visualOffsetPx));
}

function normalizePxPerBase(pxPerBase: number): number {
  return Number.isFinite(pxPerBase) && pxPerBase > 0 ? pxPerBase : 1;
}
