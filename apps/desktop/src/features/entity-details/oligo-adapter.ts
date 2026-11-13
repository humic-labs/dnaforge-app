import {
  toUserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';

import { SavedDocumentCompletionError } from '../../services/saved-document-completion';
import {
  getCurrentCatalogFileForEntity,
  getCatalogWorkspaceRootForFilePath,
} from '../../db/workspace-catalog';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import {
  listProjectEditFolders,
  mergeProjectEditFolders,
} from '../workspace-loader/public/project-edit-folders';
import { managedSequenceEditAccess } from '../lims/public/registry-record-edit-access';
import {
  readPrimerArtifactAtPath,
  PrimerProjectionError,
  PrimerHistoryError,
  PrimerPublicationPendingError,
  resumePrimerArtifactSave,
  PrimerAcceptedSavePendingError,
  updatePrimerArtifactContent,
} from '../primers/public/primer-artifact-service';
import {
  primerSequenceValidationMessage,
  validatePrimerSequence,
} from '../primers/public/primer-validation';
import { parseIdtOligoNotation } from '../primers/public/oligo-modifications';
import { PRIMER_MANAGED_SCHEMA_FIELD_KEYS } from '../primers/public/primer-schema-contract';
import { getLimsSchemas } from '../lims/public/operations';
import {
  primerArtifactMetadataFields,
  type PrimerEntitySchemaSnapshot,
} from '../primers/public/primer-artifact';
import { confirmDialog } from '../../components/confirm-dialog-store';
import type { LimsRegistryPreview } from '../../shared/lims';
import type { EntityDetailsDefinition, EntityDetailsValues } from './types';

export async function oligoDefinition(
  preview: LimsRegistryPreview
): Promise<EntityDetailsDefinition> {
  const file = await getCurrentCatalogFileForEntity(preview.entity.id);
  const record = {
    id: preview.entity.id,
    name: preview.entity.name,
    fields: { ...preview.summary.fieldValues },
    schema: { ...preview.schemaSnapshot, baseKind: 'primer' },
    preview,
    properties: {},
    path: file?.path,
    registryId: preview.entity.registrationStatus === 'tracked' ? null : preview.entity.registryId,
    registrationStatus: preview.entity.registrationStatus,
    refreshGeneticCodeRevision: false,
  };
  let workspaceRoot: string | null = null;
  try {
    if (preview.summary.archived) throw new Error('Restore this record before editing it.');
    if (!file) throw new Error('Open this oligo’s project before editing its metadata.');
    workspaceRoot = await getCatalogWorkspaceRootForFilePath(file.path);
    if (!workspaceRoot) throw new Error('The oligo’s owning project is unavailable.');
    const owningWorkspaceRoot = workspaceRoot;
    const writable = async () => {
      const folders = mergeProjectEditFolders(
        await listProjectEditFolders(),
        useWorkspaceStore.getState().folders
      );
      const access = managedSequenceEditAccess(file.path, folders);
      if (!access.canEdit) throw new Error(access.message);
    };
    await writable();
    const loaded = await readPrimerArtifactAtPath(file.path, owningWorkspaceRoot);
    if (loaded.artifact.registry.entityId !== preview.entity.id)
      throw new Error('The oligo identity changed. Reopen its metadata.');
    const savedFields = primerArtifactMetadataFields(loaded.artifact);
    const scientific = {
      kind: 'oligo' as const,
      notation: loaded.artifact.oligo?.notation ?? loaded.artifact.sequence.bases,
      orderType: loaded.artifact.oligo?.orderType ?? ('dna' as const),
    };
    const validate = (update: EntityDetailsValues) => {
      if (!update.scientific) return 'The oligo sequence is unavailable.';
      if (
        update.scientific.notation === scientific.notation &&
        update.scientific.orderType === scientific.orderType
      )
        return null;
      const parsed = parseIdtOligoNotation(update.scientific.notation, {
        orderType: update.scientific.orderType,
      });
      return (
        parsed.errors[0] ??
        primerSequenceValidationMessage(
          validatePrimerSequence(parsed.bases, { orderType: update.scientific.orderType })
        )
      );
    };
    return {
      record: {
        ...record,
        name: loaded.artifact.name,
        fields: savedFields,
        schema: loaded.artifact.entity?.schema ?? record.schema,
        scientific,
      },
      validate,
      readOnlyFields: [...PRIMER_MANAGED_SCHEMA_FIELD_KEYS, 'application'],
      schemaChoices: async () =>
        (await getLimsSchemas())
          .filter(
            (schema) =>
              schema.entityKind === (scientific.orderType === 'rna' ? 'rna_oligo' : 'oligo') ||
              (schema.baseKind === 'primer' &&
                schema.fields.some(
                  (field) =>
                    field.key === 'sequence' &&
                    field.type ===
                      (scientific.orderType === 'rna' ? 'rna_sequence' : 'dna_sequence')
                ))
          )
          .map((schema) => ({
            schemaId: schema.schemaId,
            schemaRevisionId: schema.currentRevisionId,
            name: schema.entityKind,
            displayName: schema.displayName,
            version: schema.version,
            baseKind: 'primer',
            fields: schema.fields.map((field) => ({ ...field })),
          })),
      save: async (update) => {
        await writable();
        const error = validate(update);
        if (error) throw new Error(error);
        if (update.schema.baseKind !== 'primer')
          throw new Error('Choose a schema for this oligo type.');
        const changed = Object.fromEntries(
          Object.entries(update.fields).filter(
            ([key, value]) => JSON.stringify(value) !== JSON.stringify(savedFields[key])
          )
        );
        for (const key of Object.keys(changed))
          if (
            !update.schema.fields.some(
              (field) =>
                field.key === key &&
                !field.readOnly &&
                !PRIMER_MANAGED_SCHEMA_FIELD_KEYS.has(key) &&
                key !== 'application'
            )
          )
            throw new Error('A scientific field must be edited through its sequence control.');
        const next = update.scientific;
        if (!next) throw new Error('The oligo sequence is unavailable.');
        const parsed =
          next.notation !== scientific.notation
            ? parseIdtOligoNotation(next.notation, { orderType: next.orderType })
            : null;
        if (next.orderType !== scientific.orderType)
          throw new Error('Create a separate oligo to change its DNA or RNA type.');
        if (next.notation !== scientific.notation && loaded.artifact.bindings.length) {
          const sites = loaded.artifact.bindings.length;
          const sequences = new Set(
            loaded.artifact.bindings.map(
              (binding) => binding.target.documentId || binding.target.legacyWorkspaceRelativePath
            )
          ).size;
          const accepted = await confirmDialog({
            title: userMessage('dialog.update-an-attached-primer'),
            message: userMessageWithValues(
              sites === 1
                ? 'primer.updateAttachedConfirmOneSite'
                : sequences === 1
                  ? 'primer.updateAttachedConfirmOneSequence'
                  : 'primer.updateAttachedConfirm',
              { sites: userMessageValue(sites), sequences: userMessageValue(sequences) }
            ),
            confirmLabel: userMessage('dialog.update-sequence'),
            cancelLabel: userMessage('dialog.keep-editing'),
            safeDefault: true,
          });
          if (!accepted) throw new Error('Sequence update canceled. Your draft is retained.');
        }
        const notes = Object.prototype.hasOwnProperty.call(changed, 'notes')
          ? changed.notes
          : loaded.artifact.metadata.notes;
        if (notes !== undefined && notes !== null && typeof notes !== 'string')
          throw new Error('Notes must be text.');
        let saveInput: Parameters<typeof updatePrimerArtifactContent>[0] = {
          artifactPath: file.path,
          workspaceRoot: owningWorkspaceRoot,
          expectedArtifactRevision: loaded.artifact.artifactRevision,
          ...(loaded.acceptedRevision ? { acceptedRevision: loaded.acceptedRevision } : {}),
          name: update.name,
          sequence: parsed?.bases ?? loaded.artifact.sequence.bases,
          oligo:
            next.notation === scientific.notation
              ? (loaded.artifact.oligo ?? null)
              : (parsed?.composition ?? null),
          ...(notes !== undefined ? { notes } : {}),
          entitySchema:
            update.schema.schemaRevisionId === loaded.artifact.entity?.schema.schemaRevisionId
              ? loaded.artifact.entity.schema
              : (update.schema as PrimerEntitySchemaSnapshot),
          entityFields: { ...loaded.artifact.entity?.fields, ...changed },
        };
        const notifySaved = async () => {
          window.dispatchEvent(
            new CustomEvent('waypoint:workspace-files-changed', {
              detail: { workspaceRoot: owningWorkspaceRoot, revealPath: file.path },
            })
          );
          if (next.notation !== scientific.notation) {
            const { primerServices } = await import('../primers/public/primer-services');
            for (const sequenceId of new Set(
              loaded.resolvedBindings.map((binding) => binding.sequenceId)
            ))
              primerServices.persistence.notifyBindingsChanged(sequenceId);
          }
        };
        const persist = async () => {
          await writable();
          try {
            await updatePrimerArtifactContent(saveInput);
          } catch (cause) {
            if (cause instanceof PrimerAcceptedSavePendingError)
              saveInput = {
                ...saveInput,
                expectedArtifactRevision: cause.artifact.artifactRevision,
                acceptedRevision: cause.acceptedRevision,
              };
            throw cause;
          }
          await notifySaved();
        };
        try {
          await persist();
        } catch (cause) {
          if (cause instanceof PrimerAcceptedSavePendingError)
            throw new SavedDocumentCompletionError(cause.message, persist);
          if (
            cause instanceof PrimerPublicationPendingError &&
            cause.pending.entityId === preview.entity.id
          ) {
            const pending = cause.pending;
            throw new SavedDocumentCompletionError(cause.message, async () => {
              await writable();
              await resumePrimerArtifactSave({
                entityId: pending.entityId,
                operationId: pending.operationId,
                workspaceRoot: owningWorkspaceRoot,
              });
              await notifySaved();
            });
          }
          if (cause instanceof PrimerProjectionError || cause instanceof PrimerHistoryError) {
            const retry = cause.retry;
            if (retry)
              throw new SavedDocumentCompletionError(
                'The oligo was saved, but Registry or version history still needs to be updated.',
                async () => {
                  await writable();
                  await retry();
                  await notifySaved();
                }
              );
          }
          throw cause;
        }
      },
    };
  } catch (cause) {
    const pending =
      cause instanceof PrimerPublicationPendingError &&
      cause.pending.entityId === preview.entity.id &&
      workspaceRoot
        ? cause.pending
        : null;
    const owningWorkspaceRoot = workspaceRoot;
    return {
      record: {
        ...record,
        readOnlyReason: toUserMessage(cause, 'record.oligoUnavailable'),
      },
      ...(pending && owningWorkspaceRoot
        ? {
            pendingCompletion: async () => {
              await resumePrimerArtifactSave({
                entityId: pending.entityId,
                operationId: pending.operationId,
                workspaceRoot: owningWorkspaceRoot,
              });
            },
          }
        : {}),
    };
  }
}
