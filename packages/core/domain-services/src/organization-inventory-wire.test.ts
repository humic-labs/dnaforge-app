import { expect, it } from 'vitest';
import {
  ORGANIZATION_INVENTORY_REQUEST_SCHEMA as REQUEST,
  ORGANIZATION_INVENTORY_RESPONSE_SCHEMA as RESPONSE,
  ORGANIZATION_INVENTORY_DISPOSITION_SCHEMA as DISPOSITION,
  ORGANIZATION_INVENTORY_EVENT_SCHEMA as EVENT,
  ORGANIZATION_INVENTORY_REQUEST_MAX_BYTES,
  ORGANIZATION_INVENTORY_STATE_MAX_BYTES,
  parseOrganizationInventoryRequestEnvelope,
  parseOrganizationInventoryResponseEnvelope,
  parseOrganizationInventoryDisposition,
  parseOrganizationInventoryEvent,
  organizationInventoryRequestSha256,
  organizationInventoryStateSha256,
  organizationInventoryActionSha256,
  organizationInventoryPlanDigest,
  organizationInventoryCanonicalJson,
  replayOrganizationInventoryEvent,
  assertOrganizationInventoryResponse,
  type OrganizationInventoryEvent,
  type OrganizationInventoryHeader,
  type OrganizationInventoryRequestEnvelope,
  type OrganizationInventoryResponseEnvelope,
  type OrganizationInventoryMaterialPin,
} from './organization-inventory-wire';
import { createInventoryState, type InventoryState } from './inventory-types';
import { applyInventoryOrganizationAction } from './inventory-organization';
import type { InventoryOrganizationAction } from './inventory-organization-types';
import { organizationBootstrap } from './inventory-organization.fixtures';
import { applyInventoryParsedCommandBatch } from './inventory-state';
const orgId = '11111111-1111-4111-8111-111111111111',
  inventoryId = '22222222-2222-4222-8222-222222222222';
const alice = '33333333-3333-4333-8333-333333333333',
  bob = '44444444-4444-4444-8444-444444444444';
const target = { kind: 'organization-inventory' as const, orgId, inventoryId };
const context = (accountId = alice, at = 1000) => ({
  at,
  principal: { kind: 'organization-account' as const, orgId, accountId },
  authority: { kind: 'organization-inventory' as const, orgId, inventoryId, accountId },
});
const pin: OrganizationInventoryMaterialPin = {
  materialId: 'material',
  orgId,
  homeWorkspaceId: '55555555-5555-4555-8555-555555555555',
  registryRevision: 1,
};
function recorded(
  before: InventoryState,
  action: InventoryOrganizationAction,
  accountId = alice,
  at = 1000
) {
  const materialAdmission = action.kind === 'bootstrap' ? [pin] : [];
  const preview = {
    target,
    expectedRevision: before.revision,
    accessGeneration: 'generation-a',
    action,
  };
  const planDigest = organizationInventoryPlanDigest({
    ...preview,
    beforeStateSha256: organizationInventoryStateSha256(before),
    materialAdmission,
  });
  const body = {
    ...preview,
    operationId: `operation-${before.revision}`,
    clientId: 'original-client',
    expectedPlanDigest: planDigest,
  };
  const request: OrganizationInventoryRequestEnvelope = {
    schema: REQUEST,
    purpose: 'action',
    body,
  };
  const ctx = context(accountId, at);
  const result = applyInventoryOrganizationAction(before, {
    target,
    expectedRevision: before.revision,
    action,
    context: ctx,
    admittedMaterialIds: materialAdmission.map((p) => p.materialId),
  });
  if (!result.ok) throw Error(result.message);
  const requestSha256 = organizationInventoryRequestSha256(request),
    stateSha256 = organizationInventoryStateSha256(result.state);
  const receipt: OrganizationInventoryEvent['receipt'] = {
    schema: DISPOSITION,
    kind: 'action-accepted' as const,
    target,
    operationId: body.operationId,
    requestSha256,
    submitterAccountId: accountId,
    originClientId: body.clientId,
    baseRevision: before.revision,
    revision: result.state.revision,
    recordedAt: at,
    acceptedAt: at + 1,
    stateSha256,
    accessGenerationAtDecision: body.accessGeneration,
    planDigest,
  };
  const event: OrganizationInventoryEvent = {
    schema: EVENT,
    target,
    revision: result.state.revision,
    request,
    requestSha256,
    submitter: { orgId, accountId, originClientId: body.clientId },
    context: {
      executionAt: at,
      principal: ctx.principal,
      authority: ctx.authority,
      materialAdmission,
    },
    beforeStateSha256: organizationInventoryStateSha256(before),
    afterStateSha256: stateSha256,
    receipt,
    planDigest,
    coreSourceCommit: 'a'.repeat(40),
    admission: { validUntilExclusive: at + 5000, acceptedAt: at + 1 },
  };
  return { event, after: result.state, request, preview };
}
function header(state: InventoryState, accountId = bob): OrganizationInventoryHeader {
  return {
    accountId,
    target,
    permission: 'read',
    canBootstrap: false,
    accessGeneration: 'current-b',
    accessEpoch: 9,
    revision: state.revision,
    stateSha256: organizationInventoryStateSha256(state),
    asOf: 3000,
  };
}
it('strictly versions exact raw mutation envelopes and requires the expected plan', () => {
  const f = recorded(createInventoryState(), organizationBootstrap);
  expect(parseOrganizationInventoryRequestEnvelope(f.request)).toEqual(f.request);
  for (const request of [
    { ...f.request, schema: 'v2' },
    { ...f.request, authority: context().authority },
    { ...f.request, body: { ...f.request.body, candidate: f.after } },
    { ...f.request, body: { ...f.request.body, expectedPlanDigest: undefined } },
  ])
    expect(() => parseOrganizationInventoryRequestEnvelope(request)).toThrow();
  const create: OrganizationInventoryRequestEnvelope = {
    schema: REQUEST,
    purpose: 'create' as const,
    body: { orgId, operationId: 'create', clientId: 'client', name: 'Lab' },
  };
  expect(organizationInventoryRequestSha256(create)).not.toBe(
    organizationInventoryRequestSha256({ ...create, body: { ...create.body, name: 'Lab ' } })
  );
  expect(organizationInventoryCanonicalJson({ z: undefined, a: [undefined, NaN], b: 'µ' })).toBe(
    '{"a":[null,null],"b":"µ"}'
  );
});
it('binds every semantic plan pin but excludes clock-bearing prospective state', () => {
  const before = createInventoryState(),
    base = {
      target,
      expectedRevision: 0,
      accessGeneration: 'a',
      action: organizationBootstrap,
      beforeStateSha256: organizationInventoryStateSha256(before),
      materialAdmission: [pin],
    };
  const digest = organizationInventoryPlanDigest(base);
  expect(organizationInventoryPlanDigest({ ...base, evaluatedAt: 123 } as typeof base)).toBe(
    digest
  );
  for (const changed of [
    { ...base, accessGeneration: 'b' },
    { ...base, beforeStateSha256: `sha256:${'b'.repeat(64)}` as const },
    { ...base, materialAdmission: [{ ...pin, registryRevision: 2 }] },
  ])
    expect(organizationInventoryPlanDigest(changed)).not.toBe(digest);
  expect(() =>
    organizationInventoryPlanDigest({ ...base, materialAdmission: [pin, pin] })
  ).toThrow();
  if (organizationBootstrap.kind !== 'bootstrap') throw Error('setup');
  const second = { ...pin, materialId: 'z-material' };
  const action = {
    ...organizationBootstrap,
    vessels: [
      ...organizationBootstrap.vessels,
      {
        kind: 'create-vessel' as const,
        id: 'tube2',
        name: 'Tube2',
        placement: { kind: 'located' as const, storageId: 'rack', slotId: 'B' },
      },
    ],
    stocks: [
      ...organizationBootstrap.stocks,
      {
        ...organizationBootstrap.stocks[0],
        id: 'stock2',
        vesselId: 'tube2',
        materialId: second.materialId,
      },
    ],
  };
  const unsorted = [second, pin];
  expect(organizationInventoryPlanDigest({ ...base, action, materialAdmission: unsorted })).toBe(
    organizationInventoryPlanDigest({ ...base, action, materialAdmission: [pin, second] })
  );
  expect(unsorted[0]).toBe(second);
  const amount = {
    target,
    expectedRevision: 1,
    accessGeneration: 'a',
    action: {
      kind: 'consume' as const,
      stockId: 'stock',
      quantity: { value: '1', unit: 'mL' as const },
      reason: 'Use',
    },
  };
  expect(organizationInventoryActionSha256(amount)).not.toBe(
    organizationInventoryActionSha256({
      ...amount,
      action: { ...amount.action, quantity: { value: '1000', unit: 'uL' } },
    })
  );
});
it('correlates and reproduces accepted events using the original account rather than the viewer', () => {
  const first = recorded(createInventoryState(), organizationBootstrap);
  expect(replayOrganizationInventoryEvent(createInventoryState(), first.event)).toEqual(
    first.after
  );
  const ctx = context(),
    held = applyInventoryParsedCommandBatch(
      first.after,
      {
        expectedRevision: 1,
        commands: [
          {
            kind: 'checkout-item',
            item: { kind: 'storage', id: 'rack' },
            dueAt: 4000,
            reason: 'Work',
          },
        ],
      },
      ctx
    );
  if (!held.ok) throw Error(held.message);
  const f = recorded(
    held.state,
    {
      kind: 'consume',
      stockId: 'stock',
      quantity: { value: '7', unit: 'uL' },
      reason: 'Completed',
    },
    alice,
    2000
  );
  f.event.admission.validUntilExclusive = 4000;
  const answer = {
    schema: RESPONSE,
    purpose: 'events',
    result: {
      kind: 'ready',
      header: header(f.after),
      afterRevision: 2,
      atRevision: 3,
      events: [f.event],
      nextCursor: null,
    },
  };
  expect(parseOrganizationInventoryResponseEnvelope(answer)).toEqual(answer);
  expect(replayOrganizationInventoryEvent(held.state, f.event).stocks.stock.quantity).toMatchObject(
    { value: '3' }
  );
  expect(f.event.context.principal.accountId).toBe(alice);
  expect(answer.result.header.accountId).toBe(bob);
  const wrong = structuredClone(f.event);
  wrong.context.principal.accountId = bob;
  expect(() => parseOrganizationInventoryEvent(wrong)).toThrow();
  const wrongBase = { ...held.state, revision: 1 };
  expect(() => replayOrganizationInventoryEvent(wrongBase, f.event)).toThrow();
});
it('refuses altered retained actor/client/plan/revision/hash/lease and scope fields', () => {
  const { event } = recorded(createInventoryState(), organizationBootstrap);
  const variants = [
    { ...event, requestSha256: `sha256:${'f'.repeat(64)}` },
    { ...event, revision: 9 },
    { ...event, planDigest: `sha256:${'f'.repeat(64)}` },
    { ...event, submitter: { ...event.submitter, originClientId: 'different' } },
    { ...event, admission: { ...event.admission, validUntilExclusive: 1001 } },
    { ...event, target: { ...target, inventoryId: orgId } },
  ];
  for (const changed of variants) expect(() => parseOrganizationInventoryEvent(changed)).toThrow();
  expect(() => parseOrganizationInventoryDisposition({ ...event.receipt, revision: 2 })).toThrow();
});
it('keeps terminal dispositions independent from current headers and metadata outcomes nonphysical', () => {
  const f = recorded(createInventoryState(), organizationBootstrap),
    h = header(f.after, alice);
  const response: OrganizationInventoryResponseEnvelope = {
    schema: RESPONSE,
    purpose: 'action' as const,
    result: { kind: 'decided' as const, header: h, disposition: f.event.receipt, replayed: true },
  };
  expect(parseOrganizationInventoryResponseEnvelope(response)).toEqual(response);
  assertOrganizationInventoryResponse(f.request, response);
  expect(() =>
    assertOrganizationInventoryResponse(
      {
        ...f.request,
        body: { ...f.request.body, clientId: 'replacement' },
      } as OrganizationInventoryRequestEnvelope,
      response
    )
  ).toThrow();
  const created = {
    schema: DISPOSITION,
    kind: 'inventory-created',
    orgId,
    inventoryId,
    operationId: 'create',
    requestSha256: f.event.requestSha256,
    submitterAccountId: alice,
    originClientId: 'client',
    createdAt: 50,
    initialRevision: 0,
  };
  expect(
    parseOrganizationInventoryResponseEnvelope({
      schema: RESPONSE,
      purpose: 'create',
      result: { kind: 'decided', accountId: alice, orgId, disposition: created, replayed: true },
    })
  ).toBeTruthy();
  expect(() => parseOrganizationInventoryDisposition({ ...created, revision: 1 })).toThrow();
  const refusal = {
    schema: DISPOSITION,
    kind: 'action-refused',
    target,
    operationId: 'refused',
    requestSha256: f.event.requestSha256,
    submitterAccountId: alice,
    originClientId: 'client',
    code: 'STALE_BASE',
    message: 'Changed',
    currentRevision: 1,
    decidedAt: 100,
    stateUntouched: true,
  };
  expect(parseOrganizationInventoryDisposition(refusal)).toEqual(refusal);
  expect(() =>
    parseOrganizationInventoryDisposition({ ...refusal, stateUntouched: false })
  ).toThrow();
});
it('pins contiguous pages independently of newer current header and rejects gaps/partial-empty', () => {
  const a = recorded(createInventoryState(), organizationBootstrap),
    b = recorded(
      a.after,
      { kind: 'consume', stockId: 'stock', quantity: { value: '1', unit: 'uL' }, reason: 'Use' },
      bob,
      2000
    );
  const result = {
    kind: 'ready',
    header: header(b.after),
    afterRevision: 0,
    atRevision: 1,
    events: [a.event],
    nextCursor: null,
  };
  expect(
    parseOrganizationInventoryResponseEnvelope({ schema: RESPONSE, purpose: 'events', result })
  ).toBeTruthy();
  for (const changed of [
    { ...result, events: [] },
    { ...result, afterRevision: 1 },
    { ...result, nextCursor: { afterRevision: 1, atRevision: 1 } },
    { ...result, atRevision: 3 },
  ])
    expect(() =>
      parseOrganizationInventoryResponseEnvelope({
        schema: RESPONSE,
        purpose: 'events',
        result: changed,
      })
    ).toThrow();
});
it('applies UTF8 complete-envelope caps and state reserve without accepting oversized projections', () => {
  if (organizationBootstrap.kind !== 'bootstrap') throw Error('fixture');
  const action = {
    ...organizationBootstrap,
    vessels: Array.from({ length: 120 }, (_, i) => ({
      kind: 'create-vessel' as const,
      id: `v${i}`,
      name: 'µ'.repeat(300),
      placement: { kind: 'unplaced' as const },
    })),
  };
  const envelope = {
    schema: REQUEST,
    purpose: 'preview',
    body: { target, expectedRevision: 0, accessGeneration: 'a', action },
  };
  expect(new TextEncoder().encode(JSON.stringify(envelope)).byteLength).toBeGreaterThan(
    ORGANIZATION_INVENTORY_REQUEST_MAX_BYTES
  );
  expect(() => parseOrganizationInventoryRequestEnvelope(envelope)).toThrow();
  const state = createInventoryState();
  const huge = applyInventoryParsedCommandBatch(
    state,
    {
      expectedRevision: 0,
      commands: [
        {
          kind: 'create-layout-storage',
          id: 'large',
          name: 'Large',
          layout: {
            kind: 'named',
            slots: Array.from({ length: 10000 }, (_, i) => `${i}${'µ'.repeat(100)}`),
          },
          placement: { kind: 'root' },
        },
      ],
    },
    context()
  );
  if (!huge.ok) throw Error(huge.message);
  expect(new TextEncoder().encode(JSON.stringify(huge.state)).byteLength).toBeGreaterThan(
    ORGANIZATION_INVENTORY_STATE_MAX_BYTES
  );
  expect(() => organizationInventoryStateSha256(huge.state)).toThrow();
});
it('binds preview readiness to current writing capability rather than a readable snapshot', () => {
  const f = recorded(createInventoryState(), organizationBootstrap);
  const response: OrganizationInventoryResponseEnvelope = {
    schema: RESPONSE,
    purpose: 'preview',
    result: {
      kind: 'ready',
      header: {
        ...header(createInventoryState(), alice),
        permission: 'manage',
        canBootstrap: true,
        accessGeneration: f.preview.accessGeneration,
        asOf: 1000,
      },
      planDigest: f.event.planDigest,
      actionSha256: organizationInventoryActionSha256(f.preview),
      evaluatedAt: 1000,
      nextBoundaryAt: null,
      readyUntilExclusive: 6000,
      proposed: { state: f.after, stateSha256: f.event.afterStateSha256 },
    },
  };
  assertOrganizationInventoryResponse(
    { schema: REQUEST, purpose: 'preview', body: f.preview },
    response
  );
  if (response.result.kind !== 'ready') throw Error('ready');
  const readOnly = {
    ...response,
    result: {
      ...response.result,
      header: { ...response.result.header, permission: 'read', canBootstrap: false },
    },
  };
  expect(() => parseOrganizationInventoryResponseEnvelope(readOnly)).toThrow();
  const noBootstrap = {
    ...response,
    result: { ...response.result, header: { ...response.result.header, canBootstrap: false } },
  };
  expect(() =>
    assertOrganizationInventoryResponse(
      { schema: REQUEST, purpose: 'preview', body: f.preview },
      noBootstrap
    )
  ).toThrow();
});
it('matches external request target and verified plan independently of claimed request SHA', () => {
  const f = recorded(createInventoryState(), organizationBootstrap);
  const receipt = { ...f.event.receipt, target: { ...target, inventoryId: orgId } };
  const wrong: OrganizationInventoryResponseEnvelope = {
    schema: RESPONSE,
    purpose: 'action',
    result: {
      kind: 'decided',
      header: { ...header(f.after, alice), target: receipt.target },
      disposition: receipt,
      replayed: true,
    },
  };
  expect(() => assertOrganizationInventoryResponse(f.request, wrong)).toThrow();
  const plan: OrganizationInventoryResponseEnvelope = {
    schema: RESPONSE,
    purpose: 'action',
    result: {
      kind: 'decided',
      header: header(f.after, alice),
      disposition: { ...f.event.receipt, planDigest: `sha256:${'f'.repeat(64)}` },
      replayed: true,
    },
  };
  expect(() => assertOrganizationInventoryResponse(f.request, plan)).toThrow();
});
it('requires the submitting account in write acknowledgements while preserving different read viewers', () => {
  const f = recorded(createInventoryState(), organizationBootstrap),
    viewer = header(f.after);
  const identity = {
    schema: DISPOSITION,
    target,
    operationId: 'write',
    requestSha256: f.event.requestSha256,
    submitterAccountId: alice,
    originClientId: 'client',
  };
  const actionRefused = {
    ...identity,
    kind: 'action-refused',
    code: 'STALE_BASE',
    message: 'Changed',
    currentRevision: 1,
    decidedAt: 1000,
    stateUntouched: true,
  };
  const accessSet = {
    ...identity,
    kind: 'access-set',
    subjectAccountId: bob,
    role: 'operator',
    previousAccessEpoch: 0,
    accessEpoch: 1,
    acceptedAt: 1001,
  };
  const accessRefused = {
    ...identity,
    kind: 'access-refused',
    code: 'ACCESS_CHANGED',
    message: 'Changed',
    currentAccessEpoch: 1,
    decidedAt: 1001,
    stateUntouched: true,
    accessUntouched: true,
  };
  for (const [purpose, dispositions] of [
    ['action', [f.event.receipt, actionRefused]],
    ['access', [accessSet, accessRefused]],
  ] as const) {
    for (const disposition of dispositions) {
      expect(() =>
        parseOrganizationInventoryResponseEnvelope({
          schema: RESPONSE,
          purpose,
          result: { kind: 'decided', header: viewer, disposition, replayed: true },
        })
      ).toThrow();
      expect(
        parseOrganizationInventoryResponseEnvelope({
          schema: RESPONSE,
          purpose,
          result: {
            kind: 'decided',
            header: { ...viewer, accountId: alice },
            disposition,
            replayed: true,
          },
        })
      ).toBeTruthy();
      expect(
        parseOrganizationInventoryResponseEnvelope({
          schema: RESPONSE,
          purpose: 'operation',
          result: { kind: 'known', header: viewer, disposition },
        })
      ).toBeTruthy();
    }
  }
  const creation = {
    schema: DISPOSITION,
    orgId,
    operationId: 'create',
    requestSha256: f.event.requestSha256,
    submitterAccountId: alice,
    originClientId: 'client',
  };
  for (const disposition of [
    { ...creation, kind: 'inventory-created', inventoryId, createdAt: 1000, initialRevision: 0 },
    {
      ...creation,
      kind: 'creation-refused',
      code: 'CAPACITY',
      message: 'Full',
      decidedAt: 1000,
      inventoryCreated: false,
    },
  ]) {
    expect(() =>
      parseOrganizationInventoryResponseEnvelope({
        schema: RESPONSE,
        purpose: 'create',
        result: { kind: 'decided', accountId: bob, orgId, disposition, replayed: true },
      })
    ).toThrow();
    expect(
      parseOrganizationInventoryResponseEnvelope({
        schema: RESPONSE,
        purpose: 'create',
        result: { kind: 'decided', accountId: alice, orgId, disposition, replayed: true },
      })
    ).toBeTruthy();
    expect(
      parseOrganizationInventoryResponseEnvelope({
        schema: RESPONSE,
        purpose: 'creation-operation',
        result: { kind: 'known', accountId: bob, orgId, disposition },
      })
    ).toBeTruthy();
  }
});
