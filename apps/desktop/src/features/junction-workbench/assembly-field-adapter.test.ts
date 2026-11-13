import { describe, expect, it } from 'vitest';
import type { DesignRegion, SequenceDesign } from '../design/types';
import { getComposedSequence } from '../design/types';
import {
  applyAssemblyEditableFieldValue,
  listAssemblyEditableFields,
} from './assembly-field-adapter';

describe('assembly field adapter', () => {
  it('constructs an exact substitution product through the Assembly Builder spacer command', () => {
    const design = substitutionDesign();
    const spacerField = listAssemblyEditableFields(design).fields.find(
      (field) => field.kind === 'junctionSpacer' && field.target.junctionIndex === 0
    );

    expect(spacerField).toBeDefined();

    const result = applyAssemblyEditableFieldValue(design, {
      fieldId: spacerField!.id,
      value: 'gcc',
      expectedDesignVersion: design.version,
    });

    expect(result.status).toBe('applied');
    expect(result.appliedCommands).toContainEqual(
      expect.objectContaining({
        type: 'setJunctionSpacer',
        junctionIndex: 0,
        sequence: 'gcc',
        expectedDesignVersion: design.version,
      })
    );
    expect(result.nextDesign.spacers).toContainEqual(
      expect.objectContaining({ junctionIndex: 0, sequence: 'gcc' })
    );
    expect(getComposedSequence(result.nextDesign.regions, result.nextDesign.spacers)).toBe(
      'AAATTTgccGGGCCC'
    );
  });
});

function substitutionDesign(): SequenceDesign {
  const now = new Date('2026-07-23T00:00:00.000Z');
  return {
    id: 'paper-pilot-substitution',
    name: 'Paper pilot substitution',
    topology: 'circular',
    regions: [region('before-mutation', 'AAATTT'), region('after-mutation', 'GGGCCC')],
    spacers: [],
    version: 0,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
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
    sourceSequenceId: 'source-plasmid',
    sourceSequenceName: 'source-plasmid',
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  };
}
