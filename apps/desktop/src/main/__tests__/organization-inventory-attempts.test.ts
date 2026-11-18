import type Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import {
  ORGANIZATION_INVENTORY_DISPOSITION_SCHEMA,
  ORGANIZATION_INVENTORY_REQUEST_SCHEMA,
  applyInventoryOrganizationAction,
  inventoryTableSha256,
  organizationInventoryCanonicalJson,
  organizationInventoryPlanDigest,
  organizationInventoryRequestSha256,
  organizationInventoryStateSha256,
  type InventoryOrganizationTarget,
  type OrganizationInventorySnapshotResponse,
} from '@waypoint/domain-services';
import { organizationBootstrap } from '../../../../../packages/core/domain-services/src/inventory-organization.fixtures';
import {
  createOrganizationInventoryAttemptTable,
  retainOrganizationInventoryAttempt,
  readOrganizationInventoryAttempt,
  readOrganizationInventoryAttemptForHandle,
  readBlockingOrganizationInventoryAttempt,
  markOrganizationInventoryAttemptMayHaveSent,
  recordOrganizationInventoryAttemptDisposition,
  confirmOrganizationInventoryAttemptProjection,
  OrganizationInventoryAttemptConflictError,
  type OrganizationInventoryActionEnvelope,
  type OrganizationInventoryActionDisposition,
  type OrganizationInventoryStoredAttempt,
} from '../organization-inventory-attempts';
import {
  createOrganizationInventoryProjectionTable,
  readOrganizationInventoryProjection,
  writeOrganizationInventoryProjection,
} from '../organization-inventory-cache';
import { createTestDb, createFileTestDb, openFileTestDb } from './test-db';

const accountId = '11111111-1111-4111-8111-111111111111';
const originalSession = '22222222-2222-4222-8222-222222222222';
const currentSession = '55555555-5555-4555-8555-555555555555';
const otherAccount = '66666666-6666-4666-8666-666666666666';
const target: InventoryOrganizationTarget = {
  kind: 'organization-inventory',
  orgId: '33333333-3333-4333-8333-333333333333',
  inventoryId: '44444444-4444-4444-8444-444444444444',
};
type Snapshot = Extract<OrganizationInventorySnapshotResponse, { kind: 'ready' }>;
const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) if (db.open) db.close();
});
function database() {
  const db = createTestDb();
  dbs.push(db);
  createOrganizationInventoryAttemptTable(db);
  createOrganizationInventoryProjectionTable(db);
  return db;
}
function snapshot(revision = 1, consumed = '1'): Snapshot {
  const context = {
    at: 1000,
    principal: { kind: 'organization-account' as const, orgId: target.orgId, accountId },
    authority: {
      kind: 'organization-inventory' as const,
      orgId: target.orgId,
      inventoryId: target.inventoryId,
      accountId,
    },
  };
  const created = applyInventoryOrganizationAction(null, {
    target,
    expectedRevision: 0,
    action: organizationBootstrap,
    context,
    admittedMaterialIds: ['material'],
  });
  if (!created.ok) throw Error(created.message);
  let state = created.state;
  for (let n = 1; n < revision; n++) {
    const used = applyInventoryOrganizationAction(state, {
      target,
      expectedRevision: state.revision,
      action: {
        kind: 'consume',
        stockId: 'stock',
        quantity: { value: consumed, unit: 'uL' },
        reason: 'Use',
      },
      context,
      admittedMaterialIds: [],
    });
    if (!used.ok) throw Error(used.message);
    state = used.state;
  }
  return {
    kind: 'ready',
    header: {
      accountId,
      target,
      permission: 'operate',
      canBootstrap: false,
      accessGeneration: 'generation-current',
      accessEpoch: 1,
      revision: state.revision,
      stateSha256: organizationInventoryStateSha256(state),
      asOf: 1000,
    },
    state,
  };
}
function request(operationId = 'operation-one'): OrganizationInventoryActionEnvelope {
  const action = {
    kind: 'consume' as const,
    stockId: 'stock',
    quantity: { value: '1', unit: 'uL' as const },
    reason: 'Use',
  };
  return {
    schema: ORGANIZATION_INVENTORY_REQUEST_SCHEMA,
    purpose: 'action',
    body: {
      target,
      operationId,
      clientId: 'desktop:original',
      expectedRevision: 1,
      accessGeneration: 'generation-original',
      action,
      expectedPlanDigest: organizationInventoryPlanDigest({
        target,
        expectedRevision: 1,
        accessGeneration: 'generation-original',
        action,
        beforeStateSha256: snapshot().header.stateSha256,
        materialAdmission: [],
      }),
    },
  };
}
function retain(db: Database.Database, envelope = request(), handle = 'handle-one') {
  return retainOrganizationInventoryAttempt(db, {
    accountId,
    originalDesktopSessionId: originalSession,
    previewHandleId: handle,
    request: envelope,
    at: 100,
  });
}
function accepted(
  attempt: OrganizationInventoryStoredAttempt
): OrganizationInventoryActionDisposition {
  return {
    schema: ORGANIZATION_INVENTORY_DISPOSITION_SCHEMA,
    kind: 'action-accepted',
    target,
    operationId: attempt.key.operationId,
    requestSha256: attempt.requestSha256,
    submitterAccountId: accountId,
    originClientId: attempt.request.body.clientId,
    baseRevision: 1,
    revision: 2,
    recordedAt: 1000,
    acceptedAt: 1001,
    stateSha256: snapshot(2).header.stateSha256,
    accessGenerationAtDecision: attempt.request.body.accessGeneration,
    planDigest: attempt.request.body.expectedPlanDigest,
  };
}
function refused(
  attempt: OrganizationInventoryStoredAttempt
): OrganizationInventoryActionDisposition {
  return {
    schema: ORGANIZATION_INVENTORY_DISPOSITION_SCHEMA,
    kind: 'action-refused',
    target,
    operationId: attempt.key.operationId,
    requestSha256: attempt.requestSha256,
    submitterAccountId: accountId,
    originClientId: attempt.request.body.clientId,
    code: 'REVISION_CONFLICT',
    message: 'Changed',
    currentRevision: 2,
    decidedAt: 1001,
    stateUntouched: true,
  };
}
function rows(db: Database.Database) {
  return db
    .prepare(
      'SELECT * FROM organization_inventory_attempt ORDER BY account_id, org_id, inventory_id, operation_id'
    )
    .all();
}
function project(db: Database.Database, value: Snapshot) {
  return writeOrganizationInventoryProjection(
    db,
    {
      accountId,
      desktopSessionId: currentSession,
      knownAccessTokenExpiresAt: 10000,
    },
    value
  );
}
function conflict(
  action: () => unknown,
  reason: OrganizationInventoryAttemptConflictError['reason']
) {
  expect(action).toThrow(
    expect.objectContaining({ code: 'ORGANIZATION_INVENTORY_ATTEMPT_CONFLICT', reason })
  );
}

it('requires explicit initialization and retains exact full request bytes and original metadata', () => {
  const db = createTestDb();
  dbs.push(db);
  expect(() => retain(db)).toThrow(/no such table/);
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name='organization_inventory_attempt'").get()
  ).toBeUndefined();
  createOrganizationInventoryAttemptTable(db);
  const raw = request();
  raw.body.action = {
    kind: 'consume',
    stockId: 'stock',
    quantity: { value: '1.0', unit: 'uL' },
    reason: 'Use',
  };
  const attempt = retain(db, raw);
  expect(attempt.requestText).toBe(organizationInventoryCanonicalJson(raw));
  expect(attempt.requestSha256).toBe(organizationInventoryRequestSha256(raw));
  expect(attempt.sendState).toBe('never-sent');
  const before = rows(db);
  expect(
    retainOrganizationInventoryAttempt(db, {
      accountId,
      originalDesktopSessionId: originalSession,
      previewHandleId: 'handle-one',
      request: raw,
      at: 999,
    })
  ).toEqual(attempt);
  const changed = structuredClone(raw);
  changed.body.action = {
    kind: 'consume',
    stockId: 'stock',
    quantity: { value: '1', unit: 'uL' },
    reason: 'Use',
  };
  conflict(() => retain(db, changed), 'operation-id');
  conflict(
    () => retain(db, { ...raw, body: { ...raw.body, accessGeneration: 'replacement-generation' } }),
    'operation-id'
  );
  conflict(
    () =>
      readOrganizationInventoryAttempt(db, {
        ...attempt.key,
        requestSha256: inventoryTableSha256('wrong'),
      }),
    'request-digest'
  );
  expect(rows(db)).toEqual(before);
});

it('keeps operation, consumed handle and unresolved target scopes distinct', () => {
  const db = database(),
    attempt = retain(db);
  expect(
    readOrganizationInventoryAttemptForHandle(db, {
      accountId,
      target,
      previewHandleId: 'handle-one',
    })
  ).toEqual(attempt);
  conflict(() => retain(db, request('other-operation'), 'other-handle'), 'unresolved-target');
  const elsewhere = request('elsewhere');
  elsewhere.body.target = { ...target, inventoryId: currentSession };
  conflict(() => retain(db, elsewhere), 'preview-handle');
  retain(db, elsewhere, 'elsewhere-handle');
  retainOrganizationInventoryAttempt(db, {
    accountId: otherAccount,
    originalDesktopSessionId: currentSession,
    previewHandleId: 'handle-one',
    request: request(),
    at: 101,
  });
  expect(rows(db)).toHaveLength(3);
  expect(
    readOrganizationInventoryAttempt(db, { ...attempt.key, accountId: currentSession })
  ).toBeNull();
  expect(
    readOrganizationInventoryAttemptForHandle(db, {
      accountId,
      target: elsewhere.body.target,
      previewHandleId: 'handle-one',
    })
  ).toBeNull();
  expect(readBlockingOrganizationInventoryAttempt(db, { accountId, target })).toEqual(attempt);
});

it('persists the may-have-sent claim before any terminal disposition without rewriting the request', () => {
  const db = database(),
    attempt = retain(db);
  expect(markOrganizationInventoryAttemptMayHaveSent(db, attempt.key).kind).toBe('claimed');
  expect(markOrganizationInventoryAttemptMayHaveSent(db, attempt.key).kind).toBe(
    'already-may-have-sent'
  );
  const terminal = recordOrganizationInventoryAttemptDisposition(db, attempt.key, refused(attempt));
  expect(terminal.sendState).toBe('may-have-sent');
  expect(terminal.requestText).toBe(attempt.requestText);
  expect(markOrganizationInventoryAttemptMayHaveSent(db, attempt.key)).toEqual({
    kind: 'terminal',
    attempt: terminal,
  });
  expect(readBlockingOrganizationInventoryAttempt(db, { accountId, target })).toBeNull();
  expect(() => confirmOrganizationInventoryAttemptProjection(db, attempt.key)).toThrow(
    /Only an accepted/
  );
  expect(retain(db, request('next'), 'next-handle').sendState).toBe('never-sent');
});

it('correlates and immutably records exact terminal outcomes independently of the original session', () => {
  const db = database(),
    attempt = retain(db),
    outcome = accepted(attempt);
  if (outcome.kind !== 'action-accepted') throw Error('acceptance');
  const before = rows(db);
  for (const patch of [
    { submitterAccountId: otherAccount },
    { originClientId: 'different-client' },
    { planDigest: inventoryTableSha256('wrong') },
    { baseRevision: 0, revision: 1 },
    { target: { ...target, inventoryId: currentSession } },
    { operationId: 'another' },
    { requestSha256: inventoryTableSha256('wrong') },
    { accessGenerationAtDecision: 'different' },
  ])
    conflict(
      () =>
        recordOrganizationInventoryAttemptDisposition(db, attempt.key, { ...outcome, ...patch }),
      'disposition'
    );
  expect(rows(db)).toEqual(before);
  const terminal = recordOrganizationInventoryAttemptDisposition(db, attempt.key, outcome);
  expect(terminal.sendState).toBe('never-sent');
  expect(terminal.originalDesktopSessionId).toBe(originalSession);
  expect(terminal.dispositionText).toBe(organizationInventoryCanonicalJson(outcome));
  expect(terminal.dispositionSha256).toBe(inventoryTableSha256(terminal.dispositionText!));
  expect(recordOrganizationInventoryAttemptDisposition(db, attempt.key, outcome)).toEqual(terminal);
  const persisted = rows(db);
  conflict(
    () =>
      recordOrganizationInventoryAttemptDisposition(db, attempt.key, {
        ...outcome,
        acceptedAt: 1002,
      }),
    'disposition'
  );
  conflict(
    () => recordOrganizationInventoryAttemptDisposition(db, attempt.key, refused(attempt)),
    'disposition'
  );
  expect(rows(db)).toEqual(persisted);
  expect(readOrganizationInventoryAttempt(db, attempt.key)).toEqual(terminal);
});

it('blocks accepted undelivered work until the actual validated projection confirms it', () => {
  const db = database(),
    attempt = retain(db);
  recordOrganizationInventoryAttemptDisposition(db, attempt.key, accepted(attempt));
  conflict(() => retain(db, request('next'), 'next-handle'), 'unresolved-target');
  const before = rows(db);
  expect(confirmOrganizationInventoryAttemptProjection(db, attempt.key).kind).toBe('pending');
  project(db, snapshot());
  expect(confirmOrganizationInventoryAttemptProjection(db, attempt.key).kind).toBe('pending');
  expect(rows(db)).toEqual(before);
  project(db, snapshot(2));
  const confirmed = confirmOrganizationInventoryAttemptProjection(db, attempt.key);
  expect(confirmed.kind).toBe('confirmed');
  expect(confirmed.attempt.projectionConfirmedRevision).toBe(2);
  expect(readOrganizationInventoryProjection(db, accountId, target)?.session.desktopSessionId).toBe(
    currentSession
  );
  expect(confirmed.attempt.originalDesktopSessionId).toBe(originalSession);
  expect(readBlockingOrganizationInventoryAttempt(db, { accountId, target })).toBeNull();
  project(db, snapshot(3));
  expect(
    confirmOrganizationInventoryAttemptProjection(db, attempt.key).attempt
      .projectionConfirmedRevision
  ).toBe(3);
  const delivered = rows(db);
  db.exec('DELETE FROM organization_inventory_projection');
  expect(confirmOrganizationInventoryAttemptProjection(db, attempt.key).kind).toBe('pending');
  expect(rows(db)).toEqual(delivered);
  expect(readBlockingOrganizationInventoryAttempt(db, { accountId, target })).toBeNull();
  expect(retain(db, request('next'), 'next-handle').sendState).toBe('never-sent');
});

it('rejects a different validated state at the accepted revision and preserves exact rows across file reopen', () => {
  const file = createFileTestDb('organization-inventory-attempts');
  let reopened: Database.Database | undefined;
  try {
    createOrganizationInventoryAttemptTable(file.db);
    createOrganizationInventoryProjectionTable(file.db);
    const attempt = retain(file.db);
    markOrganizationInventoryAttemptMayHaveSent(file.db, attempt.key);
    const before = rows(file.db);
    file.db.close();
    reopened = openFileTestDb(file.dbPath);
    expect(rows(reopened)).toEqual(before);
    expect(
      readBlockingOrganizationInventoryAttempt(reopened, { accountId, target })?.sendState
    ).toBe('may-have-sent');
    const outcome = accepted(attempt);
    recordOrganizationInventoryAttemptDisposition(reopened, attempt.key, outcome);
    const wrong = snapshot(2, '2');
    project(reopened, wrong);
    const acceptedRows = rows(reopened);
    conflict(
      () => confirmOrganizationInventoryAttemptProjection(reopened!, attempt.key),
      'projection'
    );
    expect(rows(reopened)).toEqual(acceptedRows);
    reopened.close();
    reopened = openFileTestDb(file.dbPath);
    expect(rows(reopened)).toEqual(acceptedRows);
    expect(readOrganizationInventoryAttempt(reopened, attempt.key)?.disposition).toEqual(outcome);
  } finally {
    reopened?.close();
    file.cleanup();
  }
});
