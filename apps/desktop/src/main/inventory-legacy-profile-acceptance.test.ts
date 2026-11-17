// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0', exit: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));

import { openFileTestDb } from './__tests__/test-db';
import { createNativeInventoryOwner } from './inventory-owner';
import { createRegisteredProjectAuthority } from './registered-project-authority';
import { nativeDocumentProfileKey } from './native-document-owner-identity';
import { INVENTORY_SCHEMA } from '@waypoint/domain-services';
import type { InventoryAcceptedRequest } from '../shared/inventory-command';

const sourcePath = process.env.INVENTORY_LEGACY_PROFILE_SOURCE;
it.runIf(Boolean(sourcePath))(
  'replays a captured legacy native profile without rewriting stored facts',
  () => {
    const source = JSON.parse(readFileSync(sourcePath!, 'utf8')) as {
      profile: string;
      databaseCopy: string;
      inventories: {
        inventoryId: string;
        revision: number;
        storedSchema: string;
        rawStateSha256: string;
      }[];
    };
    const db = openFileTestDb(source.databaseCopy);
    const raw = () => ({
      states: db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all(),
      journal: db.prepare('SELECT * FROM inventory_journal ORDER BY inventory_id,revision').all(),
    });
    try {
      const before = raw();
      const owner = createNativeInventoryOwner({
        db: () => db,
        projectAuthority: createRegisteredProjectAuthority({
          db: () => db,
          managedRootDir: () => join(source.profile, 'managed-workspaces'),
        }),
        actor: () => 'captured-legacy-profile-acceptance',
        profileKey: nativeDocumentProfileKey(source.profile),
      });
      owner.initialize();
      const retry = (request: InventoryAcceptedRequest) => {
        if (!('kind' in request)) return owner.execute(request);
        switch (request.kind) {
          case 'adopt-archive':
            return owner.applyImport(request);
          case 'receive-table':
            return owner.applyTable(request);
          case 'apply-stocktake':
            return owner.applyStocktake(request);
          case 'acknowledge-table-source':
            return owner.acknowledgeSource(request);
          case 'import-hierarchy':
            return owner.applyHierarchy(request);
          case 'receive-mapped-table':
            return owner.applyMappedTable(request);
          case 'receive-arrival':
            return owner.applyArrival(request);
          case 'import-benchling-capture':
            return owner.applyBenchlingCapture(request);
          default: {
            const unsupported: never = request;
            throw new Error(`Unsupported accepted inventory request: ${String(unsupported)}`);
          }
        }
      };
      const changes = db.prepare('SELECT total_changes() AS count').get();
      const evidence = source.inventories.map((inventory) => {
        const row = db
          .prepare('SELECT project_id,state_json FROM inventory_state WHERE inventory_id=?')
          .get(inventory.inventoryId) as { project_id: string; state_json: string };
        expect(createHash('sha256').update(row.state_json).digest('hex')).toBe(
          inventory.rawStateSha256
        );
        expect(JSON.parse(row.state_json).schema).toBe(inventory.storedSchema);
        const scope = { project: row.project_id, inventoryId: inventory.inventoryId };
        const state = owner.inspect(scope)!;
        expect(state.schema).toBe(INVENTORY_SCHEMA);
        expect(state.tableBindings).toEqual(
          Object.fromEntries(
            Object.entries(JSON.parse(row.state_json).tableBindings ?? {}).map(([key, value]) => [
              key,
              {
                ...(value as Record<string, unknown>),
                sourceRevisions: (value as Record<string, unknown>).sourceRevisions ?? [],
              },
            ])
          )
        );
        expect(state.observations).toEqual(
          Object.fromEntries(
            Object.entries(JSON.parse(row.state_json).observations ?? {}).map(([key, value]) => {
              const observation = value as {
                fact: { kind: string; quantity?: { kind: string; unit?: string } };
              };
              return [
                key,
                observation.fact.kind === 'quantity' &&
                observation.fact.quantity?.kind === 'unknown' &&
                observation.fact.quantity.unit === undefined
                  ? {
                      ...observation,
                      fact: {
                        ...observation.fact,
                        quantity: { ...observation.fact.quantity, unit: 'uL' },
                      },
                    }
                  : observation,
              ];
            })
          )
        );
        expect(state.lotRecalls).toEqual(JSON.parse(row.state_json).lotRecalls ?? {});
        expect(state.openingObservations).toEqual(
          JSON.parse(row.state_json).openingObservations ?? {}
        );
        expect(state.validityFacts).toEqual(JSON.parse(row.state_json).validityFacts ?? {});
        expect(state.arrivals).toEqual(JSON.parse(row.state_json).arrivals ?? {});
        for (const lot of Object.values(state.lots)) {
          const original = JSON.parse(row.state_json).lots[lot.id];
          expect(lot.controls).toEqual(original.controls ?? { kind: 'legacy-untracked' });
          if (original.lotConstraints) expect(lot.lotConstraints).toEqual(original.lotConstraints);
          else expect(lot.lotConstraints.knowledge).toBe('legacy-partial');
          expect(lot.validity).toEqual(original.validity ?? { kind: 'legacy-untracked' });
          expect(lot.inheritedValidity).toEqual(original.inheritedValidity ?? []);
          expect(lot.lotConstraints.lotIds).toContain(lot.id);
        }
        for (const [id, stock] of Object.entries(state.stocks)) {
          const original = JSON.parse(row.state_json).stocks[id];
          if (original.lotConstraints)
            expect(stock.lotConstraints).toEqual(original.lotConstraints);
          else expect(stock.lotConstraints.knowledge).toBe('legacy-partial');
          expect(stock.opening).toEqual(
            original.opening ?? { kind: 'unobserved', observationId: null }
          );
          expect(stock.validity).toEqual(original.validity ?? { kind: 'legacy-untracked' });
          expect(stock.inheritedValidity).toEqual(original.inheritedValidity ?? []);
          const saved = JSON.parse(row.state_json).stocks[id].quantity;
          expect(stock.quantity).toEqual(
            saved.kind === 'unknown' && saved.unit === undefined ? { ...saved, unit: 'uL' } : saved
          );
        }
        expect(state.vesselBindings).toEqual(JSON.parse(row.state_json).vesselBindings ?? {});
        for (const [id, vessel] of Object.entries(state.vessels))
          expect(vessel.contentsKnowledge).toEqual(
            JSON.parse(row.state_json).vessels[id].contentsKnowledge ?? { kind: 'recorded' }
          );
        expect(state.hierarchyBindings).toEqual(JSON.parse(row.state_json).hierarchyBindings ?? {});
        expect(state.revision).toBe(inventory.revision);
        expect(state.thermalContexts).toEqual(JSON.parse(row.state_json).thermalContexts ?? {});
        expect(state.origin).toEqual(JSON.parse(row.state_json).origin ?? { kind: 'native' });
        const history = owner.history({ ...scope, afterRevision: 0, limit: 1000 });
        expect(history.length).toBe(inventory.revision);
        const replay = owner.replay(scope);
        expect(replay).toEqual({ state, acceptedOperations: inventory.revision });
        for (const entry of history) {
          expect(owner.operation({ ...scope, operationId: entry.request.operationId })).toEqual(
            entry.receipt
          );
          expect(retry(entry.request)).toEqual(entry.receipt);
        }
        expect(raw()).toEqual(before);
        expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
        return {
          scope,
          storedSchema: inventory.storedSchema,
          state,
          history,
          replay,
          originalReceiptRetries: history.length,
        };
      });
      writeFileSync(
        join(dirname(sourcePath!), 'acceptance.json'),
        JSON.stringify(
          {
            schema: 'dnaforge.inventory-legacy-profile-acceptance.v1',
            status: 'passed',
            source,
            zeroSqlChanges: true,
            exactRawStateAndJournal: true,
            evidence,
          },
          null,
          2
        )
      );
    } finally {
      db.close();
    }
  }
);
