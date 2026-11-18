import { describe, expect, it, vi } from 'vitest';

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
vi.mock('../auth/auth-config', () => ({
  getWebBaseUrl: () => 'https://web.test',
  getAuthChannel: () => 'dev',
  getRedirectScheme: () => 'dnaforge-dev',
}));

import {
  ORGANIZATION_INVENTORY_REQUEST_SCHEMA,
  ORGANIZATION_INVENTORY_RESPONSE_SCHEMA,
  ORGANIZATION_INVENTORY_DISPOSITION_SCHEMA,
  ORGANIZATION_INVENTORY_RESPONSE_MAX_BYTES,
  applyInventoryOrganizationAction,
  createInventoryState,
  organizationInventoryActionSha256,
  organizationInventoryCanonicalJson,
  organizationInventoryPlanDigest,
  organizationInventoryRequestSha256,
  organizationInventoryStateSha256,
  type OrganizationInventoryRequestEnvelope,
} from '@waypoint/domain-services';
import { organizationBootstrap } from '../../../../../packages/core/domain-services/src/inventory-organization.fixtures';
import { createDesktopSyncClient, type DesktopSyncClient } from '../desktop-sync-client';
import { createOrganizationInventoryClient } from '../organization-inventory-client';

const orgId = '11111111-1111-4111-8111-111111111111';
const inventoryId = '22222222-2222-4222-8222-222222222222';
const accountId = '33333333-3333-4333-8333-333333333333';
const desktopSessionId = '44444444-4444-4444-8444-444444444444';
const otherId = '55555555-5555-4555-8555-555555555555';
const target = { kind: 'organization-inventory' as const, orgId, inventoryId };
const pins = { accountId, desktopSessionId };
const state = createInventoryState();
const header = {
  accountId,
  target,
  permission: 'manage' as const,
  canBootstrap: true,
  accessGeneration: 'generation-a',
  accessEpoch: 1,
  revision: 0,
  stateSha256: organizationInventoryStateSha256(state),
  asOf: 1000,
};
const request = {
  target,
  expectedRevision: 0,
  accessGeneration: header.accessGeneration,
  action: organizationBootstrap,
};
const directory = { kind: 'ready', accountId, orgId, asOf: 1000, canCreate: true, entries: [] };
const snapshot = { kind: 'ready', header, state };
const blocked = { kind: 'blocked', header, issues: [{ code: 'BLOCKED', message: 'Not allowed.' }] };
const unavailable = {
  kind: 'unavailable',
  code: 'OFFLINE',
  message: 'Unavailable.',
  retryable: true,
};
const response = (purpose: string, result: unknown) => ({
  schema: ORGANIZATION_INVENTORY_RESPONSE_SCHEMA,
  purpose,
  result,
});
function adapter(answer: unknown) {
  const requestJson = vi.fn().mockResolvedValue(answer);
  return {
    requestJson,
    client: createOrganizationInventoryClient({ requestJson } as Pick<
      DesktopSyncClient,
      'requestJson'
    >),
  };
}
function readyPreview() {
  const applied = applyInventoryOrganizationAction(state, {
    target,
    expectedRevision: 0,
    action: request.action,
    admittedMaterialIds: ['material'],
    context: {
      at: 1000,
      principal: { kind: 'organization-account', orgId, accountId },
      authority: { ...target, accountId },
    },
  });
  if (!applied.ok) throw Error(applied.message);
  return {
    kind: 'ready',
    header,
    planDigest: organizationInventoryPlanDigest({
      ...request,
      beforeStateSha256: header.stateSha256,
      materialAdmission: [
        { materialId: 'material', orgId, homeWorkspaceId: otherId, registryRevision: 1 },
      ],
    }),
    actionSha256: organizationInventoryActionSha256(request),
    evaluatedAt: 1000,
    nextBoundaryAt: null,
    readyUntilExclusive: 6000,
    proposed: {
      state: applied.state,
      stateSha256: organizationInventoryStateSha256(applied.state),
    },
  };
}

function retainedAction(): Extract<OrganizationInventoryRequestEnvelope, { purpose: 'action' }> {
  return {
    schema: ORGANIZATION_INVENTORY_REQUEST_SCHEMA,
    purpose: 'action' as const,
    body: {
      ...request,
      operationId: 'operation/retained',
      clientId: 'client-original',
      expectedPlanDigest: readyPreview().planDigest,
    },
  };
}

function acceptedAction() {
  const action = retainedAction();
  return {
    schema: ORGANIZATION_INVENTORY_DISPOSITION_SCHEMA,
    kind: 'action-accepted' as const,
    target,
    operationId: action.body.operationId,
    requestSha256: organizationInventoryRequestSha256(action),
    submitterAccountId: accountId,
    originClientId: action.body.clientId,
    baseRevision: 0,
    revision: 1,
    recordedAt: 1000,
    acceptedAt: 1000,
    stateSha256: readyPreview().proposed.stateSha256,
    accessGenerationAtDecision: action.body.accessGeneration,
    planDigest: action.body.expectedPlanDigest,
  };
}

function decidedAction() {
  const disposition = acceptedAction();
  return {
    kind: 'decided',
    header: {
      ...header,
      revision: 1,
      canBootstrap: false,
      stateSha256: disposition.stateSha256,
      accessGeneration: 'generation-current',
    },
    disposition,
    replayed: true,
  };
}

describe('organization inventory preview HTTP client', () => {
  it('sends the retained full action and exact operation lookup with current session pins', async () => {
    const action = retainedAction();
    const original = organizationInventoryCanonicalJson(action);
    const decided = decidedAction();
    const lookup = {
      target,
      operationId: action.body.operationId,
      requestSha256: organizationInventoryRequestSha256(action),
    };
    const known = { kind: 'known', header: decided.header, disposition: decided.disposition };
    const { client, requestJson } = adapter(response('action', decided));
    await expect(client.applyAction({ ...pins, request: action })).resolves.toEqual(decided);
    requestJson.mockResolvedValueOnce(response('operation', known));
    await expect(client.readOperation({ ...pins, request: lookup })).resolves.toEqual(known);
    const base = `/api/desktop-sync/organizations/${orgId}/inventories/v1/${inventoryId}`;
    const options = {
      expectedAccountId: accountId,
      expectedDesktopSessionId: desktopSessionId,
      maxResponseBytes: ORGANIZATION_INVENTORY_RESPONSE_MAX_BYTES,
    };
    expect(requestJson.mock.calls).toEqual([
      [
        `${base}/actions`,
        { method: 'POST', ...options, idempotencyKey: action.body.operationId, body: action },
      ],
      [
        `${base}/operations/${encodeURIComponent(lookup.operationId)}?requestSha256=${encodeURIComponent(lookup.requestSha256)}`,
        { method: 'GET', ...options },
      ],
    ]);
    expect(organizationInventoryCanonicalJson(action)).toBe(original);
  });

  it('returns the original accepted or refused disposition without rebinding its generation', async () => {
    const action = retainedAction();
    const decided = decidedAction();
    const refused = {
      kind: 'decided',
      header: decided.header,
      replayed: true,
      disposition: {
        schema: ORGANIZATION_INVENTORY_DISPOSITION_SCHEMA,
        kind: 'action-refused',
        target,
        operationId: action.body.operationId,
        requestSha256: organizationInventoryRequestSha256(action),
        submitterAccountId: accountId,
        originClientId: action.body.clientId,
        code: 'ACCESS_CHANGED',
        message: 'Original access changed.',
        currentRevision: 1,
        decidedAt: 2000,
        stateUntouched: true,
      },
    };
    const { client, requestJson } = adapter(response('action', decided));
    await expect(client.applyAction({ ...pins, request: action })).resolves.toEqual(decided);
    requestJson.mockResolvedValueOnce(response('action', refused));
    await expect(client.applyAction({ ...pins, request: action })).resolves.toEqual(refused);
    expect(requestJson.mock.calls.map(([, options]) => options.body)).toEqual([action, action]);
    expect(action.body.accessGeneration).toBe('generation-a');
    expect(decided.header.accessGeneration).toBe('generation-current');
  });

  it.each([
    'operation',
    'digest',
    'client',
    'base',
    'plan',
    'generation',
    'target',
    'viewer',
  ] as const)('rejects an action acknowledgement with mismatched %s', async (field) => {
    const decided = decidedAction();
    const sha = `sha256:${'f'.repeat(64)}`;
    const otherTarget = { ...target, inventoryId: otherId };
    const changes = {
      operation: { operationId: 'other-operation' },
      digest: { requestSha256: sha },
      client: { originClientId: 'other-client' },
      base: { baseRevision: 1, revision: 2 },
      plan: { planDigest: sha },
      generation: { accessGenerationAtDecision: 'other-generation' },
      target: { target: otherTarget },
      viewer: { submitterAccountId: otherId },
    }[field];
    const wrong = {
      ...decided,
      header: {
        ...decided.header,
        ...(field === 'target' ? { target: otherTarget } : {}),
        ...(field === 'viewer' ? { accountId: otherId } : {}),
      },
      disposition: { ...decided.disposition, ...changes },
    };
    await expect(
      adapter(response('action', wrong)).client.applyAction({ ...pins, request: retainedAction() })
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE', retryable: true, terminal: false });
  });

  it('permits an authorized lookup viewer distinct from the historical action submitter', async () => {
    const disposition = acceptedAction();
    const known = { kind: 'known', header: { ...header, accountId: otherId }, disposition };
    const { client } = adapter(response('operation', known));
    await expect(
      client.readOperation({
        accountId: otherId,
        desktopSessionId,
        request: {
          target,
          operationId: disposition.operationId,
          requestSha256: disposition.requestSha256,
        },
      })
    ).resolves.toEqual(known);
  });

  it.each(['known', 'not-found'] as const)(
    'correlates exact %s lookup identity and scope',
    async (kind) => {
      const disposition = acceptedAction();
      const lookup = {
        target,
        operationId: disposition.operationId,
        requestSha256: disposition.requestSha256,
      };
      const result =
        kind === 'known'
          ? { kind, header, disposition }
          : { kind, header, operationId: lookup.operationId, requestSha256: lookup.requestSha256 };
      await expect(
        adapter(response('operation', result)).client.readOperation({ ...pins, request: lookup })
      ).resolves.toEqual(result);
      const wrongIdentity =
        kind === 'known'
          ? { ...result, disposition: { ...disposition, operationId: 'another-operation' } }
          : { ...result, requestSha256: `sha256:${'f'.repeat(64)}` };
      for (const wrong of [
        wrongIdentity,
        { ...result, header: { ...header, accountId: otherId } },
        { ...result, header: { ...header, target: { ...target, inventoryId: otherId } } },
      ]) {
        await expect(
          adapter(response('operation', wrong)).client.readOperation({ ...pins, request: lookup })
        ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
      }
    }
  );

  it('uses the current same-account session to send an unchanged retained action', async () => {
    const action = retainedAction();
    const currentSessionId = otherId;
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(response('action', decidedAction())), { status: 200 })
      );
    const client = createOrganizationInventoryClient(
      createDesktopSyncClient({
        baseUrl: 'https://web.test',
        fetch,
        nowMs: () => 1000,
        getActiveStoredSession: async () => ({
          accountId,
          desktopSessionId: currentSessionId,
          accessToken: 'current-session-token',
          accessTokenExpiresAt: new Date(1000000).toISOString(),
          refreshToken: 'current-session-refresh',
          channel: 'dev',
          updatedAt: 0,
        }),
      })
    );
    await expect(
      client.applyAction({ accountId, desktopSessionId: currentSessionId, request: action })
    ).resolves.toEqual(decidedAction());
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(action);
    fetch.mockClear();
    await expect(client.applyAction({ ...pins, request: action })).rejects.toMatchObject({
      code: 'SESSION_CHANGED',
    });
    await expect(
      client.applyAction({
        accountId: otherId,
        desktopSessionId: currentSessionId,
        request: action,
      })
    ).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps unavailable and transport errors distinct from action refusal or lookup absence', async () => {
    const action = retainedAction();
    const lookup = {
      target,
      operationId: action.body.operationId,
      requestSha256: organizationInventoryRequestSha256(action),
    };
    const { client, requestJson } = adapter(response('action', unavailable));
    await expect(client.applyAction({ ...pins, request: action })).resolves.toEqual(unavailable);
    requestJson.mockResolvedValueOnce(response('operation', unavailable));
    await expect(client.readOperation({ ...pins, request: lookup })).resolves.toEqual(unavailable);
    const lostAcknowledgement = new Error('Lost acknowledgement');
    requestJson.mockRejectedValueOnce(lostAcknowledgement);
    await expect(client.applyAction({ ...pins, request: action })).rejects.toBe(
      lostAcknowledgement
    );
    for (const method of ['applyAction', 'readOperation'] as const) {
      requestJson.mockResolvedValueOnce(response('preview', unavailable));
      const call =
        method === 'applyAction'
          ? client.applyAction({ ...pins, request: action })
          : client.readOperation({ ...pins, request: lookup });
      await expect(call).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    }
    requestJson.mockClear();
    await expect(
      client.applyAction({
        ...pins,
        request: { ...action, body: { ...action.body, expectedRevision: -1 } },
      })
    ).rejects.toThrow();
    await expect(
      client.readOperation({
        ...pins,
        request: { ...lookup, requestSha256: 'invalid' as typeof lookup.requestSha256 },
      })
    ).rejects.toThrow();
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('uses exact v1 routes, both session pins, complete response limits, and the strict preview envelope', async () => {
    const { client, requestJson } = adapter(response('directory', directory));
    await expect(client.listDirectory({ ...pins, orgId })).resolves.toEqual(directory);
    requestJson.mockResolvedValueOnce(response('snapshot', snapshot));
    await expect(client.readSnapshot({ ...pins, target })).resolves.toEqual(snapshot);
    const preview = readyPreview();
    requestJson.mockResolvedValueOnce(response('preview', preview));
    await expect(client.preview({ ...pins, request })).resolves.toEqual(preview);
    const options = {
      expectedAccountId: accountId,
      expectedDesktopSessionId: desktopSessionId,
      maxResponseBytes: ORGANIZATION_INVENTORY_RESPONSE_MAX_BYTES,
    };
    const base = `/api/desktop-sync/organizations/${orgId}/inventories/v1`;
    expect(requestJson.mock.calls).toEqual([
      [base, { method: 'GET', ...options }],
      [`${base}/${inventoryId}`, { method: 'GET', ...options }],
      [
        `${base}/${inventoryId}/preview`,
        {
          method: 'POST',
          ...options,
          body: {
            schema: ORGANIZATION_INVENTORY_REQUEST_SCHEMA,
            purpose: 'preview',
            body: request,
          },
        },
      ],
    ]);
  });

  it('returns purpose-matched unavailable results without inventing scoped data', async () => {
    const { client, requestJson } = adapter(response('directory', unavailable));
    await expect(client.listDirectory({ ...pins, orgId })).resolves.toEqual(unavailable);
    requestJson.mockResolvedValueOnce(response('snapshot', unavailable));
    await expect(client.readSnapshot({ ...pins, target })).resolves.toEqual(unavailable);
    requestJson.mockResolvedValueOnce(response('preview', unavailable));
    await expect(client.preview({ ...pins, request })).resolves.toEqual(unavailable);
  });

  it.each([
    { ...directory, accountId: otherId },
    { ...directory, orgId: otherId },
  ])('rejects another viewer or organization in a valid directory', async (result) => {
    await expect(
      adapter(response('directory', result)).client.listDirectory({ ...pins, orgId })
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it.each([
    { ...header, accountId: otherId },
    { ...header, target: { ...target, inventoryId: otherId } },
  ])(
    'rejects another viewer or target in a valid snapshot and blocked preview',
    async (wrongHeader) => {
      await expect(
        adapter(response('snapshot', { ...snapshot, header: wrongHeader })).client.readSnapshot({
          ...pins,
          target,
        })
      ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
      await expect(
        adapter(response('preview', { ...blocked, header: wrongHeader })).client.preview({
          ...pins,
          request,
        })
      ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    }
  );

  it('checks ready preview base and action correlation with the public wire owner', async () => {
    const wrong = { ...readyPreview(), actionSha256: `sha256:${'0'.repeat(64)}` };
    await expect(
      adapter(response('preview', wrong)).client.preview({ ...pins, request })
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it.each(['directory', 'snapshot', 'preview'] as const)(
    'rejects wrong-purpose and malformed %s responses',
    async (purpose) => {
      for (const answer of [
        response(purpose === 'directory' ? 'snapshot' : 'directory', unavailable),
        { schema: 'unknown', purpose, result: unavailable },
        response(purpose, { ...unavailable, authority: 'caller' }),
      ]) {
        const { client } = adapter(answer);
        const result =
          purpose === 'directory'
            ? client.listDirectory({ ...pins, orgId })
            : purpose === 'snapshot'
              ? client.readSnapshot({ ...pins, target })
              : client.preview({ ...pins, request });
        await expect(result).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
      }
    }
  );

  it('rejects malformed input before the requester receives anything', async () => {
    const { client, requestJson } = adapter(response('preview', blocked));
    await expect(client.listDirectory({ ...pins, desktopSessionId: '', orgId })).rejects.toThrow();
    await expect(
      client.readSnapshot({ ...pins, target: { ...target, inventoryId: '../other' } })
    ).rejects.toThrow();
    await expect(
      client.preview({ ...pins, request: { ...request, expectedRevision: -1 } })
    ).rejects.toThrow();
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('enforces the 2 MiB raw response limit through the injected desktop requester', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(' '.repeat(ORGANIZATION_INVENTORY_RESPONSE_MAX_BYTES + 1), { status: 200 })
      );
    const client = createOrganizationInventoryClient(
      createDesktopSyncClient({
        baseUrl: 'https://web.test',
        fetch,
        nowMs: () => 1000,
        getActiveStoredSession: async () => ({
          ...pins,
          accessToken: 'token',
          accessTokenExpiresAt: new Date(1000000).toISOString(),
          refreshToken: 'refresh',
          channel: 'dev',
          updatedAt: 0,
        }),
      })
    );
    await expect(client.listDirectory({ ...pins, orgId })).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
      message: `Desktop sync response exceeds ${ORGANIZATION_INVENTORY_RESPONSE_MAX_BYTES} bytes.`,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
