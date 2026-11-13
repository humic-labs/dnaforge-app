import { describe, expect, it } from 'vitest';
import type { DesignRegion, SequenceDesign } from '../design/types';
import { computeDraftAssembly } from '../design/algorithms/draft-assembly';
import type { JunctionWorkbenchRow } from './model';
import { createAssemblyWorkbenchSession } from './AssemblyWorkbenchSession';
import {
  hasAnyEnabledSourceContributionBoundaryField,
  sourceContributionBoundaryFieldForRow,
  sourceRegisterDragCapabilityForProductOwner,
  sourceRegisterDragCapabilityForSourceRow,
} from './AssemblyWorkbenchInteractionCapabilities';

describe('AssemblyWorkbenchInteractionCapabilities', () => {
  it('maps source-row drags through enabled source-boundary manifest fields', () => {
    const design = draftedDesign('gibson');
    const session = createAssemblyWorkbenchSession(design);

    const leftRow = row('gibson-0-left', 'left-source');
    const capability = sourceRegisterDragCapabilityForSourceRow(leftRow, session.editableFields);

    expect(capability.status).toBe('enabled');
    if (capability.status !== 'enabled') return;
    expect(capability.owner).toBe('left');
    expect(capability.field.kind).toBe('sourceContributionBoundary');
    expect(capability.field.command.type).toBe('setSourceContributionBoundary');
    expect(sourceContributionBoundaryFieldForRow(leftRow, session.editableFields)?.id).toBe(
      capability.field.id
    );
  });

  it('maps product-row owner hits to the matching source-row capability', () => {
    const design = draftedDesign('gibson');
    const session = createAssemblyWorkbenchSession(design);
    const rows = [
      row('gibson-0-left', 'left-source'),
      row('gibson-0-right', 'right-source'),
      row('gibson-0-product', 'product'),
    ];

    const left = sourceRegisterDragCapabilityForProductOwner({
      owner: 'left',
      rows,
      fields: session.editableFields,
    });
    const right = sourceRegisterDragCapabilityForProductOwner({
      owner: 'right',
      rows,
      fields: session.editableFields,
    });

    expect(left.status).toBe('enabled');
    expect(right.status).toBe('enabled');
    if (left.status !== 'enabled' || right.status !== 'enabled') return;
    expect(left.activeRow.id).toBe('gibson-0-left');
    expect(right.activeRow.id).toBe('gibson-0-right');
    expect(left.field.id).not.toBe(right.field.id);
  });

  it('treats spacer product hits as non-source-register actions', () => {
    const design = draftedDesign('gibson');
    const session = createAssemblyWorkbenchSession(design);
    const rows = [
      row('gibson-0-left', 'left-source'),
      row('gibson-0-right', 'right-source'),
      row('gibson-0-product', 'product'),
    ];

    const capability = sourceRegisterDragCapabilityForProductOwner({
      owner: 'spacer',
      rows,
      fields: session.editableFields,
    });

    expect(capability).toMatchObject({
      status: 'disabled',
      reason: 'spacer-owner',
    });
  });

  it('keeps RD physical source boundaries disabled while allowing the adjacent PCR side', () => {
    const design = rdAdjacentDesign('left');
    const session = createAssemblyWorkbenchSession(design);
    const rows = [
      row('gibson-0-left', 'left-source'),
      row('gibson-0-right', 'right-source'),
      row('gibson-0-product', 'product'),
    ];

    const rdSource = sourceRegisterDragCapabilityForSourceRow(rows[0], session.editableFields);
    const pcrSource = sourceRegisterDragCapabilityForSourceRow(rows[1], session.editableFields);
    const productRdOwner = sourceRegisterDragCapabilityForProductOwner({
      owner: 'left',
      rows,
      fields: session.editableFields,
    });
    const productPcrOwner = sourceRegisterDragCapabilityForProductOwner({
      owner: 'right',
      rows,
      fields: session.editableFields,
    });

    expect(rdSource).toMatchObject({
      status: 'disabled',
      reason: 'disabled-source-boundary-field',
    });
    expect(pcrSource.status).toBe('enabled');
    expect(productRdOwner).toMatchObject({
      status: 'disabled',
      reason: 'disabled-source-boundary-field',
    });
    expect(productPcrOwner.status).toBe('enabled');
    expect(sourceContributionBoundaryFieldForRow(rows[0], session.editableFields)).toBeNull();
    expect(hasAnyEnabledSourceContributionBoundaryField(session.editableFields)).toBe(true);
  });
});

function draftedDesign(method: SequenceDesign['assemblyMethod']): SequenceDesign {
  const design = baseDesign(method);
  const draft = computeDraftAssembly(design);
  return {
    ...design,
    homologyRegions: draft.homologyRegions,
    designPrimers: draft.designPrimers,
    goldenGateJunctions: draft.goldenGateJunctions,
    assemblyState: 'ready',
    status: 'computed',
    version: 1,
  };
}

function rdAdjacentDesign(rdSide: 'left' | 'right'): SequenceDesign {
  const design = baseDesign('gibson');
  design.topology = 'linear';
  const pcr = region('pcr', 'ATGC'.repeat(30));
  const rd: DesignRegion = {
    ...region('rd', 'TTAACCGGTTAACCGG' + 'CGTA'.repeat(24)),
    sourceType: 'rd',
    rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
    rdSourceEnzyme: 'BsaI',
  };
  design.regions = rdSide === 'left' ? [rd, pcr] : [pcr, rd];
  return draftedFromBase(design);
}

function draftedFromBase(design: SequenceDesign): SequenceDesign {
  const draft = computeDraftAssembly(design);
  return {
    ...design,
    homologyRegions: draft.homologyRegions,
    designPrimers: draft.designPrimers,
    goldenGateJunctions: draft.goldenGateJunctions,
    assemblyState: 'ready',
    status: 'computed',
    version: 1,
  };
}

function baseDesign(method: SequenceDesign['assemblyMethod']): SequenceDesign {
  const now = new Date('2026-05-18T00:00:00.000Z');
  return {
    id: `design-${method}`,
    name: `${method} capability contract`,
    topology: 'circular',
    regions: [region('r1', 'ACGT'.repeat(60)), region('r2', 'TGCA'.repeat(60))],
    spacers: [],
    version: 0,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: method,
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateConfig: method === 'goldengate' ? { enzyme: 'BsaI' } : undefined,
    goldenGateJunctions: method === 'goldengate' ? [] : undefined,
    designPrimers: [],
    selectedJunctionIndex: 0,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

function region(id: string, sequence: string): DesignRegion {
  return {
    id,
    sourceSequenceId: id,
    sourceSequenceName: id,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  };
}

function row(id: string, kind: JunctionWorkbenchRow['kind']): JunctionWorkbenchRow {
  return {
    id,
    kind,
    label: id,
    sequence: '',
    coordinateStart: 0,
    anchorRowPosition: 0,
    points: [],
    annotations: [],
  } as JunctionWorkbenchRow;
}
