import {
  sheetSyncCommandIsReadOnly,
  type SheetSyncRequest,
  type SheetSyncResult,
} from './registry-artifacts/sheet-sync/command';
import { importReviewSchema, type ImportReviewAgentInput } from './import-review-command';
import type { ImportReviewInspection, ImportReviewRequest } from './import-review';
import { resolveExplicitProjectRoot } from './project-root-selection';
import { findContainingPathBoundary, normalizePathForBoundary } from './path-boundary';

export async function executeImportReviewAgent(
  input: ImportReviewAgentInput,
  context: {
    projects(): readonly { name: string; path: string; pinned?: boolean }[];
    call(request: ImportReviewRequest): Promise<ImportReviewInspection>;
    sheetSync?(request: SheetSyncRequest): Promise<SheetSyncResult>;
  }
): Promise<ImportReviewInspection | SheetSyncResult> {
  const { project, operation } = importReviewSchema.parse(input);
  const current = context.projects();
  const target = resolveExplicitProjectRoot(current, project);
  if (!target)
    throw new Error('IMPORT_PROJECT_UNAVAILABLE: Choose an exact currently admitted project.');
  if (operation.kind === 'sheet-sync') {
    if (target.pinned && !sheetSyncCommandIsReadOnly(operation.command))
      throw new Error('IMPORT_PROJECT_READ_ONLY: This project is read-only.');
    if (!context.sheetSync) throw new Error('The native spreadsheet owner is unavailable.');
    return context.sheetSync({ workspaceRoot: target.path, command: operation.command });
  }
  if (target.pinned && (operation.kind === 'prepare' || operation.command.kind !== 'inspect'))
    throw new Error('IMPORT_PROJECT_READ_ONLY: This project is read-only.');
  if (operation.kind === 'prepare') {
    const destination = operation.destination.replace(/\\/g, '/');
    if (
      destination.startsWith('/') ||
      /^[a-z]:/i.test(destination) ||
      destination.split('/').includes('..')
    )
      throw new Error('IMPORT_DESTINATION_INVALID: Choose a project-relative folder.');
    if (
      operation.source.sourcePath &&
      !findContainingPathBoundary(current, operation.source.sourcePath)
    )
      throw new Error('IMPORT_SOURCE_UNAVAILABLE: Choose a source inside an admitted project.');
    return context.call({
      kind: 'prepare',
      workspaceRoot: target.path,
      destinationDir: destination === '.' ? target.path : `${target.path}/${destination}`,
      source: operation.source,
    });
  }
  const inspection = await context.call({
    kind: 'execute',
    id: operation.id,
    command: { kind: 'inspect', limit: 1 },
  });
  if (normalizePathForBoundary(inspection.workspaceRoot) !== normalizePathForBoundary(target.path))
    throw new Error('IMPORT_REVIEW_PROJECT_MISMATCH: This review belongs to another project.');
  return context.call(operation);
}
