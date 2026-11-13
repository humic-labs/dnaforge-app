import {isElectron} from '../../../utils/environment';
export { nativeNotebookDocumentOutputSchema as notebookDocumentOutputSchema } from './native-document-output-schemas';
import {
  createConfiguredTableBlock,
} from '../../page/public/table-construction';
import { zodSchema } from 'ai';
import { notebookDocumentSchema } from '../../../shared/notebook-document';
export { notebookDocumentSchema } from '../../../shared/notebook-document';
import type { JSONContent } from '@tiptap/core';
import type {} from '@tiptap/starter-kit';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { usePageStore } from '../../page/public/store';
import { getNotebookEditorControl } from '../../page/public/notebook-editor-control';
import { useCanvasStore } from '../../canvas/public/store';
import { contentFingerprint } from '../../../db/entity-substrate/adapter';
import { canonicalNotebookJson } from '../../../db/notebook-markdown-codec';
import { resolveWorkspaceScope } from '../../../db/workspace-catalog';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  resolveExplicitProjectRoot,
  soleWritableProjectRoot,
  writableProjectRoots,
} from '../../../shared/project-root-selection';
import {
  createWorkspaceNotebook,
  NotebookCreationError,
} from '../../page/public/create-notebook-command';
import { resolveOwningRootForPage } from '../../page/public/resolve-owning-root-for-page';
import {
  executeTableEditorCommand,
  getTableEditorControl,
} from '../../page/public/table-editor-control';
import { resolveNotebookRichBlockNode } from '../../../db/notebook-content-extensions';
import { getEntityReference } from '../../../db/entity-references';
import {
  normalizeNotebookReferences,
  notebookReferenceFromHref,
} from '../../../shared/notebook-reference-normalization';
import { savedReferenceHref } from '../../../shared/saved-reference-url';
import {
  molecularDocumentReferenceHref,
} from '../../../shared/molecular-document-reference';
import { resolveMolecularDocumentReference } from '../../molecular-documents/public/references';
import {
  prepareNotebookInsertion,
  searchNotebookContent,
} from './notebook-insertion';
import { embedRegistry } from '../../page/public/embed-insertion';

export const notebookInputSchemaOptions = { useReferences: true } as const;


function revision(content: JSONContent, title: string) {
  return contentFingerprint(canonicalNotebookJson({ content, title }));
}
function validateRichBlocks(blocks: JSONContent[]) {
  for (const block of blocks) {
    resolveNotebookRichBlockNode(block);
    validateRichBlocks(block.content ?? []);
  }
}

export function createNotebookDocumentTool(folders: readonly WorkspaceFolder[]) {
  return resultTool({
    description:
      'Read and edit native notebooks through their document owner. schema discovers native document nodes, marks and embeds. search finds exact entity targets in the notebook project. One insert operation accepts an entity reference, an inspected project file (image or molecular structure), or a table; native constructors supply identity and content. Inspect first for expectedRevision and exact block indexes. splice-blocks edits formatted document blocks and embed properties through native undo history. table edits existing native table cells; insert-table remains a compatibility shortcut. Save confirms native package persistence; undo/redo preserve human edits.',
    inputSchema: zodSchema(notebookDocumentSchema, notebookInputSchemaOptions),
    execute: async ({ pageId, expectedRevision, operation }, { abortSignal }) => {
      let changed: boolean | 'unknown' = false;
      const fail = (code: string, error: string) =>
        toolFailure({ code, error, retriable: false, stateChanged: changed, partialEffects: [] });
      try {
        if (operation.kind === 'inspect-conflict' || operation.kind === 'resolve-conflict') return fail('NOTEBOOK_NATIVE_ROUTE_REQUIRED', 'Notebook version recovery requires the native document owner.');
        if(isElectron())return fail('NOTEBOOK_NATIVE_ROUTE_REQUIRED','The desktop notebook command must use its native document owner.');
        const store = usePageStore.getState();
        if (operation.kind === 'schema')
          return toolSuccess({
            embeds: embedRegistry
              .getAll()
              .filter((definition) => !definition.importOnly)
              .map((definition) => ({
                type: definition.type,
                label: definition.label,
                version: definition.version,
              })),
            nodes: Object.keys(
              pageId ? (getNotebookEditorControl(pageId)?.editor.schema.nodes ?? {}) : {}
            ),
            marks: Object.keys(
              pageId ? (getNotebookEditorControl(pageId)?.editor.schema.marks ?? {}) : {}
            ),
            sources: ['entity', 'file', 'table'],
          });
        const owner = (id: string) =>
          resolveOwningRootForPage({
            pageId: id,
            roots: folders,
            resolveScope: resolveWorkspaceScope,
          });
        if (operation.kind === 'list') {
          const all = await store.fetchPages();
          const owners = await Promise.all(all.map((page) => owner(page.id)));
          const pages = all.filter((_, index) => owners[index] !== null);
          return toolSuccess({
            pages: pages.slice(operation.offset, operation.offset + operation.limit),
            total: pages.length,
            nextOffset:
              operation.offset + operation.limit < pages.length
                ? operation.offset + operation.limit
                : null,
          });
        }
        if (operation.kind === 'create') {
          const writable = writableProjectRoots(folders);
          const project = operation.destinationProject
            ? resolveExplicitProjectRoot(writable, operation.destinationProject)
            : soleWritableProjectRoot(writable);
          if (!project)
            return fail(
              'PROJECT_REQUIRED',
              'Choose the exact writable project name or root from get_workspace.'
            );
          const created = await createWorkspaceNotebook({
            title: operation.title,
            workspaceRoot: project.path,
            source: 'agent',
            onCreated: (id) => {
              changed = true;
              useCanvasStore.getState().openAgentContentTab('page', id, operation.title);
            },
          });
          if (!created.artifact)
            return fail(
              'NOTEBOOK_PACKAGE_MISSING',
              'The page was created but its project package was not written.'
            );
          return toolSuccess({
            pageId: created.pageId,
            nextInspectionInput: {
              pageId: created.pageId,
              operation: { kind: 'inspect', limit: 1 },
            },
            created: true,
            saved: true,
            destinationProject: project.name,
          });
        }
        if (!pageId)
          return fail('NOTEBOOK_ID_REQUIRED', 'Use list to identify the native notebook.');
        const owningRoot = await owner(pageId);
        if (!owningRoot)
          return fail(
            'OUTSIDE_WORKSPACE',
            'This notebook does not belong to a uniquely identified mounted writable project.'
          );
        if (operation.kind === 'search')
          return toolSuccess({
            items: await searchNotebookContent(
              owningRoot,
              operation.query,
              operation.type,
              operation.limit
            ),
          });
        const page = await store.fetchPage(pageId);
        if (!page) return fail('NOTEBOOK_NOT_FOUND', 'The notebook does not exist.');
        const control = getNotebookEditorControl(pageId);
        const content = control?.editor.getJSON() ?? page.content;
        const currentRevision = revision(content, page.title);
        if (operation.kind === 'inspect')
          return toolSuccess({
            pageId,
            title: page.title,
            revision: currentRevision,
            dirty: usePageStore.getState().dirtyIds.has(pageId),
            editable: Boolean(control),
            blocks: (content.content ?? [])
              .slice(operation.offset, operation.offset + operation.limit)
              .map((block, offset) => ({ index: operation.offset + offset, block })),
            blockCount: content.content?.length ?? 0,
            nextOffset:
              operation.offset + operation.limit < (content.content?.length ?? 0)
                ? operation.offset + operation.limit
                : null,
          });
        const tableRead = operation.kind === 'table' && operation.command.kind === 'inspect';
        if (!tableRead && expectedRevision !== currentRevision)
          return fail('STALE_NOTEBOOK', 'Inspect the notebook again and use its current revision.');
        if (!control)
          return fail(
            'NOTEBOOK_NOT_OPEN',
            'Open this page with open_tab, then inspect and edit it.'
          );
        if (!control.editor.isEditable)
          return fail('NOTEBOOK_READ_ONLY', 'The notebook is read-only.');
        if (operation.kind === 'table') {
          const table = getTableEditorControl(pageId, operation.tableId);
          if (!table)
            return fail(
              'TABLE_NOT_READY',
              'Inspect the notebook for the table refId or data.id; keep its editing view open.'
            );
          const result = executeTableEditorCommand(table, operation.command);
          changed = !tableRead;
          return toolSuccess({
            pageId,
            tableId: operation.tableId,
            revision: revision(
              control.editor.getJSON(),
              usePageStore.getState().pages[pageId]?.title ?? page.title
            ),
            ...result,
          });
        }
        let insertedTableId: string | undefined;
        if (
          operation.kind === 'splice-blocks' ||
          operation.kind === 'insert-table' ||
          operation.kind === 'insert-reference' ||
          operation.kind === 'insert'
        ) {
          let referenceBlock: JSONContent | null = null;
          if (operation.kind === 'insert-reference') {
            if (Boolean(operation.referenceId) === Boolean(operation.documentReference))
              return fail(
                'REFERENCE_REQUIRED',
                'Supply exactly one returned documentReference or referenceId.'
              );
            const document = operation.documentReference
              ? await resolveMolecularDocumentReference(operation.documentReference)
              : null;
            const reference = operation.referenceId
              ? await getEntityReference(operation.referenceId)
              : null;
            if (!reference && !document)
              return fail('REFERENCE_NOT_FOUND', 'The saved result does not exist.');
            if (
              revision(
                control.editor.getJSON(),
                usePageStore.getState().pages[pageId]?.title ?? page.title
              ) !== expectedRevision
            )
              return fail(
                'STALE_NOTEBOOK',
                'Inspect the notebook again and use its current revision.'
              );
            referenceBlock = {
              type: 'paragraph',
              content: [
                notebookReferenceFromHref(
                  document
                    ? molecularDocumentReferenceHref(document.documentReference)
                    : savedReferenceHref(reference!.id),
                  operation.label ?? document?.snapshot.title ?? reference!.display_label
                )!,
              ],
            };
          }
          const prepared =
            operation.kind === 'insert'
              ? await prepareNotebookInsertion(owningRoot, operation.source, abortSignal)
              : null;
          if (prepared) {
            await prepared.verify();
            abortSignal?.throwIfAborted();
            if (
              currentRevision !==
              revision(
                control.editor.getJSON(),
                usePageStore.getState().pages[pageId]?.title ?? page.title
              )
            )
              return fail(
                'STALE_NOTEBOOK',
                'The notebook changed while preparing insertion. Inspect it again.'
              );
          }
          const inserted =
            operation.kind === 'insert-table'
              ? createConfiguredTableBlock(undefined, {
                  rows: operation.rows,
                  columns: operation.columns,
                })
              : (prepared?.block ?? null);
          const insertedBlocks = (
            inserted || referenceBlock
              ? [inserted ?? referenceBlock!]
              : operation.kind === 'splice-blocks'
                ? operation.blocks
                : []
          ).map(normalizeNotebookReferences);
          const deleteCount = operation.kind === 'splice-blocks' ? operation.deleteCount : 0;
          insertedTableId = inserted?.attrs?.type === 'table' ? inserted.attrs.refId : undefined;
          const blocks = content.content ?? [];
          if (operation.index > blocks.length || operation.index + deleteCount > blocks.length)
            return fail('INVALID_BLOCK_RANGE', 'The block range is outside this notebook.');
          const next = {
            ...content,
            content: [
              ...blocks.slice(0, operation.index),
              ...insertedBlocks,
              ...blocks.slice(operation.index + deleteCount),
            ],
          };
          validateRichBlocks(insertedBlocks);
          const checked = control.editor.schema.nodeFromJSON(next);
          checked.check();

          const from = control.editor.state.doc.content.content
            .slice(0, operation.index)
            .reduce((sum, block) => sum + block.nodeSize, 0);
          const to = control.editor.state.doc.content.content
            .slice(0, operation.index + deleteCount)
            .reduce((sum, block) => sum + block.nodeSize, 0);
          changed = control.editor.commands.insertContentAt({ from, to }, insertedBlocks);
        } else if (operation.kind === 'undo') changed = control.editor.commands.undo();
        else if (operation.kind === 'redo') changed = control.editor.commands.redo();
        else {
          changed = 'unknown';
          if (!(await control.save()))
            return fail(
              'NOTEBOOK_SAVE_FAILED',
              'The native notebook editor did not confirm the save.'
            );
          if (operation.kind === 'rename') await store.renamePageArtifact(pageId, operation.title);
          changed = true;
        }
        return toolSuccess({
          pageId,
          revision: revision(
            control.editor.getJSON(),
            usePageStore.getState().pages[pageId]?.title ?? page.title
          ),
          changed,
          dirty: usePageStore.getState().dirtyIds.has(pageId),
          saved: operation.kind === 'save',
          ...(insertedTableId ? { tableId: insertedTableId } : {}),
        });
      } catch (error) {
        if (error instanceof NotebookCreationError)
          return toolFailure({
            code: 'NOTEBOOK_CREATE_FAILED',
            error: error.message,
            retriable: false,
            stateChanged: error.pageId !== null,
            partialEffects: error.pageId
              ? [{ pageId: error.pageId, created: true, saved: false }]
              : [],
          });
        return fail(
          'NOTEBOOK_OPERATION_FAILED',
          error instanceof Error ? error.message : String(error)
        );
      }
    },
  });
}
