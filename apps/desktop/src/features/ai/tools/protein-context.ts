import { z } from 'zod';
import { isApiError, postFetchExternalFetchPost } from '@waypoint/api-client';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import {
  createRendererSidecarApiClient,
  resolveExternalLookupBaseUrl,
} from '../../../services/sidecar-session';

const pdbId = z.string().regex(/^[0-9][A-Za-z0-9]{3}$/);
const uniprotId = z.string().min(6).max(10).regex(/^[A-Z0-9]+$/);
const limit = z.number().int().min(1).max(20).optional();

const supportedRequestSchema = z.union([
  z.object({
    source: z.enum(['protein-mcp', 'uniprot-mcp']),
    operation: z.literal('search'),
    query: z.string().min(1).max(80).describe('Short protein name/function search; not a sequence submission.'),
    limit,
  }).strict(),
  z.object({
    source: z.literal('protein-mcp'),
    operation: z.literal('structure'),
    pdbId,
  }).strict(),
  z.object({
    source: z.literal('protein-mcp'),
    operation: z.literal('annotations'),
    uniprotId,
    limit,
  }).strict(),
  z.object({
    source: z.literal('protein-mcp'),
    operation: z.literal('annotations'),
    pdbId,
    chain: z.string().min(1).max(12).describe('Exact author chain for PDB annotations.'),
    limit,
  }).strict(),
  z.object({
    source: z.literal('protein-mcp'),
    operation: z.literal('binding_site'),
    pdbId,
    ligandId: z.string().min(1).max(8).regex(/^[A-Za-z0-9]+$/),
    limit,
  }).strict(),
  z.object({
    source: z.literal('uniprot-mcp'),
    operation: z.literal('annotations'),
    uniprotId,
    sections: z.array(z.string().max(24)).max(8).optional().describe('UniProt outline section keys; only use after an outline response.'),
  }).strict(),
]);

export const proteinContextSchema = z.object({
  source: z.enum(['protein-mcp', 'uniprot-mcp']).describe('Choose an explicit experimental source; no automatic fallback.'),
  operation: z.enum(['search', 'structure', 'annotations', 'binding_site']),
  query: z.string().min(1).max(80).optional(),
  pdbId: pdbId.optional(),
  uniprotId: uniprotId.optional(),
  chain: z.string().min(1).max(12).optional().describe('Author chain; only for protein-mcp PDB annotations, not a binding-site filter.'),
  ligandId: z.string().min(1).max(8).regex(/^[A-Za-z0-9]+$/).optional(),
  limit,
  sections: z.array(z.string().max(24)).max(8).optional().describe('Only for accession-based UniProt annotation outline follow-up.'),
}).strict().superRefine((request, context) => {
  if (!supportedRequestSchema.safeParse(request).success) context.addIssue({
    code: z.ZodIssueCode.custom,
    message: request.source === 'uniprot-mcp'
      ? 'UniProt supports search(query) and annotations(uniprotId, optional sections). It cannot resolve PDB chains or provide coordinate mapping.'
      : 'Use search(query), structure(pdbId), annotations(uniprotId OR pdbId+author chain), or binding_site(pdbId+ligandId). Do not supply selectors for a different operation; binding_site returns all matching ligand instances.',
  });
});

const failure = (error: string, code = 'PROTEIN_CONTEXT_FAILED', retriable = false) =>
  toolFailure({ code, error, retriable, stateChanged: false, partialEffects: [] });

export function createProteinGetContextTool() {
  return resultTool({
    description: 'Experimental scientific protein context from existing protein-mcp and UniProt-mcp servers. For protein-mcp: search(query) experimental structures, structure(pdbId) metadata/species/ligands, annotations(uniprotId OR pdbId+author chain), binding_site(pdbId+ligandId) geometric pocket contacts and exact numbering. For uniprot-mcp: search(query) reviewed proteins, annotations(uniprotId) curated function/features/evidence; re-call sections after an outline. Result preserves provider data and provenance. Feature positions are UniProt coordinates and require mapping before rendering. Contact distances do not establish hydrogen bonds. Use mol_open_tab for actual coordinate downloads, then mol_get_scene/mol_apply_scene and mol_save_view to include a useful view in the answer. Missing features and unavailable providers must be reported honestly.',
    inputSchema: proteinContextSchema,
    execute: async (input, context) => {
      const validated = proteinContextSchema.safeParse(input);
      if (!validated.success) return failure(validated.error.issues.map((issue) => issue.message).join('; '), 'BAD_INPUT');
      const { source, ...request } = validated.data;
      const externalId = JSON.stringify(request);
      if (externalId.length > 200) return failure('Context request exceeds the 200-character provider request budget.', 'PROTEIN_CONTEXT_REQUEST_TOO_LARGE');
      try {
        const apiClient = createRendererSidecarApiClient(await resolveExternalLookupBaseUrl('protein_get_context'));
        const options = context as typeof context & { grantedCapabilities?: string[] };
        const response = await postFetchExternalFetchPost({
          provider: source, external_id: externalId,
          granted_capabilities: options.grantedCapabilities ?? [],
        }, apiClient.options({ signal: context.abortSignal, headers: context.toolCallId ? { 'X-DNAForge-Action-Id': context.toolCallId } : {} }));
        return toolSuccess({ ...response.data, source });
      } catch (error) {
        if (isApiError(error)) return failure(JSON.stringify(error.body ?? { status: error.status }), 'PROTEIN_CONTEXT_PROVIDER_ERROR', error.status >= 500);
        return failure(error instanceof Error ? error.message : String(error), 'PROTEIN_CONTEXT_TRANSPORT_ERROR', true);
      }
    },
  });
}
