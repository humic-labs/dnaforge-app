   
                                                 
  
                                                                              
                                                                
                                                             
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { selectionToolFailure } from './sequence-tool-failure';
import { z } from 'zod';
import { calculateGcContent } from '../../design/public/algorithms/tm-calculator';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  resolveSelectionInput,
  isSelectionError,
  selectionInputSchemaShape,
} from './selection-tool-base';

const DEFAULT_WINDOW_BP = 50;
                                                                                 
const MAX_WINDOWS = 2000;

const windowSchema = z
  .number()
  .int()
  .min(1)
  .max(100000)
  .optional()
  .describe(`Non-overlapping window size in bp (default ${DEFAULT_WINDOW_BP})`);

                                                                                 
                                                                          
                                                                                
                         
export const selectionGcProfileSchema = z
  .object({ ...selectionInputSchemaShape, window: windowSchema })
  .strict();

export function createSelectionGcProfileTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Compute a GC-content profile across a selected region. Fetches the bases ' +
      'internally and returns per-window GC% plus the aggregate — do not read the ' +
      'bases yourself. Windows are non-overlapping.',
    inputSchema: selectionGcProfileSchema as z.ZodTypeAny,
    execute: async (input: z.infer<typeof selectionGcProfileSchema>) => {
      const { window } = input;
      const resolved = await resolveSelectionInput(input, folders);
      if (isSelectionError(resolved)) return selectionToolFailure(resolved);

      const bases = resolved.selectionBases;
      const windowSize = window ?? DEFAULT_WINDOW_BP;

      const windows: Array<{ start: number; end: number; gcPercent: number }> = [];
      let truncated = false;
      for (let offset = 0; offset < bases.length; offset += windowSize) {
        if (windows.length >= MAX_WINDOWS) {
          truncated = true;
          break;
        }
        const slice = bases.slice(offset, offset + windowSize);
        windows.push({
                                                                 
          start: offset + 1,
          end: Math.min(offset + windowSize, bases.length),
          gcPercent: calculateGcContent(slice),
        });
      }

      return toolSuccess({
        refId: resolved.refId,
        windowSize,
        length: bases.length,
        overallGcPercent: calculateGcContent(bases),
        windows,
        truncated,
      });
    },
  });
}
