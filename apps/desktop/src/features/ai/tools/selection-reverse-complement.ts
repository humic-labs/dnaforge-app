   
                                                         
  
                                                                                 
                                                                                 
                                                                            
                                                                           
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { selectionToolFailure } from './sequence-tool-failure';
import { z } from 'zod';
import { reverseComplement } from '@waypoint/sequence-utils';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  resolveSelectionInput,
  isSelectionError,
  selectionInputSchemaShape,
} from './selection-tool-base';

                                                           
export const REVERSE_COMPLEMENT_CAP_BP = 5000;

                                                                                 
                                                                          
                                                                   
export const selectionReverseComplementSchema = z.object({ ...selectionInputSchemaShape }).strict();

export function createSelectionReverseComplementTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Reverse-complement a selected sequence region. Fetches the bases ' +
      'internally from the reference — do not hand-transform bases yourself. ' +
      `Bounded to ${REVERSE_COMPLEMENT_CAP_BP} bp; for a larger region use a ` +
      'compute tool (translate, ORFs, restriction sites) instead.',
    inputSchema: selectionReverseComplementSchema as z.ZodTypeAny,
    execute: async (input: z.infer<typeof selectionReverseComplementSchema>) => {
      const resolved = await resolveSelectionInput(input, folders);
      if (isSelectionError(resolved)) return selectionToolFailure(resolved);

      const bases = resolved.selectionBases;
      if (bases.length > REVERSE_COMPLEMENT_CAP_BP) {
        return selectionToolFailure({
          error: 'RANGE_TOO_LARGE' as const,
          message:
            `Selection is ${bases.length} bp; reverse complement is capped at ` +
            `${REVERSE_COMPLEMENT_CAP_BP} bp. Narrow the selection or use a compute tool.`,
        });
      }

      return toolSuccess({
        refId: resolved.refId,
        reverseComplement: reverseComplement(bases, resolved.nucleicAcid),
        length: bases.length,
      });
    },
  });
}
