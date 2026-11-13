import { describe, expect, it, vi } from 'vitest';
import {
  parseSheetSyncConnection,
  writeSheetSyncConnection,
  type SheetSyncConnection,
} from './sheet-sync-connection';
import { sha256Hex } from '../primers/public/primer-artifact';
const fs = vi.hoisted(() => ({ writeWorkspaceTextFileAtomic: vi.fn(async () => undefined) }));
vi.mock('../../platform', () => ({ platform: () => ({ fs }) }));
function connection(): SheetSyncConnection {
  const record = { kind: 'strain', name: 'K12', fields: { notes: 'Stable' } };
  return {
    schema: 'dnaforge.sheet-sync',
    schemaVersion: 1,
    id: 'd788e456-ebdf-4672-818c-d5e6a1ff99b4',
    importSetId: 'existing-import-set',
    source: {
      path: '/chosen/master.xlsx',
      sheetName: 'Strains',
      keyColumn: 'ID',
      forcedKind: 'strain',
      columnMappings: [],
    },
    destinationRelativePath: 'records',
    revision: `sha256:${'a'.repeat(64)}`,
    enabled: true,
    pending: null,
    finalization: null,
    checkpoints: [
      {
        key: '001',
        entityId: 'strain-id',
        artifactRelativePath: 'records/strain.entity.json',
        source: record,
        applied: record,
      },
    ],
  };
}
describe('durable spreadsheet checkpoint', () => {
  it('roundtrips durable source and entity identities with three-way baselines', () => {
    expect(parseSheetSyncConnection(JSON.stringify(connection()))).toEqual(connection());
  });
  it('rejects newer formats, unsafe artifact paths and duplicate target identities', () => {
    const value = connection();
    expect(() =>
      parseSheetSyncConnection(JSON.stringify({ ...value, schemaVersion: 2 }))
    ).toThrow();
    expect(() =>
      parseSheetSyncConnection(
        JSON.stringify({
          ...value,
          checkpoints: [
            { ...value.checkpoints[0], artifactRelativePath: '../foreign.entity.json' },
          ],
        })
      )
    ).toThrow();
    expect(() =>
      parseSheetSyncConnection(
        JSON.stringify({
          ...value,
          checkpoints: [value.checkpoints[0], { ...value.checkpoints[0], key: '002' }],
        })
      )
    ).toThrow('share a target');
  });
  it('creates only a workspace-owned checkpoint and binds replacements to the prior bytes', async () => {
    const first = await writeSheetSyncConnection({
      workspaceRoot: '/project',
      connection: connection(),
      mutationToken: 'lease',
    });
    expect(fs.writeWorkspaceTextFileAtomic).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: `/project/.waypoint/sheet-sync/${connection().id}.json`,
        mode: 'create',
        mutationToken: 'lease',
      })
    );
    await writeSheetSyncConnection({
      workspaceRoot: '/project',
      connection: { ...connection(), revision: `sha256:${'b'.repeat(64)}` },
      expectedContent: first.content,
      mutationToken: 'lease',
    });
    expect(fs.writeWorkspaceTextFileAtomic).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: 'replace',
        expectedContentHash: await sha256Hex(first.content),
      })
    );
  });
  it('requires a new connection before changing the row-key mapping behind existing baselines', async () => {
    const value = connection();
    await expect(
      writeSheetSyncConnection({
        workspaceRoot: '/project',
        connection: { ...value, source: { ...value.source, keyColumn: 'Different ID' } },
        expectedContent: JSON.stringify(value),
        mutationToken: 'lease',
      })
    ).rejects.toThrow('Reconnect');
  });

  it('rejects nonfinite mapped values before JSON serialization can erase them', async () => {
    const value = connection();
    value.checkpoints[0].source.fields = { concentration: Infinity };
    await expect(
      writeSheetSyncConnection({
        workspaceRoot: '/project',
        connection: value,
        mutationToken: 'lease',
      })
    ).rejects.toThrow();
  });
});
