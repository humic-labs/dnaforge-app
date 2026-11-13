import { describe, expect, it } from 'vitest';

import { buildRealAssemblyPipelineDesign } from '../../test/scenarios/assembly-real-pipeline';
import { getComposedSequence } from '../design/types';
import { buildAssemblyOptimizationInput } from '../assembly/assembly-optimization-input';
import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from './AssemblyWorkbenchReducer';
import { ensureAssemblyWorkbenchIdentity } from './AssemblyWorkbenchIdentity';
import { planGoldenGateAutoOptimization } from './AssemblyWorkbenchAutoOptimizer';

describe('Golden Gate Auto-optimize circular two-PCR no-op ', () => {
  it('applies a real change on the reproduced circular two-PCR design instead of no-opping because every listed set scored 100%', () => {
    const design = ensureAssemblyWorkbenchIdentity(
      buildRealAssemblyPipelineDesign('goldengate-pcr-pcr')
    );
    const productLength = getComposedSequence(design.regions, design.spacers).length;
    const beforeJunctions = design.goldenGateJunctions ?? [];
    const beforeOverhangs = beforeJunctions.map((junction) => junction.overhang);
    expect(beforeOverhangs).toEqual(['AGTG', 'TATT']);
    const lastBefore = beforeJunctions.find((junction) => junction.junctionIndex === 1);
    expect(lastBefore, 'wrap-around last joint must exist').toBeDefined();
    expect(lastBefore!.junctionPosition).toBe(productLength);

    const plan = planGoldenGateAutoOptimization(buildAssemblyOptimizationInput(design));
    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') {
      throw new Error(`Auto-optimize planner must stay planned ; got ${plan.status}`);
    }

    const listedFidelities = plan.topCombinations.map(
      (combination) => combination.fidelity.fidelity
    );
    const scorerCannotDistinguish =
      listedFidelities.length > 1 &&
      listedFidelities.every((fidelity) => Math.abs(fidelity - listedFidelities[0]) < 1e-12);

    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState: createAssemblyWorkbenchViewState(design),
      command: {
        type: 'autoOptimize',
        scope: 'all',
        expectedDesignVersion: design.version,
      },
    });

    const afterJunctions = result.nextDesign.goldenGateJunctions ?? [];
    const afterOverhangs = afterJunctions.map((junction) => junction.overhang);
    const lastAfter = afterJunctions.find((junction) => junction.junctionIndex === 1);
    const unchangedOverhangs = afterOverhangs.join('|') === beforeOverhangs.join('|');
    const isNoop =
      result.status === 'noop' ||
      (result.nextDesign.version === design.version && unchangedOverhangs);

    if (isNoop) {
      const lastOverhang = lastAfter?.overhang ?? lastBefore!.overhang;
      if (scorerCannotDistinguish) {
        throw new Error(
          `Auto-optimize no-op on circular two-PCR Golden Gate: scorer cannot distinguish any alternative (all listed sets scored ${listedFidelities[0]}). Last joint left at ${lastOverhang} (product end ${lastBefore!.junctionPosition}).`
        );
      }
      throw new Error(
        `Auto-optimize no-op on circular two-PCR Golden Gate; last joint left at ${lastOverhang} at product end ${lastBefore!.junctionPosition}.`
      );
    }

    expect(lastAfter, 'applied set must still include the wrap-around last joint').toBeDefined();
    expect(result.status).toBe('applied');
    expect(result.nextDesign.version).toBeGreaterThan(design.version);
    expect(unchangedOverhangs).toBe(false);
    expect(plan.afterFidelity.onTargetCount).toBeGreaterThan(plan.beforeFidelity.onTargetCount);
  });

  it('applies the smallest on-target improvement, not a multi-junction rewrite of the global best', () => {
    const design = ensureAssemblyWorkbenchIdentity(
      buildRealAssemblyPipelineDesign('goldengate-pcr-pcr')
    );
    const plan = planGoldenGateAutoOptimization(buildAssemblyOptimizationInput(design));
    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') {
      throw new Error(`Auto-optimize planner must stay planned; got ${plan.status}`);
    }
    expect(plan.selectedRank).toBeGreaterThan(0);
    const selected = plan.topCombinations[plan.selectedRank];
    expect(selected.totalMovement).toBe(1);
    expect(selected.fidelity.onTargetCount).toBeGreaterThan(plan.beforeFidelity.onTargetCount);
    expect(selected.choices.map((choice) => choice.junctionIndex)).toEqual([0, 1]);
  });
});
