import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeSheetSyncFinalization,
  authorizeLocalSheetSync,
  authorizeGoogleSheetSync,
  localGoogleSheetSyncGrant,
  localSheetSyncAuthorization,
  setLocalSheetSyncActive,
  sheetSyncFinalizationAcknowledged,
} from './sheet-sync-local-state';
import { parseSheetSyncConnection, type SheetSyncConnection } from './sheet-sync-connection';
const local = vi.hoisted(() => ({
  scope: 'repo:project-a',
  ownerKey: 'account-a',
  connected: true,
  settings: new Map<string, string>(),
}));
vi.mock('../../db/workspace-catalog', () => ({ resolveWorkspaceScope: async () => local.scope }));
vi.mock('../../platform', () => ({
  platform: () => ({
    googleSheets: {
      status: async () => ({
        ownerKey: local.ownerKey,
        accounts: [
          {
            account: { id: 'dedfe665-c77c-465a-a561-fe0d65cbcd5b' },
            kind: local.connected ? 'connected' : 'reconnect-required',
          },
        ],
      }),
    },
    db: {
      select: async (_sql: string, params: unknown[]) => {
        const key = params[0];
        const value = typeof key === 'string' ? local.settings.get(key) : undefined;
        return value === undefined ? [] : [{ value }];
      },
      execute: async (_sql: string, params: unknown[]) => {
        if (typeof params[0] !== 'string' || typeof params[1] !== 'string')
          throw new Error('Invalid settings write');
        local.settings.set(params[0], params[1]);
      },
    },
  }),
}));
const connection = {
  schema: 'dnaforge.sheet-sync',
  schemaVersion: 1,
  id: 'd788e456-ebdf-4672-818c-d5e6a1ff99b4',
  importSetId: 'import-set',
  source: {
    path: '/chosen/master.xlsx',
    sheetName: 'Primers',
    keyColumn: 'ID',
    forcedKind: 'oligo',
    columnMappings: [],
  },
  destinationRelativePath: 'primers',
  revision: `sha256:${'a'.repeat(64)}`,
  enabled: true,
  pending: null,
  finalization: null,
  checkpoints: [],
} satisfies SheetSyncConnection;
beforeEach(() => {
  local.scope = 'repo:project-a';
  local.ownerKey = 'account-a';
  local.connected = true;
  local.settings.clear();
});
describe('device-local spreadsheet consent and publication receipts', () => {
  it('requires explicit local file approval bound to project identity and source configuration', async () => {
    expect(await localSheetSyncAuthorization('/project', connection)).toBe('required');
    await expect(
      authorizeLocalSheetSync('/project', connection, '/other/private.xlsx')
    ).rejects.toThrow('Choose the workbook');
    expect(local.settings.size).toBe(0);
    await authorizeLocalSheetSync('/project', connection, connection.source.path);
    expect(await localSheetSyncAuthorization('/project', connection)).toBe('authorized');
    expect(
      await localSheetSyncAuthorization(
        '/project',
        parseSheetSyncConnection(JSON.stringify(connection))
      )
    ).toBe('authorized');
    expect(
      await localSheetSyncAuthorization('/project', {
        ...connection,
        source: { ...connection.source, keyColumn: 'Different ID' },
      })
    ).toBe('required');
    local.scope = 'repo:another-project';
    expect(await localSheetSyncAuthorization('/project', connection)).toBe('required');
  });
  it('keeps a local pause separate from an immutable finalization acknowledgement', async () => {
    await authorizeLocalSheetSync('/project', connection, connection.source.path);
    await setLocalSheetSyncActive('/project', connection, false);
    const finalization = {
      id: '05a1d6e7-3d6a-4a59-81ec-8629f742a751',
      sourceRevision: connection.revision,
      snapshotPaths: [],
    };
    const current: SheetSyncConnection = {
      ...connection,
      finalization,
    };
    expect(await sheetSyncFinalizationAcknowledged('/project', current)).toBe(false);
    await acknowledgeSheetSyncFinalization('/project', current, 'source-bound-commit');
    expect(await sheetSyncFinalizationAcknowledged('/project', current)).toBe(true);
    expect(await localSheetSyncAuthorization('/project', current)).toBe('paused');
    expect(
      await sheetSyncFinalizationAcknowledged('/project', {
        ...current,
        finalization: { ...finalization, sourceRevision: `sha256:${'b'.repeat(64)}` },
      })
    ).toBe(false);
    await setLocalSheetSyncActive('/project', connection, true);
    expect(await localSheetSyncAuthorization('/project', connection)).toBe('authorized');
  });
  it('does not treat malformed local settings or a portable enabled flag as permission', async () => {
    await authorizeLocalSheetSync('/project', connection, connection.source.path);
    for (const key of local.settings.keys()) local.settings.set(key, '{corrupt');
    expect(await localSheetSyncAuthorization('/project', connection)).toBe('required');
    await expect(setLocalSheetSyncActive('/project', connection, true)).rejects.toThrow(
      'Choose the workbook'
    );
  });
});

describe('Google Sheets device-local grants', () => {
  const google: SheetSyncConnection = {
    ...connection,
    source: {
      provider: 'google-sheets',
      spreadsheetId: 'master-id',
      sheetId: 17,
      keyColumn: 'ID',
      forcedKind: 'oligo',
      columnMappings: [],
    },
  };
  const grantId = 'dedfe665-c77c-465a-a561-fe0d65cbcd5b';
  it('binds local consent to project, immutable source, native owner and connected grant', async () => {
    expect(await localSheetSyncAuthorization('/project', google)).toBe('required');
    await authorizeGoogleSheetSync('/project', google, grantId);
    expect(await localGoogleSheetSyncGrant('/project', google)).toBe(grantId);
    expect(JSON.stringify(google)).not.toContain(grantId);
    await setLocalSheetSyncActive('/project', google, false);
    expect(await localSheetSyncAuthorization('/project', google)).toBe('paused');
    await setLocalSheetSyncActive('/project', google, true);
    expect(await localGoogleSheetSyncGrant('/project', google)).toBe(grantId);
    local.ownerKey = 'account-b';
    expect(await localSheetSyncAuthorization('/project', google)).toBe('required');
    await expect(localGoogleSheetSyncGrant('/project', google)).rejects.toThrow('Authorize');
    local.ownerKey = 'account-a';
    local.connected = false;
    expect(await localSheetSyncAuthorization('/project', google)).toBe('required');
    await expect(authorizeGoogleSheetSync('/project', google, grantId)).rejects.toThrow(
      'connected'
    );
    local.connected = true;
    local.scope = 'repo:project-b';
    expect(await localSheetSyncAuthorization('/project', google)).toBe('required');
  });
});
