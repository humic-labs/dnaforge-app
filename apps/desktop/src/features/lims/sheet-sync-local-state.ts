import { z } from 'zod';
import { platform } from '../../platform';
import { resolveWorkspaceScope } from '../../db/workspace-catalog';
import { normalizePathForBoundary } from '../../shared/path-boundary';
import { sha256Hex } from '../primers/public/primer-artifact';
import type { SheetSyncConnection } from './sheet-sync-connection';

const grantSchema = z
  .object({
    fingerprint: z.string(),
    active: z.boolean(),
    google: z.object({ ownerKey: z.string(), grantId: z.string().uuid() }).strict().optional(),
  })
  .strict();
const acknowledgementSchema = z
  .object({ id: z.string().uuid(), sourceRevision: z.string(), gitCommit: z.string().nullable() })
  .strict();

async function keyFor(workspaceRoot: string, id: string, kind: 'grant' | 'finalization') {
  const scope = await resolveWorkspaceScope(workspaceRoot);
  if (!scope) throw new Error('Spreadsheet sync requires a registered project identity.');
  return `sheet-sync.local-${kind}:${await sha256Hex(scope)}:${id}`;
}
function parsedSetting(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
async function readSetting(key: string): Promise<string | null> {
  const rows = await platform().db.select<Array<{ value: string }>>(
    'SELECT value FROM settings WHERE key = ?',
    [key]
  );
  return rows[0]?.value ?? null;
}
async function writeSetting(key: string, value: unknown) {
  await platform().db.execute(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [key, JSON.stringify(value), Date.now()]
  );
}
async function sourceFingerprint(connection: SheetSyncConnection) {
  return sha256Hex(
    JSON.stringify({
      source:
        'provider' in connection.source
          ? connection.source
          : {
              path: normalizePathForBoundary(connection.source.path),
              sheetName: connection.source.sheetName,
              keyColumn: connection.source.keyColumn,
              forcedKind: connection.source.forcedKind,
              columnMappings: connection.source.columnMappings,
            },
      destinationRelativePath: connection.destinationRelativePath,
    })
  );
}
export async function localSheetSyncAuthorization(
  workspaceRoot: string,
  connection: SheetSyncConnection
): Promise<'authorized' | 'paused' | 'required'> {
  const value = await readSetting(await keyFor(workspaceRoot, connection.id, 'grant'));
  if (!value) return 'required';
  const result = grantSchema.safeParse(parsedSetting(value));
  if (!result.success || result.data.fingerprint !== (await sourceFingerprint(connection)))
    return 'required';
  if ('provider' in connection.source) {
    const status = await platform().googleSheets.status();
    if (
      !result.data.google ||
      result.data.google.ownerKey !== status.ownerKey ||
      !status.accounts.some(
        (entry) => entry.account.id === result.data.google?.grantId && entry.kind === 'connected'
      )
    )
      return 'required';
  }
  return result.data.active ? 'authorized' : 'paused';
}
export async function authorizeLocalSheetSync(
  workspaceRoot: string,
  connection: SheetSyncConnection,
  selectedPath: string
): Promise<void> {
  if ('provider' in connection.source)
    throw new Error('Choose a Google account for this connection.');
  if (normalizePathForBoundary(selectedPath) !== normalizePathForBoundary(connection.source.path))
    throw new Error('Choose the workbook recorded for this connection.');
  await writeSetting(await keyFor(workspaceRoot, connection.id, 'grant'), {
    fingerprint: await sourceFingerprint(connection),
    active: true,
  });
}
export async function setLocalSheetSyncActive(
  workspaceRoot: string,
  connection: SheetSyncConnection,
  active: boolean
): Promise<void> {
  const state = await localSheetSyncAuthorization(workspaceRoot, connection);
  if (state === 'required') {
    if (!active) return;
    throw new Error('Choose the workbook on this device before enabling synchronization.');
  }
  const key = await keyFor(workspaceRoot, connection.id, 'grant');
  const prior = grantSchema.parse(parsedSetting((await readSetting(key)) ?? 'null'));
  await writeSetting(key, { ...prior, active });
}
export async function sheetSyncFinalizationAcknowledged(
  workspaceRoot: string,
  connection: SheetSyncConnection
): Promise<boolean> {
  if (!connection.finalization) return true;
  const value = await readSetting(await keyFor(workspaceRoot, connection.id, 'finalization'));
  if (!value) return false;
  const result = acknowledgementSchema.safeParse(parsedSetting(value));
  return (
    result.success &&
    result.data.id === connection.finalization.id &&
    result.data.sourceRevision === connection.finalization.sourceRevision
  );
}
export async function acknowledgeSheetSyncFinalization(
  workspaceRoot: string,
  connection: SheetSyncConnection,
  gitCommit: string | null
): Promise<void> {
  if (!connection.finalization) throw new Error('Spreadsheet publication intent is missing.');
  await writeSetting(await keyFor(workspaceRoot, connection.id, 'finalization'), {
    id: connection.finalization.id,
    sourceRevision: connection.finalization.sourceRevision,
    gitCommit,
  });
}

export async function authorizeGoogleSheetSync(
  workspaceRoot: string,
  connection: SheetSyncConnection,
  grantId: string
): Promise<void> {
  if (!('provider' in connection.source))
    throw new Error('This connection requires a local workbook.');
  const status = await platform().googleSheets.status();
  if (!status.accounts.some((entry) => entry.account.id === grantId && entry.kind === 'connected'))
    throw new Error('Choose a connected Google account in the selected DNAForge account.');
  await writeSetting(await keyFor(workspaceRoot, connection.id, 'grant'), {
    fingerprint: await sourceFingerprint(connection),
    active: true,
    google: { ownerKey: status.ownerKey, grantId },
  });
}
export async function localGoogleSheetSyncGrant(
  workspaceRoot: string,
  connection: SheetSyncConnection
): Promise<string> {
  if (
    !('provider' in connection.source) ||
    (await localSheetSyncAuthorization(workspaceRoot, connection)) !== 'authorized'
  )
    throw new Error('Authorize this Google worksheet on this device before synchronizing.');
  const parsed = grantSchema.parse(
    parsedSetting(
      (await readSetting(await keyFor(workspaceRoot, connection.id, 'grant'))) ?? 'null'
    )
  );
  if (!parsed.google) throw new Error('Choose a Google account for this connection.');
  const status = await platform().googleSheets.status();
  if (
    status.ownerKey !== parsed.google.ownerKey ||
    !status.accounts.some(
      (entry) => entry.account.id === parsed.google?.grantId && entry.kind === 'connected'
    )
  )
    throw new Error('The selected Google account changed. Reauthorize this connection.');
  return parsed.google.grantId;
}
