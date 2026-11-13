import { navigateToRegistryEntity } from '../../lims/public/registry-presentation';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import { LIMS_REGISTRATION_STATUSES, LIMS_REGISTRY_SORTS } from '../../../shared/lims';
import {
  getLimsRegistryPreview,
  queryLimsEntities,
  queryLimsRegistrySummaries,
} from '../../lims/public/operations';
import { getLimsEntityById, resolveLimsEntityOpenTarget } from '../../lims/public/open-target';
import { isLimsEntityOpened, openLimsEntity } from '../../lims/public/open-entity';
import { projectPublicSequenceValue } from './public-sequence-projection';
export * from './lims-output-schemas';

const registrationStatusSchema = z.enum(LIMS_REGISTRATION_STATUSES);
const registryRepresentationKindSchema = z.enum([
  'file_sequence',
  'molecular_document',
  'inline_sequence',
  'genome_assembly',
  'strain_evidence',
  'organism_record',
  'unresolved',
  'none',
]);
                                                                          
const registrySortSchema = z.enum(LIMS_REGISTRY_SORTS);

export const limsQueryEntitiesSchema = z
  .object({
    id: z.string().min(1).max(200).optional(),
    kind: z.string().min(1).max(100).optional(),
    nameLike: z.string().min(1).max(200).optional(),
    registrationStatus: registrationStatusSchema.optional(),
    includeArchived: z.boolean().optional(),
    fieldEquals: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export const limsGetEntitySchema = z
  .object({
    entityId: z.string().min(1).max(200),
  })
  .strict();

export const limsQueryRegistrySummariesSchema = z
  .object({
    search: z.string().min(1).max(200).optional(),
    kind: z.string().min(1).max(100).optional(),
    nameLike: z.string().min(1).max(200).optional(),
    sequenceLike: z.string().min(1).max(200).optional(),
    registryIdLike: z.string().min(1).max(200).optional(),
    registrationStatus: registrationStatusSchema.optional(),
    registrationStatuses: z.array(registrationStatusSchema).min(1).max(20).optional(),
    kinds: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
    speciesTaxids: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
    domainStatus: z.string().max(100).nullable().optional(),
    representationKind: registryRepresentationKindSchema.optional(),
    updatedOn: z.number().int().optional(),
    updatedAfter: z.number().int().optional(),
    updatedBefore: z.number().int().optional(),
    sort: registrySortSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
    includeArchived: z.boolean().optional(),
  })
  .strict();

export const limsResolveOpenTargetSchema = limsGetEntitySchema;
export const limsOpenEntitySchema = limsGetEntitySchema
  .extend({
    presentation: z
      .enum(['document', 'registry'])
      .optional()
      .describe(
        'Use registry to show the exact human Registry details and links, even for a file-backed record. Omitted means its normal document view.'
      ),
  })
  .strict();
export const limsGetRegistryPreviewSchema = limsGetEntitySchema;

function publicRecord(value: object): Record<string, unknown> {
  return projectPublicSequenceValue(value) as Record<string, unknown>;
}

function readFailure(code: string, error: unknown) {
  return toolFailure({
    code,
    error: error instanceof Error ? error.message : String(error),
    retriable: false,
    stateChanged: false,
    partialEffects: [],
  });
}

export const limsQueryEntitiesTool = resultTool({
  description:
    'Query the local LIMS registry. Returns registered entities with their typed field payloads, including sequence references when present.',
  inputSchema: limsQueryEntitiesSchema as z.ZodTypeAny,
  execute: async (input: z.infer<typeof limsQueryEntitiesSchema>) => {
    try {
      const entities = await queryLimsEntities(input);
      return toolSuccess({
        count: entities.length,
        entities: projectPublicSequenceValue(entities),
      });
    } catch (error) {
      return readFailure('LIMS_QUERY_ENTITIES_FAILED', error);
    }
  },
});

export const limsQueryRegistrySummariesTool = resultTool({
  description:
    'Search the local LIMS registry summary table. Returns paginated rows with representation, sequence, evidence, and notable-link summaries.',
  inputSchema: limsQueryRegistrySummariesSchema as z.ZodTypeAny,
  execute: async (input: z.infer<typeof limsQueryRegistrySummariesSchema>) => {
    try {
      return toolSuccess(publicRecord(await queryLimsRegistrySummaries(input)));
    } catch (error) {
      return readFailure('LIMS_QUERY_SUMMARIES_FAILED', error);
    }
  },
});

export const limsGetRegistryPreviewTool = resultTool({
  description:
    'Read one local LIMS registry preview, including the entity, registry summary, and labeled incoming/outgoing links.',
  inputSchema: limsGetRegistryPreviewSchema as z.ZodTypeAny,
  execute: async ({ entityId }: z.infer<typeof limsGetRegistryPreviewSchema>) => {
    try {
      return toolSuccess(publicRecord(await getLimsRegistryPreview({ entityId })));
    } catch (error) {
      return readFailure('LIMS_GET_PREVIEW_FAILED', error);
    }
  },
});

export const limsGetEntityTool = resultTool({
  description: 'Read one local LIMS registry entity by id, including its typed field payload.',
  inputSchema: limsGetEntitySchema as z.ZodTypeAny,
  execute: async ({ entityId }: z.infer<typeof limsGetEntitySchema>) => {
    try {
      const entity = await getLimsEntityById(entityId);
      return toolSuccess({
        entityId,
        found: entity !== null,
        entity: projectPublicSequenceValue(entity),
      });
    } catch (error) {
      return readFailure('LIMS_GET_ENTITY_FAILED', error);
    }
  },
});

export const limsResolveOpenTargetTool = resultTool({
  description:
    'Resolve what opening a local LIMS entity would do without changing the UI. File-backed DNA entities resolve to sequence file targets; inline or strain records resolve to detail targets.',
  inputSchema: limsResolveOpenTargetSchema as z.ZodTypeAny,
  execute: async ({ entityId }: z.infer<typeof limsResolveOpenTargetSchema>) => {
    try {
      const target = await resolveLimsEntityOpenTarget(entityId);
      return toolSuccess({ target: projectPublicSequenceValue(target) });
    } catch (error) {
      return readFailure('LIMS_RESOLVE_OPEN_TARGET_FAILED', error);
    }
  },
});

export const LIMS_OPEN_ENTITY_DESCRIPTION =
  'Open an exact local LIMS entity. For visible Registry details and links, pass presentation: registry; this selects the exact record through the human Registry owner even when it has a file-backed document. Registry success requires that owner to acknowledge the exact visible record. Omit presentation (or use document) for its normal native document view; records without a document view fall back to Registry. Reading lims_get_registry_preview returns data and does not display the Registry.';
export const limsOpenEntityTool = resultTool({
  description: LIMS_OPEN_ENTITY_DESCRIPTION,
  inputSchema: limsOpenEntitySchema,
  execute: async ({ entityId, presentation }) => {
    let stateChanged: boolean | 'unknown' = false;
    const presentRegistry = async (label: string, priorResult?: object) => {
      const priorEffects = stateChanged;
      stateChanged = 'unknown';
      const result = await navigateToRegistryEntity({ entityId, fallbackSearch: label });
      const navigationChanged = !['blocked', 'app-not-ready'].includes(result.status);
      stateChanged = navigationChanged ? true : priorEffects;
      if (result.status !== 'presented' || result.entityId !== entityId)
        return toolFailure({
          code: 'REGISTRY_NOT_PRESENTED',
          error:
            'The exact Registry record was not presented; navigation was unavailable, blocked, failed, timed out or superseded.',
          retriable: false,
          stateChanged,
          partialEffects: navigationChanged ? [{ kind: 'navigation', view: 'lims' }] : [],
          details: { ...(priorResult ? publicRecord(priorResult) : {}), registryPresentation: result },
        });
      return toolSuccess({ entityId, status: 'registry-presented', presented: true });
    };
    try {
      if (presentation === 'registry') {
        const entity = await getLimsEntityById(entityId);
        if (!entity)
          return toolFailure({
            code: 'ENTITY_NOT_FOUND',
            error: 'Use Registry discovery for the exact current entity ID.',
            retriable: false,
            stateChanged: false,
            partialEffects: [],
          });
        return await presentRegistry(entity.name);
      }

      stateChanged = 'unknown';
      const result = await openLimsEntity({ entityId, strategy: { kind: 'smart' } });
      if (isLimsEntityOpened(result)) return toolSuccess(publicRecord(result));
      if (result.status !== 'unsupported')
        return toolFailure({
          code: result.status === 'not_found' ? 'LIMS_ENTITY_NOT_FOUND' : 'LIMS_ENTITY_NOT_OPENED',
          error: result.message,
          retriable: false,
          stateChanged: result.status === 'not_found' ? false : 'unknown',
          partialEffects: [],
          details: publicRecord(result),
        });
      return await presentRegistry(result.target.label, result);
    } catch (error) {
      return toolFailure({
        code: 'LIMS_OPEN_ENTITY_FAILED',
        error: error instanceof Error ? error.message : 'The native record could not be opened.',
        retriable: false,
        stateChanged,
        partialEffects: [],
      });
    }
  },
});
