import { describe, expect, it } from 'vitest';
import { applyMocloFactoryStageCommand } from './moclo-factory-command';
import type { MocloFactoryStageSelection } from './moclo-kit-definition';
import type { SequenceDesign } from './types';

function design(): SequenceDesign {
  const now = new Date('2026-09-01T00:00:00.000Z');
  return {
    id: 'design-1',
    name: 'Factory stage',
    topology: 'circular',
    regions: [],
    spacers: [],
    version: 2,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: 'goldengate',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateConfig: { enzyme: 'BsaI' },
    goldenGateJunctions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

const selection: MocloFactoryStageSelection = {
  kitId: 'ytk',
  kitRevision: 1,
  recipeId: 'ytk-multigene-device',
  stageId: 'cassette-vector',
  stageInputs: [],
  schema: {
    id: 'ytk:ytk-multigene-device:cassette-vector',
    name: 'Build cassette vector',
    revision: 1,
    origin: {
      type: 'kit',
      kitId: 'ytk',
      kitName: 'Yeast Toolkit (YTK)',
      schemaId: 'ytk-multigene-device:cassette-vector',
    },
    enzyme: 'BsaI',
    slots: [
      {
        id: 'type-1',
        label: 'Type 1 connector',
        outgoingOverhang: 'AACG',
        preferredRoles: [{ id: 'ytk:assembly-connector', label: 'Assembly connector' }],
      },
    ],
  },
};

describe('MoClo factory stage command', () => {
  it('applies the stage schema and persists the factory run identity atomically', () => {
    const result = applyMocloFactoryStageCommand({
      design: design(),
      selection,
      runId: 'factory-run-1',
      expectedVersion: 2,
      now: new Date('2026-09-01T01:00:00.000Z'),
    });

    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.nextDesign).toMatchObject({
      version: 3,
      goldenGateSchema: selection.schema,
      mocloFactory: {
        runId: 'factory-run-1',
        kitId: 'ytk',
        kitRevision: 1,
        recipeId: 'ytk-multigene-device',
        stageId: 'cassette-vector',
      },
    });
    expect(result.nextDesign.regions).toHaveLength(1);
  });

  it('refuses stale writes before changing the schema or factory context', () => {
    expect(
      applyMocloFactoryStageCommand({
        design: design(),
        selection,
        runId: 'factory-run-1',
        expectedVersion: 1,
      })
    ).toMatchObject({ status: 'rejected', code: 'stale-version' });
  });

  it('is a no-op when the exact stage is already active', () => {
    const first = applyMocloFactoryStageCommand({
      design: design(),
      selection,
      runId: 'factory-run-1',
      expectedVersion: 2,
    });
    if (first.status !== 'applied') throw new Error('Expected first command to apply.');
    expect(
      applyMocloFactoryStageCommand({
        design: first.nextDesign,
        selection,
        runId: 'factory-run-1',
        expectedVersion: first.nextDesign.version,
      })
    ).toMatchObject({ status: 'no-op' });
  });
});
