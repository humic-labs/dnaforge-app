import { z } from 'zod';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  resolveExplicitProjectRoot,
  soleWritableProjectRoot,
} from '../../../shared/project-root-selection';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import {
  createAuthoredNotebook,
  updateAuthoredNotebook,
  readAuthoredNotebook,
  notebookBlocksSchema,
  notebookReferenceSchema,
  createNotebookAuthoringReference,
} from '../../page/public/notebook-authoring';

export const CREATE_NOTEBOOK_DESCRIPTION =
  'Create a native protocol notebook with paragraphs, headings and editable DNAForge table-builder blocks. Use table blocks for tabular notebook content instead of Markdown table text. Each inline item ' +
  'is {text, referenceId?}; use exact referenceId values returned by create_notebook_reference or create_reference for sequences, ' +
  'source regions, draft assemblies and real oligos. Supply all table rows together; rows contain cells, each containing inline items. The native table editor preserves formatted runs and exact references. ' +
  'intentId identifies one creation intent: retry with the same value and content to reuse the same notebook. ' +
  'Choose workspace from get_workspace.projects, not pinned referenceFolders. ' +
  'Returns owning project, saved revision and an openable reference. No clipboard or GUI workaround is needed.';
export const UPDATE_NOTEBOOK_DESCRIPTION =
  'Append or replace native notebook content with editable DNAForge table-builder blocks and typed references. Supply tabular content as table blocks with all rows together instead of Markdown table text. ' +
  'Read get_notebook first and supply its exact revision. Unsaved human edits and stale revisions are protected.';
export const GET_NOTEBOOK_DESCRIPTION =
  'Read a native notebook from its owning project, including saved structured content, provenance and revision for safe editing.';
export const NOTEBOOK_REFERENCE_DESCRIPTION =
  'Create an openable notebook reference from the exact canonical entityId returned by DNAForge. ' +
  'Supports managed sequences, 1-based inclusive source regions, native assembly drafts, actual primer oligos ' +
  'and individual primer bindings, and notebooks. Preserves owning project and selected interval. ' +
  'Specify workspace when an identity is ambiguous. Use the returned referenceId in notebook content; never construct internal URLs.';
export { notebookReferenceSchema };

const projectSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Exact mounted project name or root; required when more than one writable project is open.'
  );
export const createNotebookSchema = z
  .object({
    workspace: projectSchema,
    title: z.string().trim().min(1).max(200),
    intentId: z.string().min(1).max(200),
    blocks: notebookBlocksSchema,
  })
  .strict();
export const updateNotebookSchema = z
  .object({
    workspace: projectSchema,
    notebookId: z.string().min(1),
    expectedRevision: z.string().min(1),
    mode: z.enum(['append', 'replace']).default('append'),
    blocks: notebookBlocksSchema,
  })
  .strict();
export const getNotebookSchema = z
  .object({
    workspace: projectSchema,
    notebookId: z.string().min(1),
  })
  .strict();

function projectRoot(folders: WorkspaceFolder[], workspace?: string): string {
  const roots = folders.filter((folder) => !folder.pinned);
  const root = workspace
    ? resolveExplicitProjectRoot(roots, workspace)
    : soleWritableProjectRoot(roots);
  if (!root) {
    const choices = roots.map((folder) => `${folder.name} (${folder.path})`).join('; ');
    throw new Error(
      `Choose an exact authoring project from get_workspace.projects for this notebook. Pinned reference folders cannot own notebooks. Available projects: ${choices || 'none; open a project first'}.`
    );
  }
  return root.path;
}

function failure(error: unknown, attempted: boolean) {
  return toolFailure({
    code: 'NOTEBOOK_OPERATION_FAILED',
    error: error instanceof Error ? error.message : String(error),
    retriable: false,
    stateChanged: attempted ? 'unknown' : false,
    partialEffects: [],
  });
}

export function createCreateNotebookTool(folders: WorkspaceFolder[], actionId: string) {
  return resultTool({
    description: CREATE_NOTEBOOK_DESCRIPTION,
    inputSchema: createNotebookSchema,
    execute: async (input) => {
      let attempted = false;
      try {
        const workspaceRoot = projectRoot(folders, input.workspace);
        attempted = true;
        return toolSuccess(
          await createAuthoredNotebook({
            ...input,
            workspaceRoot,
            mountedRoots: folders.map((folder) => folder.path),
            operationId: actionId,
          })
        );
      } catch (error) {
        return failure(error, attempted);
      }
    },
  });
}

export function createUpdateNotebookTool(folders: WorkspaceFolder[], actionId: string) {
  return resultTool({
    description: UPDATE_NOTEBOOK_DESCRIPTION,
    inputSchema: updateNotebookSchema,
    execute: async (input) => {
      let attempted = false;
      try {
        const workspaceRoot = projectRoot(folders, input.workspace);
        attempted = true;
        return toolSuccess(
          await updateAuthoredNotebook({
            ...input,
            workspaceRoot,
            mountedRoots: folders.map((folder) => folder.path),
            operationId: actionId,
          })
        );
      } catch (error) {
        return failure(error, attempted);
      }
    },
  });
}

export function createGetNotebookTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description: GET_NOTEBOOK_DESCRIPTION,
    inputSchema: getNotebookSchema,
    execute: async (input) => {
      try {
        return toolSuccess(
          await readAuthoredNotebook(projectRoot(folders, input.workspace), input.notebookId)
        );
      } catch (error) {
        return failure(error, false);
      }
    },
  });
}

export function createNotebookReferenceTool(folders: WorkspaceFolder[], actionId: string) {
  return resultTool({
    description: NOTEBOOK_REFERENCE_DESCRIPTION,
    inputSchema: notebookReferenceSchema,
    execute: async (input) => {
      try { return toolSuccess(await createNotebookAuthoringReference(input, folders, { toolCallId: actionId, messages: [] })); }
      catch (error) { return failure(error, false); }
    },
  });
}
