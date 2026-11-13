   
                                                                            
                                               
  
                                                                              
                                                                              
                                                                            
                                                                              
                               
  
                                                                       
                                                                              
                                                                             
                                                                               
                                                                               
                                                                       
  
                                                                          
                                                                              
                                                                               
                                                                      
                                  
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { designToolFailure, runDesignTool } from './design-tool-result';
import { z } from 'zod';
import { useDesignStore } from '../../design/public/store';
import { isGoldenGateJunctionOffsetLocked } from '../../design/public/algorithms/draft-assembly';
import {
  computeJunctionCount,
  ensureAssemblyWorkbenchIdentity,
  getJunctionIdentity,
} from '../../junction-workbench/public/AssemblyWorkbenchIdentity';
import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from '../../junction-workbench/public/AssemblyWorkbenchReducer';
import { goldenGateOffsetLimitBp } from '../../junction-workbench/public/AssemblyWorkbenchContract';
import type { GoldenGateJunction, SequenceDesign } from '../../design/public/types';
import { createDesignMutationClaim } from './agent-mutation';

export const setGoldenGateOffsetSchema = z
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
        'Which junction to move. Junction i is the junction AFTER region i. Designs are ' +
          'circular, so a design with N parts has N junctions (the last one wraps). Provide ' +
          'this OR junctionId; if you provide both they must agree.'
      ),
    junctionId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Stable junction id, as returned in this tool's `junctions` array. Survives " +
          'renumbering when parts are reordered, unlike junctionIndex.'
      ),
    offset: z
      .number()
      .int()
      .describe(
        'Where the overhang window sits, in BASE PAIRS relative to centred. 0 = centred on ' +
          'the junction (half the overhang taken from each part). Negative moves the window ' +
          "into the LEFT part, positive into the RIGHT part. Bounded by the design's offset " +
          'limit (default 24 bp either way); a refusal reports the actual limit.'
      ),
    expectedDesignVersion: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'The design version you last read. If supplied and the design has moved on, the write ' +
          'is refused with code stale-design-version instead of overwriting. If omitted NO ' +
          'concurrency guard runs — the result reports versionGuardApplied so you can tell.'
      ),
  })
  .strict();

type SetGoldenGateOffsetInput = z.infer<typeof setGoldenGateOffsetSchema>;

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

                                                                                           
function junctionIdsBySlot(design: SequenceDesign): Map<number, string> {
  const identities = ensureAssemblyWorkbenchIdentity(design).assemblyWorkbench?.junctions ?? [];
  return new Map(identities.map((identity) => [identity.slot, identity.id]));
}

function projectJunction(junction: GoldenGateJunction, junctionId: string | null) {
  return {
    junctionId,
    junctionIndex: junction.junctionIndex,
    offset: junction.offset,
    overhang: junction.overhang,
    overhangStart: junction.overhangStart,
    overhangEnd: junction.overhangEnd,
    overhangSource: junction.source.type,
    offsetEditable: !isGoldenGateJunctionOffsetLocked(junction),
    isValid: junction.isValid,
    validationError: junction.validationError ?? null,
  };
}

function projectJunctions(design: SequenceDesign) {
  const ids = junctionIdsBySlot(design);
  return (design.goldenGateJunctions ?? []).map((junction) =>
    projectJunction(junction, ids.get(junction.junctionIndex) ?? null)
  );
}

   
                                                                             
                                                              
   
function duplicateOverhangs(design: SequenceDesign): string[] {
  const counts = new Map<string, number>();
  for (const junction of design.goldenGateJunctions ?? []) {
    counts.set(junction.overhang, (counts.get(junction.overhang) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([overhang]) => overhang);
}

export const setGoldenGateOffsetTool = resultTool({
  description:
    'Move the Golden Gate overhang at one junction along the sequence. The overhang is the ' +
    'short sticky end the Type IIS enzyme leaves; its LENGTH is fixed by the enzyme (4 bp for ' +
    'BsaI/BbsI/BsmBI, 3 bp for SapI) and this tool never changes it — `offset` only slides the ' +
    'window, in base pairs, relative to centred (0 = half from each part, negative = into the ' +
    'left part, positive = into the right part). Physically this re-partitions which bases the ' +
    'polymerase copies from the template versus which the oligo synthesizer writes de novo into ' +
    'the primer tail, so it changes the OLIGOS YOU ORDER and never the assembled product. Use ' +
    "it to move a junction off a bad overhang — one that duplicates another junction's " +
    'overhang (the parts would ligate in the wrong order) or is palindromic (self-ligation). ' +
    'Golden Gate designs only, and only at junctions between PCR-designed parts: an end that ' +
    'came from a restriction digest is a physical property of the cut fragment and cannot be ' +
    "moved. The result reports every junction's overhang so you can confirm the collision is " +
    'gone. After writing, call draft_design_assembly to re-validate — no write recomputes ' +
    'validation on its own.',
  inputSchema: setGoldenGateOffsetSchema as z.ZodTypeAny,
  execute: async (input: SetGoldenGateOffsetInput, context?: { toolCallId?: string }) =>
    runDesignTool('SET_GOLDEN_GATE_OFFSET_FAILED', async (effects) => {
      const {
        designId: rawDesignId,
        junctionIndex: requestedIndex,
        junctionId: requestedId,
        offset,
        expectedDesignVersion,
      } = input;
      const designId = normalizeDesignId(rawDesignId);

      const base = {
        designId,
        junction: null,
        revalidationRequired: false,
        versionGuardApplied: expectedDesignVersion !== undefined,
      };

      try {
        const design = useDesignStore.getState().designs[designId];
        if (!design) {
          return designToolFailure(
            'SET_GOLDEN_GATE_OFFSET_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'design-not-found',
              error: `Design not found: ${designId}`,
            },
            effects
          );
        }

        if (design.assemblyMethod !== 'goldengate') {
          return designToolFailure(
            'SET_GOLDEN_GATE_OFFSET_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'unsupported-mode-command',
              error:
                `Overhang offsets only exist in Golden Gate assembly; this design uses ` +
                `${design.assemblyMethod}. Gibson/NEBuilder junctions are joined by homology arms ` +
                '(see set_homology_encoding), not by Type IIS sticky ends.',
              assemblyMethod: design.assemblyMethod,
              supportedAssemblyMethods: ['goldengate'],
            },
            effects
          );
        }

        const junctionCount = computeJunctionCount(design);
        const junctions = design.goldenGateJunctions ?? [];
        const validRange: [number, number] = [0, Math.max(0, junctionCount - 1)];

        if (junctions.length === 0) {
          return designToolFailure(
            'SET_GOLDEN_GATE_OFFSET_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'assembly-not-drafted',
              error:
                junctionCount === 0
                  ? 'This design has no junctions yet — add at least two regions, then call ' +
                    'draft_design_assembly.'
                  : 'Golden Gate overhangs have not been computed yet. Call draft_design_assembly ' +
                    'first; adding a region clears them.',
              junctionCount,
            },
            effects
          );
        }

        const knownJunctions = projectJunctions(design).map((junction) => ({
          junctionId: junction.junctionId,
          junctionIndex: junction.junctionIndex,
          offset: junction.offset,
          overhang: junction.overhang,
          offsetEditable: junction.offsetEditable,
        }));
        const editableJunctionIndexes = knownJunctions
          .filter((junction) => junction.offsetEditable)
          .map((junction) => junction.junctionIndex);

        if (requestedId === undefined && requestedIndex === undefined) {
          return designToolFailure(
            'SET_GOLDEN_GATE_OFFSET_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'BAD_INPUT',
              error: 'Provide either junctionIndex or junctionId.',
              junctionCount,
              validRange,
              knownJunctions,
              editableJunctionIndexes,
            },
            effects
          );
        }

        const identity = getJunctionIdentity(design, {
          ...(requestedId !== undefined ? { junctionId: requestedId } : {}),
          ...(requestedId === undefined && requestedIndex !== undefined
            ? { junctionIndex: requestedIndex }
            : {}),
        });

        if (requestedId !== undefined && !identity) {
          return designToolFailure(
            'SET_GOLDEN_GATE_OFFSET_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'junction-not-found',
              error: `Junction not found: ${requestedId}`,
              junctionCount,
              validRange,
              knownJunctions,
              editableJunctionIndexes,
            },
            effects
          );
        }

                                                                                  
                                                                                  
                                  
        if (identity && requestedId !== undefined && requestedIndex !== undefined) {
          if (identity.slot !== requestedIndex) {
            return designToolFailure(
              'SET_GOLDEN_GATE_OFFSET_FAILED',
              {
                ...base,
                status: 'rejected' as const,
                code: 'AMBIGUOUS_TARGET',
                error:
                  `junctionId ${requestedId} is junction ${identity.slot}, not junction ` +
                  `${requestedIndex}. Pass only one of the two addresses.`,
                junctionCount,
                validRange,
                knownJunctions,
                editableJunctionIndexes,
              },
              effects
            );
          }
        }

        const targetIndex = identity?.slot ?? requestedIndex;
        const junction =
          targetIndex === undefined
            ? undefined
            : junctions.find((item) => item.junctionIndex === targetIndex);

        if (!identity || !junction || targetIndex === undefined) {
          return designToolFailure(
            'SET_GOLDEN_GATE_OFFSET_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'invalid-command-target',
              error:
                targetIndex !== undefined && targetIndex > validRange[1]
                  ? `Junction ${targetIndex} does not exist.`
                  : `Junction ${targetIndex} has no computed Golden Gate overhang. Call ` +
                    'draft_design_assembly.',
              junctionCount,
              validRange,
              knownJunctions,
              editableJunctionIndexes,
            },
            effects
          );
        }

        const offsetLimitBp = goldenGateOffsetLimitBp(design.goldenGateConfig);
        if (Math.abs(offset) > offsetLimitBp) {
          return designToolFailure(
            'SET_GOLDEN_GATE_OFFSET_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'invalid-command-value',
              error:
                `Offset ${offset} is outside this design's limit of ±${offsetLimitBp} bp. Past that ` +
                'the overhang stops overlapping the junction and the primer would have to encode ' +
                'the whole gap de novo.',
              offsetLimitBp,
              validOffsetRange: [-offsetLimitBp, offsetLimitBp] as [number, number],
              junction: projectJunction(junction, identity.id),
            },
            effects
          );
        }

        if (isGoldenGateJunctionOffsetLocked(junction)) {
          return designToolFailure(
            'SET_GOLDEN_GATE_OFFSET_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'fixed-goldengate-junction',
              error:
                `Junction ${targetIndex}'s overhang comes from a restriction digest ` +
                `(source: ${junction.source.type}). That end is a physical property of the cut ` +
                'fragment — no primer can move it. Only junctions between two PCR-designed parts ' +
                'can be offset.',
              overhangSource: junction.source.type,
              junction: projectJunction(junction, identity.id),
              junctionCount,
              knownJunctions,
              editableJunctionIndexes,
            },
            effects
          );
        }

        const previousOffset = junction.offset;
        const previousOverhang = junction.overhang;
        const previousVersion = design.version;
        const guardVersion = expectedDesignVersion ?? design.version;

        const result = applyAssemblyWorkbenchCommand({
          design,
          viewState: createAssemblyWorkbenchViewState(design),
          command: {
            type: 'setGoldenGateOffset',
            junctionIndex: targetIndex,
            offset,
            expectedDesignVersion: guardVersion,
          },
        });

        if (result.status === 'noop') {
          return toolSuccess({
            ...base,
            status: 'noop' as const,
            junctionIndex: targetIndex,
            junctionId: identity.id,
            junctionCount,
            offset,
            previousOffset,
            overhangChanged: false,
            offsetLimitBp,
            junction: projectJunction(junction, identity.id),
            junctions: projectJunctions(design),
            duplicateOverhangs: duplicateOverhangs(design),
            designVersion: design.version,
            previousVersion,
          });
        }

        if (result.status !== 'applied') {
          const stale = result.errors?.some((error) =>
            String(error?.code ?? error).includes('stale-design-version')
          );
          return designToolFailure(
            'SET_GOLDEN_GATE_OFFSET_FAILED',
            {
              ...base,
              status: result.status,
              ...(stale
                ? { code: 'stale-design-version', currentVersion: design.version, retriable: true }
                : { code: result.errors?.[0]?.code }),
              errors: result.errors,
              warnings: result.warnings,
              designVersion: design.version,
              previousVersion,
              error: result.errors?.[0]?.message ?? undefined,
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
                                                                                 
                                                                                  
                                                      
          const current = useDesignStore.getState().designs[designId];
          return designToolFailure(
            'SET_GOLDEN_GATE_OFFSET_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'stale-design-version',
              error:
                'The design changed before this edit could be committed. Re-read it with get_design ' +
                'and retry.',
              previousVersion,
              currentVersion: current?.version ?? null,
              retriable: true,
            },
            effects
          );
        }

        effects.changed({ kind: 'design-edited', designId });
        const next = useDesignStore.getState().designs[designId] ?? result.nextDesign;
        const nextJunction =
          (next.goldenGateJunctions ?? []).find((item) => item.junctionIndex === targetIndex) ??
          junction;
        const nextIds = junctionIdsBySlot(next);

        return toolSuccess({
          ...base,
          status: 'applied' as const,
          junctionIndex: targetIndex,
          junctionId: identity.id,
          junctionCount,
          offset,
          previousOffset,
          previousOverhang,
          overhangChanged: nextJunction.overhang !== previousOverhang,
          offsetLimitBp,
          junction: projectJunction(nextJunction, nextIds.get(targetIndex) ?? identity.id),
          junctions: projectJunctions(next),
          duplicateOverhangs: duplicateOverhangs(next),
          previousVersion,
          designVersion: next.version,
          appliedCommands: result.appliedCommands,
          warnings: result.warnings,
                                                                            
                                                                              
          revalidationRequired: true,
          mutation: createDesignMutationClaim({
            operationId: context?.toolCallId,
            toolName: 'set_golden_gate_offset',
            effect: 'set_golden_gate_offset',
            designId,
            beforeVersion: previousVersion,
            afterVersion: next.version,
            changed: next.version !== previousVersion,
            expected: {
              junctionId: identity.id,
              junctionIndex: targetIndex,
              offset,
              overhang: nextJunction?.overhang ?? null,
            },
          }),
        });
      } catch (error) {
        return designToolFailure(
          'SET_GOLDEN_GATE_OFFSET_FAILED',
          {
            ...base,
            status: 'rejected' as const,
            code: 'EXECUTION_FAILED',
            error: `Failed to set Golden Gate offset: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          effects
        );
      }
    }),
});
