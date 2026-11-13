   
                                                                            
               
  
                                                                            
                                                                                
                                                                              
                                                                                
                                                                       
                              
   

import { resultTool, toolSuccess, toolFailure } from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resolveSelectionInput, isSelectionError, sliceRangeBases } from './selection-tool-base';

                                                                 
export const GET_SELECTION_BASES_CAP_BP = 5000;

const startSchema = z.number().int().min(1).describe('1-indexed inclusive start coordinate');
const endSchema = z.number().int().min(1).describe('1-indexed inclusive end coordinate');
const wrapsSchema = z
  .boolean()
  .optional()
  .describe('true if the window wraps the origin of a circular sequence');

                                                                         
                                                                              
                                                                           
                                                                                
                                                                 
                         
export const getSelectionBasesSchema = z
  .object({
    refId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Reference id of an app selection (identifies the sequence). ' +
          'Provide refId (an app selection) OR sequence (raw bases) — exactly one.'
      ),
    sequence: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Raw bases to window into directly, when no app selection exists. ' +
          'Provide sequence (raw bases) OR refId (an app selection) — exactly one.'
      ),
    start: startSchema,
    end: endSchema,
    wraps: wrapsSchema,
  })
  .strict();

export const getSelectionBasesOutputSchema = z.object({
  ok: z.literal(true), refId: z.string(), documentId: z.string().nullable(),
  start: z.number().int().positive(), end: z.number().int().positive(), wraps: z.boolean(),
  length: z.number().int().nonnegative(), bases: z.string().max(GET_SELECTION_BASES_CAP_BP),
});

export function createGetSelectionBasesTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Last resort: return the raw bases for a bounded window of a referenced ' +
      'sequence (max ' +
      `${GET_SELECTION_BASES_CAP_BP} bp). You are unreliable at reading long ACGT; ` +
      'if you receive bases, do NOT manually translate, reverse-complement, or ' +
      'scan them — call a selection_* compute tool instead, which returns the ' +
      'answer directly. Prefer a compute tool over this tool.',
    inputSchema: getSelectionBasesSchema as z.ZodTypeAny,
    execute: async (input: z.infer<typeof getSelectionBasesSchema>) => {
      const { start, end, wraps } = input;
                                                                                  
      if (!wraps && end < start) {
        return {
          ...toolFailure({code: 'INVALID_RANGE', error: 'A non-wrapping window must have end >= start.', retriable: false, stateChanged: false, partialEffects: []}),
          message:
            `end (${end}) must be >= start (${start}) for a non-wrapping window. ` +
            'Pass wraps: true for a window that crosses the origin of a circular sequence.',
        };
      }

      const resolved = await resolveSelectionInput(input, folders);
      if (isSelectionError(resolved)) return {...resolved, ...toolFailure({code: resolved.error, error: resolved.message, retriable: false, stateChanged: false, partialEffects: [], details: resolved.regions ? {regions: resolved.regions} : undefined})};

                                                                                
                                 
      const windowLength = wraps
        ? resolved.parentLength - start + 1 + end
        : end - start + 1;
      if (windowLength > GET_SELECTION_BASES_CAP_BP) {
        return {
          ...toolFailure({code: 'RANGE_TOO_LARGE', error: `Requested window is ${windowLength} bp; the raw-base cap is ${GET_SELECTION_BASES_CAP_BP} bp. Use a selection compute tool.`, retriable: false, stateChanged: false, partialEffects: []}),
          message:
            `Requested window is ${windowLength} bp; the raw-base cap is ` +
            `${GET_SELECTION_BASES_CAP_BP} bp. Use selection_find_orfs, ` +
            `selection_translate, selection_restriction_sites, or selection_gc_profile ` +
            `instead of pulling raw bases.`,
        };
      }

      const bases = sliceRangeBases(resolved.parentSequence, start, end, wraps === true);

      return toolSuccess({
        refId: resolved.refId,
        documentId: resolved.documentId,
        start,
        end,
        wraps: wraps === true,
        length: bases.length,
        bases,
      });
    },
  });
}
