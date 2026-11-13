// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  deliverPendingMeaningfulActivityReceipts,
  meaningfulActivityPendingRetentionMs,
  storePendingMeaningfulActivityReceipt,
} from './meaningful-activity-pending';

const ACCOUNT_ID = '550e8400-e29b-41d4-a716-446655440001';
const ACTION_ID = '550e8400-e29b-41d4-a716-446655440002';
const APP_SESSION_ID = '550e8400-e29b-41d4-a716-446655440003';
const LATER_SESSION_ID = '550e8400-e29b-41d4-a716-446655440004';
const externalAuthority = {
  actorKind: 'external' as const,
  executionMode: 'interactive' as const,
  impersonated: false,
};

function memoryDatabase() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    async execute(sql: string, params: unknown[] = []) {
      if (sql.includes("SET upload_state = 'expired'")) {
        for (const row of rows) {
          if (row.upload_state === 'pending' && Number(row.expires_at_ms) < Number(params[0])) {
            row.upload_state = 'expired';
          }
        }
      } else if (sql.includes('INSERT OR IGNORE INTO meaningful_activity_pending')) {
        if (rows.some((row) => row.action_id === params[0])) return;
        rows.push({
          action_id: params[0],
          workflow: params[1],
          workflow_action: params[2],
          workflow_status: params[3],
          initiated_at_ms: params[4],
          qualified_at_ms: params[5],
          value_delivered: params[6],
          usable_result: params[7],
          selected_count: params[8],
          app_session_id: params[9],
          upload_state: 'pending',
          historical: 0,
          created_at_ms: params[10],
          expires_at_ms: params[11],
        });
      } else if (sql.includes("SET upload_state = 'sent'")) {
        const row = rows.find(
          (candidate) => candidate.action_id === params[4] && candidate.upload_state === 'pending'
        );
        if (row) {
          row.upload_state = 'sent';
          row.bound_account_id = params[0];
          row.identity_resolution = params[1];
          row.historical = params[2];
          row.sent_at_ms = params[3];
        }
      }
    },
    async select<T>(sql: string, params: unknown[] = []): Promise<T> {
      const now = Number(params[0]);
      const selected = rows.filter(
        (row) =>
          row.upload_state === 'pending' &&
          Number(row.expires_at_ms) >= now &&
          (!sql.includes('AND app_session_id = ?') || row.app_session_id === params[1])
      );
      return selected as T;
    },
  };
}

async function store(db: ReturnType<typeof memoryDatabase>, overrides = {}) {
  await storePendingMeaningfulActivityReceipt(
    {
      actionId: ACTION_ID,
      workflow: 'hosted_ai',
      action: 'complete',
      status: 'stopped',
      initiatedAtMs: 1_000,
      qualifiedAtMs: 2_000,
      valueDelivered: true,
      appSessionId: APP_SESSION_ID,
      ...overrides,
    },
    { db, now: () => 2_000 }
  );
}

describe('meaningful activity pending receipts', () => {
  it('binds a same-session receipt once and preserves the initiation timestamp', async () => {
    const db = memoryDatabase();
    await store(db);
    const emit = vi.fn(() => true);

    await expect(
      deliverPendingMeaningfulActivityReceipts({
        accountId: ACCOUNT_ID,
        appSessionId: APP_SESSION_ID,
        authority: externalAuthority,
        binding: 'same_session',
        emit,
        dependencies: { db, now: () => 3_000 },
      })
    ).resolves.toBe(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        action_id: ACTION_ID,
        initiated_at_ms: 1_000,
        qualified_at_ms: 2_000,
        historical: false,
        identity_resolution: 'direct_session',
        $insert_id: ACTION_ID,
      })
    );
    expect(db.rows[0]).toMatchObject({
      upload_state: 'sent',
      bound_account_id: ACCOUNT_ID,
    });
    await expect(
      deliverPendingMeaningfulActivityReceipts({
        accountId: ACCOUNT_ID,
        appSessionId: APP_SESSION_ID,
        authority: externalAuthority,
        binding: 'same_session',
        emit,
        dependencies: { db, now: () => 4_000 },
      })
    ).resolves.toBe(0);
  });

  it('requires explicit confirmation before binding older activity', async () => {
    const db = memoryDatabase();
    await store(db);
    const emit = vi.fn(() => true);
    const base = {
      accountId: ACCOUNT_ID,
      appSessionId: LATER_SESSION_ID,
      authority: externalAuthority,
      binding: 'explicit' as const,
      emit,
      dependencies: { db, now: () => 3_000 },
    };

    await expect(deliverPendingMeaningfulActivityReceipts(base)).resolves.toBe(0);
    await expect(
      deliverPendingMeaningfulActivityReceipts({ ...base, explicitConfirmation: true })
    ).resolves.toBe(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ historical: true, identity_resolution: 'linked_later' })
    );
  });

  it('delivers internal receipts labelled actor_kind=internal', async () => {
    const db = memoryDatabase();
    await store(db);
    const emit = vi.fn(() => true);
    await expect(
      deliverPendingMeaningfulActivityReceipts({
        accountId: ACCOUNT_ID,
        appSessionId: APP_SESSION_ID,
        authority: { ...externalAuthority, actorKind: 'internal' },
        binding: 'same_session',
        emit,
        dependencies: { db, now: () => 3_000 },
      })
    ).resolves.toBe(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ actor_kind: 'internal' }));
  });

  it('expires unbound receipts and rejects test or inferred identity', async () => {
    const db = memoryDatabase();
    await store(db);
    const emit = vi.fn(() => true);
    await expect(
      deliverPendingMeaningfulActivityReceipts({
        accountId: ACCOUNT_ID,
        appSessionId: APP_SESSION_ID,
        authority: { ...externalAuthority, actorKind: 'test' },
        binding: 'same_session',
        emit,
        dependencies: { db, now: () => 3_000 },
      })
    ).resolves.toBe(0);
    await expect(
      deliverPendingMeaningfulActivityReceipts({
        accountId: ACCOUNT_ID,
        appSessionId: APP_SESSION_ID,
        authority: externalAuthority,
        binding: 'same_session',
        emit,
        dependencies: { db, now: () => 2_000 + meaningfulActivityPendingRetentionMs + 1 },
      })
    ).resolves.toBe(0);
    expect(db.rows[0]?.upload_state).toBe('expired');
    await expect(
      deliverPendingMeaningfulActivityReceipts({
        accountId: 'installation-identity',
        appSessionId: APP_SESSION_ID,
        authority: externalAuthority,
        binding: 'same_session',
        emit,
        dependencies: { db, now: () => 3_000 },
      })
    ).resolves.toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });
});
