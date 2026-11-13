   
                                                
  
                                                                             
                                                                            
                                                                              
                                                                        
                                                 
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { selectionToolFailure } from './sequence-tool-failure';
import { z } from 'zod';
import {
  geneticCodeLabel,
  isKnownGeneticCodeId,
  STANDARD_GENETIC_CODE_ID,
  translateSequence,
} from '@waypoint/sequence-utils';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  resolveSelectionInput,
  isSelectionError,
  selectionInputSchemaShape,
} from './selection-tool-base';

                                                                         
                                                                              
                                                                               
                                                                                 
                                                                              
                  
export const selectionTranslateSchema = z.object({ ...selectionInputSchemaShape }).strict();

export function createSelectionTranslateTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Translate a selected sequence region to protein. Fetches the bases ' +
      'internally from the reference and returns the amino-acid sequence only — ' +
      'you never need (and should never ask for) the raw bases. Strand- and ' +
      'reading-frame-aware from the selection descriptor: a minus-strand region ' +
      'is reverse-complemented before translation.',
    inputSchema: selectionTranslateSchema as z.ZodTypeAny,
    execute: async (input: z.infer<typeof selectionTranslateSchema>) => {
      const resolved = await resolveSelectionInput(input, folders);
      if (isSelectionError(resolved)) return selectionToolFailure(resolved);

      const direction: 1 | -1 = resolved.strand === '-' ? -1 : 1;
      const translTable = resolved.translTable;
                                                                                
                                                                               
                                                                              
      const geneticCode = isKnownGeneticCodeId(translTable)
        ? translTable
        : STANDARD_GENETIC_CODE_ID;
      const codons = translateSequence(resolved.selectionBases, direction, 0, geneticCode);
      const protein = codons.map((c) => c.aminoAcid).join('');

      const unknownTable = translTable != null && !isKnownGeneticCodeId(translTable);

      return toolSuccess({
        refId: resolved.refId,
        protein,
        proteinLengthAa: protein.length,
        strand: resolved.strand === '-' ? ('-' as const) : ('+' as const),
        frame: 0,
        geneticCode: geneticCodeLabel(geneticCode),
        translTable,
        startsWithMet: protein.startsWith('M'),
        hasInternalStop: protein.slice(0, -1).includes('*'),
                                                                               
                                                                                    
        ...(unknownTable
          ? {
              note:
                `The selection declares translation table ${translTable}, which is not a ` +
                `published NCBI genetic code. The standard code was applied instead.`,
            }
          : {}),
      });
    },
  });
}
