import { userMessage, toUserMessage, type UserMessage } from '@waypoint/user-messages';
import { isExactProviderStableId } from '../../shared/provider-object-reference';
import { getCurrentCatalogFileForEntity } from '../../db/workspace-catalog';
import { updateLimsEntity } from '../../services/lims-entity-mutations';
import { UnconfirmedDocumentSaveError } from '../../services/saved-document-completion';
import type { LimsRegistryPreview, LimsUpdateEntityInput } from '../../shared/lims';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import {
  listProjectEditFolders,
  mergeProjectEditFolders,
} from '../workspace-loader/public/project-edit-folders';
import { managedSequenceEditAccess } from './registry-record-edit-access';
import { canonicalEntityArtifactValue } from '../../shared/entity-artifact-projection';
import { resolvedEntitySchemaFields } from '../../shared/sequence-entity-schema';
import type { LoadedEntityRecord } from './entity-record-document';

interface RegistryMetadataUpdate {
  name: string;
  fields: Record<string, unknown>;
}

export interface SavedRecordMetadataRecovery {
  loaded: LoadedEntityRecord;
  pending: () => LimsUpdateEntityInput | null;
  restore: (request: LimsUpdateEntityInput) => void;
  retry: () => Promise<void>;
  discard: () => void;
}

async function assertWritable(path: string): Promise<void> {
  const folders = mergeProjectEditFolders(
    await listProjectEditFolders(),
    useWorkspaceStore.getState().folders
  );
  const access = managedSequenceEditAccess(path, folders);
  if (!access.canEdit) throw new Error(access.message.replace(/sequence/g, 'record'));
}

export async function prepareRegistryMetadataEdit(
  preview: LimsRegistryPreview,
  loaded?: LoadedEntityRecord
) {
  preview = structuredClone(preview);
  const file = await getCurrentCatalogFileForEntity(preview.entity.id);
  const scientificAuthority = preview.nativeRecord?.scientificAuthority;
  const path = scientificAuthority?.artifactPath ?? loaded?.path ?? file?.path;
  let readOnlyReason: UserMessage | undefined;
  try {
    if (path) await assertWritable(path);
  } catch (cause) {
    readOnlyReason = toUserMessage(cause, 'record.projectUnavailable');
  }
  const source = preview.entity.fields.sourceMetadata;
  const origin = source && typeof source === 'object' && 'origin' in source ? source.origin : null;
  if (
    preview.originalSource ||
    (origin &&
      typeof origin === 'object' &&
      !Array.isArray(origin) &&
      'connectorType' in origin &&
      origin.connectorType === 'benchling' &&
      'sourceId' in origin &&
      typeof origin.sourceId === 'string' &&
      isExactProviderStableId(origin.sourceId))
  )
    readOnlyReason = userMessage('record.originalSourceReadOnly');
  let pending: LimsUpdateEntityInput | null = null;
  let pendingPayload: string | null = null;
  const retry = async () => {
    if (!pending) return;
    if (readOnlyReason) throw new Error(readOnlyReason);
    if (path) await assertWritable(path);
    const request = pending;
    try {
      const result = await updateLimsEntity(
        structuredClone(request),
        ...(scientificAuthority ? [{ scientificAuthority }] : [])
      );
      if (result.id !== preview.entity.id || result.workspaceId !== preview.entity.workspaceId)
        throw new Error('The saved record identity or home changed. Reload the record.');
      pending = null;
      pendingPayload = null;
    } catch (cause) {
      throw new UnconfirmedDocumentSaveError(
        `The save is not confirmed. Retry the same change or reload the saved record. ${cause instanceof Error ? cause.message : String(cause)}`,
        retry
      );
    }
  };
  return {
    preview,
    path,
    readOnlyReason,
    savedRecord: loaded
      ? ({
          loaded,
          pending: () => (pending ? structuredClone(pending) : null),
          restore: (request: LimsUpdateEntityInput) => {
            if (
              request.id !== preview.entity.id ||
              typeof request.operationId !== 'string' ||
              !request.operationId ||
              !Number.isSafeInteger(request.expectedEventSeq) ||
              Number(request.expectedEventSeq) < 1
            )
              throw new Error('This pending save does not identify the selected record.');
            pending = structuredClone(request);
            pendingPayload = null;
          },
          retry,
          discard: () => {
            pending = null;
            pendingPayload = null;
          },
        } satisfies SavedRecordMetadataRecovery)
      : undefined,
    async save(update: RegistryMetadataUpdate) {
      const payload = JSON.stringify(update);
      if (pending) {
        if (pendingPayload !== payload)
          throw new Error('Finish the pending save before changing this record.');
        return retry();
      }
      const eventSeq = preview.entity.eventSeq;
      if (typeof eventSeq !== 'number' || !Number.isSafeInteger(eventSeq) || eventSeq < 1)
        throw new Error(
          'Refresh this record before saving; its current edit version is unavailable.'
        );
      const fields = { ...update.fields };
      const relationshipTargets: Record<string, string | null> = {};
      for (const field of resolvedEntitySchemaFields(preview.schemaSnapshot)) {
        if (field.type !== 'record_relationship' || !(field.key in fields)) continue;
        const value = fields[field.key];
        delete fields[field.key];
        if (
          JSON.stringify(canonicalEntityArtifactValue(value)) ===
          JSON.stringify(canonicalEntityArtifactValue(preview.summary.fieldValues[field.key]))
        )
          continue;
        if (value === null || value === undefined) relationshipTargets[field.key] = null;
        else if (
          typeof value === 'object' &&
          'destinationEntityId' in value &&
          typeof value.destinationEntityId === 'string' &&
          value.destinationEntityId
        )
          relationshipTargets[field.key] = value.destinationEntityId;
        else throw new Error(`Choose a valid entity for ${field.label} before saving.`);
      }
      pending = structuredClone({
        id: preview.entity.id,
        expectedEventSeq: eventSeq,
        operationId: crypto.randomUUID(),
        ...(update.name !== preview.entity.name ? { name: update.name } : {}),
        fields,
        ...(Object.keys(relationshipTargets).length ? { relationshipTargets } : {}),
      });
      pendingPayload = payload;
      await retry();
    },
  };
}
