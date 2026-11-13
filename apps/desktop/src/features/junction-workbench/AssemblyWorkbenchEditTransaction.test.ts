// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { AssemblyWorkbenchEditableField } from './AssemblyWorkbenchContract';
import {
  beginAssemblyWorkbenchEditTransaction,
  cancelAssemblyWorkbenchEditTransaction,
  sourceRegisterDragScaleForField,
  updateAssemblyWorkbenchEditTransaction,
} from './AssemblyWorkbenchEditTransaction';

describe('AssemblyWorkbenchEditTransaction', () => {
  it('keeps continuous visual motion separate from snapped bp values', () => {
    let transaction = beginAssemblyWorkbenchEditTransaction({
      field: numericField({ value: 20 }),
      interactionKind: 'field-handle',
      startClientX: 100,
      pxPerBase: 8,
      dragScale: 1,
    });

    let update = updateAssemblyWorkbenchEditTransaction(transaction, 103);
    transaction = update.transaction;
    expect(update.visualOffsetChanged).toBe(true);
    expect(update.snappedValueChanged).toBe(false);
    expect(transaction.latestVisualOffsetPx).toBe(3);
    expect(transaction.latestValue).toBe(20);

    update = updateAssemblyWorkbenchEditTransaction(transaction, 105);
    transaction = update.transaction;
    expect(update.visualOffsetChanged).toBe(true);
    expect(update.snappedValueChanged).toBe(true);
    expect(transaction.latestVisualOffsetPx).toBe(5);
    expect(transaction.latestValue).toBe(21);
  });

  it('uses the same transaction math for source viewport register edits', () => {
    const field = numericField({
      kind: 'sourceContributionBoundary',
      value: 760,
      min: 700,
      max: 900,
    });
    const transaction = beginAssemblyWorkbenchEditTransaction({
      field,
      interactionKind: 'source-register',
      startClientX: 400,
      pxPerBase: 8,
      dragScale: sourceRegisterDragScaleForField(field),
    });

    const update = updateAssemblyWorkbenchEditTransaction(transaction, 424);

    expect(update.transaction.latestVisualOffsetPx).toBe(24);
    expect(update.transaction.latestValue).toBe(757);
  });

  it('clamps both visual movement and semantic value to the editable range', () => {
    const transaction = beginAssemblyWorkbenchEditTransaction({
      field: numericField({ value: 12, min: 10, max: 15 }),
      interactionKind: 'field-handle',
      startClientX: 0,
      pxPerBase: 10,
      dragScale: 1,
    });

    const update = updateAssemblyWorkbenchEditTransaction(transaction, 1000);

    expect(update.transaction.latestVisualOffsetPx).toBe(30);
    expect(update.transaction.latestValue).toBe(15);
  });

  it('can cancel back to the transaction start without committing a draft value', () => {
    const transaction = beginAssemblyWorkbenchEditTransaction({
      field: numericField({ value: 24 }),
      interactionKind: 'field-handle',
      startClientX: 50,
      pxPerBase: 8,
      dragScale: 1,
    });
    const updated = updateAssemblyWorkbenchEditTransaction(transaction, 82).transaction;

    expect(updated.latestValue).toBe(28);
    expect(cancelAssemblyWorkbenchEditTransaction(updated)).toEqual(
      expect.objectContaining({
        latestClientX: 50,
        latestVisualOffsetPx: 0,
        latestValue: 24,
      })
    );
  });
});

function numericField(
  overrides: Partial<AssemblyWorkbenchEditableField> & {
    value?: number;
    min?: number;
    max?: number;
  } = {}
): AssemblyWorkbenchEditableField {
  const kind = overrides.kind ?? 'primerPbs';
  return {
    id: 'field',
    kind,
    label: 'Field',
    target: {
      junctionIndex: 0,
      side: kind === 'sourceContributionBoundary' ? 'downstream' : 'left',
    },
    value: overrides.value ?? 20,
    units: 'bp',
    range: {
      min: overrides.min ?? 10,
      max: overrides.max ?? 60,
      step: 1,
      largeStep: 5,
    },
    anchors: [
      {
        rowId: 'row',
        rowKind: kind === 'sourceContributionBoundary' ? 'left-source' : 'product',
        bioCol: 0,
        role: 'boundary',
      },
    ],
    command: {
      type:
        kind === 'sourceContributionBoundary'
          ? 'setSourceContributionBoundary'
          : 'setPrimerPbsLength',
      payload:
        kind === 'sourceContributionBoundary'
          ? { regionId: 'region', side: 'downstream', sourcePosition: overrides.value ?? 20 }
          : { primerId: 'primer', length: overrides.value ?? 20 },
      valueKey: kind === 'sourceContributionBoundary' ? 'sourcePosition' : 'length',
    },
    constraints: [],
    ...overrides,
  };
}
