import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { externalFetchPayloadSchema } from './external-output-schemas';
export { externalFetchOutputSchema } from './external-output-schemas';
import { z } from 'zod';
import {
  createRendererSidecarApiClient,
  resolveExternalLookupBaseUrl,
} from '../../../services/sidecar-session';
import {
  ApiResponseParseError,
  isApiError,
  postFetchExternalFetchPost,
} from '@waypoint/api-client';

const bindToSchema = z
  .object({
    source_kind: z.enum(['sequence', 'feature', 'project']),
    source_uri: z.string().min(1).max(2000),
    relationship: z.string().min(1).max(100),
    evidence: z.enum(['asserted', 'inferred', 'predicted']),
  })
  .strict();

export const externalFetchSchema = z
  .object({
    provider: z.string().min(1).max(64),
    external_id: z.string().min(1).max(200),
    workspace_id: z.string().min(1).max(200).optional(),
    bind_to: bindToSchema.optional(),
  })
  .strict();

export const externalFetchTool = resultTool({
  description:
    'Fetch and persist an external biology database resource (e.g., UniProt entry) via the sidecar. ' +
    'Returns license + attribution + persisted resource id.',
  inputSchema: externalFetchSchema,
  execute: async (
    args: z.infer<typeof externalFetchSchema>,
    context: { abortSignal?: AbortSignal; toolCallId?: string; grantedCapabilities?: string[] }
  ) => {
    const apiClient = createRendererSidecarApiClient(await resolveExternalLookupBaseUrl('external.fetch'));
    const headers: Record<string, string> = {};
    if (context.toolCallId) {
      headers['X-DNAForge-Action-Id'] = context.toolCallId;
    }
    try {
      const response = await postFetchExternalFetchPost(
        { ...args, granted_capabilities: context.grantedCapabilities ?? [] },
        apiClient.options({ headers, signal: context.abortSignal })
      );
      const parsed = externalFetchPayloadSchema.safeParse(response.data);
      if (!parsed.success) {
        return { status: response.status, ...toolFailure({
          code: 'INVALID_EXTERNAL_FETCH_RESPONSE', error: 'Sidecar returned an invalid fetch receipt.',
          retriable: false, stateChanged: 'unknown', partialEffects: [],
        }) };
      }
      return toolSuccess({ status: response.status, ...parsed.data });
    } catch (error) {
      if (error instanceof ApiResponseParseError) {
        return { status: error.responseStatus, ...toolFailure({ code: 'INVALID_EXTERNAL_FETCH_RESPONSE', error: 'Sidecar returned a non-JSON response.', retriable: false, stateChanged: 'unknown', partialEffects: [] }) };
      }
      if (!isApiError(error)) throw error;
      const detail =
        typeof error.body === 'object' && error.body !== null && 'detail' in error.body
          ? String((error.body as { detail: unknown }).detail)
          : error.bodyPreview
            ? 'sidecar returned non-JSON response'
            : 'sidecar returned non-2xx';
      return { status: error.status, ...toolFailure({
        code: 'EXTERNAL_FETCH_FAILED', error: detail, retriable: false,
        stateChanged: 'unknown', partialEffects: [],
        details: { body: error.body, ...(error.bodyPreview ? {bodyPreview: error.bodyPreview} : {}) },
      }) };
    }
  },
});
