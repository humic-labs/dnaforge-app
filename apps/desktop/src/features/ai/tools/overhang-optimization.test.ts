import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import {
  applyOverhangOptimizationOutputSchema,
  planOverhangOptimizationOutputSchema,
  setPrimerPbsLengthOutputSchema,
} from './design-output-schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeDraftAssembly } from '../../design/algorithms/draft-assembly';
import { useDesignStore } from '../../design/store';
import { getComposedSequence } from '../../design/types';
import type { DesignRegion, SequenceDesign } from '../../design/types';
import {
  clearGoldenGateAutoOptimizationCacheForTesting,
  setGoldenGateExactSearchNodeLimitForTesting,
} from '../../junction-workbench/AssemblyWorkbenchAutoOptimizer';
import * as reducer from '../../junction-workbench/AssemblyWorkbenchReducer';
import {
  applyOverhangOptimizationTool,
  buildOverhangOptimizationPlanId,
  planOverhangOptimizationTool,
} from './overhang-optimization';
import { setPrimerPbsLengthTool } from './set-primer-pbs-length';

type PlanCombination = {
  rank: number;
  isCurrentDesign: boolean;
  valid: boolean;
  predictedFidelity: number | null;
  onTargetCount?: number;
  changedJunctionCount: number;
  totalMovementBp: number;
  offsetsToApply: Record<string, number>;
  junctions: Array<{
    junctionIndex: number;
    offset: number;
    overhang: string;
    changed: boolean;
    locked: boolean;
  }>;
};

type PlanResult = {
  status: string;
  code?: string;
  error?: string;
  remedy?: string;
  planId: string | null;
  designVersion?: number;
  enzyme?: string;
  scope?: string;
  scopeJunctionIndex?: number | null;
  optimizable?: boolean;
  recommendedRank?: number;
  searchProvedOptimal?: boolean;
  evaluatedNodes?: number;
  editableJunctionIndexes?: number[];
  lockedJunctions?: Array<{
    junctionIndex: number;
    overhang: string;
    overhangSource: string;
  }>;
  knownJunctionIndexes?: number[];
  combinations: PlanCombination[];
  currentFidelity?: {
    predictedFidelity: number | null;
    valid: boolean;
    conflicts: unknown[];
  };
  fidelityDataset?: {
    key: string;
    doi: string;
    license: string;
    overhangLengthBp: number;
  };
};

type ApplyResult = {
  status: string;
  code?: string;
  error?: string;
  remedy?: string;
  retriable?: boolean;
  planId?: string;
  requestedRank?: number;
  appliedRank?: number;
  planAgreement?: string;
  planDisagreements?: unknown[];
  previousVersion?: number;
  designVersion?: number;
  currentVersion?: number;
  validRanks?: [number, number];
  combinationCount?: number;
  changedJunctionCount?: number;
  totalMovementBp?: number;
  changedJunctions?: Array<{
    junctionIndex: number;
    previousOffset: number;
    offset: number;
    previousOverhang: string;
    overhang: string;
  }>;
  junctionsBefore?: Array<{ junctionIndex: number; offset: number; overhang: string }>;
  junctions?: Array<{ junctionIndex: number; offset: number; overhang: string }>;
  primersChanged?: boolean;
  revalidationRequired?: boolean;
  versionGuardApplied?: boolean;
  mutation?: {
    operationId: string;
    toolName: string;
    effect: string;
    beforeVersion: number;
    afterVersion: number;
    changed: boolean;
  };
};

const NOW = new Date('2026-07-26T00:00:00.000Z');

function pcrRegion(id: string, sequence: string): DesignRegion {
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

function rdRegion(
  id: string,
  sequence: string,
  upstream: string,
  downstream: string
): DesignRegion {
  return {
    ...pcrRegion(id, sequence),
    sourceType: 'rd',
    rdOverhangs: { upstream, downstream },
    rdSourceEnzyme: 'BsaI',
  };
}

function baseDesign(
  id: string,
  assemblyMethod: SequenceDesign['assemblyMethod'] = 'goldengate'
): SequenceDesign {
  return {
    id,
    name: id,
    topology: 'linear',
    regions: [],
    spacers: [],
    version: 1,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod,
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateConfig: assemblyMethod === 'goldengate' ? { enzyme: 'BsaI' } : undefined,
    goldenGateJunctions: assemblyMethod === 'goldengate' ? [] : undefined,
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function installDesign(design: SequenceDesign): string {
  useDesignStore.setState({
    designs: { [design.id]: design },
    activeDesignId: design.id,
    pendingDispatchId: null,
  });
  return design.id;
}

function drafted(design: SequenceDesign): SequenceDesign {
  const draft = computeDraftAssembly(design);
  return {
    ...design,
    homologyRegions: draft.homologyRegions,
    designPrimers: draft.designPrimers,
    goldenGateJunctions: draft.goldenGateJunctions,
    assemblyState: 'ready',
    status: 'computed',
    version: design.version + 1,
  };
}

function installOptimizableDesign(id = 'gg-opt'): string {
  const design = baseDesign(id);
  design.regions = [
    pcrRegion('r1', 'C'.repeat(32) + 'GAT'),
    pcrRegion('r2', 'ATG' + 'C'.repeat(30) + 'CAT'),
    pcrRegion('r3', 'ATC' + 'G'.repeat(30) + 'GGA'),
    rdRegion('rd', 'A'.repeat(64), 'AATG', 'GCAA'),
  ];
  design.goldenGateConfig = { enzyme: 'BsaI', offsetLimitBp: 6 };
  return installDesign(drafted(design));
}

function designOf(id: string): SequenceDesign {
  return useDesignStore.getState().designs[id];
}

async function plan(designId: string, junctionIndex?: number): Promise<PlanResult> {
  return execDesignContract<PlanResult>(
    planOverhangOptimizationOutputSchema,
    planOverhangOptimizationTool,
    {
      designId,
      ...(junctionIndex === undefined ? {} : { junctionIndex }),
    }
  );
}

function changedChoice(result: PlanResult): PlanCombination {
  const choice = result.combinations.find(
    (combination) => combination.rank > 0 && combination.changedJunctionCount > 0
  );
  if (!choice) throw new Error('Expected at least one changed optimizer combination.');
  return choice;
}

describe('plan_overhang_optimization / apply_overhang_optimization', () => {
  beforeEach(() => {
    clearGoldenGateAutoOptimizationCacheForTesting();
    setGoldenGateExactSearchNodeLimitForTesting(null);
    useDesignStore.setState({
      designs: {},
      activeDesignId: null,
      pendingDispatchId: null,
    });
  });

  afterEach(() => {
    setGoldenGateExactSearchNodeLimitForTesting(null);
    vi.restoreAllMocks();
  });

  it('projects the shipped ranked optimizer without mutating the design', async () => {
    const id = installOptimizableDesign();
    const before = structuredClone(designOf(id));

    const result = await plan(id);

    expect(result.status).toBe('ok');
    expect(result.planId).toMatch(/^ggopt2:BsaI-HFv2:/);
    expect(result.enzyme).toBe('BsaI');
    expect(result.scope).toBe('all-junctions');
    expect(result.scopeJunctionIndex).toBeNull();
    expect(result.combinations.length).toBeGreaterThan(1);
    expect(result.combinations[0]).toMatchObject({
      rank: 0,
      isCurrentDesign: true,
      changedJunctionCount: 0,
      totalMovementBp: 0,
    });
    expect(result.currentFidelity).toEqual(
      expect.objectContaining({
        predictedFidelity: expect.anything(),
        valid: expect.any(Boolean),
        conflicts: expect.any(Array),
      })
    );
    expect(result.fidelityDataset).toMatchObject({
      key: 'BsaI-HFv2',
      doi: expect.any(String),
      license: expect.any(String),
      overhangLengthBp: 4,
    });
    expect(designOf(id)).toEqual(before);
    expect(result.searchProvedOptimal).toBe(true);
  });

  it('reports searchProvedOptimal=false when the exact search hits the node budget ', async () => {
    setGoldenGateExactSearchNodeLimitForTesting(8);
    const id = installOptimizableDesign('gg-budget');
    const result = await plan(id);
    expect(result.status).toBe('ok');
    expect(result.searchProvedOptimal).toBe(false);
    expect(result.evaluatedNodes).toBeGreaterThan(8);
    expect(result.combinations.length).toBeGreaterThan(0);
    const lastJunctionIndex = Math.max(
      ...(designOf(id).goldenGateJunctions ?? []).map((junction) => junction.junctionIndex)
    );
    for (const combination of result.combinations) {
      expect(
        combination.junctions.some((junction) => junction.junctionIndex === lastJunctionIndex)
      ).toBe(true);
    }
  });

  it('binds a plan id to the ordered ranks and exact dataset content', () => {
    const base = {
      optimizationFingerprint: 'problem-1',
      datasetKey: 'BsaI-HFv2',
      datasetContentIdentity: 'source-hash:workbook-hash',
      scopeJunctionIndex: null,
      currentCombinationKey: '0:0:AATG',
      orderedCombinationKeys: ['0:0:AATG', '0:1:ATGC', '0:-1:CAAT'],
    };

    const original = buildOverhangOptimizationPlanId(base);
    expect(
      buildOverhangOptimizationPlanId({
        ...base,
        orderedCombinationKeys: ['0:0:AATG', '0:-1:CAAT', '0:1:ATGC'],
      })
    ).not.toBe(original);
    expect(
      buildOverhangOptimizationPlanId({
        ...base,
        datasetContentIdentity: 'source-hash:new-workbook-hash',
      })
    ).not.toBe(original);
  });

  it('does not call worse changed alternatives optimizations after the recommended plan lands', async () => {
    const id = installOptimizableDesign('gg-already-best');
    const first = await plan(id);
    expect(first.recommendedRank).toBeGreaterThan(0);
    const currentRow = first.combinations[0];
    const recommended = first.combinations.find(
      (combination) => combination.rank === first.recommendedRank
    );
    expect(currentRow.onTargetCount).toEqual(expect.any(Number));
    expect(recommended?.onTargetCount).toEqual(expect.any(Number));
    if (
      currentRow.predictedFidelity === recommended?.predictedFidelity &&
      typeof currentRow.onTargetCount === 'number' &&
      typeof recommended.onTargetCount === 'number'
    ) {
      expect(recommended.onTargetCount).toBeGreaterThan(currentRow.onTargetCount);
    }

    let currentPlan = first;
    let steps = 0;
    while (currentPlan.recommendedRank && currentPlan.recommendedRank > 0 && steps < 20) {
      const applied = await execDesignContract<ApplyResult>(
        applyOverhangOptimizationOutputSchema,
        applyOverhangOptimizationTool,
        {
          designId: id,
          planId: currentPlan.planId,
          rank: currentPlan.recommendedRank,
        }
      );
      expect(applied.status).toBe('applied');
      currentPlan = await plan(id);
      steps += 1;
    }
    expect(steps).toBeGreaterThan(0);
    expect(currentPlan.status).toBe('ok');
    expect(currentPlan.recommendedRank).toBe(0);
    expect(
      currentPlan.combinations.some(
        (combination) => combination.rank > 0 && combination.changedJunctionCount > 0
      )
    ).toBe(true);
    expect(currentPlan.optimizable).toBe(false);
  });

  it('mints a stable plan id for the same ranked meaning and a different id for a scoped plan', async () => {
    const id = installOptimizableDesign();
    const allFirst = await plan(id);
    const allSecond = await plan(id);
    const editable = allFirst.editableJunctionIndexes?.[0];
    expect(editable).toBeDefined();
    const scoped = await plan(id, editable);

    expect(allFirst.status).toBe('ok');
    expect(allSecond.planId).toBe(allFirst.planId);
    expect(scoped.status).toBe('ok');
    expect(scoped.planId).not.toBe(allFirst.planId);
    expect(scoped.scopeJunctionIndex).toBe(editable);
    expect(scoped.scope).toBe(`junction-${editable}`);
    expect(
      scoped.combinations
        .flatMap((combination) => combination.junctions)
        .filter((junction) => junction.changed)
        .every((junction) => junction.junctionIndex === editable)
    ).toBe(true);
  });

  it('reports restriction-digest junctions as physically locked', async () => {
    const id = installOptimizableDesign();
    const result = await plan(id);

    expect(result.status).toBe('ok');
    expect(result.lockedJunctions?.length).toBeGreaterThan(0);
    expect(result.lockedJunctions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          overhangSource: expect.stringMatching(/rd/),
        }),
      ])
    );
    for (const locked of result.lockedJunctions ?? []) {
      expect(result.editableJunctionIndexes).not.toContain(locked.junctionIndex);
      expect(
        result.combinations.every((combination) => {
          const junction = combination.junctions.find(
            (entry) => entry.junctionIndex === locked.junctionIndex
          );
          return junction?.locked === true && junction.changed === false;
        })
      ).toBe(true);
    }
  });

  it('returns self-correcting refusals for the wrong method, an undrafted design, and SapI', async () => {
    const gibson = baseDesign('gibson', 'gibson');
    gibson.regions = [pcrRegion('a', 'A'.repeat(80)), pcrRegion('b', 'C'.repeat(80))];
    installDesign(drafted(gibson));
    const wrongMethod = await plan(gibson.id);

    const undrafted = baseDesign('undrafted');
    undrafted.regions = [pcrRegion('a', 'A'.repeat(80)), pcrRegion('b', 'C'.repeat(80))];
    installDesign(undrafted);
    const notDrafted = await plan(undrafted.id);

    const sapi = baseDesign('sapi');
    sapi.regions = [pcrRegion('a', 'A'.repeat(80)), pcrRegion('b', 'C'.repeat(80))];
    sapi.goldenGateConfig = { enzyme: 'SapI' };
    installDesign(drafted(sapi));
    const noDataset = await plan(sapi.id);

    expect(wrongMethod).toMatchObject({
      status: 'rejected',
      code: 'unsupported-mode-command',
      planId: null,
    });
    expect(wrongMethod.remedy).toBeTruthy();
    expect(notDrafted).toMatchObject({
      status: 'rejected',
      code: 'assembly-not-drafted',
      planId: null,
    });
    expect(notDrafted.remedy).toMatch(/draft_design_assembly/);
    expect(noDataset).toMatchObject({
      status: 'rejected',
      code: 'optimizer-data-unavailable',
      planId: null,
    });
    expect(noDataset.error).toMatch(/three-base/i);
  });

  it('names valid junction indexes when a scoped target does not exist', async () => {
    const id = installOptimizableDesign();
    const result = await plan(id, 99);

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('invalid-command-target');
    expect(result.knownJunctionIndexes?.length).toBeGreaterThan(0);
    expect(result.knownJunctionIndexes).not.toContain(99);
    expect(result.remedy).toMatch(/knownJunctionIndexes/);
  });

  it('treats rank 0 as a no-op and does not rewrite primers or bump the design version', async () => {
    const id = installOptimizableDesign();
    const planned = await plan(id);
    const before = structuredClone(designOf(id));

    const result = await execDesignContract<ApplyResult>(
      applyOverhangOptimizationOutputSchema,
      applyOverhangOptimizationTool,
      {
        designId: id,
        planId: planned.planId,
        rank: 0,
        expectedDesignVersion: before.version,
      }
    );

    expect(result.status).toBe('noop');
    expect(result.appliedRank).toBe(0);
    expect(result.previousVersion).toBe(before.version);
    expect(result.designVersion).toBe(before.version);
    expect(result.versionGuardApplied).toBe(true);
    expect(designOf(id)).toEqual(before);
  });

  it('applies the quoted rank exactly, changes primers, and preserves the assembled product', async () => {
    const id = installOptimizableDesign();
    const planned = await plan(id);
    const choice = changedChoice(planned);
    const before = structuredClone(designOf(id));
    const productBefore = getComposedSequence(before.regions, before.spacers);

    const result = await execDesignContract<ApplyResult>(
      applyOverhangOptimizationOutputSchema,
      applyOverhangOptimizationTool,
      {
        designId: id,
        planId: planned.planId,
        rank: choice.rank,
        expectedDesignVersion: before.version,
      },
      {
        toolCallId: 'call-optimize-1',
        messages: [],
        abortSignal: undefined as never,
      }
    );

    const after = designOf(id);
    expect(result.status).toBe('applied');
    expect(result.appliedRank).toBe(choice.rank);
    expect(result.planAgreement).toBe('exact');
    expect(result.planDisagreements).toEqual([]);
    expect(result.changedJunctionCount).toBe(choice.changedJunctionCount);
    expect(result.totalMovementBp).toBe(choice.totalMovementBp);
    expect(result.changedJunctions?.length).toBeGreaterThan(0);
    expect(result.primersChanged).toBe(true);
    expect(result.revalidationRequired).toBe(true);
    expect(result.previousVersion).toBe(before.version);
    expect(result.designVersion).toBeGreaterThan(before.version);
    expect(after.designPrimers).not.toEqual(before.designPrimers);
    expect(getComposedSequence(after.regions, after.spacers)).toBe(productBefore);
    for (const expected of choice.junctions) {
      expect(
        after.goldenGateJunctions?.find(
          (junction) => junction.junctionIndex === expected.junctionIndex
        )
      ).toMatchObject({
        offset: expected.offset,
        overhang: expected.overhang,
      });
    }
    expect(result.mutation).toMatchObject({
      operationId: 'call-optimize-1',
      toolName: 'apply_overhang_optimization',
      effect: 'applied_overhang_optimization',
      beforeVersion: before.version,
      afterVersion: after.version,
      changed: true,
    });
  });

  it('never offers or applies an overhang combination that shortens an existing PBS', async () => {
    const id = installOptimizableDesign('gg-pbs-constrained');
    const beforeEditPlan = await plan(id);
    const designVersionBeforeEdit = designOf(id).version;
    const pbsEdit = await execDesignContract<{ status: string; designVersion?: number }>(
      setPrimerPbsLengthOutputSchema,
      setPrimerPbsLengthTool,
      {
        designId: id,
        fragmentIndex: 1,
        direction: 'reverse',
        length: 33,
        expectedDesignVersion: designVersionBeforeEdit,
      }
    );
    expect(pbsEdit.status).toBe('applied');
    const pbsEditedDesign = designOf(id);
    const pbsLengthsBefore = pbsEditedDesign.designPrimers.flatMap((pair) => [
      pair.forward.pbs.end - pair.forward.pbs.start,
      pair.reverse.pbs.end - pair.reverse.pbs.start,
    ]);
    expect(pbsLengthsBefore[3]).toBe(33);

    const constrainedPlan = await plan(id);
    expect(constrainedPlan.status).toBe('ok');
    expect(constrainedPlan.planId).not.toBe(beforeEditPlan.planId);
    const feasibleChoice = changedChoice(constrainedPlan);

    const applied = await execDesignContract<ApplyResult>(
      applyOverhangOptimizationOutputSchema,
      applyOverhangOptimizationTool,
      {
        designId: id,
        planId: constrainedPlan.planId,
        rank: feasibleChoice.rank,
        expectedDesignVersion: pbsEditedDesign.version,
      }
    );

    expect(applied.status).toBe('applied');
    expect(applied.planAgreement).toBe('exact');
    expect(
      designOf(id).designPrimers.flatMap((pair) => [
        pair.forward.pbs.end - pair.forward.pbs.start,
        pair.reverse.pbs.end - pair.reverse.pbs.start,
      ])
    ).toEqual(pbsLengthsBefore);
  });

  it('never moves a locked restriction-digest junction when applying another rank', async () => {
    const id = installOptimizableDesign();
    const planned = await plan(id);
    const choice = changedChoice(planned);
    const lockedIndexes = planned.lockedJunctions?.map((junction) => junction.junctionIndex) ?? [];
    const before = structuredClone(designOf(id));

    const result = await execDesignContract<ApplyResult>(
      applyOverhangOptimizationOutputSchema,
      applyOverhangOptimizationTool,
      {
        designId: id,
        planId: planned.planId,
        rank: choice.rank,
      }
    );

    expect(result.status).toBe('applied');
    for (const junctionIndex of lockedIndexes) {
      expect(
        designOf(id).goldenGateJunctions?.find(
          (junction) => junction.junctionIndex === junctionIndex
        )
      ).toEqual(
        before.goldenGateJunctions?.find((junction) => junction.junctionIndex === junctionIndex)
      );
    }
  });

  it('refuses a stale design version before writing', async () => {
    const id = installOptimizableDesign();
    const planned = await plan(id);
    const choice = changedChoice(planned);
    const before = structuredClone(designOf(id));

    const result = await execDesignContract<ApplyResult>(
      applyOverhangOptimizationOutputSchema,
      applyOverhangOptimizationTool,
      {
        designId: id,
        planId: planned.planId,
        rank: choice.rank,
        expectedDesignVersion: before.version + 1,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('stale-design-version');
    expect(result.retriable).toBe(true);
    expect(result.currentVersion).toBe(before.version);
    expect(designOf(id)).toEqual(before);
  });

  it('refuses a plan after an offset changes and returns the newly ranked options', async () => {
    const id = installOptimizableDesign();
    const planned = await plan(id);
    const choice = changedChoice(planned);
    useDesignStore.setState((state) => {
      const design = state.designs[id];
      return {
        designs: {
          ...state.designs,
          [id]: {
            ...design,
            goldenGateJunctions: design.goldenGateJunctions?.map((junction, index) =>
              index === 0
                ? { ...junction, offset: junction.offset + 1, overhang: 'GCTA' }
                : junction
            ),
          },
        },
      };
    });
    const changed = structuredClone(designOf(id));

    const result = await execDesignContract<
      ApplyResult & { combinations?: PlanCombination[]; actualPlanId?: string }
    >(applyOverhangOptimizationOutputSchema, applyOverhangOptimizationTool, {
      designId: id,
      planId: planned.planId,
      rank: choice.rank,
    });

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('PLAN_STALE');
    expect(result.retriable).toBe(true);
    expect(result.actualPlanId).not.toBe(planned.planId);
    expect(result.combinations?.length).toBeGreaterThan(0);
    expect(designOf(id)).toEqual(changed);
  });

  it('refuses a mismatched plan scope and an out-of-range rank without writing', async () => {
    const id = installOptimizableDesign();
    const planned = await plan(id);
    const before = structuredClone(designOf(id));
    const editable = planned.editableJunctionIndexes?.[0];
    expect(editable).toBeDefined();

    const wrongScope = await execDesignContract<ApplyResult>(
      applyOverhangOptimizationOutputSchema,
      applyOverhangOptimizationTool,
      {
        designId: id,
        planId: planned.planId,
        rank: 1,
        junctionIndex: editable,
      }
    );
    const outOfRange = await execDesignContract<ApplyResult>(
      applyOverhangOptimizationOutputSchema,
      applyOverhangOptimizationTool,
      {
        designId: id,
        planId: planned.planId,
        rank: 999,
      }
    );

    expect(wrongScope.status).toBe('rejected');
    expect(wrongScope.code).toBe('PLAN_STALE');
    expect(outOfRange.status).toBe('rejected');
    expect(outOfRange.code).toBe('RANK_OUT_OF_RANGE');
    expect(outOfRange.validRanks).toEqual([0, planned.combinations.length - 1]);
    expect(outOfRange.combinationCount).toBe(planned.combinations.length);
    expect(designOf(id)).toEqual(before);
  });

  it('refuses reducer/planner disagreement before committing any oligo change', async () => {
    const id = installOptimizableDesign();
    const planned = await plan(id);
    const choice = changedChoice(planned);
    const before = structuredClone(designOf(id));
    const original = reducer.applyAssemblyWorkbenchCommand;
    vi.spyOn(reducer, 'applyAssemblyWorkbenchCommand').mockImplementation((args) => {
      const result = original(args);
      if (result.status !== 'applied') return result;
      const junctions = result.nextDesign.goldenGateJunctions ?? [];
      return {
        ...result,
        nextDesign: {
          ...result.nextDesign,
          goldenGateJunctions: junctions.map((junction, index) =>
            index === 0 ? { ...junction, offset: junction.offset + 1 } : junction
          ),
        },
      };
    });

    const result = await execDesignContract<ApplyResult>(
      applyOverhangOptimizationOutputSchema,
      applyOverhangOptimizationTool,
      {
        designId: id,
        planId: planned.planId,
        rank: choice.rank,
      }
    );

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('PLAN_APPLICATION_DIVERGED');
    expect(result.planAgreement).toBe('divergent');
    expect(result.planDisagreements?.length).toBeGreaterThan(0);
    expect(designOf(id)).toEqual(before);
  });

  it('accepts waypoint design URIs and returns structured unknown-design errors', async () => {
    const id = installOptimizableDesign();
    const uriResult = await plan(`waypoint://design/${encodeURIComponent(id)}`);
    const missing = await plan('missing-design');

    expect(uriResult.status).toBe('ok');
    expect(uriResult.planId).toBeTruthy();
    expect(missing.status).toBe('rejected');
    expect(missing.code).toBe('design-not-found');
    expect(missing.remedy).toBeTruthy();
  });
});
