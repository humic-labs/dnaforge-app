   
                                                
  
                                                                    
                                                                              
                                                                                
                                                                                
                                                             
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { selectionToolFailure } from './sequence-tool-failure';
import { z } from 'zod';
import { findORFs, isKnownGeneticCodeId, STANDARD_GENETIC_CODE_ID } from '@waypoint/sequence-utils';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  resolveSelectionInput,
  isSelectionError,
  selectionInputSchemaShape,
} from './selection-tool-base';

const DEFAULT_MIN_LEN_BP = 100;
                                                                                   
const MAX_ORFS = 200;

const minLenSchema = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe(`Minimum ORF length in bp (default ${DEFAULT_MIN_LEN_BP})`);

                                                                                 
                                                                          
                                                                                
                         
export const selectionFindOrfsSchema = z
  .object({ ...selectionInputSchemaShape, minLen: minLenSchema })
  .strict();

export function createSelectionFindOrfsTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Find open reading frames (ORFs) in a selected region. Fetches the bases ' +
      'internally and returns an ORF table (positions relative to the selection ' +
      'start, strand, frame, length) — do not read or scan bases yourself. Scans ' +
      'all six frames over the full selected range.',
    inputSchema: selectionFindOrfsSchema as z.ZodTypeAny,
    execute: async (input: z.infer<typeof selectionFindOrfsSchema>) => {
      const { minLen } = input;
      const resolved = await resolveSelectionInput(input, folders);
      if (isSelectionError(resolved)) return selectionToolFailure(resolved);

      const minLength = minLen ?? DEFAULT_MIN_LEN_BP;
                                                                                
                                                                               
                                                                                 
      const geneticCode = isKnownGeneticCodeId(resolved.translTable)
        ? resolved.translTable
        : STANDARD_GENETIC_CODE_ID;
      const found = findORFs(resolved.selectionBases, minLength, { geneticCode });
      const sorted = [...found].sort((a, b) => b.length - a.length);
      const absOffset = resolved.range.wraps ? null : resolved.range.start - 1;

      const orfs = sorted.slice(0, MAX_ORFS).map((orf) => ({
                                                               
        start: orf.start + 1,
        end: orf.end + 1,
        strand: orf.strand,
        frame: orf.frame,
        lengthBp: orf.length,
        codonCount: Math.floor(orf.length / 3),
        ...(absOffset != null ? { absoluteStart: orf.start + 1 + absOffset } : {}),
      }));

      return toolSuccess({
        refId: resolved.refId,
        coordinateSystem: '1-indexed-relative-to-selection' as const,
        minLen: minLength,
        orfCount: found.length,
        orfs,
        truncated: found.length > MAX_ORFS,
      });
    },
  });
}
