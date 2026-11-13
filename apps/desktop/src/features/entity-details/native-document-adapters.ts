import { isTabDirty } from '../canvas/public/artifact-document-lifecycle';
import { userMessage, toUserMessage, UserMessageError } from '@waypoint/user-messages';
import { useCanvasStore } from '../canvas/public/store';
import { platform } from '../../platform';
import { SavedDocumentCompletionError } from '../../services/saved-document-completion';
import { getCurrentCatalogFileForEntity } from '../../db/workspace-catalog';
import type { LimsRegistryPreview } from '../../shared/lims';
import type { EntityDetailsDefinition, EntityDetailsValues } from './types';
import { managedSequenceEditAccess } from '../lims/public/registry-record-edit-access';
import {
  listProjectEditFolders,
  mergeProjectEditFolders,
} from '../workspace-loader/public/project-edit-folders';
import { useWorkspaceStore } from '../../stores/workspaceStore';

function assertNoNativeDocumentDraft(entityId: string, path: string): void {
  for (const panel of Object.values(useCanvasStore.getState().panels))
    for (const tab of panel.tabs) {
      if (
        isTabDirty(tab) &&
        (tab.entityId === entityId ||
          tab.entityId === path ||
          tab.trackView?.document.id === entityId ||
          tab.initialStructureAttrs?.molecularDocumentPath === path)
      )
        throw new UserMessageError(
          'record.native.save-or-discard-this-document-s-content-before-editing-its-metadata'
        );
    }
}

async function writable(path: string) {
  const folders = mergeProjectEditFolders(
    await listProjectEditFolders(),
    useWorkspaceStore.getState().folders
  );
  const access = managedSequenceEditAccess(path, folders);
  if (!access.canEdit) throw new Error(access.message);
}

export async function nativeDocumentDefinition(
  preview: LimsRegistryPreview
): Promise<EntityDetailsDefinition> {
  const file = await getCurrentCatalogFileForEntity(preview.entity.id);
  let reason = preview.summary.archived ? userMessage('record.restoreBeforeEditing') : undefined;
  let rename: ((name: string) => Promise<void>) | undefined;
  let name = preview.entity.name;
  try {
    if (reason) throw new Error(reason);
    if (preview.entity.kind === 'track-view') {
      const saved = await platform().trackViews.read(preview.entity.id);
      if (saved.document.id !== preview.entity.id)
        throw new UserMessageError(
          'record.native.the-saved-view-identity-changed-reopen-its-metadata'
        );
      if (saved.workspaceRoot) await writable(saved.path);
      assertNoNativeDocumentDraft(preview.entity.id, saved.path);
      name = saved.document.name;
      rename = async (nextName) => {
        assertNoNativeDocumentDraft(preview.entity.id, saved.path);
        if (saved.workspaceRoot) await writable(saved.path);
        const { saveTrackView, projectSavedTrackView } =
          await import('../sequence/public/track-view-library');
        const result = await saveTrackView({
          document: { ...saved.document, name: nextName, updatedAt: new Date().toISOString() },
          expectedRevision: saved.revision,
          ...(saved.workspaceRoot
            ? { destination: { workspaceRoot: saved.workspaceRoot, path: saved.path } }
            : {}),
        });
        const canvas = useCanvasStore.getState();
        for (const panel of Object.values(canvas.panels))
          for (const tab of panel.tabs) {
            if (tab.trackView?.document.id === saved.document.id)
              canvas.updateTab(panel.id, tab.id, {
                label: result.saved.document.name,
                trackView: result.saved,
              });
          }
        if (result.warning)
          throw new SavedDocumentCompletionError(result.warning, async () => {
            if (result.saved.workspaceRoot) await writable(result.saved.path);
            const current = await platform().trackViews.read(result.saved.document.id);
            if (current.revision !== result.saved.revision)
              throw new UserMessageError(
                'record.native.this-view-changed-after-its-save-reopen-its-current-version'
              );
            if (current.warning) throw new Error(current.warning);
            await projectSavedTrackView(current);
          });
      };
    } else if (preview.entity.kind === 'molecular-document') {
      if (!file)
        throw new UserMessageError('record.native.open-this-document-s-project-before-editing-it');
      await writable(file.path);
      const { readMolecularDocument, renameMolecularDocument } =
        await import('../molecular-documents/public/services');
      const saved = await readMolecularDocument(file.path);
      if (saved.catalogEntityId !== preview.entity.id)
        throw new UserMessageError(
          'record.native.the-molecular-document-identity-changed-reopen-its-metadata'
        );
      assertNoNativeDocumentDraft(preview.entity.id, saved.path);
      name = saved.document.name;
      rename = async (nextName) => {
        assertNoNativeDocumentDraft(preview.entity.id, saved.path);
        await writable(file.path);
        await renameMolecularDocument({ saved, name: nextName });
      };
    } else {
      if (!file)
        throw new UserMessageError('record.native.open-this-notebook-s-project-before-editing-it');
      await writable(file.path);
      const { usePageStore } = await import('../page/public/store');
      const page = await usePageStore.getState().fetchPage(preview.entity.id);
      if (!page)
        throw new UserMessageError('record.native.the-notebook-is-unavailable-reopen-its-project');
      name = page.title;
      if (usePageStore.getState().dirtyIds.has(preview.entity.id))
        throw new UserMessageError(
          'record.native.save-or-discard-notebook-content-before-editing-its-metadata'
        );
      rename = async (nextName) => {
        await writable(file.path);
        const store = usePageStore.getState();
        if (store.dirtyIds.has(preview.entity.id))
          throw new UserMessageError(
            'record.native.save-or-discard-notebook-content-before-editing-its-metadata'
          );
        if (store.pages[preview.entity.id]?.title !== name)
          throw new UserMessageError(
            'record.native.the-notebook-name-changed-reopen-metadata-before-saving'
          );
        const result = await store.renamePageArtifact(preview.entity.id, nextName);
        if (!result) throw new UserMessageError('record.native.the-notebook-could-not-be-renamed');
      };
    }
  } catch (cause) {
    reason = toUserMessage(
      cause,
      preview.entity.kind === 'track-view' && !file
        ? 'record.trackViewProjectRequired'
        : 'record.owningDocumentUnavailable'
    );
  }
  const schema = {
    ...preview.schemaSnapshot,
    fields: preview.schemaSnapshot.fields.map((field) => ({ ...field, readOnly: true })),
  };
  const fields = { ...preview.summary.fieldValues };
  return {
    record: {
      id: preview.entity.id,
      name,
      schema,
      fields,
      preview,
      properties: {},
      path: file?.path,
      registrationStatus: preview.entity.registrationStatus,
      registryId:
        preview.entity.registrationStatus === 'tracked' ? null : preview.entity.registryId,
      refreshGeneticCodeRevision: false,
      readOnlyReason: reason,
    },
    ...(rename && !reason
      ? {
          save: async (update: EntityDetailsValues) => {
            if (
              update.schema.schemaRevisionId !== schema.schemaRevisionId ||
              JSON.stringify(update.fields) !== JSON.stringify(fields)
            )
              throw new UserMessageError(
                'record.native.these-fields-are-controlled-by-the-document-s-native-editor'
              );
            await rename(update.name);
          },
        }
      : {}),
  };
}
