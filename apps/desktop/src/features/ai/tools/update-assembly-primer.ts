import { z } from 'zod';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { useDesignStore } from '../../design/public/store';
import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from '../../junction-workbench/public/AssemblyWorkbenchReducer';
import { getPrimerIdentity } from '../../junction-workbench/public/AssemblyWorkbenchIdentity';
import { createDesignMutationClaim } from './agent-mutation';
import { IUPAC_BASES_PATTERN, OPTIONAL_IUPAC_BASES_PATTERN } from '../../../shared/published-schema-patterns';

export const UPDATE_ASSEMBLY_PRIMER_DESCRIPTION =
  'Freely edit an existing assembly primer in Gibson, NEBuilder or Golden Gate: author its ' +
  'annealing bases, full synthesized 5-prime tail, name or binding coordinates. Intentional ' +
  'mismatches, substitutions, insertions, deletions and arbitrary lengths are allowed. These ' +
  'edits persist through redrafting. The intended assembled product is unchanged; scientific ' +
  'compatibility is not implied. Exact vendor-ready oligo notation also supports DNA/RNA chemistry and terminal/internal modifications; annealingLength splits the last natural bases from the 5-prime tail. Use get_design to read stable primer IDs and the current version.';

export const updateAssemblyPrimerSchema = z
  .object({
    designId: z.string().min(1),
    primerId: z.string().min(1),
    expectedDesignVersion: z.number().int().nonnegative(),
    name: z.string().min(1).optional(),
    pbsSequence: z
      .string()
      .min(1)
      .regex(IUPAC_BASES_PATTERN)
      .optional(),
    overhangSequence: z
      .string()
      .regex(OPTIONAL_IUPAC_BASES_PATTERN)
      .optional(),
    pbsStart: z.number().int().nonnegative().optional(),
    pbsEnd: z.number().int().positive().optional(),
    oligo: z.object({ vendor: z.literal('idt'), notation: z.string().min(1).max(10000), orderType: z.enum(['dna', 'rna']).optional() }).strict().optional(),
    annealingLength: z.number().int().positive().optional(),
  })
  .strict();

export function createUpdateAssemblyPrimerTool() {
  return resultTool({
    description: UPDATE_ASSEMBLY_PRIMER_DESCRIPTION,
    inputSchema: updateAssemblyPrimerSchema,
    execute: async (input, context) => {
      const designId = input.designId.startsWith('waypoint://design/')
        ? decodeURIComponent(input.designId.slice('waypoint://design/'.length))
        : input.designId;
      const design = useDesignStore.getState().designs[designId];
      if (!design)
        return toolFailure({
          code: 'DESIGN_NOT_FOUND',
          error: `Design not found: ${designId}`,
          retriable: false,
          stateChanged: false,
          partialEffects: [],
        });
      const result = applyAssemblyWorkbenchCommand({
        design,
        viewState: createAssemblyWorkbenchViewState(design),
        command: { ...input, type: 'setPrimerContent' },
      });
      if (result.status !== 'applied')
        return toolFailure({
          code: result.errors[0]?.code ?? 'PRIMER_EDIT_REJECTED',
          error: result.errors[0]?.message ?? 'The primer edit could not be applied.',
          retriable: result.errors.some((error) => error.code === 'stale-design-version'),
          stateChanged: false,
          partialEffects: [],
          details: { designVersion: design.version },
        });
      const committed = useDesignStore
        .getState()
        .commitWorkbenchDesign(designId, result.nextDesign, input.expectedDesignVersion);
      if (!committed)
        return toolFailure({
          code: 'stale-design-version',
          error: 'The design changed before commit. Read it again and retry.',
          retriable: true,
          stateChanged: false,
          partialEffects: [],
        });
      const identity = getPrimerIdentity(result.nextDesign, { primerId: input.primerId });
      const primer = result.nextDesign.designPrimers
        .flatMap((pair) => [pair.forward, pair.reverse])
        .find((item) => item.id === identity?.id);
      return toolSuccess({
        changed: true,
        designId,
        designVersion: result.nextDesign.version,
        primer,
        warnings: [
          'Authored primer content is preserved; binding and assembly compatibility require validation.',
        ],
        mutation: createDesignMutationClaim({
          operationId: context.toolCallId,
          toolName: 'update_assembly_primer',
          effect: 'updated_assembly_primer',
          designId,
          beforeVersion: design.version,
          afterVersion: result.nextDesign.version,
          changed: true,
          expected: { primerId: input.primerId, sequence: primer?.sequence },
        }),
      });
    },
  });
}
