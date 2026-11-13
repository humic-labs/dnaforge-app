import { describe, expect, it } from 'vitest';
import type { RenderedPrimerSegment } from '@waypoint/workspace-editor';
import type { AssemblyWorkbenchEditableField } from './AssemblyWorkbenchContract';
import { projectFieldHandlesForRow } from './JunctionFieldHandleProjection';
import type { JunctionWorkbenchRow } from './model';

describe('projectFieldHandlesForRow', () => {
  it('renders product PBS handles without reintroducing product primer-tail handles', () => {
    const sourceRow = row('left', 'left-source');
    const productRow = {
      ...row('product', 'product'),
      constraints: [
        {
          kind: 'homology-width' as const,
          startBioCol: -4,
          endBioCol: 6,
          editable: true,
          label: '10 bp overlap',
        },
      ],
    };
    const fields = [sourceBoundaryField(), primerTailField(), primerPbsField(), homologyArmField()];
    const primerSegments = [primerSegment('p1', 'tail'), primerSegment('p2', 'pbs')];

    expect(
      projectFieldHandlesForRow({
        row: sourceRow,
        fields,
        primerSegments,
        height: 100,
        screenXForBioCol: (bioCol) => bioCol * 8,
      }).map((handle) => handle.kind)
    ).toEqual(['primerPbs']);

    const productHandles = projectFieldHandlesForRow({
      row: productRow,
      fields,
      primerSegments,
      height: 100,
      screenXForBioCol: (bioCol) => bioCol * 8,
    });
    expect(productHandles.map((handle) => handle.kind)).toEqual(['primerPbs', 'homologyArm']);
    expect(productHandles[0]).toMatchObject({
      kind: 'primerPbs',
      rowId: 'product',
      role: 'pbs-start',
      x: 80,
      y: 10,
      height: 12,
      guideStartY: 10,
    });
    expect(productHandles[1]).toMatchObject({
      y: 48,
      height: 52,
    });
  });

  it('clips primer handle guides to the affected primer strand', () => {
    const productRow = row('product', 'product');
    const reverseField: AssemblyWorkbenchEditableField = {
      ...primerPbsField(),
      id: 'reverse-primer-pbs',
      target: { junctionIndex: 0, primerId: 'p3', side: 'right' },
      anchors: [
        { rowId: 'product', rowKind: 'product', bioCol: 0, role: 'pbs-start' },
        { rowId: 'product', rowKind: 'product', bioCol: 20, role: 'pbs-end' },
      ],
    };

    const handles = projectFieldHandlesForRow({
      row: productRow,
      fields: [primerPbsField(), reverseField],
      primerSegments: [
        primerSegment('p2', 'pbs', { direction: 'forward', y: 10, height: 12 }),
        primerSegment('p3', 'pbs', { direction: 'reverse', y: 64, height: 12 }),
      ],
      height: 100,
      screenXForBioCol: (bioCol) => bioCol * 8,
    });

    expect(
      handles.map((handle) => ({
        id: handle.field.id,
        role: handle.role,
        y: handle.y,
        height: handle.height,
        guideStartY: handle.guideStartY,
      }))
    ).toEqual([
      { id: 'primer-pbs', role: 'pbs-start', y: 10, height: 12, guideStartY: 10 },
      { id: 'reverse-primer-pbs', role: 'pbs-end', y: 64, height: 12, guideStartY: 76 },
    ]);
  });

  it('keeps a primer handle at the drawn primer boundary while its binding segment is culled', () => {
    const productRow: JunctionWorkbenchRow = {
      ...row('product', 'product'),
      primers: [
        {
          id: 'p2',
          name: 'reverse primer',
          start: 15,
          end: 55,
          direction: 'reverse',
          bases: 'A'.repeat(40),
          overhangLength: 15,
        },
        {
          id: 'p3',
          name: 'forward primer',
          start: 30,
          end: 72,
          direction: 'forward',
          bases: 'A'.repeat(42),
          overhangLength: 12,
        },
      ],
    };
    const forwardField: AssemblyWorkbenchEditableField = {
      ...primerPbsField(),
      id: 'forward-primer-pbs',
      target: { junctionIndex: 0, primerId: 'p3', side: 'right' },
      anchors: [
        { rowId: 'product', rowKind: 'product', bioCol: 0, role: 'pbs-start' },
        { rowId: 'product', rowKind: 'product', bioCol: 30, role: 'pbs-end' },
      ],
    };

    const handles = projectFieldHandlesForRow({
      row: productRow,
      fields: [primerPbsField(), forwardField],
      primerSegments: [primerSegment('p2', 'tail')],
      height: 100,
      screenXForBioCol: (bioCol) => 8 + (40 + bioCol) * 8,
    });

    expect(
      handles.map((handle) => [handle.field.id, handle.role, handle.x, handle.geometryPending])
    ).toEqual([
      ['primer-pbs', 'pbs-start', 8 + 15 * 8, true],
      ['forward-primer-pbs', 'pbs-end', 8 + 72 * 8, true],
    ]);
  });

  it('uses the drawn binding segment once the primer is in view', () => {
    const productRow: JunctionWorkbenchRow = {
      ...row('product', 'product'),
      primers: [
        {
          id: 'p2',
          name: 'reverse primer',
          start: 15,
          end: 55,
          direction: 'reverse',
          bases: 'A'.repeat(40),
          overhangLength: 15,
        },
      ],
    };

    const handles = projectFieldHandlesForRow({
      row: productRow,
      fields: [primerPbsField()],
      primerSegments: [primerSegment('p2', 'pbs')],
      height: 100,
      screenXForBioCol: (bioCol) => 8 + (40 + bioCol) * 8,
    });

    expect(handles).toHaveLength(1);
    expect(handles[0].x).toBe(80);
    expect(handles[0].geometryPending).toBeUndefined();
  });

  it('projects no primer handle for a row that does not draw that primer', () => {
    expect(
      projectFieldHandlesForRow({
        row: row('product', 'product'),
        fields: [primerPbsField()],
        primerSegments: [],
        height: 100,
        screenXForBioCol: (bioCol) => bioCol * 8,
      })
    ).toEqual([]);
  });

  it('projects product overlap handles from spacer-inclusive crossover geometry', () => {
    const productRow = {
      ...row('product', 'product'),
      constraints: [
        {
          kind: 'homology-width' as const,
          startBioCol: -2,
          endBioCol: 7,
          editable: true,
          label: '9 bp crossover',
        },
      ],
    };
    const fields = [
      homologyArmField({ id: 'left-homology', side: 'left', value: 5, oppositeValue: 4 }),
      homologyArmField({ id: 'right-homology', side: 'right', value: 4, oppositeValue: 5 }),
    ];

    const handles = projectFieldHandlesForRow({
      row: productRow,
      fields,
      primerSegments: [],
      height: 100,
      screenXForBioCol: (bioCol) => bioCol * 8,
    });

    expect(handles.map((handle) => [handle.field.id, handle.x, handle.role])).toEqual([
      ['left-homology', -16, 'tail-start'],
      ['right-homology', 56, 'tail-end'],
    ]);
  });

  it('projects disabled homology arms as constrained product overlap markers', () => {
    const productRow = {
      ...row('product', 'product'),
      constraints: [
        {
          kind: 'homology-width' as const,
          startBioCol: -18,
          endBioCol: 4,
          editable: true,
          label: '18 bp crossover',
        },
      ],
    };
    const fields = [
      homologyArmField({ id: 'left-rd-homology', side: 'left', value: 18, oppositeValue: 0 }),
      homologyArmField({
        id: 'right-locked-homology',
        side: 'right',
        value: 0,
        oppositeValue: 18,
        disabled: true,
      }),
    ];

    const handles = projectFieldHandlesForRow({
      row: productRow,
      fields,
      primerSegments: [],
      height: 100,
      screenXForBioCol: (bioCol) => bioCol * 8,
    });

    expect(handles.map((handle) => [handle.field.id, handle.disabled, handle.role])).toEqual([
      ['left-rd-homology', undefined, 'tail-start'],
      ['right-locked-homology', true, 'tail-end'],
    ]);
  });

  it('projects Golden Gate product offset handles at the scar center, not a cut edge', () => {
    const productRow = {
      ...row('product', 'product'),
      spacerColumns: [40, 41, 42],
      constraints: [
        {
          kind: 'fixed-overhang' as const,
          startBioCol: 1,
          endBioCol: 5,
          editable: true,
          label: 'PCR-designed overhang',
        },
      ],
    };

    const handles = projectFieldHandlesForRow({
      row: productRow,
      fields: [goldenGateOverhangField()],
      primerSegments: [],
      height: 100,
      screenXForBioCol: (bioCol) => bioCol * 8,
    });

    expect(handles).toHaveLength(1);
    expect(handles[0]).toMatchObject({
      kind: 'goldenGateOverhang',
      role: 'boundary',
      x: 24,
      y: 48,
      height: 52,
      dragScale: 1,
    });
  });
});

function row(id: string, kind: JunctionWorkbenchRow['kind']): JunctionWorkbenchRow {
  return {
    id,
    kind,
    label: id,
    sequence: 'A'.repeat(80),
    coordinateStart: 0,
    anchorRowPosition: 40,
    points: Array.from({ length: 80 }, (_, rowPosition) => ({
      rowId: id,
      bioCol: rowPosition - 40,
      rowPosition,
      productPosition: kind === 'product' ? rowPosition : null,
      kind: 'valid',
      editable: true,
    })),
    annotations: [],
  };
}

function sourceBoundaryField(): AssemblyWorkbenchEditableField {
  return {
    id: 'source-boundary',
    kind: 'sourceContributionBoundary',
    label: 'Source boundary',
    target: { junctionIndex: 0, side: 'downstream' },
    value: 40,
    units: 'bp',
    range: { min: 10, max: 70, step: 1, largeStep: 5 },
    anchors: [{ rowId: 'left', rowKind: 'left-source', bioCol: 0, role: 'boundary' }],
    command: { type: 'setEditableField', payload: {}, valueKey: 'sourcePosition' },
    constraints: [],
  };
}

function primerTailField(): AssemblyWorkbenchEditableField {
  return {
    id: 'primer-tail',
    kind: 'primerTail',
    label: 'Primer tail',
    target: { junctionIndex: 0, primerId: 'p1', side: 'left' },
    value: 20,
    units: 'bp',
    range: { min: 0, max: 60, step: 1, largeStep: 5 },
    anchors: [
      { rowId: 'product', rowKind: 'product', bioCol: -20, role: 'tail-start' },
      { rowId: 'product', rowKind: 'product', bioCol: 0, role: 'tail-end' },
    ],
    command: { type: 'setEditableField', payload: {}, valueKey: 'length' },
    constraints: [],
  };
}

function primerPbsField(): AssemblyWorkbenchEditableField {
  return {
    id: 'primer-pbs',
    kind: 'primerPbs',
    label: 'Primer PBS',
    target: { junctionIndex: 0, primerId: 'p2', side: 'left' },
    value: 20,
    units: 'bp',
    range: { min: 4, max: 60, step: 1, largeStep: 5 },
    anchors: [
      { rowId: 'left', rowKind: 'left-source', bioCol: -20, role: 'pbs-start' },
      { rowId: 'left', rowKind: 'left-source', bioCol: 0, role: 'pbs-end' },
      { rowId: 'product', rowKind: 'product', bioCol: -20, role: 'pbs-start' },
      { rowId: 'product', rowKind: 'product', bioCol: 0, role: 'pbs-end' },
    ],
    command: { type: 'setEditableField', payload: {}, valueKey: 'length' },
    constraints: [],
  };
}

function homologyArmField(
  overrides: {
    id?: string;
    side?: 'left' | 'right';
    value?: number;
    oppositeValue?: number;
    disabled?: boolean;
  } = {}
): AssemblyWorkbenchEditableField {
  const side = overrides.side ?? 'left';
  const value = overrides.value ?? 4;
  const oppositeValue = overrides.oppositeValue ?? 4;
  const encoding =
    side === 'left'
      ? { onLeft: value, onRight: oppositeValue }
      : { onLeft: oppositeValue, onRight: value };
  const rowId = side === 'left' ? 'left' : 'right';
  const rowKind = side === 'left' ? 'left-source' : 'right-source';
  return {
    id: overrides.id ?? 'homology',
    kind: 'homologyArm',
    label: `${side} homology`,
    target: { junctionIndex: 0, side },
    value,
    units: 'bp',
    range: { min: 0, max: 60, step: 1, largeStep: 5 },
    anchors: [
      { rowId, rowKind, bioCol: side === 'left' ? -value : 0, role: 'tail-start' },
      { rowId, rowKind, bioCol: side === 'left' ? 0 : value, role: 'tail-end' },
    ],
    command: {
      type: 'setEditableField',
      payload: { encoding },
      valueKey: side === 'left' ? 'encoding.onLeft' : 'encoding.onRight',
    },
    constraints: [],
    disabled: overrides.disabled,
  };
}

function goldenGateOverhangField(): AssemblyWorkbenchEditableField {
  return {
    id: 'goldengate-overhang',
    kind: 'goldenGateOverhang',
    label: 'Golden Gate offset',
    target: { junctionIndex: 0 },
    value: 0,
    units: 'bp',
    range: { min: -24, max: 24, step: 1, largeStep: 5 },
    anchors: [{ rowId: 'product', rowKind: 'product', bioCol: 3, role: 'boundary' }],
    command: { type: 'setEditableField', payload: { offset: 0 }, valueKey: 'offset' },
    constraints: [],
  };
}

function primerSegment(
  primerId: string,
  role: RenderedPrimerSegment['role'],
  overrides: Partial<Pick<RenderedPrimerSegment, 'direction' | 'y' | 'height'>> = {}
): RenderedPrimerSegment {
  const direction = overrides.direction ?? 'forward';
  return {
    primer: {
      id: primerId,
      name: primerId,
      start: 10,
      end: 30,
      direction,
      bases: 'A'.repeat(20),
      tm: 60,
      gc: 50,
    },
    primerId,
    direction,
    role,
    start: 10,
    end: 30,
    primerBaseStart: 0,
    primerBaseEnd: 20,
    x: 80,
    y: overrides.y ?? 10,
    width: 120,
    height: overrides.height ?? 12,
    lane: 0,
    cycleOffset: 0,
  };
}
