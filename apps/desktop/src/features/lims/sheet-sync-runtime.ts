import { deliverWorkspaceDisplayOutcome } from '../../services/workspace-display-participants';
import { notifyWorkspaceReconciled } from '../../services/workspace-reconciled-event';
import { notifyGitStatusChanged } from '../../hooks/useGitStatus';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import type { ExcelSyncSource } from '../../shared/registry-artifacts/sheet-sync/sources';
import { excelSourceSchema, type GoogleSyncSource } from './sheet-sync-connection';
import {
  connectPreparedSheetSync,
  prepareSheetSyncConnection,
  sheetSyncCommand,
  sheetSyncPrimerTmSettings,
} from './sheet-sync-client';
export type { SheetSyncPullSummary } from '../../shared/registry-artifacts/sheet-sync/runtime';
export { prepareSheetSyncConnection } from './sheet-sync-client';
export async function createExcelSheetSyncConnection(input: {
  workspaceRoot: string;
  source: ExcelSyncSource;
  destinationRelativePath: string;
  preparedId?: string;
  requestId?: string;
}) {
  const preparedId =
    input.preparedId ??
    (
      await prepareSheetSyncConnection({
        workspaceRoot: input.workspaceRoot,
        source: excelSourceSchema.parse(input.source),
        destinationRelativePath: input.destinationRelativePath,
      })
    ).preparedId;
  return connectPreparedSheetSync(input.workspaceRoot, preparedId, input.requestId ?? preparedId);
}
export async function createGoogleSheetSyncConnection(input: {
  workspaceRoot: string;
  source: GoogleSyncSource;
  grantId: string;
  destinationRelativePath: string;
  preparedId?: string;
  requestId?: string;
}) {
  const preparedId =
    input.preparedId ??
    (
      await prepareSheetSyncConnection({
        workspaceRoot: input.workspaceRoot,
        source: input.source,
        destinationRelativePath: input.destinationRelativePath,
        grantId: input.grantId,
      })
    ).preparedId;
  return connectPreparedSheetSync(input.workspaceRoot, preparedId, input.requestId ?? preparedId);
}
export async function setSheetSyncEnabled(
  workspaceRoot: string,
  id: string,
  enabled: boolean
): Promise<void> {
  await sheetSyncCommand(workspaceRoot, { kind: 'set-enabled', id, enabled }, 'changed');
}
export async function pullExcelSheetConnection(input: {
  workspaceRoot: string;
  id: string;
  assertCurrent?: () => void;
}) {
  input.assertCurrent?.();
  const result = await sheetSyncCommand(
    input.workspaceRoot,
    { kind: 'pull', id: input.id, primerTmSettings: sheetSyncPrimerTmSettings() },
    'pulled'
  );
  input.assertCurrent?.();
  if (result.summary && (result.summary.created || result.summary.updated)) {
    useWorkspaceStore.getState().bumpFileTreeRefresh();
    notifyWorkspaceReconciled(input.workspaceRoot);
    notifyGitStatusChanged(input.workspaceRoot);
    const display = await deliverWorkspaceDisplayOutcome({
      workspaceRoot: input.workspaceRoot,
      operationId: `sheet-sync:${input.id}:${crypto.randomUUID()}`,
      assertCurrent: input.assertCurrent ?? (() => {}),
    });
    input.assertCurrent?.();
    if (display.state === 'failed')
      console.warn(
        'Spreadsheet records were published; some views could not refresh.',
        display.errors
      );
  }
  return result.summary;
}
