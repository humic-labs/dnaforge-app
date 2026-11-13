import type {
  NotebookConflictComparison,
  NotebookConflictResolution,
  ResolveNotebookConflictRequest,
} from '../notebook-conflict';
import { defineGroup, event, invoke } from './contract';
import type {
  MarkdownNotebookAdoptionIssue,
  MarkdownNotebookAdoption,
  MarkdownNotebookAdoptionRequest,
} from '../markdown-notebook';
import type {
  NativeNotebookRequest,
  NotebookDocumentSnapshot,
  NativeNotebookCreateRequest,
  NativeNotebookCreateResult,
} from '../notebook-document';

export const notebookContract = defineGroup('notebook', {
  inspectConflict: invoke<[documentId: string], NotebookConflictComparison>(),
  resolveConflict: invoke<[request: ResolveNotebookConflictRequest], NotebookConflictResolution>(),
  onMarkdownAdoptionFailed: event<[issue: MarkdownNotebookAdoptionIssue]>().channel(
    'notebook:markdownAdoptionFailed'
  ),
  adoptMarkdown: invoke<
    [request: MarkdownNotebookAdoptionRequest],
    MarkdownNotebookAdoption | null
  >(),
  onMarkdownAdopted: event<[result: MarkdownNotebookAdoption]>().channel(
    'notebook:markdownAdopted'
  ),
  create: invoke<[request: NativeNotebookCreateRequest], NativeNotebookCreateResult>(),
  completeLegacyDraftMigration: invoke<[pendingIds: readonly string[]], void>(),
  execute: invoke<[request: NativeNotebookRequest], NotebookDocumentSnapshot>(),
  onChanged: event<[snapshot: NotebookDocumentSnapshot]>().channel('notebook:changed'),
});
