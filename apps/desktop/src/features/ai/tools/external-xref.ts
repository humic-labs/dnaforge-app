   
                                                              
                                                                         
                        
  
                                                                              
                                                                             
                                                                            
                                          
   

import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { externalXrefPayloadSchema } from './external-output-schemas';
export { externalXrefOutputSchema } from './external-output-schemas';
import { z } from 'zod';
import { configureSidecarApiClient } from './sidecar-client';
import {
  ApiResponseParseError,
  getXrefsExternalXrefsGet,
  isApiError,
} from '@waypoint/api-client';

export const externalXrefSchema = z
  .object({
    provider: z.string().min(1).max(64),
    external_id: z.string().min(1).max(200),
    target_provider: z.string().min(1).max(64).optional(),
  })
  .strict();

export const externalXrefTool = resultTool({
  description:
    'List cross-references for a previously-fetched external resource. ' +
    'Read-only against the local cache — does NOT trigger network fetches.',
  inputSchema: externalXrefSchema,
  execute: async (
    args: z.infer<typeof externalXrefSchema>,
    context: { abortSignal?: AbortSignal }
  ) => {
    await configureSidecarApiClient('external.xref');
    let payload: {
      resource_id: string;
      target_provider?: string | null;
      xrefs: z.infer<typeof externalXrefPayloadSchema>['xrefs'];
      total: number;
    };
    let status: number;
    try {
      const response = await getXrefsExternalXrefsGet(
        {
          provider: args.provider,
          external_id: args.external_id,
          target_provider: args.target_provider,
        },
        { signal: context.abortSignal }
      );
      const parsed = externalXrefPayloadSchema.safeParse(response.data);
      if (!parsed.success) return { status: response.status, ...toolFailure({
        code: 'INVALID_XREF_RESPONSE', error: 'Sidecar returned an invalid cross-reference response.',
        retriable: false, stateChanged: false, partialEffects: [],
      }) };
      payload = parsed.data;
      status = response.status;
    } catch (error) {
      if (error instanceof ApiResponseParseError) {
        return { status: error.responseStatus, ...toolFailure({ code: 'INVALID_XREF_RESPONSE', error: 'Sidecar returned a non-JSON response.', retriable: false, stateChanged: false, partialEffects: [] }) };
      }
      if (!isApiError(error)) throw error;
      if (error.status === 404) {
        return { status: 404, ...toolFailure({
          code: 'RESOURCE_NOT_CACHED', error: 'Resource is not in the local cache. Call external_fetch first to populate it.',
          retriable: false, stateChanged: false, partialEffects: [],
        }) };
      }
      return { status: error.status, ...toolFailure({code: 'EXTERNAL_XREF_FAILED', error: 'Cross-reference lookup failed.',
        retriable: false, stateChanged: false, partialEffects: [], details: {body: error.body} }) };
    }

    return toolSuccess({
      status,
      resource_id: payload.resource_id,
      xrefs: payload.xrefs,
      total: payload.total,
    });
  },
});
