// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  parseInventoryArchive,
  parseInventoryState,
  type InventoryCommand,
  type InventoryState,
} from '@waypoint/domain-services';
import {
  inventoryReceiptSchema,
  type InventoryApplyImportRequest,
  type NativeInventoryHistoryEntry,
} from '../shared/inventory-command';
import {
  nativeInventoryArchive,
  nativeInventoryArchiveRuntime,
  nativeInventoryImportPreview,
  replayNativeInventoryJournal,
} from './inventory-archive';
import {
  nativeInventoryRequestDigest,
  parseNativeInventoryJournalEntry,
} from './inventory-journal';
import { createNativeInventoryOwner } from './inventory-owner';
import {
  createRegisteredProjectAuthority,
  withAgentProjectScope,
} from './registered-project-authority';
import { openReadonlyFileTestDb } from './__tests__/test-db';

let historicalDb: Database.Database;
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./ipc/database', () => ({ getDb: () => historicalDb }));

const authority = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) };
const principal = { kind: 'agent' as const, identityId: 'archive-operator' };
const context = { at: 10, principal, authority };

function original(): { state: InventoryState; row: NativeInventoryHistoryEntry } {
  const commands: readonly InventoryCommand[] = [
    { kind: 'create-vessel', id: 'vessel', name: 'Retained tube', placement: { kind: 'unplaced' } },
  ];
  const request = {
    project: 'source-project',
    inventoryId: 'source-inventory',
    operationId: 'source-create',
    expectedRevision: 0,
    commands,
  };
  const result = applyInventoryCommandBatch(
    createInventoryState(),
    { expectedRevision: request.expectedRevision, commands },
    context
  );
  if (!result.ok) throw Error(result.message);
  return {
    state: result.state,
    row: {
      request,
      receipt: {
        status: 'committed',
        inventoryId: request.inventoryId,
        operationId: request.operationId,
        revision: 1,
        actor: 'native:archive-operator',
        recordedAt: context.at,
        context: { version: 14, principal, authority },
        requestDigest: nativeInventoryRequestDigest(request),
      },
    },
  };
}

function artifact(
  state: InventoryState,
  row: NativeInventoryHistoryEntry,
  schema: string = state.schema
) {
  return nativeInventoryArchive({
    projectId: row.request.project,
    inventoryId: row.request.inventoryId,
    state: { revision: state.revision, json: JSON.stringify({ ...state, schema }) },
    history: [
      {
        operationId: row.request.operationId,
        revision: row.receipt.revision,
        requestJson: JSON.stringify(row.request),
        receiptJson: JSON.stringify(row.receipt),
      },
    ],
  });
}

function adoption(sourceText: string, version: 13 | 14): NativeInventoryHistoryEntry {
  const target = {
    projectId: 'target-project',
    inventoryId: 'target-inventory',
    present: false,
    revision: 0,
  };
  const preview = nativeInventoryImportPreview(sourceText, target, { bindings: [] }, [], 20);
  if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
  const request: InventoryApplyImportRequest = {
    kind: 'adopt-archive',
    project: target.projectId,
    inventoryId: target.inventoryId,
    operationId: 'adopt-original',
    expectedRevision: 0,
    sourceText,
    options: preview.options,
    expectedPlanDigest: preview.planDigest,
  };
  return {
    request,
    receipt: {
      status: 'committed',
      inventoryId: request.inventoryId,
      operationId: request.operationId,
      revision: 1,
      actor: 'native:archive-operator',
      recordedAt: 20,
      context: { version, principal, authority },
      requestDigest: nativeInventoryRequestDigest(request),
    },
  };
}

describe('local inventory format and authority boundaries', () => {
  it('preserves all original local receipt contexts and admits local V14 without account authority', () => {
    const { row } = original();
    for (let version = 1; version <= 14; version++) {
      const receipt = { ...row.receipt, context: { version, principal, authority } };
      const bytes = JSON.stringify(receipt);
      expect(inventoryReceiptSchema.parse(receipt)).toEqual(receipt);
      expect(JSON.stringify(receipt)).toBe(bytes);
      expect(() =>
        inventoryReceiptSchema.parse({
          ...receipt,
          context: {
            version,
            principal: { kind: 'organization-account', orgId: 'org', accountId: 'account' },
            authority: {
              kind: 'organization-inventory',
              orgId: 'org',
              accountId: 'account',
              inventoryId: 'inventory',
            },
          },
        })
      ).toThrow();
    }
  });

  it('roundtrips current local format while refusing it under V13 adoption', () => {
    const { state, row } = original();
    expect(state.schema).toBe('dnaforge.inventory.v31');
    const archive = artifact(state, row);
    const bytes = archive.sourceText;
    expect(replayNativeInventoryJournal([row])).toEqual(state);
    expect(() => parseInventoryArchive(bytes, nativeInventoryArchiveRuntime)).not.toThrow();
    expect(() => replayNativeInventoryJournal([adoption(bytes, 13)])).toThrow();
    expect(
      Object.values(replayNativeInventoryJournal([adoption(bytes, 14)]).vessels).map(
        (vessel) => vessel.name
      )
    ).toEqual(['Retained tube']);
    expect(archive.sourceText).toBe(bytes);
  });

  it('keeps an ancestor format refusal through a newer nested receipt and older outer schema', () => {
    const { state, row } = original();
    const inner = artifact(state, row);
    const outerRow = adoption(inner.sourceText, 14);
    const outerState = replayNativeInventoryJournal([outerRow]);
    const outer = artifact(outerState, outerRow, 'dnaforge.inventory.v30');
    expect(() =>
      parseInventoryArchive(outer.sourceText, nativeInventoryArchiveRuntime)
    ).not.toThrow();
    expect(() =>
      parseInventoryArchive(outer.sourceText, nativeInventoryArchiveRuntime, {
        allowOrganizationAuthority: false,
      })
    ).toThrow();
  });
});

it.runIf(Boolean(process.env.INVENTORY_LOCAL_AUTHORITY_HISTORY_DB))(
  'reads and replays original local history without rewriting state, receipts or profile bytes',
  async () =>
    withAgentProjectScope({ kind: 'app-following' }, async () => {
      const path = process.env.INVENTORY_LOCAL_AUTHORITY_HISTORY_DB!;
      const profileKey = process.env.INVENTORY_LOCAL_AUTHORITY_PROFILE_KEY!;
      expect(profileKey).toMatch(/^[a-f0-9]{64}$/);
      const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
      const fileBefore = hash(readFileSync(path));
      historicalDb = openReadonlyFileTestDb(path);
      try {
        historicalDb.pragma('query_only=ON');
        expect(historicalDb.readonly).toBe(true);
        const raw = () =>
          JSON.stringify({
            states: historicalDb
              .prepare('SELECT * FROM inventory_state ORDER BY inventory_id')
              .all(),
            journal: historicalDb
              .prepare('SELECT * FROM inventory_journal ORDER BY inventory_id,revision')
              .all(),
          });
        const before = raw();
        let replayed = 0;
        let admitted = 0;
        for (const row of historicalDb
          .prepare('SELECT * FROM inventory_state ORDER BY inventory_id')
          .all() as { inventory_id: string; project_id: string; state_json: string }[]) {
          const workspace = historicalDb
            .prepare('SELECT path FROM workspaces WHERE repo_uuid=?')
            .get(row.project_id) as { path: string };
          const projectAuthority = createRegisteredProjectAuthority({
            db: () => historicalDb,
            managedRootDir: () => dirname(dirname(workspace.path)),
          });
          const owner = createNativeInventoryOwner({
            db: () => historicalDb,
            projectAuthority,
            profileKey,
            actor: () => 'native:historical-read',
          });
          const scope = { project: row.project_id, inventoryId: row.inventory_id };
          const history = (
            historicalDb
              .prepare('SELECT * FROM inventory_journal WHERE inventory_id=? ORDER BY revision')
              .all(row.inventory_id) as {
              inventory_id: string;
              operation_id: string;
              revision: number;
              request_json: string;
              receipt_json: string;
            }[]
          ).map((entry) =>
            parseNativeInventoryJournalEntry(entry, row.project_id, {
              request: JSON.parse(entry.request_json),
              receipt: JSON.parse(entry.receipt_json),
            })
          );
          const state = parseInventoryState(JSON.parse(row.state_json));
          expect(replayNativeInventoryJournal(history)).toEqual(state);
          replayed += history.length;
          if (projectAuthority.resolve(row.project_id)) {
            expect(owner.inspect(scope)).toEqual(state);
            for (const entry of history)
              expect(owner.operation({ ...scope, operationId: entry.request.operationId })).toEqual(
                entry.receipt
              );
            admitted += history.length;
          } else expect(() => owner.inspect(scope)).toThrow('PROJECT_ACCESS_DENIED');
        }
        expect(replayed).toBe(Number(process.env.INVENTORY_LOCAL_AUTHORITY_HISTORY_ROWS));
        expect(admitted).toBe(Number(process.env.INVENTORY_LOCAL_AUTHORITY_ADMITTED_ROWS));
        expect(historicalDb.prepare('SELECT total_changes() AS n').get()).toEqual({ n: 0 });
        expect(raw()).toBe(before);
        console.log(
          JSON.stringify({ replayed, admitted, unavailable: replayed - admitted, writes: 0 })
        );
      } finally {
        historicalDb.close();
        expect(hash(readFileSync(path))).toBe(fileBefore);
      }
    })
);
