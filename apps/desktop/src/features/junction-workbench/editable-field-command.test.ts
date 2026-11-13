// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { AssemblyWorkbenchEditableField } from './AssemblyWorkbenchContract';
import { resolveEditableFieldCommand } from './editable-field-command';

describe('resolveEditableFieldCommand', () => {
  it('resolves nested homology encoding payloads', () => {
    const field = editableField({
      kind: 'homologyArm',
      value: 18,
      command: {
        type: 'setHomologyEncoding',
        payload: {
          junctionId: 'j1',
          junctionIndex: 0,
          encoding: { onLeft: 18, onRight: 20 },
        },
        valueKey: 'encoding.onLeft',
      },
    });

    const result = resolveEditableFieldCommand(field, 23, {
      expectedDesignVersion: 4,
      recomputePrimers: false,
    });

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.command).toEqual({
      type: 'setHomologyEncoding',
      junctionId: 'j1',
      junctionIndex: 0,
      encoding: { onLeft: 23, onRight: 20 },
      expectedDesignVersion: 4,
      recomputePrimers: false,
    });
  });

  it('clamps numeric values to the manifest range', () => {
    const field = editableField({
      kind: 'primerPbs',
      value: 20,
      range: { min: 10, max: 60, step: 1, largeStep: 5 },
      command: {
        type: 'setPrimerPbsLength',
        payload: { primerId: 'p1', length: 20 },
        valueKey: 'length',
      },
    });

    const result = resolveEditableFieldCommand(field, 100, { expectedDesignVersion: 9 });

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.value).toBe(60);
    expect(result.command).toEqual({
      type: 'setPrimerPbsLength',
      primerId: 'p1',
      length: 60,
      expectedDesignVersion: 9,
    });
  });

  it('rejects disabled fields', () => {
    const result = resolveEditableFieldCommand(editableField({ disabled: true }), 12);
    expect(result).toMatchObject({ status: 'rejected', reason: 'disabled' });
  });
});

function editableField(
  overrides: Partial<AssemblyWorkbenchEditableField> = {}
): AssemblyWorkbenchEditableField {
  return {
    id: 'field',
    kind: 'sourceContributionBoundary',
    label: 'Field',
    target: { junctionIndex: 0 },
    value: 20,
    units: 'bp',
    range: { min: 0, max: 100, step: 1, largeStep: 10 },
    anchors: [{ rowId: 'row', rowKind: 'left-source', bioCol: 0, role: 'boundary' }],
    command: {
      type: 'setSourceContributionBoundary',
      payload: { regionId: 'r1', side: 'downstream', sourcePosition: 20 },
      valueKey: 'sourcePosition',
    },
    constraints: [],
    ...overrides,
  };
}
