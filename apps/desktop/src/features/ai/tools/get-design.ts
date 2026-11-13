   
                                                       
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { designToolFailure, runDesignTool } from './design-tool-result';
import { z } from 'zod';
import { useDesignStore } from '../../design/public/store';
import { projectDesignDetail, projectDesignHeader } from './design-projection';

export const getDesignSchema = z
  .object({
    designId: z.string().min(1).describe('Design id returned by create_design or a design URI.'),
    level: z
      .enum(['header', 'detail'])
      .optional()
      .describe(
        'header returns a compact inventory. detail (the default) includes parts, physical ' +
          'restriction-digest ends, spacers, primers, Tm model/provenance, the composed product, ' +
          'and all assembly issues. Products over 50 kb return a preview instead of the full sequence.'
      ),
  })
  .strict();

export const getDesignTool = resultTool({
  description:
    'Read canonical DNAForge design state by id. Use this to verify mutations that target ' +
    'waypoint://design/{id}. IMPORTANT: check `assemblyIssues` and `blocksFinalize`, not just ' +
    '`validationErrorCount`. Some real errors — notably `gg-internal-site`, an internal Type IIS ' +
    'recognition site that would re-cut a Golden Gate part — are deliberately not run-blocking, ' +
    'so they never appear in `validationErrors`. A design with `validationErrorCount: 0` and ' +
    '`blocksFinalize: true` is broken and cannot be exported. Each primer reports `savedOligo`: ' +
    'the saved oligo and revision linked to it, or null. save_design_primers records these ' +
    'links and reports whether each is still current.',
  inputSchema: getDesignSchema as z.ZodTypeAny,
  execute: async ({ designId, level = 'detail' }: z.infer<typeof getDesignSchema>) =>
    runDesignTool('GET_DESIGN_FAILED', async (effects) => {
      const normalizedDesignId = normalizeDesignId(designId);
      const design = useDesignStore.getState().designs[normalizedDesignId];
      if (!design) {
        return designToolFailure(
          'GET_DESIGN_FAILED',
          {
            designId: normalizedDesignId,
            exists: false,
            resourceUri: designResourceUri(normalizedDesignId),
            level,
            error: `Design not found: ${normalizedDesignId}`,
          },
          effects
        );
      }

      const common = {
        designId: normalizedDesignId,
        exists: true as const,
        resourceUri: designResourceUri(normalizedDesignId),
      };
      if (level === 'header')
        return toolSuccess({ ...common, level: 'header' as const, ...projectDesignHeader(design) });
      return toolSuccess({ ...common, level: 'detail' as const, ...projectDesignDetail(design) });
    }),
});

function normalizeDesignId(input: string): string {
  if (!input.startsWith('waypoint://')) {
    return input;
  }

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

function designResourceUri(designId: string): string {
  return `waypoint://design/${encodeURIComponent(designId)}`;
}
