import { seedOriginalProjectFixture } from './original-project-fixture';
import Database from 'better-sqlite3';
import { setImmediate as yieldToRunner } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema } from '../schema';
import {
  applyLimsImportBatchInDb,
  archiveLimsEntityInDb,
  linkLimsEntitiesInDb,
  queryLimsEntitiesInDb,
  registerLimsEntityInDb,
  restoreLimsEntityInDb,
  undoLimsImportBatchInDb,
  updateLimsEntityInDb,
} from '../lims';
import {
  assertLimsProjectionReplayParityInDb,
  rebuildLimsProjectionInDb,
} from '../lims-projection-rebuild';
import { createTestDb } from './test-db';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  seedOriginalProjectFixture(db);
});

afterEach(() => {
  db.close();
});

describe(' registry longevity replay harness', () => {
  it('keeps projection byte-parity across a seeded mutation stream', async () => {
    const operations = Number.parseInt(process.env.LIMS_REGISTRY_LONGEVITY_EVENTS ?? '1000', 10);
    const rng = mulberry32(0xd0a951);
    const entityIds: string[] = [];

    for (let i = 0; i < operations; i++) {
      if (i % 25 === 0) await yieldToRunner();
      const choice = Math.floor(rng() * 6);
      if (entityIds.length < 2 || choice === 0) {
        const id = `longevity-oligo-${i}`;
        registerLimsEntityInDb(db, {
          id,
          kind: 'oligo',
          name: `Longevity oligo ${i}`,
          fields: {
            sequence: {
              mode: 'inline',
              bases: basesFor(i),
              topology: 'linear',
              length: 24,
            },
            use: 'primer',
            note: i % 5 === 0 ? null : `seed ${i}`,
          },
        });
        entityIds.push(id);
      } else if (choice === 1) {
        const id = pick(entityIds, rng);
        updateLimsEntityInDb(db, {
          id,
          fields: { note: i % 3 === 0 ? null : `updated ${i}` },
        });
      } else if (choice === 2) {
        const id = pick(entityIds, rng);
        archiveLimsEntityInDb(db, { id });
        if (i % 2 === 0) restoreLimsEntityInDb(db, { id });
      } else if (choice === 3) {
        const [from, to] = pickPair(entityIds, rng);
        restoreIfArchived(from);
        restoreIfArchived(to);
        linkLimsEntitiesInDb(db, {
          fromEntityId: from,
          toEntityId: to,
          type: 'associated_with',
          payload: { role: 'longevity', nullable: i % 4 === 0 ? null : `op-${i}` },
        });
      } else if (choice === 4) {
        const target = pick(entityIds, rng);
        restoreIfArchived(target);
        const batchId = `longevity-import-${i}`;
        applyLimsImportBatchInDb(db, {
          batchId,
          sourceName: `longevity-${i}.csv`,
          sourceKind: 'csv',
          records: [
            {
              id: `row-${i}`,
              action: 'register_entity',
              accepted: true,
              entity: {
                id: `longevity-imported-${i}`,
                kind: 'oligo',
                name: `Imported longevity ${i}`,
                fields: {
                  sequence: {
                    mode: 'inline',
                    bases: basesFor(i + 10_000),
                    topology: 'linear',
                    length: 24,
                  },
                  use: 'primer',
                },
              },
              links: [
                {
                  type: 'associated_with',
                  toEntityId: target,
                  payload: { role: 'target', nullable: null },
                },
              ],
              source: { nullable: null },
            },
          ],
        });
        undoLimsImportBatchInDb(db, { batchId });
        restoreLimsEntityInDb(db, { id: `longevity-imported-${i}` });
        linkLimsEntitiesInDb(db, {
          fromEntityId: `longevity-imported-${i}`,
          toEntityId: target,
          type: 'associated_with',
          payload: { role: 'target', nullable: null },
        });
        entityIds.push(`longevity-imported-${i}`);
      } else {
        assertLimsProjectionReplayParityInDb(db);
      }

      if (i > 0 && i % 100 === 0) {
        expect(assertLimsProjectionReplayParityInDb(db).appliedEvents).toBeGreaterThan(0);
      }
    }

    expect(rebuildLimsProjectionInDb(db).appliedEvents).toBeGreaterThan(0);
    expect(assertLimsProjectionReplayParityInDb(db).appliedEvents).toBeGreaterThan(0);
    expect(queryLimsEntitiesInDb(db, { includeArchived: true, limit: 100_000 }).length).toBe(
      entityIds.length
    );
  }, 180_000);
});

function restoreIfArchived(id: string): void {
  const entity = queryLimsEntitiesInDb(db, { id, includeArchived: true })[0];
  if (entity?.tombstone) restoreLimsEntityInDb(db, { id });
}

function pick(values: readonly string[], rng: () => number): string {
  return values[Math.floor(rng() * values.length)];
}

function pickPair(values: readonly string[], rng: () => number): [string, string] {
  const from = pick(values, rng);
  let to = pick(values, rng);
  while (to === from) to = pick(values, rng);
  return [from, to];
}

function basesFor(seed: number): string {
  const alphabet = 'ACGT';
  let value = BigInt(seed + 1);
  let bases = '';
  for (let i = 0; i < 24; i++) {
    bases = alphabet[Number(value & 3n)] + bases;
    value >>= 2n;
  }
  return bases;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
