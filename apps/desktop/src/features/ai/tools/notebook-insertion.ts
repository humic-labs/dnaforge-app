import { withUserMessage } from '@waypoint/user-messages';
import type { JSONContent } from '@tiptap/core';
import type { z } from 'zod';
import { notebookEntityTypeSchema, notebookInsertionSchema } from '../../../shared/notebook-insertion-schema';
export { notebookEntityTypeSchema, notebookInsertionSchema } from '../../../shared/notebook-insertion-schema';
import { platform } from '../../../platform';
import {
  getCatalogEntityForWorkspaceRoot,
  getCurrentCatalogFileForEntity,
} from '../../../db/workspace-catalog';
import {
  MOLECULAR_DOCUMENT_SUFFIX,
  getCurrentMolecularSnapshot,
} from '../../../shared/molecular-document';
import { molecularDocumentReferenceHref } from '../../../shared/molecular-document-reference';
import { molecularDocumentReferenceForFile } from '../../molecular-documents/public/references';
import { notebookReferenceFromHref } from '../../../shared/notebook-reference-normalization';
import { searchMountedCatalogEntitiesByName } from '../../../db/catalog-reference-search';
import { searchPrimerReferencesByName } from '../../../db/primer-reference-search';
import {
  normalizePathForBoundary,
  pathIsAtOrUnder,
  pathRelativeToBoundary,
} from '../../../shared/path-boundary';
import {
  embedRegistry,
  readNotebookImage,
  structureFileSource,
  IMAGE_CONSTANTS,
  type PickerResult,
} from '../../page/public/embed-insertion';
import {
  createConfiguredTableBlock,
} from '../../page/public/table-construction';
import { inspectWorkspaceEntry, resolveWorkspaceEntry } from './workspace-entry';


export async function searchNotebookContent(
  root: string,
  query: string,
  type: z.infer<typeof notebookEntityTypeSchema> | undefined,
  limit: number
) {
  const entities =
    type === 'primer'
      ? []
      : await searchMountedCatalogEntitiesByName({ query, workspaceRoots: [root], limit: 200 });
  const items = entities
    .filter((entity) => entity.entityType === 'sequence' || entity.entityType === 'notebook')
    .map((entity) => ({
      entityId: entity.entityId,
      type: entity.entityType === 'notebook' ? 'page' : 'sequence',
      name: entity.name,
    }));
  if (!type || type === 'primer') {
    const primers = await searchPrimerReferencesByName({ query, workspaceRoot: root, limit });
    items.push(
      ...primers.map((primer) => ({ entityId: primer.primerId, type: 'primer', name: primer.name }))
    );
  }
  return items.filter((item) => !type || item.type === type).slice(0, limit);
}

function pickerBlock(result: PickerResult, version: number): JSONContent {
  return result.nodeType === 'mention'
    ? {
        type: 'paragraph',
        content: [
          {
            type: 'mention',
            attrs: {
              entityType: result.entityType,
              entityId: result.entityId,
              label: result.label,
              path: result.path ?? null,
              contentHash: result.contentHash ?? null,
              objectUuid: result.objectUuid ?? null,
            },
          },
        ],
      }
    : {
        type: 'embed',
        attrs: { type: result.embedType, version, refId: result.refId, data: result.data ?? {} },
      };
}

export async function prepareNotebookInsertion(
  root: string,
  source: z.infer<typeof notebookInsertionSchema>,
  signal?: AbortSignal
): Promise<{ block: JSONContent; verify: () => Promise<void> }> {
  signal?.throwIfAborted();
  if (source.kind === 'table')
    return {
      block: createConfiguredTableBlock(undefined, { rows: source.rows, columns: source.columns }),
      verify: async () => signal?.throwIfAborted(),
    };
  const folders = [{ path: root, name: root, addedAt: 0 }];
  if (source.kind === 'file') {
    const target = resolveWorkspaceEntry(folders, source.path, false);
    const before = await inspectWorkspaceEntry(target);
    if (before.type !== 'file' || before.revision !== source.expectedRevision)
      throw new Error('Inspect this source file again before insertion.');
    const stat = await platform().fs.stat(target.absolutePath);
    if (
      !stat.isFile ||
      normalizePathForBoundary(stat.canonicalPath) !== normalizePathForBoundary(target.absolutePath)
    )
      throw new Error('The source file has no matching native identity.');
    const fileName = target.absolutePath.split(/[\\/]/u).pop()!;
    const verify = async () => {
      const after = await inspectWorkspaceEntry(target);
      signal?.throwIfAborted();
      if (after.revision !== before.revision)
        throw new Error('The source file changed while preparing insertion.');
    };
    if (fileName.toLowerCase().endsWith(MOLECULAR_DOCUMENT_SUFFIX)) {
      const saved = await platform().molecularDocuments.read({
        path: target.absolutePath,
        workspaceRoot: root,
      });
      if (`sha256:${saved.revision}` !== before.contentHash)
        throw new Error('The molecular document changed while preparing insertion.');
      const reference = await molecularDocumentReferenceForFile(root, saved.document);
      const chip = notebookReferenceFromHref(
        molecularDocumentReferenceHref(reference),
        getCurrentMolecularSnapshot(saved.document).title
      );
      if (!chip) throw new Error('The saved molecular document reference is unavailable.');
      await verify();
      return { block: { type: 'paragraph', content: [chip] }, verify };
    }
    const extension = fileName.toLowerCase().split('.').pop();
    const mediaTypes: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
    };
    const mediaType = mediaTypes[extension ?? ''];
    if (!mediaType && !['pdb', 'cif', 'mmcif', 'ent'].includes(extension ?? ''))
      throw new Error(
        'This file has no native image or structure embed. Insert an entity reference or formatted document block instead.'
      );
    if (mediaType && stat.size > IMAGE_CONSTANTS.MAX_FILE_SIZE)
      throw withUserMessage(new Error('Image too large (max 50MB)'), "failure.image-too-large-max-50mb");
    signal?.throwIfAborted();
    const bytes = await platform().fs.readFileBounded(target.absolutePath, stat.size);
    const definition = embedRegistry.get(mediaType ? 'image' : 'structure3d');
    if (!definition?.picker || definition.importOnly)
      throw new Error('The native embed constructor is unavailable.');
    const insertion = await definition.picker.onComplete({});
    if (insertion.nodeType !== 'embed')
      throw new Error('This file did not produce a native embed.');
    const file = new File([new Uint8Array(bytes)], fileName, { type: mediaType ?? 'text/plain' });
    insertion.data = mediaType
      ? await readNotebookImage(file)
      : structureFileSource(insertion.data ?? {}, new TextDecoder().decode(bytes), fileName);
    await verify();
    return { block: pickerBlock(insertion, definition.version), verify };
  }
  const definition = embedRegistry.get(source.type);
  if (!definition?.picker || definition.importOnly)
    throw new Error('This entity has no native insertion constructor.');
  if (source.type === 'primer') {
    const lookup = async () => {
      const matches = await searchPrimerReferencesByName({
        query: '',
        primerId: source.entityId,
        workspaceRoot: root,
        limit: 2,
      });
      if (matches.length !== 1)
        throw new Error('Search this notebook for the exact native primer identity.');
      return matches[0];
    };
    const primer = await lookup();
    const result = await definition.picker.onComplete({
      primerId: primer.primerId,
      primerName: primer.name,
      path: primer.workspaceRelativePath,
      owningRoot: root,
    });
    const verify = async () => {
      const current = await lookup();
      signal?.throwIfAborted();
      if (JSON.stringify(current) !== JSON.stringify(primer))
        throw new Error('The primer changed while preparing insertion.');
      if (primer.workspaceRelativePath && result.nodeType === 'mention') {
        const target = resolveWorkspaceEntry(folders, primer.workspaceRelativePath, false);
        const state = await inspectWorkspaceEntry(target);
        if (state.contentHash !== result.contentHash)
          throw new Error('The primer artifact changed while preparing insertion.');
      }
    };
    await verify();
    return { block: pickerBlock(result, definition.version), verify };
  }
  const lookup = async () => {
    const entity = await getCatalogEntityForWorkspaceRoot(source.entityId, root);
    if (
      !entity ||
      entity.status !== 'active' ||
      entity.type !== (source.type === 'page' ? 'notebook' : 'sequence')
    )
      throw new Error('Search for this exact entity in the notebook project.');
    return entity;
  };
  const entity = await lookup();
  const binding = await getCurrentCatalogFileForEntity(entity.id);
  if (!binding || !pathIsAtOrUnder(binding.path, root))
    throw new Error('This entity has no current native file in the notebook project.');
  const target = resolveWorkspaceEntry(folders, binding.path, false);
  const before = await inspectWorkspaceEntry(target);
  const result = await definition.picker.onComplete(
    source.type === 'page'
      ? { pageId: entity.id, pageName: entity.name }
      : {
          entityId: entity.id,
          sequenceName: entity.name,
          path: pathRelativeToBoundary(binding.path, root),
          contentHash: before.contentHash,
          objectUuid: binding.object_uuid,
          owningRoot: root,
        }
  );
  const verify = async () => {
    const current = await lookup();
    const currentBinding = await getCurrentCatalogFileForEntity(entity.id);
    const after = await inspectWorkspaceEntry(target);
    signal?.throwIfAborted();
    if (
      current.name !== entity.name ||
      current.updated_at !== entity.updated_at ||
      currentBinding?.path !== binding.path ||
      currentBinding?.object_uuid !== binding.object_uuid ||
      after.revision !== before.revision
    )
      throw new Error('The entity or its source changed while preparing insertion.');
  };
  await verify();
  return { block: pickerBlock(result, definition.version), verify };
}
