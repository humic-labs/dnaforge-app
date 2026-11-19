import { ENTITY_TYPE_ICON_KINDS } from '@waypoint/scientific-artifacts/shared/entity-types';
import { jsonObjectSchema, jsonValueSchema } from '../../../shared/json-value';
import { z } from 'zod';
import { LIMS_REGISTRATION_STATUSES } from '../../../shared/lims';

const count = z.number().int().nonnegative();
const registrationStatus = z.enum(LIMS_REGISTRATION_STATUSES);
const topology = z.enum(['linear', 'circular']);
const sourceFormat = z.enum(['gb', 'genbank', 'fasta', 'snapgene', 'unknown']);

                                                                                
                                                                                 
                                                                             
const fieldValues = jsonObjectSchema.describe(
  "Values keyed by the field definitions of this record's immutable schema revision."
);

const schemaField = z.object({
  key: z.string(),
  label: z.string(),
  type: z.string(),
  required: z.boolean().optional(),
  suggested: z.boolean().optional(),
  enumOptions: z.array(z.string()).optional(),
  maxLength: z.number().optional(),
  minValue: z.number().optional(),
  maxValue: z.number().optional(),
  minDate: z.string().optional(),
  maxDate: z.string().optional(),
  agenda: z.object({ role: z.enum(['milestone', 'deadline', 'observation']), zone: z.string().optional() }).optional(),
  description: z.string().optional(),
  requireResolved: z.boolean().optional(),
  intrinsic: z.enum(['sequence.length', 'sequence.topology', 'sequence.geneticCode']).optional(),
  readOnly: z.boolean().optional(),
});
export const limsSchemaSnapshotOutputSchema = z
  .object({
    schemaId: z.string(),
    schemaRevisionId: z.string(),
    name: z.string(),
    displayName: z.string(),
    baseKind: z.string(),
    fields: z.array(schemaField),
    version: z.number().int(),
    description: z.string().nullable().optional(),
  })
  .catchall(jsonValueSchema);

export const limsEntityOutputSchema = z.object({
  id: z.string(),
  kind: z.string(),
  schemaId: z.string().nullable(),
  schemaRevisionId: z.string(),
  name: z.string(),
  registryId: z.string().nullable(),
  fields: fieldValues,
  registrationStatus,
  domainStatus: z.string().nullable(),
  workspaceId: z.number().int().nullable(),
  actor: z.string().nullable(),
  eventSeq: z.number().int().nullable(),
  tombstone: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().nullable(),
});

const limsLink = z.object({
  id: z.string(),
  fromEntityId: z.string(),
  toEntityId: z.string(),
  type: z.string(),
  payload: jsonObjectSchema.describe('Relationship-type-specific values.'),
  workspaceId: z.number().int().nullable(),
  actor: z.string().nullable(),
  eventSeq: z.number().int().nullable(),
  tombstone: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().nullable(),
});

const targetIdentity = { entityId: z.string(), entityKind: z.string(), label: z.string() };
const sequenceSummary = z.object({
  topology,
  length: count,
  contentHash: z.string(),
  fileContentHash: z.string().optional(),
  normalizedSequenceHash: z.string().optional(),
  sourceFormat,
  sequenceId: z.number().int().nullable().optional(),
  sizeBytes: count.nullable().optional(),
  modifiedAt: z.number().nullable().optional(),
});
const sequenceFileTarget = z.object({
  kind: z.literal('sequence_file'),
  ...targetIdentity,
  documentId: z.string(),
  registrationStatus,
  sequence: sequenceSummary,
  source: z.string().optional(),
});
const managedSequenceTarget = z.object({
  kind: z.literal('managed_sequence'),
  ...targetIdentity,
  registrationStatus,
  document: z.object({ kind: z.literal('managed-sequence'), packageId: z.string() }),
});
const proteinTarget = z.object({
  kind: z.literal('protein_sequence'),
  ...targetIdentity,
  registrationStatus,
  filePath: z.string().optional(),
});
const notebookTarget = z.object({
  kind: z.literal('notebook'),
  ...targetIdentity,
  filePath: z.string().optional(),
});
const trackTarget = z.object({ kind: z.literal('track_view'), ...targetIdentity });
const molecularDocumentTarget = z.object({
  kind: z.literal('molecular_document'),
  ...targetIdentity,
});
const recordFileTarget = z.object({
  kind: z.literal('record_file'),
  ...targetIdentity,
  workspaceId: z.number().int(),
  artifactRelativePath: z.string(),
});
const primerTarget = z.object({
  kind: z.literal('primer'),
  ...targetIdentity,
  workspaceId: z.number().int().nullable(),
  artifactRelativePath: z.string(),
});
const recordDetailTarget = z.object({
  kind: z.literal('record_detail'),
  ...targetIdentity,
  reason: z.enum([
    'inline_sequence',
    'strain_evidence',
    'organism_record',
    'unresolved_sequence',
    'no_primary_representation',
  ]),
  inlineSequence: z
    .object({ length: count, topology, contentHash: z.string().optional() })
    .optional(),
});
const missingTarget = z.object({
  kind: z.literal('missing_entity'),
  entityId: z.string(),
  label: z.string(),
  reason: z.literal('not_found'),
});
export const limsOpenTargetOutputSchema = z.discriminatedUnion('kind', [
  sequenceFileTarget,
  managedSequenceTarget,
  proteinTarget,
  notebookTarget,
  trackTarget,
  molecularDocumentTarget,
  recordFileTarget,
  primerTarget,
  recordDetailTarget,
  missingTarget,
]);

const gapStatus = z.enum(['no_hypothesis', 'no_verified', 'unresolved', 'match', 'mismatch']);
const limsRegistrySummary = z.object({
  id: z.string(),
  workspaceId: z.number().int().nullable().optional(),
  kind: z.string(),
  schemaSnapshot: limsSchemaSnapshotOutputSchema,
  fieldValues,
  schemaDisplayName: z.string().optional(),
  schemaIconKind: z.enum(ENTITY_TYPE_ICON_KINDS).optional(),
  eventSeq: z.number().int().nullable().optional(),
  name: z.string(),
  registryId: z.string().nullable(),
  registrationStatus,
  domainStatus: z.string().nullable(),
  organism: z.object({ speciesTaxid: z.string(), speciesName: z.string() }).nullable().optional(),
  representation: z.object({
    kind: z.enum([
      'record_file',
      'primer',
      'file_sequence',
      'protein_sequence',
      'track_view',
      'molecular_document',
      'inline_sequence',
      'genome_assembly',
      'strain_evidence',
      'organism_record',
      'notebook',
      'unresolved',
      'none',
    ]),
    label: z.string(),
    canOpen: z.boolean(),
    openTarget: limsOpenTargetOutputSchema.optional(),
  }),
  summary: z.string(),
  evidenceSummary: z
    .object({
      confidenceLabel: z.string(),
      gapStatus,
      gapMessage: z.string(),
      parentGenomeName: z.string().optional(),
      hypothesisGenomeName: z.string().optional(),
      verifiedGenomeName: z.string().optional(),
    })
    .optional(),
  sequenceSummary: z
    .object({
      topology: topology.optional(),
      length: count.optional(),
      sourceFormat: sourceFormat.optional(),
      inlineBases: z.string().optional(),
      contentHash: z.string().optional(),
      fileContentHash: z.string().optional(),
      normalizedSequenceHash: z.string().optional(),
    })
    .optional(),
  linkSummary: z.object({
    outgoingCount: count,
    incomingCount: count,
    notable: z.array(z.object({ type: z.string(), label: z.string(), entityId: z.string() })),
  }),
  searchableText: z.string(),
  updatedAt: z.number(),
  archived: z.boolean(),
});

const genomeGap = z.object({
  status: gapStatus,
  hypothesisGenomeId: z.string().optional(),
  verifiedGenomeId: z.string().optional(),
  hypothesisLength: count.optional(),
  verifiedLength: count.optional(),
  lengthDelta: z.number().int().optional(),
  mismatchCount: count.optional(),
  firstDifferences: z
    .array(
      z.object({
        position: z.number().int(),
        hypothesisBase: z.string(),
        verifiedBase: z.string(),
      })
    )
    .optional(),
  message: z.string(),
});
const linkedEntity = z.object({
  link: limsLink,
  entity: z.object({
    id: z.string(),
    kind: z.string(),
    name: z.string(),
    registrationStatus,
    domainStatus: z.string().nullable(),
  }),
  summary: limsRegistrySummary,
});

export const limsQueryEntitiesOutputSchema = z.object({
  ok: z.literal(true),
  count,
  entities: z.array(limsEntityOutputSchema),
});
export const limsQueryRegistrySummariesOutputSchema = z.object({
  ok: z.literal(true),
  eventSeq: count.optional(),
  summaries: z.array(limsRegistrySummary),
  totalCount: count,
  limit: count,
  offset: count,
  availableKinds: z.array(z.object({ kind: z.string(), count })).optional(),
  availableOrganisms: z
    .array(
      z.object({
        speciesTaxid: z.string(),
        speciesName: z.string(),
        count,
      })
    )
    .optional(),
  availableProjects: z
    .array(z.object({ workspaceId: z.number().int(), name: z.string(), count }))
    .optional(),
});
export const limsGetRegistryPreviewOutputSchema = z.object({
  ok: z.literal(true),
  entity: limsEntityOutputSchema,
  summary: limsRegistrySummary,
  classificationEligible: z.boolean().optional(),
  acceptedScientificOwner: z.boolean().optional(),
  savedLifecycleAuthority: z.literal('sequence_package').optional(),
  schemaSnapshot: limsSchemaSnapshotOutputSchema,
  outgoingLinks: z.array(linkedEntity),
  incomingLinks: z.array(linkedEntity),
  strainGenomeSummary: z
    .object({
      strain: limsEntityOutputSchema,
      parentGenome: limsEntityOutputSchema.nullable(),
      hypothesisGenome: limsEntityOutputSchema.nullable(),
      verifiedGenome: limsEntityOutputSchema.nullable(),
      parentLink: limsLink.nullable(),
      hypothesisLink: limsLink.nullable(),
      verifiedLink: limsLink.nullable(),
      gap: genomeGap,
    })
    .optional(),
  nativeRecord: z.object({ schemaSnapshot: limsSchemaSnapshotOutputSchema }).optional(),
  originalSource: z
    .object({
      workspaceId: z.number().int().positive(),
      entityId: z.string(),
      sourceRecordId: z.string(),
      kind: z.literal('reviewed_table_row').optional(),
    })
    .optional(),
});
export const limsGetEntityOutputSchema = z.discriminatedUnion('found', [
  z.object({
    ok: z.literal(true),
    entityId: z.string(),
    found: z.literal(true),
    entity: limsEntityOutputSchema,
  }),
  z.object({
    ok: z.literal(true),
    entityId: z.string(),
    found: z.literal(false),
    entity: z.null(),
  }),
]);
export const limsResolveOpenTargetOutputSchema = z.object({
  ok: z.literal(true),
  target: limsOpenTargetOutputSchema,
});
export const limsOpenEntityOutputSchema = z.discriminatedUnion('status', [
  z.object({
    ok: z.literal(true),
    status: z.literal('opened_record'),
    tabId: z.string(),
    target: z.discriminatedUnion('kind', [recordFileTarget, recordDetailTarget]),
  }),
  z.object({
    ok: z.literal(true),
    status: z.literal('opened_primer'),
    tabId: z.string(),
    target: primerTarget,
  }),
  z.object({
    ok: z.literal(true),
    status: z.literal('registry-presented'),
    entityId: z.string(),
    presented: z.literal(true),
  }),
  z.object({
    ok: z.literal(true),
    status: z.literal('opened_molecular_document'),
    tabId: z.string(),
    target: molecularDocumentTarget,
  }),
  z.object({
    ok: z.literal(true),
    status: z.literal('opened'),
    tabId: z.string(),
    target: z.union([sequenceFileTarget, managedSequenceTarget]),
  }),
  z.object({
    ok: z.literal(true),
    status: z.literal('opened_protein'),
    tabId: z.string(),
    target: proteinTarget,
  }),
  z.object({
    ok: z.literal(true),
    status: z.literal('opened_notebook'),
    tabId: z.string(),
    target: notebookTarget,
  }),
  z.object({
    ok: z.literal(true),
    status: z.literal('opened_track_view'),
    tabId: z.string(),
    target: trackTarget,
  }),
]);

export const registryRecordsOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    schemas: z.array(z.object({
      schemaId: z.string(), currentRevisionId: z.string(), entityKind: z.string(),
      baseKind: z.string(), displayName: z.string(), description: z.string().nullable(),
      version: z.number(), builtin: z.boolean(), fields: z.array(schemaField),
    })),
    total: count, nextOffset: count.nullable(),
  }),
  z.object({
    ok: z.literal(true), entity: limsEntityOutputSchema, created: z.boolean(),
    saved: z.literal(true), relativePath: z.string(), historyCommitted: z.boolean(),
  }),
  z.object({
    ok: z.literal(true), entity: limsEntityOutputSchema,
    relationships: z.array(z.object({ toEntityId: z.string(), type: z.string(), payload: jsonValueSchema })),
  }),
  z.object({
    ok: z.literal(true), entityId: z.string(),
    history: z.array(z.object({
      eventSeq: count, eventType: z.string(), label: z.string(), actor: z.string().nullable(),
      at: z.number(), changes: z.array(z.object({ field: z.string(),
        kind: z.enum(['added', 'changed', 'removed']), before: z.string().optional(),
        after: z.string().optional(), description: z.string().optional() })),
    })), total: count, nextOffset: count.nullable(),
  }),
  z.object({ ok: z.literal(true), active: z.array(limsLink), tombstoned: count }),
  z.object({ ok: z.literal(true), entity: limsEntityOutputSchema,
    reverted: z.boolean().optional(), reason: z.literal('no-prior-edit').optional() }),
]);
