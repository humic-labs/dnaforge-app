import { z } from 'zod';
import { jsonObjectSchema } from '../../../shared/json-value';
import {
  administrationHandoffSchema,
  administrationSettingsSchema,
  administrationStructureGuidanceSchema,
} from '../../../shared/administration';

const count = z.number().int().nonnegative();
const ok = { ok: z.literal(true) };
const strings = z.array(z.string());
const changed = z.union([z.boolean(), z.literal('unknown')]);
const catalogKind = z.enum([
  'track-view',
  'molecular-document',
  'sequence',
  'primer',
  'notebook',
  'design',
  'alignment',
  'trace',
  'report',
  'construct',
  'sample',
  'record',
  'structure',
  'protein',
  'protocol',
  'protocol_run',
  'file',
]);
export const searchWorkspaceOutputSchema = z
  .object({
    ...ok,
    query: z.string(),
    projects: z.array(z.object({ name: z.string(), root: z.string() })),
    results: z.array(
      z.object({
        entityId: z.string(),
        entityType: catalogKind,
        name: z.string(),
        workspaceRoot: z.string(),
        workspaceName: z.string(),
      })
    ),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const projectHistoryOutputSchema = z
  .object({
    ...ok,
    status: z.literal('ok'),
    operation: z.enum(['inspect', 'stage', 'unstage', 'commit', 'save-all', 'initialize']),
    inspection: z.object({
      workspaceRoot: z.string(),
      tracked: z.boolean(),
      head: z.string().nullable(),
      branch: z.string().nullable(),
      revision: z.string(),
      entries: z.array(
        z.object({
          path: z.string(),
          status: z.enum(['modified', 'added', 'deleted', 'untracked']),
          staged: z.boolean(),
          unstaged: z.boolean(),
          package: z.boolean(),
        })
      ),
      totalEntries: count,
      nextOffset: count.nullable(),
      protectedStagedPaths: strings,
    }),
    stateChanged: z.boolean(),
    paths: strings,
    commitOid: z.string().optional(),
    warnings: strings,
  })
  .strict();

const lookup = z.object({ kind: z.string().optional(), name: z.string() });
const entityDraft = z.object({
  id: z.string().optional(),
  kind: z.string(),
  name: z.string(),
  fields: jsonObjectSchema,
  registrationStatus: z.string().optional(),
  domainStatus: z.string().nullable().optional(),
  schemaRevisionId: z.string().optional(),
  schemaSnapshot: jsonObjectSchema.optional(),
  workspaceId: count.nullable().optional(),
  actor: z.string().nullable().optional(),
  batchId: z.string().nullable().optional(),
  createdAt: z.number().optional(),
  failAfterEntityInsert: z.boolean().optional(),
});
const importRecord = z.object({
  id: z.string(),
  sourceRow: count.optional(),
  externalRowId: z.string().optional(),
  sequenceNotation: z.string().optional(),
  accepted: z.boolean(),
  action: z.enum(['create', 'skip']),
  entityDraft,
  requiresRegistrationKind: z.boolean().optional(),
  suggestedKind: z.string().optional(),
  kindEvidence: z.string().optional(),
  duplicateCandidates: z.array(
    z.object({ entityId: z.string(), name: z.string(), reason: z.string() })
  ),
  duplicateDecision: z
    .union([
      z.object({ kind: z.literal('skip') }),
      z.object({ kind: z.literal('reuse'), entityId: z.string() }),
    ])
    .optional(),
  proposedLinks: z.array(
    z.object({
      type: z.string(),
      fromEntityId: z.string().optional(),
      fromEntityLookup: lookup.optional(),
      toEntityId: z.string().optional(),
      toEntityLookup: lookup.optional(),
      suggested: z.boolean().optional(),
      payload: jsonObjectSchema,
    })
  ),
  unresolvedLinks: z.array(
    z.object({
      label: z.string(),
      kind: z.string().optional(),
      type: z.string().optional(),
      targetProviderIdentity: z
        .object({
          provider: z.literal('benchling'),
          stableObjectId: z.string(),
          objectClass: z.enum([
            'notebook',
            'sequence',
            'protein',
            'protocol',
            'registry_entity',
            'other',
          ]),
        })
        .optional(),
      severity: z.enum(['advisory', 'blocking', 'provisional_stub', 'ambiguous']),
      candidateEntityIds: strings.optional(),
      reason: z.string(),
    })
  ),
  errors: strings,
  warnings: strings,
  source: jsonObjectSchema,
});
const receipt = z.object({
  sourcePath: z.string().optional(),
  members: z
    .array(
      z.object({
        sourceRecordId: z.string(),
        sourceRowId: z.string(),
        sourceRow: count.optional(),
        externalRowId: z.string().optional(),
        entityId: z.string(),
        entityKind: z.string(),
        artifactRelativePath: z.string(),
      })
    )
    .optional(),
  changed,
  artifactPaths: strings,
  imported: count,
  skipped: count,
  failed: count,
  batchId: z.string().optional(),
  insertedLinks: count.optional(),
  gitCommitted: z.boolean().optional(),
  importSet: z.object({ id: z.string(), manifestRelativePath: z.string() }).nullable().optional(),
  partialEffects: strings.optional(),
});
const retainedImportReviewOutputSchema = z
  .object({
    ...ok,
    id: z.string(),
    revision: z.string(),
    workspaceRoot: z.string(),
    destinationDir: z.string(),
    phase: z.enum(['review', 'applying', 'applied', 'partial', 'cancelled', 'failed']),
    sourceName: z.string(),
    sourceFingerprint: z.string(),
    schemaRevisionId: z.string().optional(),
    selectedSheet: z.string().optional(),
    sheetDispositions: z
      .array(
        z.object({
          sheetName: z.string(),
          verdict: z.enum([
            'entity-table',
            'possible-table',
            'metadata-notes',
            'low-density',
            'empty',
            'leftover-region',
          ]),
          score: z.number(),
          rowCount: count,
          headerRowIndex: count.optional(),
          reason: z.string().optional(),
        })
      )
      .optional(),
    sourceKind: z.enum(['csv', 'tsv', 'xlsx', 'genbank', 'fasta', 'mixed']),
    columns: z.array(
      z.object({
        sourceColumn: z.string(),
        mappedField: z.string().optional(),
        mappingMode: z.enum(['mapped', 'source_only', 'ignored']),
        confidence: z.enum(['deterministic', 'agent_suggested', 'user_overridden', 'learned']),
        warnings: strings,
      })
    ),
    totalRecords: count,
    records: z.array(importRecord),
    nextOffset: count.nullable(),
    canApply: z.boolean(),
    receipt: receipt.optional(),
    error: z.string().optional(),
  })
  .strict();

const storedSheetSyncConnection = z
  .object({ connection: jsonObjectSchema, content: z.string() })
  .strict();
const sheetSyncOutputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...ok,
      kind: z.literal('prepared'),
      preparedId: z.string(),
      sourceRevision: z.string(),
      schemaRevisionId: z.string(),
      plan: jsonObjectSchema,
    })
    .strict(),
  z
    .object({
      ...ok,
      kind: z.literal('connected'),
      requestId: z.string(),
      connectionId: z.string(),
      stored: storedSheetSyncConnection.nullable(),
      message: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...ok,
      kind: z.literal('partial'),
      requestId: z.string(),
      connectionId: z.string(),
      stored: storedSheetSyncConnection.nullable(),
      message: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...ok,
      kind: z.literal('connections'),
      entries: z.array(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('connection'), stored: storedSheetSyncConnection }).strict(),
          z.object({ kind: z.literal('invalid'), name: z.string(), message: z.string() }).strict(),
        ])
      ),
    })
    .strict(),
  z.object({ ...ok, kind: z.literal('connection'), stored: storedSheetSyncConnection }).strict(),
  z
    .object({
      ...ok,
      kind: z.literal('pulled'),
      summary: z
        .object({
          created: count,
          updated: count,
          unchanged: count,
          conflicts: z.array(z.object({ key: z.string(), reason: z.string() }).strict()),
          localEdits: strings,
          missingRows: strings,
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      ...ok,
      kind: z.literal('authorization'),
      state: z.enum(['authorized', 'paused', 'required']),
    })
    .strict(),
  z.object({ ...ok, kind: z.literal('changed') }).strict(),
]);
export const importReviewOutputSchema = z.union([
  retainedImportReviewOutputSchema,
  sheetSyncOutputSchema,
]);

const account = z.object({
  accountId: z.string(),
  desktopSessionId: z.string(),
  email: z.string().optional(),
});
const selection = z.object({
  workspaceUuid: z.string(),
  rootArtifactId: z.string(),
  selectedArtifactIds: strings.optional(),
  selectedConversationIds: strings,
});
const shareArtifactType = z.enum([
  'sequence',
  'notebook',
  'design',
  'primer',
  'protein',
  'protocol',
  'protocol_run',
  'structure',
  'alignment',
  'trace',
  'report',
  'construct',
  'sample',
  'selection',
  'file',
  'folder',
]);
const artifact = z.object({
  id: z.string(),
  type: shareArtifactType,
  name: z.string(),
});
const shareReview = z.object({
  workspace: z.object({ uuid: z.string(), name: z.string(), remoteWorkspaceId: z.string() }),
  rootArtifactId: z.string(),
  rootArtifact: artifact,
  manifest: z.object({
    rootArtifactId: z.string(),
    artifacts: z.array(artifact.extend({ required: z.boolean() })),
    relationships: z.array(
      z.object({ sourceArtifactId: z.string(), relation: z.string(), targetArtifactId: z.string() })
    ),
    files: z.array(z.object({ fileId: z.string(), ownerArtifactId: z.string(), role: z.string() })),
    chats: z.array(z.object({ conversationId: z.string(), title: z.string() })),
    omissions: z.array(z.object({ code: z.string(), subject: z.string(), detail: z.string() })),
  }),
  files: z.array(
    z.object({
      id: z.string(),
      ownerArtifactId: z.string(),
      relativePath: z.string(),
      name: z.string(),
      role: z.string(),
      contentType: z.string(),
      sizeBytes: count,
      sha256: z.string(),
    })
  ),
  chats: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      createdAt: z.string(),
      updatedAt: z.string(),
      messages: z.array(
        z.object({
          id: z.string(),
          role: z.enum(['user', 'assistant']),
          content: z.string(),
          createdAt: z.string(),
          references: z.array(
            z.object({ artifactId: z.string(), artifactType: shareArtifactType, label: z.string() })
          ),
        })
      ),
    })
  ),
  conversationCandidates: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      createdAt: z.number(),
      updatedAt: z.number(),
      exactReferenceCount: count,
    })
  ),
  digest: z.string(),
});
const shareImportReview = z
  .object({
    source: z.object({
      shareId: z.string(),
      shortId: z.string(),
      bundleSha256: z.string(),
      artifactName: z.string(),
      fileCount: count,
      conversationCount: count,
      totalBytes: count,
    }),
    destination: z.object({
      kind: z.literal('new-private-project'),
      workspaceUuid: z.string(),
      displayName: z.string(),
      repoPath: z.string(),
    }),
  })
  .strict();
const sourceRef = z.object({ id: z.string(), url: z.string(), objectType: z.string().optional() });
const migrationScope = z.discriminatedUnion('kind', [
  z.object({
    version: z.literal(1),
    kind: z.literal('file'),
    source: sourceRef,
    acquisition: z.literal('local_bundle').optional(),
  }),
  z.object({
    version: z.literal(1),
    kind: z.literal('folder'),
    folder: sourceRef,
    includeChildren: z.literal(false),
    includeArchived: z.boolean().optional(),
    acquisition: z.literal('local_bundle').optional(),
  }),
  z.object({
    version: z.literal(1),
    kind: z.literal('folder_tree'),
    roots: z.array(sourceRef),
    includeChildren: z.literal(true),
    includeArchived: z.boolean().optional(),
    acquisition: z.literal('local_bundle').optional(),
  }),
]);
const linkedRecovery = z.object({
  schema: z.literal('dnaforge.benchling.linked-item-recovery-progress.v1'),
  mode: z.enum(['linked_item_recovery', 'workspace_append']).optional(),
  attemptId: z.string(),
  state: z.enum([
    'copying',
    'parsing',
    'awaiting_conflict_resolution',
    'reconciling',
    'validating',
    'completed',
    'failed',
  ]),
  selectedFileCount: count,
  processedFileCount: count,
  recoveredUniqueObjectCount: count,
  repairedRelationshipCount: count,
  retainedExistingObjectCount: count,
  retainedExistingObjects: z.array(z.object({ stableId: z.string(), name: z.string() })),
  corroboratedExistingObjectCount: count,
  versionConflictResolution: z
    .union([
      z.object({ kind: z.literal('none') }),
      z.object({
        kind: z.literal('awaiting_choice'),
        firstConflict: z.object({ stableId: z.string(), name: z.string() }),
      }),
      z.object({
        kind: z.literal('resolved'),
        policy: z.enum(['keep_existing', 'use_incoming']),
        conflictCount: count,
      }),
    ])
    .optional(),
  pendingImportDecision: jsonObjectSchema.optional(),
  importDecisionSummary: jsonObjectSchema.optional(),
  startedAt: z.string().optional(),
  work: z
    .object({
      kind: z.enum([
        'copy_bytes',
        'read_and_classify_objects',
        'write_objects',
        'resolve_links',
        'validate_saved_objects',
        'validate_objects',
        'persist_source_files',
        'validate_source_files',
        'finalize_workspace',
      ]),
      completed: count,
      total: count,
    })
    .optional(),
  updatedAt: z.string(),
  errorMessage: z.string().optional(),
});
const migrationRun = z.object({
  version: z.literal(1),
  id: z.string(),
  workspaceId: z.string(),
  displayName: z.string(),
  workspaceOrigin: z.enum(['migration_created', 'adopted_existing']).optional(),
  scope: migrationScope,
  binding: z
    .object({
      version: z.literal(1),
      benchlingOrigin: z.string(),
      benchlingOrganizationBaseUrl: z.string().optional(),
      benchlingAccountEmail: z.string(),
      benchlingOrganizationId: z.string(),
      benchlingOrganizationName: z.string(),
      gmailMailbox: z.string().optional(),
      confirmedAt: z.string(),
      gmailMismatchConfirmedAt: z.string().optional(),
    })
    .nullable(),
  state: z.enum([
    'draft',
    'identity_confirmation',
    'scope_planning',
    'export_pending',
    'downloading',
    'parsing',
    'offline_resolution',
    'targeted_reads',
    'projecting',
    'validating',
    'ready_to_unlock',
    'paused',
    'action_required',
    'cancelled_preserved',
    'unlocked',
    'failed',
    'discarded',
  ]),
  resumeState: z
    .enum([
      'draft',
      'identity_confirmation',
      'scope_planning',
      'export_pending',
      'downloading',
      'parsing',
      'offline_resolution',
      'targeted_reads',
      'projecting',
      'validating',
      'ready_to_unlock',
    ])
    .nullable(),
  attempt: count,
  converterVersions: z.record(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  unlockedAt: z.string().nullable(),
  lastError: z
    .object({
      code: z.string(),
      message: z.string(),
      blocking: z.boolean(),
      sourceObjectId: z.string().optional(),
      sourceFileName: z.string().optional(),
      relationshipId: z.string().optional(),
    })
    .nullable(),
  recoveryAction: z.literal('start_new_migration_select_original_export').nullable(),
  sourceArtifact: z
    .object({
      kind: z.literal('local_bundle'),
      format: z.enum(['zip', 'html']),
      fileName: z.string(),
      sha256: z.string(),
      sizeBytes: count,
    })
    .optional(),
  localBundleState: z.enum(['waiting_for_selection', 'copying', 'ready']).nullable(),
  localBundleMode: z.enum(['external_zip', 'copied_artifact']).optional(),
  retryWithoutFileAvailable: z.boolean().optional(),
  bestEffortRecoveryPending: z.boolean().optional(),
  linkedItemRecovery: linkedRecovery.nullable().optional(),
});
const sharePublished = z.union([
  z.object({
    ...ok,
    url: z.string(),
    shortId: z.string(),
    shareId: z.string(),
    versionId: z.string(),
    versionNumber: count,
    versionContentSha256: z.string(),
    bundleId: z.string(),
    bundleContentSha256: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.string(),
    message: z.string(),
    refreshedReview: shareReview.optional(),
  }),
]);
const action = z.object({
  id: z.string(),
  revision: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  account: account.nullable(),
  originAgent: z.object({ identityId: z.string(), capabilities: strings }).nullable(),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('share'), selection, review: shareReview }),
    z.object({ kind: z.literal('share-import'), review: shareImportReview }),
    z.object({
      kind: z.literal('migration'),
      runId: z.string(),
      runRevision: z.string(),
      action: z.enum(['start', 'pause', 'resume', 'unlock']),
    }),
    z.object({ kind: z.literal('handoff'), target: administrationHandoffSchema }),
  ]),
  state: z.enum([
    'prepared',
    'awaiting-human',
    'executing',
    'completed',
    'cancelled',
    'stale',
    'unresolved',
  ]),
  effects: strings,
  message: z.string().optional(),
  result: z
    .union([
      sharePublished,
      z.object({
        workspaceUuid: z.string(),
        displayName: z.string(),
        repoPath: z.string(),
        warnings: strings,
      }),
      migrationRun,
      z.object({ completed: z.boolean(), message: z.string() }),
    ])
    .optional(),
});
const zoom = z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied'), factor: z.number() }),
  z.object({
    status: z.literal('refused'),
    reason: z.enum(['invalid_factor', 'window_unavailable']),
  }),
  z.object({
    status: z.literal('failed'),
    reason: z.literal('apply_failed'),
    factor: z.number().nullable(),
  }),
  z.object({ status: z.literal('unavailable') }),
]);
export const administrationOutputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...ok,
      kind: z.literal('settings'),
      snapshot: z.object({
        ownerId: z.string(),
        generation: count,
        revision: z.string(),
        values: administrationSettingsSchema,
        adopted: z.array(administrationSettingsSchema.keyof()),
        persistence: z.enum(['saved', 'unsaved']),
        unsavedKeys: z.array(administrationSettingsSchema.keyof()),
        zoom: zoom.optional(),
        message: z.string().optional(),
      }),
      stateChanged: z.boolean(),
    })
    .strict(),
  z.object({ ...ok, kind: z.literal('account'), account: account.nullable() }).strict(),
  z
    .object({
      ...ok,
      kind: z.literal('structure-guidance'),
      guidance: administrationStructureGuidanceSchema,
    })
    .strict(),
  z.object({ ...ok, kind: z.literal('action'), action }).strict(),
  z
    .object({
      ...ok,
      kind: z.literal('migration'),
      run: migrationRun.nullable(),
      revision: z.string().nullable(),
    })
    .strict(),
]);
