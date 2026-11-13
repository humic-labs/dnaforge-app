   
                                                        
  
                                                                                 
                                                                              
                                                                                   
                               
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { selectionToolFailure } from './sequence-tool-failure';
import { z } from 'zod';
import { loadAllEnzymes, findCutSites, type RestrictionEnzyme } from '@waypoint/sequence-utils';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  resolveSelectionInput,
  isSelectionError,
  selectionInputSchemaShape,
} from './selection-tool-base';

                                                                            
const MAX_SITES_PER_ENZYME = 200;

const enzymesSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(50)
  .describe('Enzyme names to scan for, e.g. ["EcoRI","BamHI"]');

                                                                                 
                                                                          
                                                                                 
                                        
export const selectionRestrictionSitesSchema = z
  .object({ ...selectionInputSchemaShape, enzymes: enzymesSchema })
  .strict();

export function createSelectionRestrictionSitesTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Find restriction-enzyme recognition sites in a selected region. Fetches ' +
      'the bases internally and returns a site table (positions relative to the ' +
      'selection start, counts, strand) for the named enzymes — do not read or ' +
      'scan bases yourself. Scans the full selected range.',
    inputSchema: selectionRestrictionSitesSchema as z.ZodTypeAny,
    execute: async (input: z.infer<typeof selectionRestrictionSitesSchema>) => {
      const { enzymes } = input;
      const resolved = await resolveSelectionInput(input, folders);
      if (isSelectionError(resolved)) return selectionToolFailure(resolved);

                                                                              
                                                                               
                                                                                
                                                                             
      let catalog: RestrictionEnzyme[];
      try {
        catalog = await loadAllEnzymes();
      } catch (err) {
        return selectionToolFailure({
          error: 'ENZYME_CATALOG_UNAVAILABLE' as const,
          message: `Could not load the restriction-enzyme catalog: ${
            err instanceof Error ? err.message : 'Unknown error'
          }`,
        });
      }

      const byName = new Map<string, RestrictionEnzyme>();
      for (const enzyme of catalog) {
        byName.set(enzyme.name.toLowerCase(), enzyme);
      }

      const bases = resolved.selectionBases;
                                                                                  
      const absOffset = resolved.range.wraps ? null : resolved.range.start - 1;
      const notFound: string[] = [];
      const results = [];

      for (const requested of enzymes) {
        const enzyme = byName.get(requested.toLowerCase());
        if (!enzyme) {
          notFound.push(requested);
          continue;
        }
        const cutSites = findCutSites(bases, enzyme);
        const sites = cutSites.slice(0, MAX_SITES_PER_ENZYME).map((site) => ({
                                                                 
          recognitionStart: site.recognitionStart + 1,
          strand: site.strand,
          cutTop: site.cutPositionTop + 1,
          cutBottom: site.cutPositionBottom + 1,
          ...(absOffset != null
            ? { absoluteRecognitionStart: site.recognitionStart + 1 + absOffset }
            : {}),
        }));
        results.push({
          enzyme: enzyme.name,
          recognitionSequence: enzyme.recognition_sequence,
          siteCount: cutSites.length,
          sites,
          truncated: cutSites.length > MAX_SITES_PER_ENZYME,
        });
      }

      return toolSuccess({
        refId: resolved.refId,
        coordinateSystem: '1-indexed-relative-to-selection' as const,
        results,
        notFound,
      });
    },
  });
}
