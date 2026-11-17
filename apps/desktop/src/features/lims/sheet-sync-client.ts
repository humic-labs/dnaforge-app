import { useSettingsStore } from '../junction-workbench/public/settings';
import type { PrimerTmSettings } from '../../shared/primer-tm-settings';
import { platform } from '../../platform';
import type {
  SheetSyncCommand,
  SheetSyncResult,
  SheetSyncPrepared,
} from '../../shared/registry-artifacts/sheet-sync/command';
export async function sheetSyncCommand<K extends SheetSyncResult['kind']>(
  workspaceRoot: string,
  command: SheetSyncCommand,
  kind: K
): Promise<Extract<SheetSyncResult, { kind: K }>> {
  const result = await platform().importReview.sheetSync({ workspaceRoot, command });
  if (result.kind !== kind)
    throw new Error(
      'message' in result && result.message
        ? result.message
        : 'The native spreadsheet operation returned an unexpected outcome.'
    );
  return result as Extract<SheetSyncResult, { kind: K }>;
}
export function sheetSyncPrimerTmSettings(): PrimerTmSettings {
  const settings = useSettingsStore.getState();
  return {
    userSetting: structuredClone(settings.tmModel),
    userSettingIsExplicit: settings.tmModelExplicit,
    conditions: structuredClone(settings.tmConditions),
    concNm: settings.primerConcNm,
  };
}
export async function prepareSheetSyncConnection(input: {
  workspaceRoot: string;
  source: Extract<SheetSyncCommand, { kind: 'prepare' }>['source'];
  destinationRelativePath: string;
  grantId?: string;
}): Promise<SheetSyncPrepared> {
  const { workspaceRoot, ...source } = input;
  return sheetSyncCommand(
    workspaceRoot,
    { kind: 'prepare', ...source, primerTmSettings: sheetSyncPrimerTmSettings() },
    'prepared'
  );
}
export async function connectPreparedSheetSync(
  workspaceRoot: string,
  preparedId: string,
  requestId: string
) {
  const result = await platform().importReview.sheetSync({
    workspaceRoot,
    command: { kind: 'connect', preparedId, requestId },
  });
  if (result.kind !== 'connected' || !result.stored) {
    const message = 'message' in result ? result.message : undefined;
    throw Object.assign(
      new Error(
        message ??
          'Spreadsheet connection remains incomplete. Inspect its retained native outcome before retrying.'
      ),
      { sheetSyncOutcome: result }
    );
  }
  return result.stored;
}
