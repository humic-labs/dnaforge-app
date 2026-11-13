   
                                                                                
                                                                
  
                                                                     
                                                                                
                                                                               
                                                                              
                                                                             
                                                                         
  
                                                                               
                                                                              
                                                                                
                                                                             
                                                                                
                                                                         
  
                                                                                
                                                                               
                                       
  
                                                                               
                                                                                
                                                                          
                                                                            
                                                                             
                                                                         
                 
  
                                                                           
                                                                               
                                                                              
                                                                            
                                                                              
  
                                                                               
                                                                         
                                                                                
                                                                              
                                                                               
                                    
  
                                                                               
                                                                              
                                                                             
                                                                         
                                                                            
                                                                               
                                                                            
                                                                       
  
                                                                             
                                                                               
                                              
  
                                                                               
                                                                              
                                                                              
                                                                           
                                                                               
                                                    
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { designToolFailure, runDesignTool } from './design-tool-result';
import { z } from 'zod';
import { useDesignStore } from '../../design/public/store';
import { isGoldenGateJunctionOffsetLocked } from '../../design/public/algorithms/draft-assembly';
import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from '../../junction-workbench/public/AssemblyWorkbenchReducer';
import { goldenGateOffsetLimitBp } from '../../junction-workbench/public/AssemblyWorkbenchContract';
import {
  planGoldenGateAutoOptimization,
  type GoldenGateAutoOptimizePlan,
  type GoldenGateOptimizationCombination,
} from '../../junction-workbench/public/AssemblyWorkbenchAutoOptimizer';
import {
  getGoldenGateFidelityDataset,
  getGoldenGateFidelitySource,
  type GoldenGateSetFidelityScore,
} from '../../junction-workbench/public/golden-gate-fidelity/GoldenGateFidelityDataset';
import { buildAssemblyOptimizationInput } from '../../assembly/public/assembly-optimization-input';
import type {
  GoldenGateEnzyme,
  GoldenGateJunction,
  SequenceDesign,
} from '../../design/public/types';
import { createDesignMutationClaim } from './agent-mutation';

   
                                                                       
                                                                          
                                                                           
                                                                       
   
const FIDELITY_DATASET_ENZYMES: readonly GoldenGateEnzyme[] = ['BsaI', 'BbsI', 'BsmBI'];

export const planOverhangOptimizationSchema = z
  .object({
    designId: z
      .string()
      .min(1)
      .describe('Design id returned by create_design, or a waypoint://design/{id} URI.'),
    junctionIndex: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Optional. Restrict the search to ONE junction, leaving every other junction exactly ' +
          'where it is. Junction i is the junction AFTER region i; a circular design with N ' +
          'parts has N junctions (the last one wraps). Omit to consider every movable junction ' +
          'at once, which is almost always what you want — overhangs cross-react as a SET, so ' +
          'the best single-junction move is often not part of the best set. If you pass this, ' +
          'you must pass the same value to apply_overhang_optimization.'
      ),
  })
  .strict();

export const applyOverhangOptimizationSchema = z
  .object({
    designId: z
      .string()
      .min(1)
      .describe('Design id, or a waypoint://design/{id} URI. The same design you planned.'),
    planId: z
      .string()
      .min(1)
      .describe(
        'The planId returned by plan_overhang_optimization. It is recomputed here and the write ' +
          'is refused if it no longer matches, which is how a design edit between your read and ' +
          'this write is caught instead of silently applying whatever now sits at that rank. ' +
          'You cannot obtain a planId without having looked at the ranked options, so no blind ' +
          'call can move an overhang.'
      ),
    rank: z
      .number()
      .int()
      .min(0)
      .describe(
        'Which ranked combination to apply, as printed by plan_overhang_optimization. Rank 0 is ' +
          'the design exactly as it stands, so applying it changes nothing and returns noop. ' +
          'Ranks are only meaningful together with the planId they came from.'
      ),
    junctionIndex: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Must be the SAME scope you passed to plan_overhang_optimization (omitted there means ' +
          'omitted here). The scope is part of the plan identity, so a mismatch is refused as a ' +
          'stale plan rather than applied to the wrong junction set.'
      ),
    expectedDesignVersion: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'The design version you last read. If supplied and the design has moved on, the write is ' +
          'refused with code stale-design-version. Independent of the planId guard: planId ' +
          'protects the MEANING of the rank, this protects against any concurrent edit at all. ' +
          'If omitted, the commit is still guarded against edits that race this call by the ' +
          'version read at call time, but no caller-supplied historical version is checked. ' +
          '`versionGuardApplied` reports whether YOU supplied one.'
      ),
  })
  .strict();

type PlanOverhangOptimizationInput = z.infer<typeof planOverhangOptimizationSchema>;
type ApplyOverhangOptimizationInput = z.infer<typeof applyOverhangOptimizationSchema>;

function normalizeDesignId(input: string): string {
  if (!input.startsWith('waypoint://')) return input;
  try {
    const parsed = new URL(input);
    if (parsed.protocol === 'waypoint:' && parsed.hostname === 'design') {
      return decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
    }
  } catch {
    return input;
  }
  return input;
}

                                                                                
function stableHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + code + index, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

                                                                               
function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function round(value: number, places: number): number | null {
  const finite = finiteOrNull(value);
  return finite === null ? null : Number(finite.toFixed(places));
}

function projectFidelity(score: GoldenGateSetFidelityScore) {
  return {
                                                                          
                                                                        
    predictedFidelity: round(score.fidelity, 6),
    logFidelity: round(score.logFidelity, 6),
    onTargetCount: score.onTargetCount,
                                                                             
                                                                            
    valid: score.valid,
    conflicts: score.conflicts.map((conflict) => ({
      type: conflict.type,
      overhang: conflict.overhang,
      otherOverhang: conflict.otherOverhang ?? null,
    })),
  };
}

   
                                                      
                                                                               
                                                                              
                                                                           
   
function combinationKey(combination: GoldenGateOptimizationCombination): string {
  return combination.choices
    .map((choice) => `${choice.junctionIndex}:${choice.offset}:${choice.overhang}`)
    .join('|');
}

export function buildOverhangOptimizationPlanId(input: {
  optimizationFingerprint: string;
  datasetKey: string;
  datasetContentIdentity: string;
  scopeJunctionIndex: number | null;
  currentCombinationKey: string;
  orderedCombinationKeys: readonly string[];
}): string {
  const payload = [
    'ggopt-v2',
    input.optimizationFingerprint,
    input.datasetKey,
    input.datasetContentIdentity,
    input.scopeJunctionIndex === null ? 'all' : `junction:${input.scopeJunctionIndex}`,
    input.currentCombinationKey,
                                                                                
                                                                               
    ...input.orderedCombinationKeys.map((key, rank) => `${rank}:${key}`),
  ].join('|');
  return `ggopt2:${input.datasetKey}:${stableHash(payload)}`;
}

function projectJunctionState(design: SequenceDesign) {
  return (design.goldenGateJunctions ?? []).map((junction) => ({
    junctionIndex: junction.junctionIndex,
    offset: junction.offset,
    overhang: junction.overhang,
    overhangSource: junction.source.type,
    offsetEditable: !isGoldenGateJunctionOffsetLocked(junction),
    isValid: junction.isValid,
  }));
}

function projectCombination(
  combination: GoldenGateOptimizationCombination,
  current: GoldenGateOptimizationCombination
) {
  const currentByJunction = new Map(
    current.choices.map((choice) => [choice.junctionIndex, choice])
  );
  const perOverhang = combination.fidelity.perOverhang;
  return {
    rank: combination.rank,
    isCurrentDesign: combination.rank === 0,
    ...projectFidelity(combination.fidelity),
                                                          
    changedJunctionCount: combination.changedCount,
                                                                            
    totalMovementBp: combination.totalMovement,
                                                                           
    offsetsToApply: Object.fromEntries(
      [...combination.offsetsByJunctionIndex.entries()].map(([junctionIndex, offset]) => [
        String(junctionIndex),
        offset,
      ])
    ),
    junctions: combination.choices.map((choice, index) => {
      const before = currentByJunction.get(choice.junctionIndex);
      return {
        junctionIndex: choice.junctionIndex,
        offset: choice.offset,
        overhang: choice.overhang,
        previousOffset: before?.offset ?? null,
        previousOverhang: before?.overhang ?? null,
        changed: combination.offsetsByJunctionIndex.has(choice.junctionIndex),
        movementBp: choice.movement,
           
                                                                               
                                                                             
                                            
           
        locked: choice.locked,
           
                                                                           
                                                                          
                                       
           
        correctLigationProbability: round(perOverhang[index]?.probability ?? 0, 6),
      };
    }),
  };
}

type PlannedContext = {
  design: SequenceDesign;
  plan: Extract<GoldenGateAutoOptimizePlan, { status: 'planned' }>;
  combinations: GoldenGateOptimizationCombination[];
  current: GoldenGateOptimizationCombination;
  planId: string;
  scopeJunctionIndex: number | null;
  enzyme: GoldenGateEnzyme;
};

type Refusal = Record<string, unknown> & { status: 'rejected'; code: string; error: string };

function refuse(code: string, error: string, extra: Record<string, unknown> = {}): Refusal {
  return { status: 'rejected', code, error, ...extra };
}

   
                                                                            
  
                                                                              
                                                                             
                
   
function resolveOptimizationContext(
  designId: string,
  requestedJunctionIndex: number | undefined
): PlannedContext | Refusal {
  const design = useDesignStore.getState().designs[designId];
  if (!design) {
    return refuse('design-not-found', `Design not found: ${designId}`, {
      remedy: 'List designs with get_workspace, or create one with create_design.',
    });
  }

  if (design.assemblyMethod !== 'goldengate') {
    return refuse(
      'unsupported-mode-command',
      `Overhang fidelity only exists in Golden Gate assembly; this design uses ` +
        `${design.assemblyMethod}. Gibson/NEBuilder junctions are joined by long homology arms ` +
        'that anneal by sequence identity, not by 4 bp sticky ends, so there is no overhang set ' +
        'to optimize and nothing to score against ligation data.',
      {
        assemblyMethod: design.assemblyMethod,
        supportedAssemblyMethods: ['goldengate'],
        remedy:
          'If you meant to build this by Golden Gate, switch the method first; otherwise tune ' +
          'the homology arms with set_homology_encoding.',
      }
    );
  }

  const enzyme: GoldenGateEnzyme = design.goldenGateConfig?.enzyme ?? 'BsaI';
  if (!FIDELITY_DATASET_ENZYMES.includes(enzyme)) {
    return refuse(
      'optimizer-data-unavailable',
      `No empirical ligation-fidelity data is bundled for ${enzyme}. ${enzyme} leaves a ` +
        'THREE-base overhang, and the bundled dataset (Pryor et al. 2020, NEB) measures ' +
        'four-base overhang ligation only — there is no measured cell for a 3 bp sticky end, so ' +
        'a fidelity score for this design would be invented rather than measured.',
      {
        enzyme,
        supportedEnzymes: [...FIDELITY_DATASET_ENZYMES],
        remedy:
          `Switch the design to one of ${FIDELITY_DATASET_ENZYMES.join(', ')} if you need ` +
          'fidelity-guided overhang selection, or move individual junctions by hand with ' +
          'set_golden_gate_offset (which needs no dataset).',
      }
    );
  }

  const junctions = design.goldenGateJunctions ?? [];
  if (junctions.length === 0 || design.designPrimers.length === 0) {
    return refuse(
      'assembly-not-drafted',
      'This design has no computed Golden Gate junctions or primers yet, so there are no ' +
        'overhangs to score. Adding a region also clears them.',
      {
        goldenGateJunctionCount: junctions.length,
        designPrimerCount: design.designPrimers.length,
        remedy: 'Call draft_design_assembly first, then plan again.',
      }
    );
  }

  const junctionIndexes = junctions.map((junction) => junction.junctionIndex);
  let scopeJunctionIndex: number | null = null;
  if (requestedJunctionIndex !== undefined) {
    if (!junctionIndexes.includes(requestedJunctionIndex)) {
      return refuse(
        'invalid-command-target',
        `Junction ${requestedJunctionIndex} has no computed Golden Gate overhang.`,
        {
          knownJunctionIndexes: junctionIndexes,
          junctions: projectJunctionState(design),
          remedy: 'Pass one of knownJunctionIndexes, or omit junctionIndex to search them all.',
        }
      );
    }
    scopeJunctionIndex = requestedJunctionIndex;
  }

                                                                              
                                                                             
                                                         
  const plan = planGoldenGateAutoOptimization(buildAssemblyOptimizationInput(design), {
    scopeJunctionIndex,
  });

  if (plan.status === 'unavailable') {
    return refuse(
      plan.reason === 'no-four-base-dataset'
        ? 'optimizer-data-unavailable'
        : 'optimizer-search-limit',
      plan.message,
      { enzyme, supportedEnzymes: [...FIDELITY_DATASET_ENZYMES] }
    );
  }

  const combinations = plan.topCombinations;
  const current = combinations[0];
  if (!current) {
    return refuse(
      'optimizer-data-unavailable',
      'The optimizer returned no combinations for this design, not even its current state.',
      { remedy: 'Call draft_design_assembly and try again.' }
    );
  }

  return {
    design,
    plan,
    combinations,
    current,
    planId: buildOverhangOptimizationPlanId({
      optimizationFingerprint: plan.optimizationFingerprint,
      datasetKey: plan.datasetKey,
      datasetContentIdentity: (() => {
        const dataset = getGoldenGateFidelityDataset(plan.datasetKey);
        return `${dataset.sourceFileSha256}:${dataset.workbookCellDigestSha256}`;
      })(),
      scopeJunctionIndex,
      currentCombinationKey: combinationKey(current),
      orderedCombinationKeys: combinations.map(combinationKey),
    }),
    scopeJunctionIndex,
    enzyme,
  };
}

function isRefusal(value: PlannedContext | Refusal): value is Refusal {
  return (value as Refusal).status === 'rejected';
}

function editableJunctionIndexes(design: SequenceDesign, scope: number | null): number[] {
  return (design.goldenGateJunctions ?? [])
    .filter(
      (junction) =>
        !isGoldenGateJunctionOffsetLocked(junction) &&
        (scope === null || junction.junctionIndex === scope)
    )
    .map((junction) => junction.junctionIndex);
}

function lockedJunctionReport(design: SequenceDesign) {
  return (design.goldenGateJunctions ?? [])
    .filter((junction: GoldenGateJunction) => isGoldenGateJunctionOffsetLocked(junction))
    .map((junction) => ({
      junctionIndex: junction.junctionIndex,
      overhang: junction.overhang,
      overhangSource: junction.source.type,
      reason:
        'This end came from a restriction digest. The overhang is a physical property of the ' +
        'cut fragment, so no primer can move it.',
    }));
}

export const planOverhangOptimizationTool = resultTool({
  description:
    'Rank alternative Golden Gate overhang sets for an assembly, WITHOUT changing anything. ' +
    'In a Golden Gate reaction every part is cut to leave a short 4 bp single-stranded sticky ' +
    'end, and all the parts ligate together in one pot. Two junctions whose overhangs can pair ' +
    'with each other — identical, reverse-complementary, or simply cross-reactive — let parts ' +
    'join in the wrong order, and the assembly scrambles. The overhang at a PCR-designed ' +
    'junction is not fixed: sliding its 4 bp window a few bases along the sequence yields a ' +
    'different overhang while producing the exact same final construct, because the bases just ' +
    'move between "copied from the template" and "written into the primer tail". This tool ' +
    'searches those offsets and returns ranked whole-set combinations scored against real ' +
    "published NEB ligation data (Pryor et al. 2020), with each combination's predicted " +
    'fidelity, how many junctions it would move, and the total movement in base pairs. Rank 0 ' +
    'is always the design exactly as it stands, so you can see what you would be trading. ' +
    'Nothing is applied — read the options, pick one, then call apply_overhang_optimization ' +
    'with the planId and rank from this result. Requires a drafted Golden Gate design; junctions ' +
    'whose ends came from a restriction digest cannot move and are reported as locked.',
  inputSchema: planOverhangOptimizationSchema as z.ZodTypeAny,
  execute: async (input: PlanOverhangOptimizationInput) =>
    runDesignTool('PLAN_OVERHANG_OPTIMIZATION_FAILED', async (effects) => {
      const designId = normalizeDesignId(input.designId);
      const base = { designId, planId: null as string | null, combinations: [] as unknown[] };

      try {
        const context = resolveOptimizationContext(designId, input.junctionIndex);
        if (isRefusal(context))
          return designToolFailure(
            'PLAN_OVERHANG_OPTIMIZATION_FAILED',
            { ...base, ...context },
            effects
          );

        const { design, plan, combinations, current, planId, scopeJunctionIndex, enzyme } = context;
        const editable = editableJunctionIndexes(design, scopeJunctionIndex);
                                                                          
                                                                              
                                                                          
                                 
        const optimizable = editable.length > 0 && plan.selectedRank > 0;
        const source = getGoldenGateFidelitySource();

        return toolSuccess({
          ...base,
          status: 'ok' as const,
          planId,
          designId,
          designVersion: design.version,
          enzyme,
          offsetLimitBp: goldenGateOffsetLimitBp(design.goldenGateConfig),
          scope:
            scopeJunctionIndex === null
              ? ('all-junctions' as const)
              : (`junction-${scopeJunctionIndex}` as const),
          scopeJunctionIndex,
          editableJunctionIndexes: editable,
          lockedJunctions: lockedJunctionReport(design),
             
                                                                           
                                                                                 
                                                                       
             
          optimizable,
          notOptimizableReason: optimizable
            ? null
            : editable.length === 0
              ? 'Every junction in scope has a fixed restriction-digest overhang, so no offset ' +
                'can be moved.'
              : 'The optimizer found no offset combination that scores better than the current ' +
                'one. The design is already at the best overhang set it can reach.',
          currentFidelity: projectFidelity(current.fidelity),
             
                                                                               
                                                                              
                                                                              
                                                                               
             
          recommendedRank: plan.selectedRank,
             
                                                                                 
                                                                                
                                                                              
             
          searchProvedOptimal: plan.exhaustive,
          evaluatedNodes: plan.evaluatedNodes,
          fidelityDataset: {
            key: plan.datasetKey,
            paper: source.paper,
            doi: source.doi,
            license: source.license,
            overhangLengthBp: 4,
          },
          combinations: combinations.map((combination) => projectCombination(combination, current)),
          nextStep:
            'Choose a rank and call apply_overhang_optimization with this planId. Applying ' +
            'changes the primer sequences the user would order, never the assembled construct.',
        });
      } catch (error) {
        return designToolFailure(
          'PLAN_OVERHANG_OPTIMIZATION_FAILED',
          {
            ...base,
            status: 'rejected' as const,
            code: 'EXECUTION_FAILED',
            error: `Failed to plan overhang optimization: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          effects
        );
      }
    }),
});

export const applyOverhangOptimizationTool = resultTool({
  description:
    'Apply ONE ranked overhang combination from plan_overhang_optimization. You must quote back ' +
    'the planId and the rank you chose: the plan is recomputed here and the write is refused if ' +
    'the design moved on, so a rank can never silently mean a different combination than the ' +
    'one you read. This rewrites the Golden Gate offsets, which rewrites the PRIMER SEQUENCES ' +
    'THE USER WOULD ORDER — the assembled construct sequence is unchanged, only the split ' +
    'between template-copied and synthesized bases moves. Rank 0 is the design as it stands and ' +
    'returns noop. Junctions whose ends came from a restriction digest are never touched. After ' +
    'applying, call draft_design_assembly to re-validate — no write recomputes validation on ' +
    'its own.',
  inputSchema: applyOverhangOptimizationSchema as z.ZodTypeAny,
  execute: async (input: ApplyOverhangOptimizationInput, context?: { toolCallId?: string }) =>
    runDesignTool('APPLY_OVERHANG_OPTIMIZATION_FAILED', async (effects) => {
      const designId = normalizeDesignId(input.designId);
      const base = {
        designId,
        requestedRank: input.rank,
        versionGuardApplied: input.expectedDesignVersion !== undefined,
        revalidationRequired: false,
      };

      try {
        const resolved = resolveOptimizationContext(designId, input.junctionIndex);
        if (isRefusal(resolved))
          return designToolFailure(
            'APPLY_OVERHANG_OPTIMIZATION_FAILED',
            { ...base, ...resolved },
            effects
          );

        const { design, combinations, current, planId, scopeJunctionIndex } = resolved;

        if (
          input.expectedDesignVersion !== undefined &&
          input.expectedDesignVersion !== design.version
        ) {
          return designToolFailure(
            'APPLY_OVERHANG_OPTIMIZATION_FAILED',
            {
              ...base,
              ...refuse(
                'stale-design-version',
                `The design is at version ${design.version}, not ${input.expectedDesignVersion}.`,
                { currentVersion: design.version, retriable: true }
              ),
            },
            effects
          );
        }

        if (planId !== input.planId) {
                                                                                
                                                                                 
                                                                                 
          return designToolFailure(
            'APPLY_OVERHANG_OPTIMIZATION_FAILED',
            {
              ...base,
              ...refuse(
                'PLAN_STALE',
                'This plan no longer describes the design. Something changed since you read the ' +
                  'ranked options — a region, a spacer, an enzyme, an offset, or the scope you ' +
                  'passed — so rank ' +
                  `${input.rank} may now mean a different combination than the one you chose.`,
                {
                  expectedPlanId: input.planId,
                  actualPlanId: planId,
                  retriable: true,
                  remedy:
                    'Re-read the options with plan_overhang_optimization, choose again, and retry ' +
                    'with the fresh planId.',
                  currentFidelity: projectFidelity(current.fidelity),
                  combinations: combinations.map((combination) =>
                    projectCombination(combination, current)
                  ),
                }
              ),
            },
            effects
          );
        }

        const chosen = combinations[input.rank];
        if (!chosen) {
          return designToolFailure(
            'APPLY_OVERHANG_OPTIMIZATION_FAILED',
            {
              ...base,
              ...refuse(
                'RANK_OUT_OF_RANGE',
                `Rank ${input.rank} is not in this plan; it ranks ${combinations.length} ` +
                  `combination${combinations.length === 1 ? '' : 's'}.`,
                {
                  validRanks: [0, combinations.length - 1] as [number, number],
                  combinationCount: combinations.length,
                  planId,
                }
              ),
            },
            effects
          );
        }

        const beforeJunctions = projectJunctionState(design);
        const previousVersion = design.version;
        const guardVersion = input.expectedDesignVersion ?? design.version;

                                                                              
                                                                               
                                                                      
                                                                             
                      
        const viewState =
          scopeJunctionIndex === null
            ? createAssemblyWorkbenchViewState(design)
            : { selectedJunctionId: null, selectedJunctionIndex: scopeJunctionIndex };

        const result = applyAssemblyWorkbenchCommand({
          design,
          viewState,
          command: {
            type: 'autoOptimize',
            scope: scopeJunctionIndex === null ? 'all' : 'selected-junction',
            candidateRank: input.rank,
            expectedDesignVersion: guardVersion,
          },
        });

        if (result.status === 'noop') {
          return toolSuccess({
            ...base,
            status: 'noop' as const,
            planId,
            appliedRank: input.rank,
            message:
              input.rank === 0
                ? 'Rank 0 is the design as it stands, so nothing was changed.'
                : 'That combination is already the current design, so nothing was changed.',
            designVersion: design.version,
            previousVersion,
            junctions: beforeJunctions,
            fidelity: projectFidelity(current.fidelity),
          });
        }

        if (result.status !== 'applied') {
          const stale = result.errors?.some((error) =>
            String(error?.code ?? error).includes('stale-design-version')
          );
          return designToolFailure(
            'APPLY_OVERHANG_OPTIMIZATION_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: stale
                ? 'stale-design-version'
                : (result.errors?.[0]?.code ?? 'command-rejected'),
              error: result.errors?.[0]?.message ?? 'The optimizer command was rejected.',
              ...(stale ? { currentVersion: design.version, retriable: true } : {}),
              errors: result.errors,
              warnings: result.warnings,
              designVersion: design.version,
              previousVersion,
            },
            effects
          );
        }

        const plannedNextJunctions = projectJunctionState(result.nextDesign);
        const plannedNextOffsets = new Map(
          plannedNextJunctions.map((junction) => [junction.junctionIndex, junction.offset])
        );
        const planDisagreements = chosen.choices
          .filter((choice) => plannedNextOffsets.get(choice.junctionIndex) !== choice.offset)
          .map((choice) => ({
            junctionIndex: choice.junctionIndex,
            plannedOffset: choice.offset,
            actualOffset: plannedNextOffsets.get(choice.junctionIndex) ?? null,
          }));

        if (planDisagreements.length > 0) {
                                                                                
                                                                                 
                                                                           
                                                                 
          return designToolFailure(
            'APPLY_OVERHANG_OPTIMIZATION_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'PLAN_APPLICATION_DIVERGED',
              error:
                'The assembly reducer no longer maps this rank to the offsets shown by the plan. ' +
                'Nothing was changed.',
              remedy:
                'Do not retry this rank. Re-plan and inspect the new options; this disagreement ' +
                'indicates the planner and reducer contracts drifted.',
              planId,
              appliedRank: input.rank,
              planAgreement: 'divergent' as const,
              planDisagreements,
              previousVersion,
              designVersion: design.version,
              junctions: beforeJunctions,
            },
            effects
          );
        }

        effects.attemptedMutation();
        const committed = useDesignStore
          .getState()
          .commitWorkbenchDesign(design.id, result.nextDesign, guardVersion);

        if (!committed) {
          effects.unchanged();
                                                                            
                                                                        
                                         
          const currentDesign = useDesignStore.getState().designs[designId];
          return designToolFailure(
            'APPLY_OVERHANG_OPTIMIZATION_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'stale-design-version',
              error:
                'The design changed before this optimization could be committed. Re-plan with ' +
                'plan_overhang_optimization and retry.',
              previousVersion,
              currentVersion: currentDesign?.version ?? null,
              retriable: true,
            },
            effects
          );
        }

        effects.changed({ kind: 'design-edited', designId });
        const next = useDesignStore.getState().designs[designId] ?? result.nextDesign;
        const afterJunctions = projectJunctionState(next);

        const changedJunctions = afterJunctions
          .map((after) => {
            const before = beforeJunctions.find(
              (item) => item.junctionIndex === after.junctionIndex
            );
            if (!before || (before.offset === after.offset && before.overhang === after.overhang)) {
              return null;
            }
            return {
              junctionIndex: after.junctionIndex,
              previousOffset: before.offset,
              offset: after.offset,
              previousOverhang: before.overhang,
              overhang: after.overhang,
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        return toolSuccess({
          ...base,
          status: 'applied' as const,
          planId,
          appliedRank: input.rank,
             
                                                                          
                                                                                 
                                                                                 
                                                                           
             
          planAgreement: 'exact' as const,
          planDisagreements: [],
          beforeFidelity: projectFidelity(current.fidelity),
          afterFidelity: projectFidelity(chosen.fidelity),
          changedJunctionCount: chosen.changedCount,
          totalMovementBp: chosen.totalMovement,
          changedJunctions,
          junctionsBefore: beforeJunctions,
          junctions: afterJunctions,
          previousVersion,
          designVersion: next.version,
          appliedCommands: result.appliedCommands,
          warnings: result.warnings,
                                                                            
                                                                              
          revalidationRequired: true,
          primersChanged: true,
          mutation: createDesignMutationClaim({
            operationId: context?.toolCallId,
            toolName: 'apply_overhang_optimization',
            effect: 'applied_overhang_optimization',
            designId,
            beforeVersion: previousVersion,
            afterVersion: next.version,
            changed: next.version !== previousVersion,
            expected: {
              planId,
              rank: input.rank,
              offsetsToApply: Object.fromEntries(
                [...chosen.offsetsByJunctionIndex.entries()].map(([junctionIndex, offset]) => [
                  String(junctionIndex),
                  offset,
                ])
              ),
            },
          }),
        });
      } catch (error) {
        return designToolFailure(
          'APPLY_OVERHANG_OPTIMIZATION_FAILED',
          {
            ...base,
            status: 'rejected' as const,
            code: 'EXECUTION_FAILED',
            error: `Failed to apply overhang optimization: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          effects
        );
      }
    }),
});
