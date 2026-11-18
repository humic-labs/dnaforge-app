import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', isPackaged: false, getPath: () => '/tmp' },
  dialog: { showErrorBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));
vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn() }));

import {
  ORGANIZATION_INVENTORY_REQUEST_SCHEMA,
  ORGANIZATION_INVENTORY_RESPONSE_MAX_BYTES,
  assertOrganizationInventoryResponse,
  organizationInventoryCanonicalJson,
  organizationInventoryRequestSha256,
  parseOrganizationInventoryRequestEnvelope,
  parseOrganizationInventoryResponseEnvelope,
  type InventoryOrganizationAction,
  type InventoryOrganizationTarget,
  type OrganizationInventoryRequestEnvelope,
} from '@waypoint/domain-services';
import type { StoredSession } from '../auth/session-store';
import { createDesktopSyncClient } from '../desktop-sync-client';
import {
  createOrganizationInventoryClient,
  type OrganizationInventoryHttpClient,
} from '../organization-inventory-client';
import { createOrganizationInventoryOwner } from '../organization-inventory-owner';
import {
  createOrganizationInventoryProjectionTable,
  readOrganizationInventoryProjection,
} from '../organization-inventory-cache';
import {
  readOrganizationInventoryAttemptForHandle,
  readOrganizationInventoryAttempt,
} from '../organization-inventory-attempts';
import { ensureSchema } from '../schema';
import { createFileTestDb, openFileTestDb } from './test-db';

interface NativeInventoryAcceptanceFixture {
  baseUrl: string;
  orgId: string;
  materialId: string;
  admin: StoredSession;
  operator: StoredSession;
}

function loadFixture(path: string): NativeInventoryAcceptanceFixture {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('The Native inventory acceptance fixture could not be read as JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('A Native inventory acceptance fixture object is required.');
  const fixture = value as NativeInventoryAcceptanceFixture;
  if (
    typeof fixture.baseUrl !== 'string' ||
    typeof fixture.orgId !== 'string' ||
    typeof fixture.materialId !== 'string'
  )
    throw new Error('The fixture requires baseUrl, orgId and materialId.');
  const url = new URL(fixture.baseUrl);
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol))
    throw new Error('The fixture base URL must be an HTTP origin without credentials.');
  for (const session of [fixture.admin, fixture.operator]) {
    if (
      !session ||
      typeof session.accountId !== 'string' ||
      typeof session.desktopSessionId !== 'string' ||
      typeof session.accessToken !== 'string' ||
      !session.accessToken ||
      typeof session.refreshToken !== 'string' ||
      !session.refreshToken ||
      !Number.isFinite(Date.parse(session.accessTokenExpiresAt)) ||
      Date.parse(session.accessTokenExpiresAt) <= Date.now() + 5 * 60 * 1000
    )
      throw new Error('Both fixture accounts need actual issued sessions with current tokens.');
  }
  if (
    fixture.admin.accountId === fixture.operator.accountId ||
    fixture.admin.desktopSessionId === fixture.operator.desktopSessionId
  )
    throw new Error('Two independent issued account/session identities are required.');
  return fixture;
}

function externalEvidenceDirectory(path: string): string {
  const repository = realpathSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
  );
  const requested = resolve(path);
  const outside = (candidate: string) => {
    const suffix = relative(repository, candidate);
    return suffix === '..' || suffix.startsWith('../');
  };
  if (!outside(requested)) throw new Error('Acceptance evidence must stay outside the repository.');
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const actual = realpathSync(requested);
  if (!outside(actual)) throw new Error('Acceptance evidence resolves inside the repository.');
  chmodSync(actual, 0o700);
  return actual;
}

const enabled = Boolean(process.env.DNAFORGE_INVENTORY_NATIVE_FIXTURE);

async function runNativeInventoryAcceptance(submit: boolean) {
  const fixture = loadFixture(process.env.DNAFORGE_INVENTORY_NATIVE_FIXTURE!);
  const evidenceRoot = process.env.DNAFORGE_INVENTORY_NATIVE_EVIDENCE_DIR;
  if (!evidenceRoot) throw new Error('DNAFORGE_INVENTORY_NATIVE_EVIDENCE_DIR is required.');
  const root = externalEvidenceDirectory(evidenceRoot);
  const evidence = mkdtempSync(join(root, submit ? 'native-submission-' : 'native-preview-'));
  chmodSync(evidence, 0o700);
  const secrets = [fixture.admin, fixture.operator].flatMap((session) => [
    session.accessToken,
    session.refreshToken,
  ]);
  const sanitized = (text: string) =>
    secrets.reduce((value, secret) => value.split(secret).join('[redacted]'), text);
  const save = (name: string, value: unknown) => {
    const path = join(evidence, name);
    writeFileSync(path, sanitized(`${JSON.stringify(value, null, 2)}\n`), {
      encoding: 'utf8',
      mode: 0o600,
    });
    chmodSync(path, 0o600);
  };
  let stage = 'create-request';
  let target: InventoryOrganizationTarget | null = null;
  let name = `Shared inventory ${new Date().toISOString()}`;
  const physical = {
    storageId: `rack:${randomUUID()}`,
    sourceVesselId: `tube:${randomUUID()}`,
    emptyVesselId: `tube:${randomUUID()}`,
    stockId: `stock:${randomUUID()}`,
    freeSlot: 'C',
  };
  const acceptedPrefixes: Array<{ purpose: string; requestSha256: string; response: unknown }> = [];
  const locate = () => {
    const value = { target, name, physical, stage, evidenceDirectory: evidence };
    save('target.json', value);
    const temporary = join(root, `target-${randomUUID()}.json`);
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, join(root, 'target.json'));
    chmodSync(join(root, 'target.json'), 0o600);
  };
  const makeTransport = (session: StoredSession) =>
    createDesktopSyncClient({
      baseUrl: fixture.baseUrl,
      getActiveStoredSession: async () => session,
      performRefresh: async () => {
        throw new Error('Fixture authentication expired; refresh is outside this acceptance.');
      },
    });
  const transportA = makeTransport(fixture.admin);
  const transportB = makeTransport(fixture.operator);
  const clientA = createOrganizationInventoryClient(transportA);
  const clientB = createOrganizationInventoryClient(transportB);
  const path = (suffix = '') =>
    `/api/desktop-sync/organizations/${encodeURIComponent(fixture.orgId)}/inventories/v1${suffix}`;
  let sequence = 0;
  const retainRequest = (label: string, input: OrganizationInventoryRequestEnvelope) => {
    const request = parseOrganizationInventoryRequestEnvelope(input);
    const requestText = organizationInventoryCanonicalJson(request);
    const requestSha256 = organizationInventoryRequestSha256(request);
    save(`${String(++sequence).padStart(2, '0')}-${label}-request.json`, {
      request,
      requestText,
      requestSha256,
    });
    return { request, requestSha256 };
  };
  const send = async (
    label: string,
    suffix: string,
    input: OrganizationInventoryRequestEnvelope
  ) => {
    const retained = retainRequest(label, input);
    const raw = await transportA.requestJson<unknown>(path(suffix), {
      method: 'POST',
      body: retained.request,
      expectedAccountId: fixture.admin.accountId,
      expectedDesktopSessionId: fixture.admin.desktopSessionId,
      maxResponseBytes: ORGANIZATION_INVENTORY_RESPONSE_MAX_BYTES,
      ...('operationId' in retained.request.body
        ? { idempotencyKey: retained.request.body.operationId }
        : {}),
    });
    const response = parseOrganizationInventoryResponseEnvelope(raw);
    save(`${String(sequence).padStart(2, '0')}-${label}-response.json`, response);
    assertOrganizationInventoryResponse(retained.request, response);
    if (
      'disposition' in response.result &&
      ['inventory-created', 'access-set', 'action-accepted'].includes(
        response.result.disposition.kind
      )
    ) {
      acceptedPrefixes.push({
        purpose: response.purpose,
        requestSha256: retained.requestSha256,
        response,
      });
      save('accepted-prefixes.json', acceptedPrefixes);
    }
    return response;
  };
  const sessionPins = (session: StoredSession) => ({
    accountId: session.accountId,
    desktopSessionId: session.desktopSessionId,
  });
  const snapshotA = async () => {
    if (!target) throw new Error('The server has not issued an inventory target.');
    const snapshot = await clientA.readSnapshot({ ...sessionPins(fixture.admin), target });
    if (snapshot.kind !== 'ready') throw new Error(`Snapshot unavailable: ${snapshot.code}`);
    return snapshot;
  };
  const eventsA = async (atRevision = 1) => {
    if (!target) throw new Error('The server has not issued an inventory target.');
    const raw = await transportA.requestJson<unknown>(
      path(
        `/${encodeURIComponent(target.inventoryId)}/events?afterRevision=0&atRevision=${atRevision}&limit=10`
      ),
      {
        method: 'GET',
        expectedAccountId: fixture.admin.accountId,
        expectedDesktopSessionId: fixture.admin.desktopSessionId,
        maxResponseBytes: ORGANIZATION_INVENTORY_RESPONSE_MAX_BYTES,
      }
    );
    const response = parseOrganizationInventoryResponseEnvelope(raw);
    if (response.purpose !== 'events' || response.result.kind !== 'ready')
      throw new Error('The server did not provide the complete accepted event page.');
    return response.result;
  };
  const clientId = `desktop:${randomUUID()}`;
  const files: ReturnType<typeof createFileTestDb>[] = [];
  const owners: ReturnType<typeof createOrganizationInventoryOwner>[] = [];
  const reopened: Database.Database[] = [];
  try {
    const created = await send('create', '', {
      schema: ORGANIZATION_INVENTORY_REQUEST_SCHEMA,
      purpose: 'create',
      body: { orgId: fixture.orgId, operationId: randomUUID(), clientId, name },
    });
    if (
      created.purpose !== 'create' ||
      created.result.kind !== 'decided' ||
      created.result.disposition.kind !== 'inventory-created'
    )
      throw new Error('Inventory creation did not return its original accepted disposition.');
    target = {
      kind: 'organization-inventory',
      orgId: fixture.orgId,
      inventoryId: created.result.disposition.inventoryId,
    };
    stage = 'created';
    locate();
    const directory = await clientA.listDirectory({
      ...sessionPins(fixture.admin),
      orgId: fixture.orgId,
    });
    if (directory.kind !== 'ready')
      throw new Error('The created inventory directory is unavailable.');
    const entry = directory.entries.find(
      (item) => item.header.target.inventoryId === target!.inventoryId
    );
    if (!entry) throw new Error('The normal directory does not contain the issued inventory.');
    name = entry.name;
    save('created-directory.json', directory);
    locate();
    const empty = await snapshotA();
    const granted = await send('grant-operator', `/${target.inventoryId}/access`, {
      schema: ORGANIZATION_INVENTORY_REQUEST_SCHEMA,
      purpose: 'access',
      body: {
        target,
        operationId: randomUUID(),
        clientId,
        accessGeneration: empty.header.accessGeneration,
        expectedAccessEpoch: empty.header.accessEpoch,
        subjectAccountId: fixture.operator.accountId,
        role: 'operator',
      },
    });
    if (
      granted.purpose !== 'access' ||
      granted.result.kind !== 'decided' ||
      granted.result.disposition.kind !== 'access-set'
    )
      throw new Error('The actual operator grant was not accepted.');
    stage = 'operator-granted';
    locate();
    const initial = await snapshotA();
    const action: InventoryOrganizationAction = {
      kind: 'bootstrap',
      reason: 'Record the initial lab stock',
      storage: [
        {
          kind: 'create-layout-storage',
          id: physical.storageId,
          name: 'Rack',
          layout: { kind: 'named', slots: ['A', 'B', 'C'] },
          placement: { kind: 'root' },
        },
      ],
      vessels: [
        {
          kind: 'create-vessel',
          id: physical.sourceVesselId,
          name: 'Source tube',
          placement: { kind: 'located', storageId: physical.storageId, slotId: 'A' },
        },
        {
          kind: 'create-vessel',
          id: physical.emptyVesselId,
          name: 'Empty tube',
          placement: { kind: 'located', storageId: physical.storageId, slotId: 'B' },
        },
      ],
      stocks: [
        {
          id: physical.stockId,
          vesselId: physical.sourceVesselId,
          materialId: fixture.materialId,
          quantity: { value: '10', unit: 'uL' },
          quality: 'usable',
        },
      ],
    };
    const previewBody = {
      target,
      expectedRevision: initial.header.revision,
      accessGeneration: initial.header.accessGeneration,
      action,
    };
    const planned = await send('bootstrap-preview', `/${target.inventoryId}/preview`, {
      schema: ORGANIZATION_INVENTORY_REQUEST_SCHEMA,
      purpose: 'preview',
      body: previewBody,
    });
    if (planned.purpose !== 'preview' || planned.result.kind !== 'ready')
      throw new Error('Initial stock preview was not ready.');
    const bootstrapped = await send('bootstrap', `/${target.inventoryId}/actions`, {
      schema: ORGANIZATION_INVENTORY_REQUEST_SCHEMA,
      purpose: 'action',
      body: {
        ...previewBody,
        operationId: randomUUID(),
        clientId,
        expectedPlanDigest: planned.result.planDigest,
      },
    });
    if (
      bootstrapped.purpose !== 'action' ||
      bootstrapped.result.kind !== 'decided' ||
      bootstrapped.result.disposition.kind !== 'action-accepted'
    )
      throw new Error('Initial stock was not accepted.');
    stage = 'bootstrapped';
    locate();
    const beforeEvents = await eventsA();
    save('events-before-native-preview.json', beforeEvents);
    const accounts = [fixture.admin, fixture.operator];
    const clients = [clientA, clientB];
    const callers = [{}, {}];
    let submittedHttpCount = 0;
    for (let index = 0; index < accounts.length; index++) {
      const file = createFileTestDb(`organization-inventory-native-${index}`);
      files.push(file);
      if (submit) ensureSchema(file.db, file.dbPath);
      else createOrganizationInventoryProjectionTable(file.db);
      const originalClient = clients[index];
      const client: OrganizationInventoryHttpClient =
        submit && index === 0
          ? {
              ...originalClient,
              async applyAction(input) {
                submittedHttpCount++;
                const stored = file.db
                  .prepare('SELECT * FROM organization_inventory_attempt')
                  .all();
                save('attempt-before-http.json', stored);
                const retained = retainRequest('native-submit', input.request);
                expect(stored).toHaveLength(1);
                expect(stored[0]).toMatchObject({
                  request_text: organizationInventoryCanonicalJson(input.request),
                  request_sha256: retained.requestSha256,
                  original_desktop_session_id: fixture.admin.desktopSessionId,
                  send_state: 'may-have-sent',
                  disposition_text: null,
                });
                const response = await originalClient.applyAction(input);
                save('native-submit-http-response.json', response);
                if (
                  response.kind === 'decided' &&
                  response.disposition.kind === 'action-accepted'
                ) {
                  acceptedPrefixes.push({
                    purpose: 'action',
                    requestSha256: retained.requestSha256,
                    response,
                  });
                  save('accepted-prefixes.json', acceptedPrefixes);
                }
                return response;
              },
            }
          : originalClient;
      owners.push(
        createOrganizationInventoryOwner({
          db: file.db,
          client,
          getActiveSession: async () => accounts[index],
          refreshSession: async () => {
            throw new Error('Fixture refresh is not permitted.');
          },
        })
      );
    }
    const directories = await Promise.all(
      owners.map((owner, index) =>
        owner.organizationDirectory(
          {
            expectedAccountId: accounts[index].accountId,
            expectedDesktopSessionId: accounts[index].desktopSessionId,
            orgId: fixture.orgId,
          },
          () => {},
          callers[index]
        )
      )
    );
    directories.forEach((read, index) => {
      expect(read.kind).toBe('ready');
      if (read.kind !== 'ready') throw new Error(`Native directory unavailable: ${read.code}`);
      expect(
        read.directory.entries.some(
          (item) => item.name === name && item.header.target.inventoryId === target!.inventoryId
        )
      ).toBe(true);
      save(`directory-${index}.json`, read);
    });
    const reads = await Promise.all(
      owners.map((owner, index) =>
        owner.organizationSnapshot(
          {
            expectedAccountId: accounts[index].accountId,
            expectedDesktopSessionId: accounts[index].desktopSessionId,
            target: target!,
          },
          () => {},
          callers[index]
        )
      )
    );
    const confirmed = reads.map((read, index) => {
      expect(read.kind).toBe('current');
      if (read.kind !== 'current')
        throw new Error('Native did not return a complete current snapshot.');
      expect(read.snapshot.header.accountId).toBe(accounts[index].accountId);
      expect(read.snapshot.state.revision).toBe(1);
      expect(read.snapshot.state.stocks[physical.stockId].quantity).toEqual({
        kind: 'known',
        value: '10',
        unit: 'uL',
      });
      save(`snapshot-${index}.json`, read);
      return read;
    });
    expect(confirmed[0].snapshot.state).toEqual(confirmed[1].snapshot.state);
    const rows = (db: Database.Database) =>
      db
        .prepare(
          'SELECT * FROM organization_inventory_projection ORDER BY account_id,org_id,inventory_id'
        )
        .all();
    const beforeCaches = files.map((file) => rows(file.db));
    const previews = await Promise.all(
      owners.map((owner, index) => {
        const body = {
          target: target!,
          expectedRevision: 1,
          accessGeneration: confirmed[index].binding.accessGeneration,
          action: {
            kind: 'consume' as const,
            stockId: physical.stockId,
            quantity: { value: '7', unit: 'uL' as const },
            reason: 'Preview reported use',
          },
        };
        retainRequest(`native-preview-${index}`, {
          schema: ORGANIZATION_INVENTORY_REQUEST_SCHEMA,
          purpose: 'preview',
          body,
        });
        return owner.organizationPreview(
          { binding: confirmed[index].binding, request: body },
          () => {},
          callers[index]
        );
      })
    );
    previews.forEach((preview, index) => {
      expect(preview.kind).toBe('ready');
      if (preview.kind !== 'ready') throw new Error(`Native preview unavailable: ${preview.kind}`);
      expect(preview.previewHandleId).toMatch(/^[a-f0-9-]{36}$/);
      expect(preview.preview.proposed.state.stocks[physical.stockId].quantity).toEqual({
        kind: 'known',
        value: '3',
        unit: 'uL',
      });
      expect(rows(files[index].db)).toEqual(beforeCaches[index]);
      expect(
        readOrganizationInventoryProjection(files[index].db, accounts[index].accountId, target!)
          ?.snapshot.state
      ).toEqual(confirmed[index].snapshot.state);
      save(`preview-${index}.json`, preview);
    });
    const after = await snapshotA();
    const afterEvents = await eventsA();
    expect(after.header.revision).toBe(1);
    expect(after.state).toEqual(confirmed[0].snapshot.state);
    expect(beforeEvents.events).toHaveLength(1);
    expect(afterEvents.events).toEqual(beforeEvents.events);
    expect(afterEvents.header.revision).toBe(1);
    expect(acceptedPrefixes.map((prefix) => prefix.purpose)).toEqual([
      'create',
      'access',
      'action',
    ]);
    save('server-after-native-preview.json', { snapshot: after, events: afterEvents });
    let finalCaches = beforeCaches;
    let finalSnapshots = confirmed.map((read) => read.snapshot);
    const attemptRows = (db: Database.Database) =>
      db
        .prepare(
          'SELECT * FROM organization_inventory_attempt ORDER BY account_id,org_id,inventory_id,operation_id'
        )
        .all();
    let finalAttempts: unknown[][] = [];
    if (submit) {
      const preview = previews[0];
      if (preview.kind !== 'ready') throw new Error('The original Native preview is not ready.');
      const originalReadyHandle = preview.previewHandleId;
      const independentCaller = {};
      const independentReadRequest = {
        expectedAccountId: fixture.admin.accountId,
        expectedDesktopSessionId: fixture.admin.desktopSessionId,
        target,
      };
      save('native-independent-caller-read-before-submit-input.json', {
        request: independentReadRequest,
        originalReadyHandle,
      });
      stage = 'native-independent-caller-read-before-submit';
      locate();
      const independent = await owners[0].organizationSnapshot(
        independentReadRequest,
        () => {},
        independentCaller
      );
      save('native-independent-caller-read-before-submit-result.json', independent);
      if (independent.kind !== 'current')
        throw new Error('The independent caller did not receive a complete current snapshot.');
      expect(independent.snapshot.header.stateSha256).toBe(preview.preview.header.stateSha256);
      expect(independent.snapshot.header.revision).toBe(preview.preview.header.revision);
      expect(independent.snapshot.header.accessGeneration).toBe(preview.binding.accessGeneration);
      expect(independent.snapshot.state).toEqual(confirmed[0].snapshot.state);
      const submission = {
        expectedAccountId: fixture.admin.accountId,
        expectedDesktopSessionId: fixture.admin.desktopSessionId,
        target,
        previewHandleId: originalReadyHandle,
      };
      save('native-submit-input.json', submission);
      stage = 'native-submit';
      locate();
      const submitted = await owners[0].organizationSubmit(submission, () => {}, callers[0]);
      save('native-submit-result.json', submitted);
      if (submitted.kind !== 'accepted')
        throw new Error(`Native submission was not accepted: ${submitted.kind}`);
      const original = readOrganizationInventoryAttemptForHandle(files[0].db, {
        accountId: fixture.admin.accountId,
        target,
        previewHandleId: preview.previewHandleId,
      });
      expect(original).not.toBeNull();
      if (!original) throw new Error('Native submission was not durably retained.');
      expect(original.request).toEqual(submitted.attempt.request);
      expect(original.requestSha256).toBe(submitted.attempt.requestSha256);
      expect(original.disposition).toEqual(submitted.disposition);
      expect(original.sendState).toBe('may-have-sent');
      expect(original.originalDesktopSessionId).toBe(fixture.admin.desktopSessionId);
      expect(original.projectionConfirmedRevision).toBe(2);
      expect(submitted.disposition.submitterAccountId).toBe(fixture.admin.accountId);
      expect(submitted.disposition.baseRevision).toBe(1);
      expect(submitted.disposition.revision).toBe(2);
      expect(submitted.delivery).toEqual({ kind: 'current', confirmedRevision: 2 });
      expect(original.request.body.clientId).toBe(
        files[0].db.prepare('SELECT device_id FROM workspace_sync_device WHERE id=1').pluck().get()
      );
      const beforeDuplicate = attemptRows(files[0].db);
      save('attempt-after-submit.json', beforeDuplicate);
      const duplicate = await owners[0].organizationSubmit(submission, () => {}, callers[0]);
      save('native-duplicate-submit-result.json', duplicate);
      if (duplicate.kind !== 'accepted')
        throw new Error(`Duplicate Native submission lost its original outcome: ${duplicate.kind}`);
      expect(duplicate.attempt).toEqual(submitted.attempt);
      expect(duplicate.disposition).toEqual(submitted.disposition);
      expect(duplicate.delivery).toEqual({ kind: 'current', confirmedRevision: 2 });
      expect(attemptRows(files[0].db)).toEqual(beforeDuplicate);
      expect(submittedHttpCount).toBe(1);
      const readB = await owners[1].organizationSnapshot(
        {
          expectedAccountId: fixture.operator.accountId,
          expectedDesktopSessionId: fixture.operator.desktopSessionId,
          target,
        },
        () => {},
        callers[1]
      );
      save('snapshot-operator-after-submit.json', readB);
      if (readB.kind !== 'current') throw new Error('The second Native client is not current.');
      const afterSubmit = await snapshotA();
      const afterSubmitEvents = await eventsA(2);
      save('server-after-native-submit.json', { snapshot: afterSubmit, events: afterSubmitEvents });
      expect(afterSubmit.header.revision).toBe(2);
      expect(afterSubmit.state.stocks[physical.stockId].quantity).toEqual({
        kind: 'known',
        value: '3',
        unit: 'uL',
      });
      expect(readB.snapshot.state).toEqual(afterSubmit.state);
      expect(afterSubmitEvents.header.revision).toBe(2);
      expect(afterSubmitEvents.events).toHaveLength(2);
      expect(afterSubmitEvents.events[0]).toEqual(beforeEvents.events[0]);
      expect(afterSubmitEvents.events[1].request).toEqual(original.request);
      expect(afterSubmitEvents.events[1].requestSha256).toBe(original.requestSha256);
      expect(afterSubmitEvents.events[1].receipt).toEqual(original.disposition);
      finalSnapshots = accounts.map((account, index) => {
        const projection = readOrganizationInventoryProjection(
          files[index].db,
          account.accountId,
          target!
        );
        if (!projection) throw new Error('A complete Native projection is missing after delivery.');
        expect(projection.snapshot.header.revision).toBe(2);
        expect(projection.snapshot.state).toEqual(afterSubmit.state);
        return projection.snapshot;
      });
      expect(acceptedPrefixes.map((prefix) => prefix.purpose)).toEqual([
        'create',
        'access',
        'action',
        'action',
      ]);
      finalCaches = files.map((file) => rows(file.db));
      finalAttempts = files.map((file) => attemptRows(file.db));
      expect(finalAttempts[0]).toHaveLength(1);
      expect(finalAttempts[1]).toEqual([]);
      save('native-exact-attempt.json', original);
      stage = 'native-submission-confirmed';
      locate();
    }
    owners.forEach((owner) => owner.dispose());
    for (let index = 0; index < files.length; index++) {
      files[index].db.close();
      const db = openFileTestDb(files[index].dbPath);
      reopened.push(db);
      expect(rows(db)).toEqual(finalCaches[index]);
      const projection = readOrganizationInventoryProjection(db, accounts[index].accountId, target);
      expect(projection?.snapshot).toEqual(finalSnapshots[index]);
      save(`cache-reopened-${index}.json`, rows(db));
      if (submit) {
        expect(attemptRows(db)).toEqual(finalAttempts[index]);
        save(`attempts-reopened-${index}.json`, attemptRows(db));
        if (index === 0) {
          const preview = previews[0];
          if (preview.kind !== 'ready') throw new Error('Missing original Native handle.');
          const row = readOrganizationInventoryAttemptForHandle(db, {
            accountId: fixture.admin.accountId,
            target,
            previewHandleId: preview.previewHandleId,
          });
          if (!row) throw new Error('The original operation did not survive file reopen.');
          expect(readOrganizationInventoryAttempt(db, row.key)).toEqual(row);
          expect(row.requestText).toBe(organizationInventoryCanonicalJson(row.request));
          expect(row.requestSha256).toBe(organizationInventoryRequestSha256(row.request));
          expect(row.disposition?.kind).toBe('action-accepted');
          expect(row.projectionConfirmedRevision).toBe(2);
        }
      }
      db.close();
      const destination = join(evidence, `projection-${index}.sqlite`);
      copyFileSync(files[index].dbPath, destination);
      chmodSync(destination, 0o600);
      save(`projection-${index}-sha256.json`, {
        sha256: createHash('sha256').update(readFileSync(destination)).digest('hex'),
      });
    }
    stage = submit ? 'submission-passed' : 'preview-only-passed';
    locate();
    save('receipt.json', {
      status: 'passed',
      scope: submit
        ? 'real-http-native-file-sqlite-submission'
        : 'real-http-native-file-sqlite-preview-only',
      target,
      name,
      accounts: accounts.map((session) => ({
        accountId: session.accountId,
        desktopSessionId: session.desktopSessionId,
      })),
      revision: submit ? 2 : 1,
      acceptedEventCount: submit ? 2 : 1,
      confirmedQuantity: { value: submit ? '3' : '10', unit: 'uL' },
      proposedQuantity: { value: '3', unit: 'uL' },
      acceptedPrefixCount: acceptedPrefixes.length,
      physicalSubmissionAfterBootstrap: submit,
      fullDesktopUiQualified: false,
    });
  } catch (error) {
    const message = sanitized(
      error instanceof Error ? error.message : 'Native inventory acceptance failed.'
    );
    save('receipt.json', {
      status: 'failed',
      stage,
      target,
      name,
      message,
      acceptedPrefixCount: acceptedPrefixes.length,
    });
    if (target) locate();
    throw new Error(message);
  } finally {
    owners.forEach((owner) => owner.dispose());
    reopened.forEach((db) => {
      if (db.open) db.close();
    });
    files.forEach((file) => file.cleanup());
  }
}

it.skipIf(!enabled)(
  'loads and previews one actual shared inventory through two Native clients without committing effects',
  () => runNativeInventoryAcceptance(false),
  60_000
);
it.skipIf(!enabled)(
  'submits one actual shared use through a Native handle exactly once and reopens both confirmed projections',
  () => runNativeInventoryAcceptance(true),
  60_000
);
