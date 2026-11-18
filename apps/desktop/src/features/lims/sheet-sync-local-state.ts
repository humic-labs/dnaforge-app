import type { SheetSyncConnection } from './sheet-sync-connection';
import { sheetSyncCommand } from './sheet-sync-client';
export async function localSheetSyncAuthorization(
  workspaceRoot: string,
  connection: SheetSyncConnection
) {
  return (
    await sheetSyncCommand(
      workspaceRoot,
      { kind: 'authorization', id: connection.id },
      'authorization'
    )
  ).state;
}
export async function authorizeLocalSheetSync(
  workspaceRoot: string,
  connection: SheetSyncConnection,
  selectedPath: string
): Promise<void> {
  await sheetSyncCommand(
    workspaceRoot,
    { kind: 'authorize-excel', id: connection.id, selectedPath },
    'changed'
  );
}
export async function authorizeGoogleSheetSync(
  workspaceRoot: string,
  connection: SheetSyncConnection,
  grantId: string
): Promise<void> {
  await sheetSyncCommand(
    workspaceRoot,
    { kind: 'authorize-google', id: connection.id, grantId },
    'changed'
  );
}
