import { userMessage, toUserMessage, UserMessageError } from '@waypoint/user-messages';
import { setSequenceGeneticCodeOnDocument } from '../sequence/public/set-sequence-genetic-code';
import { resolveSequenceDocumentById } from '../sequence/public/sequence-document-repository';
import { platform } from '../../platform';
import { SavedDocumentCompletionError } from '../../services/saved-document-completion';
import {
  getCurrentCatalogFileForEntity,
  findWorkspaceRootForPath,
} from '../../db/workspace-catalog';
import type { LimsRegistryPreview } from '../../shared/lims';
import {
  createSequenceEntityMetadataForSchema,
  resolvedEntitySchemaFields,
  BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT,
} from '../../shared/sequence-entity-schema';
import { validatedSequenceEntityRegistrationStatus } from '../../shared/entity-record';
import { parseTextSequenceFileAsAnnotated } from '../../shared/parse-sequence-file';
import { readStableWorkspaceGeneration } from '../../services/workspace-sync-renderer-generation';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { reconcileWorkspaceAfterFilesChanged } from '../../services/workspace-operations';
import { managedSequenceRepository } from '../sequence/public/managed-sequence-repository';
import { useSequenceStore } from '../sequence/public/store';
import { useCanvasStore } from '../canvas/public/store';
import { getLimsRegistryPreview, getLimsSchemas } from '../lims/public/operations';
import { prepareRegistryMetadataEdit } from '../lims/public/registry-metadata-edit';
import {
  loadSavedEntityRecord,
  type LoadedEntityRecord,
} from '../lims/public/entity-record-document';
import { managedSequenceEditAccess } from '../lims/public/registry-record-edit-access';
import {
  listProjectEditFolders,
  mergeProjectEditFolders,
} from '../workspace-loader/public/project-edit-folders';
import { currentGeneticCodeChoice } from '../sequence/public/components/GeneticCodeControl';
import { geneticCodeOverrideFor } from '../sequence/public/genetic-code-field-model';
import type { EntityDetailsDefinition, EntityDetailsTarget, EntityDetailsValues } from './types';

import { createEntityDetailsFactory } from './adapter-factory';
import { sequenceFileMetadataReadOnlyReason } from './sequence-file-policy';
export { createEntityDetailsFactory } from './adapter-factory';

async function editFolders() {
  return mergeProjectEditFolders(
    await listProjectEditFolders(),
    useWorkspaceStore.getState().folders
  );
}

async function assertEditable(path: string): Promise<string | undefined> {
  const access = managedSequenceEditAccess(path, await editFolders());
  if (!access.canEdit) throw new Error(access.message);
  return access.workspaceRoot;
}

function baseRecord(preview: LimsRegistryPreview) {
  return {
    id: preview.entity.id,
    name: preview.entity.name,
    fields: { ...preview.summary.fieldValues },
    schema: preview.nativeRecord?.schemaSnapshot ?? preview.schemaSnapshot,
    registryId: preview.entity.registrationStatus === 'tracked' ? null : preview.entity.registryId,
    registrationStatus: preview.entity.registrationStatus,
    refreshGeneticCodeRevision: false,
    properties:
      preview.schemaSnapshot.baseKind === 'sequence'
        ? { size: preview.summary.fieldValues.size }
        : {},
    preview,
  };
}

async function managedDefinition(
  preview: LimsRegistryPreview | null,
  target: EntityDetailsTarget
): Promise<EntityDetailsDefinition> {
  const openTarget = preview?.summary.representation.openTarget;
  const ref =
    openTarget?.kind === 'managed_sequence' ? openTarget.document : target.managedSequence;
  if (!ref || ref.packageId !== target.entityId)
    throw new Error('The sequence package identity is unavailable.');
  if (preview?.summary.archived) {
    const definition = await registryDefinition(preview);
    if (
      preview.savedLifecycleAuthority !== 'sequence_package' ||
      preview.acceptedScientificOwner === true
    )
      return definition;
    const access = managedSequenceEditAccess(ref.packageRoot, await editFolders());
    return {
      ...definition,
      archivedSequenceOrganization: { ref, readOnly: !access.canEdit },
    };
  }
  const resolved = await managedSequenceRepository.resolve(ref);
  let baseline = resolved.document;
  const workspaceRoot = findWorkspaceRootForPath(
    useWorkspaceStore.getState().folders,
    resolved.ref.packageRoot
  );
  const sequence = await readStableWorkspaceGeneration(
    workspaceRoot,
    async () =>
      parseTextSequenceFileAsAnnotated(
        await platform().fs.readTextFile(resolved.productPath),
        resolved.productPath
      ).sequence
  );
  const access = managedSequenceEditAccess(resolved.ref.packageRoot, await editFolders());
  const readOnlyReason = !access.canEdit
    ? access.message
    : target.sequenceFile?.readOnly
      ? userMessage('record.sequenceReadOnly')
      : preview?.summary.archived
        ? userMessage('record.restoreBeforeEditing')
        : undefined;
  const currentCode = currentGeneticCodeChoice(sequence);
  const record = {
    ...(preview
      ? baseRecord(preview)
      : {
          id: target.entityId,
          fields: {},
          schema: baseline.entity.schema,
          registrationStatus: baseline.entity.registrationStatus,
          registryId: baseline.entity.registryId,
          refreshGeneticCodeRevision: false,
          properties: {},
          preview: null,
        }),
    name: baseline.name,
    schema: baseline.entity.schema,
    fields: {
      ...baseline.entity.fields,
      topology: baseline.product.topology ?? (sequence.circular ? 'circular' : 'linear'),
      geneticCode: currentCode,
    },
    path: resolved.ref.packageRoot,
    registryId:
      baseline.entity.registrationStatus === 'tracked' ? null : baseline.entity.registryId,
    registrationStatus: baseline.entity.registrationStatus,
    readOnlyReason,
    properties: { size: sequence.length },
    sequence: { ref: resolved.ref, document: baseline, data: sequence },
  };
  const reconcile = async () => {
    const root = await assertEditable(resolved.ref.packageRoot);
    if (root)
      await reconcileWorkspaceAfterFilesChanged({
        workspaceRoot: root,
        strict: true,
        notifyGitStatus: true,
      });
  };
  const complete = async () => {
    try {
      await reconcile();
    } catch {
      throw new SavedDocumentCompletionError(
        'The sequence changes are saved, but its project could not be refreshed. Retry save to finish.',
        reconcile
      );
    }
  };
  const updatePresentation = (
    name: string,
    circular?: boolean,
    chosenGeneticCode?: ReturnType<typeof geneticCodeOverrideFor>
  ) => {
    const store = useSequenceStore.getState();
    store.patchSavedMetadata(target.entityId, {
      name,
      ...(circular !== undefined ? { circular } : {}),
      ...(chosenGeneticCode !== undefined
        ? { chosenGeneticCode: chosenGeneticCode ?? undefined }
        : {}),
    });
    const canvas = useCanvasStore.getState();
    for (const panel of Object.values(canvas.panels))
      for (const tab of panel.tabs) {
        if (tab.type === 'sequence' && tab.entityId === target.entityId)
          canvas.updateTab(panel.id, tab.id, { label: name });
      }
  };
  return {
    record,
    editableIntrinsics: ['sequence.topology', 'sequence.geneticCode'],
    ...(!readOnlyReason
      ? {
          schemaChoices: async () =>
            (await getLimsSchemas())
              .filter((schema) => schema.baseKind === 'sequence')
              .map((schema) => createSequenceEntityMetadataForSchema(schema).schema),
          rename: async (name: string) => {
            await assertEditable(resolved.ref.packageRoot);
            const next = await managedSequenceRepository.updateMetadata(resolved.ref, (current) => {
              if (current.name !== baseline.name)
                throw new Error('Name changed elsewhere. Reopen Metadata before renaming.');
              return { ...current, name, updatedAt: new Date().toISOString() };
            });
            baseline = { ...baseline, name: next.name };
            updatePresentation(next.name);
            await complete();
          },
          save: async (update: EntityDetailsValues) => {
            await assertEditable(resolved.ref.packageRoot);
            if (update.schema.baseKind !== 'sequence') throw new Error('Choose a sequence schema.');
            const topology = update.fields.topology;
            if (topology !== 'linear' && topology !== 'circular')
              throw new Error('Choose Linear or Circular.');
            const codeChanged =
              update.fields.geneticCode !== currentCode || update.refreshGeneticCodeRevision;
            const geneticCode = codeChanged
              ? geneticCodeOverrideFor(String(update.fields.geneticCode), sequence)
              : undefined;
            const next = await managedSequenceRepository.updateMetadata(
              resolved.ref,
              (current) => {
                if (
                  current.entity.schema.schemaRevisionId !== baseline.entity.schema.schemaRevisionId
                )
                  throw new Error('This record’s schema changed. Reopen Metadata before saving.');
                if (
                  topology !== record.fields.topology &&
                  current.product.topology !== baseline.product.topology
                )
                  throw new Error('Topology changed elsewhere. Reopen Metadata before saving.');
                const fields = { ...current.entity.fields };
                for (const field of resolvedEntitySchemaFields(update.schema)) {
                  if (
                    field.intrinsic ||
                    same(update.fields[field.key], baseline.entity.fields[field.key])
                  )
                    continue;
                  if (field.readOnly)
                    throw new Error(`${field.label} is controlled by its data type.`);
                  if (!same(current.entity.fields[field.key], baseline.entity.fields[field.key]))
                    throw new Error(
                      `${field.label} changed elsewhere. Reopen Metadata before saving.`
                    );
                  fields[field.key] = update.fields[field.key];
                }
                const schema = update.schema as typeof baseline.entity.schema;
                return {
                  ...current,
                  product: { ...current.product, topology },
                  entity: {
                    ...current.entity,
                    schema,
                    fields,
                    registrationStatus: validatedSequenceEntityRegistrationStatus(
                      schema,
                      fields,
                      current.entity.registrationStatus
                    ),
                  },
                  updatedAt: new Date().toISOString(),
                };
              },
              { ...(geneticCode !== undefined ? { geneticCode } : {}) }
            );
            updatePresentation(next.name, next.product.topology === 'circular', geneticCode);
            await complete();
          },
        }
      : {}),
  };
}

async function registryDefinition(
  preview: LimsRegistryPreview,
  loaded?: LoadedEntityRecord
): Promise<EntityDetailsDefinition> {
  const record = {
    ...baseRecord(preview),
    ...(preview.nativeRecord
      ? { schema: preview.nativeRecord.schemaSnapshot, fields: { ...preview.entity.fields } }
      : {}),
  };
  if (preview.summary.archived)
    return { record: { ...record, readOnlyReason: userMessage('record.restoreBeforeEditing') } };

  try {
    const session = await prepareRegistryMetadataEdit(preview, loaded);
    return {
      record: {
        ...record,
        path: session.path,
        schema: session.preview.nativeRecord?.schemaSnapshot ?? session.preview.schemaSnapshot,
        readOnlyReason: session.readOnlyReason,
        lifecycleReadOnlyReason: session.lifecycleReadOnlyReason,
      },
      savedRecord: session.savedRecord,
      save: async (update) => {
        if (update.schema.schemaRevisionId !== record.schema.schemaRevisionId)
          throw new Error('This schema is controlled by the entity’s native editor.');
        const fields = Object.fromEntries(
          Object.entries(update.fields).filter(
            ([key, value]) => !same(value, preview.summary.fieldValues[key])
          )
        );
        await session.save({ name: update.name, fields });
        useCanvasStore.getState().updateTabByEntityId(preview.entity.id, { label: update.name });
      },
    };
  } catch (cause) {
    const file = await getCurrentCatalogFileForEntity(preview.entity.id);
    return {
      record: {
        ...record,
        path: file?.path,
        readOnlyReason: toUserMessage(cause, 'record.projectUnavailable'),
      },
    };
  }
}

export const entityDetailsAdapters = [
  {
    id: 'managed-sequence',
    matches: (preview, target) =>
      Boolean(target.managedSequence) ||
      preview.summary.representation.openTarget?.kind === 'managed_sequence',
    create: managedDefinition,
  },
  {
    id: 'native-document',
    matches: (preview) =>
      ['track-view', 'molecular-document', 'notebook'].includes(preview.entity.kind),
    create: async (preview) =>
      (await import('./native-document-adapters')).nativeDocumentDefinition(preview),
  },
  {
    id: 'native-oligo',
    matches: (preview) => {
      const artifact = preview.entity.fields.artifact;
      return Boolean(
        artifact &&
        typeof artifact === 'object' &&
        'schema' in artifact &&
        artifact.schema === 'dnaforge.primer'
      );
    },
    create: async (preview) => (await import('./oligo-adapter')).oligoDefinition(preview),
  },
  { id: 'schema-record', matches: () => true, create: (preview) => registryDefinition(preview) },
] satisfies readonly import('./adapter-factory').EntityDetailsAdapter[];
const loadDefinition = createEntityDetailsFactory(entityDetailsAdapters);

async function fileDefinition(
  target: EntityDetailsTarget,
  preview: LimsRegistryPreview | null
): Promise<EntityDetailsDefinition> {
  const input = target.sequenceFile;
  const storedSequence = preview?.entity.fields.sequence;
  const documentId =
    input?.documentId ??
    (storedSequence &&
    typeof storedSequence === 'object' &&
    'documentId' in storedSequence &&
    typeof storedSequence.documentId === 'string'
      ? storedSequence.documentId
      : target.entityId);
  const located = input
    ? { sourcePath: input.path }
    : await resolveSequenceDocumentById(
        documentId,
        (await editFolders()).map((folder) => folder.path)
      );
  const workspaceRoot = findWorkspaceRootForPath(
    useWorkspaceStore.getState().folders,
    located.sourcePath
  );
  const source = preview?.summary.representation.openTarget;
  const fileSize = source?.kind === 'sequence_file' ? source.sequence.sizeBytes : undefined;
  const filePolicy = sequenceFileMetadataReadOnlyReason(
    located.sourcePath,
    fileSize ?? (await platform().fs.stat(located.sourcePath)).size
  );
  if (filePolicy) {
    const base = preview
      ? baseRecord(preview)
      : {
          id: target.entityId,
          name: input?.name ?? located.sourcePath.split(/[\\/]/).pop() ?? 'Sequence',
          schema: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT,
          fields: {},
          registryId: null,
          registrationStatus: 'tracked' as const,
          preview: null,
          refreshGeneticCodeRevision: false,
          properties: {},
        };
    return {
      record: {
        ...base,
        path: located.sourcePath,
        properties: {
          size: source?.kind === 'sequence_file' ? source.sequence.length : input?.sequence.length,
        },
        readOnlyReason: filePolicy,
        schema: {
          ...base.schema,
          fields: base.schema.fields.map((field) => ({ ...field, readOnly: true })),
        },
      },
      canEditName: false,
    };
  }
  const sequence = await readStableWorkspaceGeneration(
    workspaceRoot,
    async () =>
      parseTextSequenceFileAsAnnotated(
        await platform().fs.readTextFile(located.sourcePath),
        located.sourcePath
      ).sequence
  );
  const access = managedSequenceEditAccess(located.sourcePath, await editFolders());
  const reason = input?.readOnly
    ? userMessage('record.sequenceReadOnly')
    : preview?.summary.archived
      ? userMessage('record.restoreBeforeEditing')
      : access.canEdit
        ? undefined
        : access.message;
  const base = preview
    ? baseRecord(preview)
    : {
        id: target.entityId,
        name: input?.name ?? sequence.name,
        schema: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT,
        fields: {},
        registryId: null,
        registrationStatus: 'tracked' as const,
        preview: null,
        refreshGeneticCodeRevision: false,
        properties: {},
      };
  return {
    record: {
      ...base,
      path: located.sourcePath,
      readOnlyReason: reason,
      schema: {
        ...base.schema,
        fields: base.schema.fields.map((field) => ({ ...field, readOnly: true })),
      },
      fields: {
        ...base.fields,
        topology: sequence.circular ? 'circular' : 'linear',
        geneticCode: currentGeneticCodeChoice(sequence),
      },
      properties: { size: sequence.length },
      sequence: { data: sequence },
    },
    sequenceRegistration: {
      documentId,
      sourcePath: located.sourcePath,
      topology: sequence.circular ? 'circular' : 'linear',
      length: sequence.length,
    },
    canEditName: false,
    editableIntrinsics: ['sequence.geneticCode'],
    ...(!reason
      ? {
          save: async (update: EntityDetailsValues) => {
            await assertEditable(located.sourcePath);
            const result = await setSequenceGeneticCodeOnDocument({
              documentId,
              geneticCode: geneticCodeOverrideFor(String(update.fields.geneticCode), sequence),
              folders: (await editFolders()).map((folder) => ({
                ...folder,
                name: folder.name ?? folder.path.split(/[\\/]/).pop() ?? folder.path,
                addedAt: 0,
              })),
            });
            if (!result.ok && result.error === 'unsaved_edits')
              throw new UserMessageError(
                'record.native.save-or-discard-this-document-s-content-before-editing-its-metadata'
              );
            if (!result.ok) throw new Error(result.message);
          },
        }
      : {}),
  };
}

export async function loadEntityDetails(
  target: EntityDetailsTarget
): Promise<EntityDetailsDefinition> {
  if (target.recordFile) {
    const loaded = await loadSavedEntityRecord(target.entityId);
    return registryDefinition(loaded.preview, loaded);
  }
  let preview: LimsRegistryPreview | null = null;
  try {
    preview = await getLimsRegistryPreview({ entityId: target.entityId });
  } catch (cause) {
    if (!target.sequenceFile && !target.managedSequence) throw cause;
  }
  if (preview?.summary.representation.openTarget?.kind === 'managed_sequence')
    return loadDefinition(preview, target);
  if (target.sequenceFile && !target.managedSequence) return fileDefinition(target, preview);
  if (preview?.summary.representation.openTarget?.kind === 'sequence_file')
    return preview.summary.archived ? registryDefinition(preview) : fileDefinition(target, preview);
  if (!preview && target.managedSequence) return managedDefinition(null, target);
  if (!preview)
    throw new Error(
      'The Registry projection is unavailable. Reopen this entity after its project loads.'
    );
  if (preview.summary.representation.openTarget?.kind === 'record_file') {
    const loaded = await loadSavedEntityRecord(target.entityId);
    return registryDefinition(loaded.preview, loaded);
  }
  return loadDefinition(preview, target);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
