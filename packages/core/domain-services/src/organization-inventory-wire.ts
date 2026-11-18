import { inventoryOrganizationAdmissionBoundary } from './inventory-admission-time';
import { z } from 'zod';
import { inventoryTableCanonicalJson, inventoryTableSha256 } from './inventory-table-binding';
import {
  parseInventoryOrganizationAction,
  applyInventoryOrganizationAction,
} from './inventory-organization';
import { assertInventoryActorScope } from './inventory-actor-scope';
import {
  parseInventoryState,
  parseInventoryOrganizationExecutionContext,
} from './inventory-validation';
import { createInventoryState, INVENTORY_SCHEMA, type InventoryState } from './inventory-types';
import type { InventoryOrganizationAction } from './inventory-organization-types';
import type { InventoryTableSha256 } from './inventory-table-types';

export const ORGANIZATION_INVENTORY_REQUEST_SCHEMA = 'dnaforge.organization-inventory-request.v1';
export const ORGANIZATION_INVENTORY_RESPONSE_SCHEMA = 'dnaforge.organization-inventory-response.v1';
export const ORGANIZATION_INVENTORY_DISPOSITION_SCHEMA =
  'dnaforge.organization-inventory-disposition.v1';
export const ORGANIZATION_INVENTORY_EVENT_SCHEMA = 'dnaforge.organization-inventory-event.v1';
export const ORGANIZATION_INVENTORY_PLAN_SCHEMA = 'dnaforge.organization-inventory-plan.v1';
export const ORGANIZATION_INVENTORY_REQUEST_MAX_BYTES = 64 * 1024;
export const ORGANIZATION_INVENTORY_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
export const ORGANIZATION_INVENTORY_STATE_MAX_BYTES =
  ORGANIZATION_INVENTORY_RESPONSE_MAX_BYTES - ORGANIZATION_INVENTORY_REQUEST_MAX_BYTES;
export const ORGANIZATION_INVENTORY_EVENT_MAX_BYTES = 128 * 1024;
export const ORGANIZATION_INVENTORY_LEASE_MAX_MS = 5000;
export const ORGANIZATION_INVENTORY_DIRECTORY_MAX_ENTRIES = 50;
export const ORGANIZATION_INVENTORY_EVENTS_MAX_ENTRIES = 10;

export function organizationInventoryCanonicalJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError('Organization inventory values must be JSON values.');
  return inventoryTableCanonicalJson(JSON.parse(text));
}
const bytes = (value: unknown) =>
  new TextEncoder().encode(organizationInventoryCanonicalJson(value)).byteLength;
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => v.trim().length > 0 && !v.includes('\0'));
const identifier = text(512).refine((v) => v.trim() === v);
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const sha = z.custom<InventoryTableSha256>(
  (v) => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v)
);
const safe = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const targetSchema = z
  .object({ kind: z.literal('organization-inventory'), orgId: uuid, inventoryId: uuid })
  .strict();
const generation = text(1024);
const permission = z.enum(['read', 'operate', 'manage']);
const unavailable = z
  .object({
    kind: z.literal('unavailable'),
    code: text(512),
    message: text(2000),
    retryable: z.boolean(),
  })
  .strict();
const action = z.custom<InventoryOrganizationAction>((value) => {
  try {
    parseInventoryOrganizationAction(value);
    return true;
  } catch {
    return false;
  }
});
const stateSchema = z.custom<InventoryState>((value) => {
  try {
    if (!value || typeof value !== 'object' || Reflect.get(value, 'schema') !== INVENTORY_SCHEMA)
      return false;
    const parsed = parseInventoryState(value);
    return (
      organizationInventoryCanonicalJson(parsed) === organizationInventoryCanonicalJson(value) &&
      bytes(value) <= ORGANIZATION_INVENTORY_STATE_MAX_BYTES
    );
  } catch {
    return false;
  }
});
const issue = z.object({ code: text(512), message: text(2000) }).strict();
const same = (a: unknown, b: unknown) =>
  organizationInventoryCanonicalJson(a) === organizationInventoryCanonicalJson(b);
const check = (ctx: z.RefinementCtx, condition: boolean, message: string) => {
  if (!condition) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
};
function budget(ctx: z.RefinementCtx, value: unknown, max: number) {
  try {
    check(
      ctx,
      bytes(value) <= max,
      'Organization inventory payload exceeds its complete encoded limit.'
    );
  } catch {
    check(ctx, false, 'Organization inventory payload must be JSON.');
  }
}
export const organizationInventoryHeaderSchema = z
  .object({
    accountId: uuid,
    target: targetSchema,
    permission,
    canBootstrap: z.boolean(),
    accessGeneration: generation,
    accessEpoch: safe,
    revision: safe,
    stateSha256: sha,
    asOf: safe,
  })
  .strict()
  .superRefine((v, ctx) =>
    check(
      ctx,
      !v.canBootstrap || v.permission === 'manage',
      'Bootstrap capability requires manage permission.'
    )
  );
export const organizationInventoryMaterialPinSchema = z
  .object({
    materialId: identifier,
    orgId: uuid,
    homeWorkspaceId: uuid,
    registryRevision: safe.min(1),
  })
  .strict();
export type OrganizationInventoryHeader = z.infer<typeof organizationInventoryHeaderSchema>;
export type OrganizationInventoryMaterialPin = z.infer<
  typeof organizationInventoryMaterialPinSchema
>;
export const organizationInventoryCreateRequestSchema = z
  .object({ orgId: uuid, operationId: identifier, clientId: identifier, name: text(2000) })
  .strict();
export const organizationInventoryGrantRequestSchema = z
  .object({
    target: targetSchema,
    operationId: identifier,
    clientId: identifier,
    accessGeneration: generation,
    expectedAccessEpoch: safe,
    subjectAccountId: uuid,
    role: z.enum(['reader', 'operator']).nullable(),
  })
  .strict();
export const organizationInventoryPreviewRequestSchema = z
  .object({ target: targetSchema, expectedRevision: safe, accessGeneration: generation, action })
  .strict();
export const organizationInventoryApplyRequestSchema = organizationInventoryPreviewRequestSchema
  .extend({ operationId: identifier, clientId: identifier, expectedPlanDigest: sha })
  .strict();
export const organizationInventoryOperationRequestSchema = z
  .object({ target: targetSchema, operationId: identifier, requestSha256: sha })
  .strict();
export const organizationInventoryCreationOperationRequestSchema = z
  .object({ orgId: uuid, operationId: identifier, requestSha256: sha })
  .strict();
export const organizationInventoryEventsRequestSchema = z
  .object({
    target: targetSchema,
    afterRevision: safe,
    atRevision: safe.nullable(),
    limit: safe.min(1).max(ORGANIZATION_INVENTORY_EVENTS_MAX_ENTRIES),
  })
  .strict()
  .superRefine((v, ctx) =>
    check(
      ctx,
      v.atRevision === null || v.afterRevision <= v.atRevision,
      'Event cursor exceeds its fixed boundary.'
    )
  );
export type OrganizationInventoryCreateRequest = z.infer<
  typeof organizationInventoryCreateRequestSchema
>;
export type OrganizationInventoryGrantRequest = z.infer<
  typeof organizationInventoryGrantRequestSchema
>;
export type OrganizationInventoryPreviewRequest = z.infer<
  typeof organizationInventoryPreviewRequestSchema
>;
export type OrganizationInventoryApplyRequest = z.infer<
  typeof organizationInventoryApplyRequestSchema
>;
export type OrganizationInventoryOperationRequest = z.infer<
  typeof organizationInventoryOperationRequestSchema
>;
export type OrganizationInventoryCreationOperationRequest = z.infer<
  typeof organizationInventoryCreationOperationRequestSchema
>;
export type OrganizationInventoryEventsRequest = z.infer<
  typeof organizationInventoryEventsRequestSchema
>;
const envelope = <T extends z.ZodTypeAny, P extends string>(purpose: P, body: T) =>
  z
    .object({
      schema: z.literal(ORGANIZATION_INVENTORY_REQUEST_SCHEMA),
      purpose: z.literal(purpose),
      body,
    })
    .strict();
export const organizationInventoryRequestEnvelopeSchema = z
  .discriminatedUnion('purpose', [
    envelope('create', organizationInventoryCreateRequestSchema),
    envelope('access', organizationInventoryGrantRequestSchema),
    envelope('preview', organizationInventoryPreviewRequestSchema),
    envelope('action', organizationInventoryApplyRequestSchema),
  ])
  .superRefine((v, ctx) => budget(ctx, v, ORGANIZATION_INVENTORY_REQUEST_MAX_BYTES));
export type OrganizationInventoryRequestEnvelope = z.infer<
  typeof organizationInventoryRequestEnvelopeSchema
>;

const identity = {
  schema: z.literal(ORGANIZATION_INVENTORY_DISPOSITION_SCHEMA),
  target: targetSchema,
  operationId: identifier,
  requestSha256: sha,
  submitterAccountId: uuid,
  originClientId: identifier,
};
const acceptedAction = z
  .object({
    ...identity,
    kind: z.literal('action-accepted'),
    baseRevision: safe,
    revision: safe,
    recordedAt: safe,
    acceptedAt: safe,
    stateSha256: sha,
    accessGenerationAtDecision: generation,
    planDigest: sha,
  })
  .strict()
  .superRefine((v, ctx) => {
    check(
      ctx,
      v.revision === v.baseRevision + 1 && v.baseRevision < Number.MAX_SAFE_INTEGER,
      'Physical acceptance must advance exactly one revision.'
    );
    check(ctx, v.acceptedAt >= v.recordedAt, 'Acceptance precedes domain execution.');
  });
const refusedAction = z
  .object({
    ...identity,
    kind: z.literal('action-refused'),
    code: text(512),
    message: text(2000),
    currentRevision: safe,
    decidedAt: safe,
    stateUntouched: z.literal(true),
  })
  .strict();
const acceptedGrant = z
  .object({
    ...identity,
    kind: z.literal('access-set'),
    subjectAccountId: uuid,
    role: z.enum(['reader', 'operator']).nullable(),
    previousAccessEpoch: safe,
    accessEpoch: safe,
    acceptedAt: safe,
  })
  .strict()
  .superRefine((v, ctx) =>
    check(
      ctx,
      v.accessEpoch === v.previousAccessEpoch + 1 &&
        v.previousAccessEpoch < Number.MAX_SAFE_INTEGER,
      'Access acceptance must advance exactly one epoch.'
    )
  );
const refusedGrant = z
  .object({
    ...identity,
    kind: z.literal('access-refused'),
    code: text(512),
    message: text(2000),
    currentAccessEpoch: safe,
    decidedAt: safe,
    stateUntouched: z.literal(true),
    accessUntouched: z.literal(true),
  })
  .strict();
const creationIdentity = {
  schema: z.literal(ORGANIZATION_INVENTORY_DISPOSITION_SCHEMA),
  orgId: uuid,
  operationId: identifier,
  requestSha256: sha,
  submitterAccountId: uuid,
  originClientId: identifier,
};
const created = z
  .object({
    ...creationIdentity,
    kind: z.literal('inventory-created'),
    inventoryId: uuid,
    createdAt: safe,
    initialRevision: z.literal(0),
  })
  .strict();
const refusedCreation = z
  .object({
    ...creationIdentity,
    kind: z.literal('creation-refused'),
    code: text(512),
    message: text(2000),
    decidedAt: safe,
    inventoryCreated: z.literal(false),
  })
  .strict();
export const organizationInventoryDispositionSchema = z.union([
  acceptedAction,
  refusedAction,
  acceptedGrant,
  refusedGrant,
  created,
  refusedCreation,
]);
export type OrganizationInventoryDisposition = z.infer<
  typeof organizationInventoryDispositionSchema
>;
export type OrganizationInventoryAcceptedAction = Extract<
  OrganizationInventoryDisposition,
  { kind: 'action-accepted' }
>;
export type OrganizationInventoryRefusedAction = Extract<
  OrganizationInventoryDisposition,
  { kind: 'action-refused' }
>;
export type OrganizationInventoryGrantAccepted = Extract<
  OrganizationInventoryDisposition,
  { kind: 'access-set' }
>;
export type OrganizationInventoryGrantRefused = Extract<
  OrganizationInventoryDisposition,
  { kind: 'access-refused' }
>;
export type OrganizationInventoryCreationAccepted = Extract<
  OrganizationInventoryDisposition,
  { kind: 'inventory-created' }
>;
export type OrganizationInventoryCreationRefused = Extract<
  OrganizationInventoryDisposition,
  { kind: 'creation-refused' }
>;

export function organizationInventoryRequestSha256(
  value: OrganizationInventoryRequestEnvelope
): InventoryTableSha256 {
  return inventoryTableSha256(
    organizationInventoryCanonicalJson(organizationInventoryRequestEnvelopeSchema.parse(value))
  );
}
export function organizationInventoryActionSha256(
  value: OrganizationInventoryPreviewRequest
): InventoryTableSha256 {
  return inventoryTableSha256(
    organizationInventoryCanonicalJson(organizationInventoryPreviewRequestSchema.parse(value))
  );
}
export function organizationInventoryStateSha256(state: InventoryState): InventoryTableSha256 {
  return inventoryTableSha256(organizationInventoryCanonicalJson(stateSchema.parse(state)));
}
export function organizationInventoryPlanDigest(
  input: OrganizationInventoryPreviewRequest & {
    beforeStateSha256: InventoryTableSha256;
    materialAdmission: readonly OrganizationInventoryMaterialPin[];
  }
): InventoryTableSha256 {
  const { target, expectedRevision, accessGeneration, action } =
    organizationInventoryPreviewRequestSchema.parse({
      target: input.target,
      expectedRevision: input.expectedRevision,
      accessGeneration: input.accessGeneration,
      action: input.action,
    });
  const beforeStateSha256 = sha.parse(input.beforeStateSha256);
  const materialAdmission = z
    .array(organizationInventoryMaterialPinSchema)
    .max(256)
    .parse(input.materialAdmission)
    .sort((a, b) => (a.materialId < b.materialId ? -1 : a.materialId > b.materialId ? 1 : 0));
  if (
    new Set(materialAdmission.map((p) => p.materialId)).size !== materialAdmission.length ||
    materialAdmission.some((p) => p.orgId !== target.orgId)
  )
    throw new TypeError('Material admission must contain distinct same-organization pins.');
  if (
    action.kind !== 'bootstrap'
      ? materialAdmission.length !== 0
      : !same(
          [...new Set(action.stocks.map((s) => s.materialId))].sort(),
          materialAdmission.map((p) => p.materialId)
        )
  )
    throw new TypeError('Material pins must exactly match initial stock materials.');
  return inventoryTableSha256(
    organizationInventoryCanonicalJson({
      schema: ORGANIZATION_INVENTORY_PLAN_SCHEMA,
      target,
      expectedRevision,
      accessGeneration,
      action,
      beforeStateSha256,
      materialAdmission,
    })
  );
}
const principal = z
  .object({ kind: z.literal('organization-account'), orgId: uuid, accountId: uuid })
  .strict();
const authority = z
  .object({
    kind: z.literal('organization-inventory'),
    orgId: uuid,
    inventoryId: uuid,
    accountId: uuid,
  })
  .strict();
export const organizationInventoryEventSchema = z
  .object({
    schema: z.literal(ORGANIZATION_INVENTORY_EVENT_SCHEMA),
    target: targetSchema,
    revision: safe,
    request: organizationInventoryRequestEnvelopeSchema,
    requestSha256: sha,
    submitter: z.object({ orgId: uuid, accountId: uuid, originClientId: identifier }).strict(),
    context: z
      .object({
        executionAt: safe,
        principal,
        authority,
        materialAdmission: z.array(organizationInventoryMaterialPinSchema).max(256),
      })
      .strict(),
    beforeStateSha256: sha,
    afterStateSha256: sha,
    receipt: acceptedAction,
    planDigest: sha,
    coreSourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    admission: z.object({ validUntilExclusive: safe, acceptedAt: safe }).strict(),
  })
  .strict()
  .superRefine((v, ctx) => {
    budget(ctx, v, ORGANIZATION_INVENTORY_EVENT_MAX_BYTES);
    if (v.request.purpose !== 'action') {
      check(ctx, false, 'A physical event requires its original action envelope.');
      return;
    }
    const request = v.request.body,
      receipt = v.receipt,
      context = v.context;
    check(
      ctx,
      same(v.target, request.target) && same(v.target, receipt.target),
      'Event target does not match request and receipt.'
    );
    check(
      ctx,
      context.principal.orgId === v.target.orgId &&
        context.authority.orgId === v.target.orgId &&
        context.authority.inventoryId === v.target.inventoryId &&
        v.submitter.orgId === v.target.orgId,
      'Event authority scope mismatch.'
    );
    check(
      ctx,
      context.principal.accountId === context.authority.accountId &&
        context.principal.accountId === v.submitter.accountId &&
        v.submitter.accountId === receipt.submitterAccountId,
      'Event original account mismatch.'
    );
    check(
      ctx,
      request.clientId === v.submitter.originClientId &&
        request.clientId === receipt.originClientId &&
        request.operationId === receipt.operationId,
      'Event original operation/client mismatch.'
    );
    check(
      ctx,
      v.requestSha256 === organizationInventoryRequestSha256(v.request) &&
        v.requestSha256 === receipt.requestSha256,
      'Event exact request digest mismatch.'
    );
    check(
      ctx,
      receipt.baseRevision === request.expectedRevision && v.revision === receipt.revision,
      'Event physical revision mismatch.'
    );
    check(
      ctx,
      context.executionAt === receipt.recordedAt &&
        receipt.acceptedAt === v.admission.acceptedAt &&
        v.afterStateSha256 === receipt.stateSha256,
      'Event receipt time/state mismatch.'
    );
    check(
      ctx,
      receipt.accessGenerationAtDecision === request.accessGeneration,
      'Event original access generation mismatch.'
    );
    check(
      ctx,
      v.admission.validUntilExclusive > context.executionAt &&
        v.admission.validUntilExclusive - context.executionAt <=
          ORGANIZATION_INVENTORY_LEASE_MAX_MS &&
        v.admission.acceptedAt < v.admission.validUntilExclusive,
      'Event admission lease mismatch.'
    );
    try {
      parseInventoryOrganizationExecutionContext({
        at: context.executionAt,
        principal: context.principal,
        authority: context.authority,
      });
      const digest = organizationInventoryPlanDigest({
        ...request,
        beforeStateSha256: v.beforeStateSha256,
        materialAdmission: context.materialAdmission,
      });
      check(
        ctx,
        digest === v.planDigest &&
          digest === receipt.planDigest &&
          digest === request.expectedPlanDigest,
        'Event semantic plan mismatch.'
      );
      check(
        ctx,
        same(
          context.materialAdmission,
          [...context.materialAdmission].sort((a, b) =>
            a.materialId < b.materialId ? -1 : a.materialId > b.materialId ? 1 : 0
          )
        ),
        'Event material pins must be ordered.'
      );
    } catch {
      check(ctx, false, 'Event material/authority context is invalid.');
    }
  });
export type OrganizationInventoryEvent = z.infer<typeof organizationInventoryEventSchema>;
const directory = z
  .object({
    kind: z.literal('ready'),
    accountId: uuid,
    orgId: uuid,
    asOf: safe,
    canCreate: z.boolean(),
    entries: z
      .array(z.object({ name: text(2000), header: organizationInventoryHeaderSchema }).strict())
      .max(ORGANIZATION_INVENTORY_DIRECTORY_MAX_ENTRIES),
  })
  .strict()
  .superRefine((v, ctx) => {
    check(
      ctx,
      new Set(v.entries.map((e) => e.header.target.inventoryId)).size === v.entries.length,
      'Duplicate directory inventory.'
    );
    check(
      ctx,
      v.entries.every(
        (e) => e.header.accountId === v.accountId && e.header.target.orgId === v.orgId
      ),
      'Directory viewer/scope mismatch.'
    );
  });
function scopedState(
  ctx: z.RefinementCtx,
  state: InventoryState,
  header: OrganizationInventoryHeader
) {
  try {
    assertInventoryActorScope(state, header.target);
  } catch {
    check(ctx, false, 'Snapshot attribution does not match its organization scope.');
  }
}
const snapshot = z
  .object({
    kind: z.literal('ready'),
    header: organizationInventoryHeaderSchema,
    state: stateSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    scopedState(ctx, v.state, v.header);
    check(
      ctx,
      v.state.revision === v.header.revision &&
        organizationInventoryStateSha256(v.state) === v.header.stateSha256 &&
        v.state.lastRecordedAt <= v.header.asOf,
      'Snapshot state does not match its current header.'
    );
  });
const readyPreview = z
  .object({
    kind: z.literal('ready'),
    header: organizationInventoryHeaderSchema,
    planDigest: sha,
    actionSha256: sha,
    evaluatedAt: safe,
    nextBoundaryAt: safe.nullable(),
    readyUntilExclusive: safe,
    proposed: z.object({ state: stateSchema, stateSha256: sha }).strict(),
  })
  .strict()
  .superRefine((v, ctx) => {
    scopedState(ctx, v.proposed.state, v.header);
    check(
      ctx,
      v.header.permission !== 'read',
      'Ready preview requires current writing permission.'
    );
    check(
      ctx,
      v.proposed.state.revision === v.header.revision + 1 &&
        v.proposed.state.lastRecordedAt === v.evaluatedAt &&
        organizationInventoryStateSha256(v.proposed.state) === v.proposed.stateSha256,
      'Preview candidate does not match its evaluation.'
    );
    check(
      ctx,
      v.readyUntilExclusive > v.evaluatedAt &&
        v.readyUntilExclusive - v.evaluatedAt <= ORGANIZATION_INVENTORY_LEASE_MAX_MS &&
        (v.nextBoundaryAt === null ||
          (v.nextBoundaryAt > v.evaluatedAt && v.readyUntilExclusive <= v.nextBoundaryAt)),
      'Preview time lease is invalid.'
    );
  });
const blockedPreview = z
  .object({
    kind: z.literal('blocked'),
    header: organizationInventoryHeaderSchema,
    issues: z.array(issue).min(1).max(256),
  })
  .strict();
const actionResponse = z
  .object({
    kind: z.literal('decided'),
    header: organizationInventoryHeaderSchema,
    disposition: z.union([acceptedAction, refusedAction]),
    replayed: z.boolean(),
  })
  .strict()
  .superRefine((v, ctx) =>
    check(
      ctx,
      same(v.header.target, v.disposition.target) &&
        v.header.accountId === v.disposition.submitterAccountId,
      'Action write response target/account mismatch.'
    )
  );
const grantResponse = z
  .object({
    kind: z.literal('decided'),
    header: organizationInventoryHeaderSchema,
    disposition: z.union([acceptedGrant, refusedGrant]),
    replayed: z.boolean(),
  })
  .strict()
  .superRefine((v, ctx) =>
    check(
      ctx,
      same(v.header.target, v.disposition.target) &&
        v.header.accountId === v.disposition.submitterAccountId,
      'Access write response target/account mismatch.'
    )
  );
const creationResponse = z
  .object({
    kind: z.literal('decided'),
    accountId: uuid,
    orgId: uuid,
    disposition: z.union([created, refusedCreation]),
    replayed: z.boolean(),
  })
  .strict()
  .superRefine((v, ctx) =>
    check(
      ctx,
      v.orgId === v.disposition.orgId && v.accountId === v.disposition.submitterAccountId,
      'Creation write response organization/account mismatch.'
    )
  );
const creationLookup = z.union([
  z
    .object({
      kind: z.literal('known'),
      accountId: uuid,
      orgId: uuid,
      disposition: z.union([created, refusedCreation]),
    })
    .strict()
    .superRefine((v, ctx) =>
      check(ctx, v.orgId === v.disposition.orgId, 'Creation lookup organization mismatch.')
    ),
  z
    .object({
      kind: z.literal('not-found'),
      accountId: uuid,
      orgId: uuid,
      operationId: identifier,
      requestSha256: sha,
    })
    .strict(),
  unavailable,
]);
const lookup = z.union([
  z
    .object({
      kind: z.literal('known'),
      header: organizationInventoryHeaderSchema,
      disposition: z.union([acceptedAction, refusedAction, acceptedGrant, refusedGrant]),
    })
    .strict()
    .superRefine((v, ctx) =>
      check(ctx, same(v.header.target, v.disposition.target), 'Operation lookup target mismatch.')
    ),
  z
    .object({
      kind: z.literal('not-found'),
      header: organizationInventoryHeaderSchema,
      operationId: identifier,
      requestSha256: sha,
    })
    .strict(),
  unavailable,
]);
const cursor = z.object({ afterRevision: safe, atRevision: safe }).strict();
const events = z
  .object({
    kind: z.literal('ready'),
    header: organizationInventoryHeaderSchema,
    afterRevision: safe,
    atRevision: safe,
    events: z
      .array(organizationInventoryEventSchema)
      .max(ORGANIZATION_INVENTORY_EVENTS_MAX_ENTRIES),
    nextCursor: cursor.nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    check(
      ctx,
      v.afterRevision <= v.atRevision && v.atRevision <= v.header.revision,
      'Event page boundary is invalid.'
    );
    check(
      ctx,
      v.events.every(
        (e, i) =>
          same(e.target, v.header.target) &&
          e.revision === v.afterRevision + i + 1 &&
          e.revision <= v.atRevision
      ),
      'Event page must be contiguous within its fixed boundary.'
    );
    const end = v.events.at(-1)?.revision ?? v.afterRevision;
    check(
      ctx,
      end === v.atRevision
        ? v.nextCursor === null
        : v.events.length > 0 &&
            v.nextCursor !== null &&
            v.nextCursor.afterRevision === end &&
            v.nextCursor.atRevision === v.atRevision,
      'Event page cursor does not match its boundary.'
    );
  });
const response = <T extends z.ZodTypeAny, P extends string>(purpose: P, result: T) =>
  z
    .object({
      schema: z.literal(ORGANIZATION_INVENTORY_RESPONSE_SCHEMA),
      purpose: z.literal(purpose),
      result,
    })
    .strict();
export const organizationInventoryResponseEnvelopeSchema = z
  .discriminatedUnion('purpose', [
    response('directory', z.union([directory, unavailable])),
    response('snapshot', z.union([snapshot, unavailable])),
    response('create', z.union([creationResponse, unavailable])),
    response('access', z.union([grantResponse, unavailable])),
    response('preview', z.union([readyPreview, blockedPreview, unavailable])),
    response('action', z.union([actionResponse, unavailable])),
    response('operation', lookup),
    response('creation-operation', creationLookup),
    response('events', z.union([events, unavailable])),
  ])
  .superRefine((v, ctx) => budget(ctx, v, ORGANIZATION_INVENTORY_RESPONSE_MAX_BYTES));
export type OrganizationInventoryResponseEnvelope = z.infer<
  typeof organizationInventoryResponseEnvelopeSchema
>;
export type OrganizationInventoryDirectoryResponse = Extract<
  OrganizationInventoryResponseEnvelope,
  { purpose: 'directory' }
>['result'];
export type OrganizationInventorySnapshotResponse = Extract<
  OrganizationInventoryResponseEnvelope,
  { purpose: 'snapshot' }
>['result'];
export type OrganizationInventoryPreviewResponse = Extract<
  OrganizationInventoryResponseEnvelope,
  { purpose: 'preview' }
>['result'];
export type OrganizationInventoryApplyResponse = Extract<
  OrganizationInventoryResponseEnvelope,
  { purpose: 'action' }
>['result'];
export type OrganizationInventoryGrantResponse = Extract<
  OrganizationInventoryResponseEnvelope,
  { purpose: 'access' }
>['result'];
export type OrganizationInventoryCreationResponse = Extract<
  OrganizationInventoryResponseEnvelope,
  { purpose: 'create' }
>['result'];
export type OrganizationInventoryLookupResponse = Extract<
  OrganizationInventoryResponseEnvelope,
  { purpose: 'operation' }
>['result'];
export type OrganizationInventoryCreationLookupResponse = Extract<
  OrganizationInventoryResponseEnvelope,
  { purpose: 'creation-operation' }
>['result'];
export type OrganizationInventoryEventsResponse = Extract<
  OrganizationInventoryResponseEnvelope,
  { purpose: 'events' }
>['result'];
export function parseOrganizationInventoryRequestEnvelope(
  value: unknown
): OrganizationInventoryRequestEnvelope {
  return organizationInventoryRequestEnvelopeSchema.parse(value);
}
export function parseOrganizationInventoryResponseEnvelope(
  value: unknown
): OrganizationInventoryResponseEnvelope {
  return organizationInventoryResponseEnvelopeSchema.parse(value);
}
export function parseOrganizationInventoryDisposition(
  value: unknown
): OrganizationInventoryDisposition {
  return organizationInventoryDispositionSchema.parse(value);
}
export function parseOrganizationInventoryEvent(value: unknown): OrganizationInventoryEvent {
  return organizationInventoryEventSchema.parse(value);
}
export function assertOrganizationInventoryResponse(
  request: OrganizationInventoryRequestEnvelope,
  response: OrganizationInventoryResponseEnvelope
): void {
  const raw = parseOrganizationInventoryRequestEnvelope(request),
    answer = parseOrganizationInventoryResponseEnvelope(response);
  if (raw.purpose !== answer.purpose)
    throw new TypeError('Organization response purpose does not match its request.');
  if (answer.result.kind === 'unavailable') return;
  if ('disposition' in answer.result) {
    const disposition = answer.result.disposition;
    if (
      raw.purpose === 'preview' ||
      disposition.requestSha256 !== organizationInventoryRequestSha256(raw) ||
      disposition.operationId !== raw.body.operationId ||
      disposition.originClientId !== raw.body.clientId
    )
      throw new TypeError('Organization response does not match the exact original request.');
    if (raw.purpose === 'create') {
      if (!('orgId' in disposition) || disposition.orgId !== raw.body.orgId)
        throw new TypeError('Creation disposition does not match its original organization.');
    } else {
      if (!('target' in disposition) || !same(raw.body.target, disposition.target))
        throw new TypeError('Disposition does not match its original inventory target.');
    }
    if (
      raw.purpose === 'action' &&
      disposition.kind === 'action-accepted' &&
      (disposition.baseRevision !== raw.body.expectedRevision ||
        disposition.planDigest !== raw.body.expectedPlanDigest ||
        disposition.accessGenerationAtDecision !== raw.body.accessGeneration)
    )
      throw new TypeError('Accepted action does not match its original base and plan.');
    if (
      raw.purpose === 'access' &&
      disposition.kind === 'access-set' &&
      (disposition.subjectAccountId !== raw.body.subjectAccountId ||
        disposition.role !== raw.body.role ||
        disposition.previousAccessEpoch !== raw.body.expectedAccessEpoch)
    )
      throw new TypeError('Accepted grant does not match its original subject and access epoch.');
  }
  if (raw.purpose === 'preview' && answer.purpose === 'preview' && answer.result.kind === 'ready') {
    if (
      !same(raw.body.target, answer.result.header.target) ||
      raw.body.expectedRevision !== answer.result.header.revision ||
      raw.body.accessGeneration !== answer.result.header.accessGeneration ||
      organizationInventoryActionSha256(raw.body) !== answer.result.actionSha256 ||
      (raw.body.action.kind === 'bootstrap' && !answer.result.header.canBootstrap)
    )
      throw new TypeError('Preview response does not match the original base/action.');
  }
}
export function replayOrganizationInventoryEvent(
  before: InventoryState | null,
  value: unknown
): InventoryState {
  const event = parseOrganizationInventoryEvent(value);
  if (event.request.purpose !== 'action') throw new TypeError('Replay requires an action.');
  const state = before === null ? createInventoryState() : stateSchema.parse(before),
    request = event.request.body;
  assertInventoryActorScope(state, event.target);
  if (
    state.revision !== request.expectedRevision ||
    organizationInventoryStateSha256(state) !== event.beforeStateSha256
  )
    throw new TypeError('Event replay requires its exact original base state.');
  const result = applyInventoryOrganizationAction(state, {
    target: event.target,
    expectedRevision: request.expectedRevision,
    action: request.action,
    context: {
      at: event.context.executionAt,
      principal: event.context.principal,
      authority: event.context.authority,
    },
    admittedMaterialIds: event.context.materialAdmission.map((p) => p.materialId),
  });
  if (!result.ok) throw new TypeError(`Event replay refused: ${result.code}: ${result.message}`);
  const boundary = inventoryOrganizationAdmissionBoundary(
    state,
    result.state,
    event.context.executionAt
  );
  if (boundary !== null && event.admission.validUntilExclusive > boundary)
    throw new TypeError('Event admission exceeds its physical time boundary.');
  if (organizationInventoryStateSha256(result.state) !== event.afterStateSha256)
    throw new TypeError('Event replay did not reproduce its retained resulting state.');
  return result.state;
}
