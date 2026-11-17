export {
  excelSourceSchema,
  parseSheetSyncConnection,
  parseSheetSyncSnapshot,
  sheetSyncConnectionRelativePath,
  sheetSyncSnapshotRelativePath,
  sheetSyncWorkspacePath,
  sheetSyncSourceView,
} from '../../shared/registry-artifacts/sheet-sync/persistence';
export type {
  GoogleSyncSource,
  SheetSyncConnection,
  SheetSyncSnapshot,
  StoredSheetSyncConnection,
  SheetSyncConnectionEntry,
} from '../../shared/registry-artifacts/sheet-sync/persistence';
import { sheetSyncCommand } from './sheet-sync-client';
export async function loadSheetSyncConnection(workspaceRoot: string, id: string) {
  return (await sheetSyncCommand(workspaceRoot, { kind: 'inspect', id }, 'connection')).stored;
}
export async function listSheetSyncConnections(workspaceRoot: string) {
  return (await sheetSyncCommand(workspaceRoot, { kind: 'list' }, 'connections')).entries;
}
