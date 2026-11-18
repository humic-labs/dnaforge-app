import { z } from 'zod';
import {
  ORGANIZATION_INVENTORY_RESPONSE_SCHEMA,
  organizationInventoryPreviewRequestSchema,
  parseOrganizationInventoryResponseEnvelope,
  organizationInventoryCanonicalJson,
  parseOrganizationInventoryRequestEnvelope,
  parseOrganizationInventoryDisposition,
  organizationInventoryRequestSha256,
  type OrganizationInventoryDirectoryResponse,
  type OrganizationInventorySnapshotResponse,
  type OrganizationInventoryPreviewResponse,
  type OrganizationInventoryPreviewRequest,
  type InventoryOrganizationTarget,
  type OrganizationInventoryRequestEnvelope,
  type OrganizationInventoryDisposition,
  type InventoryTableSha256,
} from '@waypoint/domain-services';

export interface InventoryOrganizationSessionIdentity {
  readonly accountId: string;
  readonly desktopSessionId: string;
  readonly knownAccessTokenExpiresAt: number;
}
export interface InventoryOrganizationBinding extends InventoryOrganizationSessionIdentity {
  readonly target: InventoryOrganizationTarget;
  readonly accessGeneration: string;
  readonly bindingEpoch: string;
}
export interface InventoryOrganizationDirectoryRequest {
  readonly expectedAccountId: string;
  readonly expectedDesktopSessionId: string;
  readonly orgId: string;
}
export interface InventoryOrganizationSnapshotRequest {
  readonly expectedAccountId: string;
  readonly expectedDesktopSessionId: string;
  readonly target: InventoryOrganizationTarget;
}
export interface InventoryOrganizationPreviewRequest {
  readonly binding: InventoryOrganizationBinding;
  readonly request: OrganizationInventoryPreviewRequest;
}
export type InventoryOrganizationUnavailable = Extract<
  OrganizationInventoryDirectoryResponse,
  { kind: 'unavailable' }
>;
export type InventoryOrganizationDirectoryRead =
  | {
      readonly kind: 'ready';
      readonly session: InventoryOrganizationSessionIdentity;
      readonly directory: Extract<OrganizationInventoryDirectoryResponse, { kind: 'ready' }>;
    }
  | InventoryOrganizationUnavailable;
export type InventoryOrganizationSnapshotRead =
  | {
      readonly kind: 'current';
      readonly binding: InventoryOrganizationBinding;
      readonly snapshot: Extract<OrganizationInventorySnapshotResponse, { kind: 'ready' }>;
    }
  | {
      readonly kind: 'cached-offline';
      readonly binding: InventoryOrganizationBinding;
      readonly snapshot: Extract<OrganizationInventorySnapshotResponse, { kind: 'ready' }>;
      readonly failure: InventoryOrganizationUnavailable;
    }
  | InventoryOrganizationUnavailable;
export type InventoryOrganizationPreviewRead =
  | {
      readonly kind: 'ready';
      readonly previewHandleId: string;
      readonly binding: InventoryOrganizationBinding;
      readonly preview: Extract<OrganizationInventoryPreviewResponse, { kind: 'ready' }>;
    }
  | {
      readonly kind: 'blocked';
      readonly binding: InventoryOrganizationBinding;
      readonly preview: Extract<OrganizationInventoryPreviewResponse, { kind: 'blocked' }>;
    }
  | InventoryOrganizationUnavailable;
export interface InventoryOrganizationClient {
  organizationDirectory(
    request: InventoryOrganizationDirectoryRequest
  ): Promise<InventoryOrganizationDirectoryRead>;
  organizationSnapshot(
    request: InventoryOrganizationSnapshotRequest
  ): Promise<InventoryOrganizationSnapshotRead>;
  organizationPreview(
    request: InventoryOrganizationPreviewRequest
  ): Promise<InventoryOrganizationPreviewRead>;
  organizationCancelPreview(
    request: InventoryOrganizationCancelPreviewRequest
  ): Promise<InventoryOrganizationCancelPreviewRead>;
  organizationSubmit(
    request: InventoryOrganizationSubmitRequest
  ): Promise<InventoryOrganizationActionAttemptRead>;
  organizationAttempt(
    request: InventoryOrganizationAttemptRequest
  ): Promise<InventoryOrganizationAttemptRead>;
  organizationRecover(
    request: InventoryOrganizationRecoverRequest
  ): Promise<InventoryOrganizationActionAttemptRead>;
}
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => v.trim().length > 0 && !v.includes('\0'));
const target = z
  .object({ kind: z.literal('organization-inventory'), orgId: uuid, inventoryId: uuid })
  .strict();
export const inventoryOrganizationSessionIdentitySchema = z
  .object({ accountId: uuid, desktopSessionId: uuid, knownAccessTokenExpiresAt: timestamp })
  .strict();
export const inventoryOrganizationBindingSchema = inventoryOrganizationSessionIdentitySchema
  .extend({ target, accessGeneration: text, bindingEpoch: text })
  .strict();
export const inventoryOrganizationDirectoryRequestSchema = z
  .object({ expectedAccountId: uuid, expectedDesktopSessionId: uuid, orgId: uuid })
  .strict();
export const inventoryOrganizationSnapshotRequestSchema = z
  .object({ expectedAccountId: uuid, expectedDesktopSessionId: uuid, target })
  .strict();
const equal = (a: unknown, b: unknown) =>
  organizationInventoryCanonicalJson(a) === organizationInventoryCanonicalJson(b);
function check(ctx: z.RefinementCtx, valid: boolean, message: string) {
  if (!valid) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
}
export const inventoryOrganizationPreviewRequestSchema = z
  .object({
    binding: inventoryOrganizationBindingSchema,
    request: organizationInventoryPreviewRequestSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    check(
      ctx,
      equal(v.binding.target, v.request.target) &&
        v.binding.accessGeneration === v.request.accessGeneration,
      'Preview does not match its issued inventory binding.'
    );
  });
function wire<P extends 'directory' | 'snapshot' | 'preview', K extends string>(
  purpose: P,
  kind: K,
  value: unknown
): boolean {
  try {
    return (
      parseOrganizationInventoryResponseEnvelope({
        schema: ORGANIZATION_INVENTORY_RESPONSE_SCHEMA,
        purpose,
        result: value,
      }).result.kind === kind
    );
  } catch {
    return false;
  }
}
const unavailable = z.custom<InventoryOrganizationUnavailable>((v) =>
  wire('directory', 'unavailable', v)
);
const directory = z.custom<Extract<OrganizationInventoryDirectoryResponse, { kind: 'ready' }>>(
  (v) => wire('directory', 'ready', v)
);
const snapshot = z.custom<Extract<OrganizationInventorySnapshotResponse, { kind: 'ready' }>>((v) =>
  wire('snapshot', 'ready', v)
);
const ready = z.custom<Extract<OrganizationInventoryPreviewResponse, { kind: 'ready' }>>((v) =>
  wire('preview', 'ready', v)
);
const blocked = z.custom<Extract<OrganizationInventoryPreviewResponse, { kind: 'blocked' }>>((v) =>
  wire('preview', 'blocked', v)
);
function matchesHeader(
  binding: InventoryOrganizationBinding,
  header: { accountId: string; target: InventoryOrganizationTarget; accessGeneration: string }
) {
  return (
    binding.accountId === header.accountId &&
    equal(binding.target, header.target) &&
    binding.accessGeneration === header.accessGeneration
  );
}
export const inventoryOrganizationDirectoryReadSchema = z.union([
  z
    .object({
      kind: z.literal('ready'),
      session: inventoryOrganizationSessionIdentitySchema,
      directory,
    })
    .strict()
    .superRefine((v, ctx) =>
      check(
        ctx,
        v.session.accountId === v.directory.accountId,
        'Directory does not match its Native account.'
      )
    ),
  unavailable,
]);
export const inventoryOrganizationSnapshotReadSchema = z.union([
  z
    .object({ kind: z.literal('current'), binding: inventoryOrganizationBindingSchema, snapshot })
    .strict()
    .superRefine((v, ctx) =>
      check(
        ctx,
        matchesHeader(v.binding, v.snapshot.header),
        'Snapshot does not match its Native binding.'
      )
    ),
  z
    .object({
      kind: z.literal('cached-offline'),
      binding: inventoryOrganizationBindingSchema,
      snapshot,
      failure: unavailable,
    })
    .strict()
    .superRefine((v, ctx) =>
      check(
        ctx,
        matchesHeader(v.binding, v.snapshot.header) && v.failure.retryable,
        'Offline snapshot requires a matching binding and retryable connectivity failure.'
      )
    ),
  unavailable,
]);
export const inventoryOrganizationPreviewReadSchema = z.union([
  z
    .object({
      kind: z.literal('ready'),
      previewHandleId: uuid,
      binding: inventoryOrganizationBindingSchema,
      preview: ready,
    })
    .strict()
    .superRefine((v, ctx) =>
      check(
        ctx,
        matchesHeader(v.binding, v.preview.header),
        'Preview does not match its Native binding.'
      )
    ),
  z
    .object({
      kind: z.literal('blocked'),
      binding: inventoryOrganizationBindingSchema,
      preview: blocked,
    })
    .strict()
    .superRefine((v, ctx) =>
      check(
        ctx,
        matchesHeader(v.binding, v.preview.header),
        'Preview does not match its Native binding.'
      )
    ),
  unavailable,
]);

export interface InventoryOrganizationActionAttempt {
  readonly target: InventoryOrganizationTarget;
  readonly operationId: string;
  readonly requestSha256: InventoryTableSha256;
  readonly originalDesktopSessionId: string;
  readonly createdAt: number;
  readonly request: Extract<OrganizationInventoryRequestEnvelope, { purpose: 'action' }>;
}
export type InventoryOrganizationSubmitRequest = z.infer<
  typeof inventoryOrganizationSubmitRequestSchema
>;
export type InventoryOrganizationCancelPreviewRequest = z.infer<
  typeof inventoryOrganizationCancelPreviewRequestSchema
>;
export type InventoryOrganizationAttemptRequest = z.infer<
  typeof inventoryOrganizationAttemptRequestSchema
>;
export type InventoryOrganizationRecoverRequest = z.infer<
  typeof inventoryOrganizationRecoverRequestSchema
>;
export type InventoryOrganizationActionAttemptRead = z.infer<
  typeof inventoryOrganizationActionAttemptReadSchema
>;
export type InventoryOrganizationAttemptRead = z.infer<
  typeof inventoryOrganizationAttemptReadSchema
>;
export type InventoryOrganizationCancelPreviewRead = z.infer<
  typeof inventoryOrganizationCancelPreviewReadSchema
>;
const sha = z.custom<InventoryTableSha256>(
  (value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
);
const identifier = text.refine((value) => value.trim() === value);
const currentPins = { expectedAccountId: uuid, expectedDesktopSessionId: uuid };
export const inventoryOrganizationSubmitRequestSchema = z
  .object({ ...currentPins, target, previewHandleId: uuid })
  .strict();
export const inventoryOrganizationCancelPreviewRequestSchema =
  inventoryOrganizationSubmitRequestSchema;
export const inventoryOrganizationAttemptRequestSchema = z
  .object({
    ...currentPins,
    target,
    query: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('pending') }).strict(),
      z.object({ kind: z.literal('exact'), operationId: identifier, requestSha256: sha }).strict(),
    ]),
  })
  .strict();
export const inventoryOrganizationRecoverRequestSchema = z
  .object({
    ...currentPins,
    target,
    operationId: identifier,
    requestSha256: sha,
    mode: z.enum(['inspect', 'retry-exact', 'confirm-unsent']),
  })
  .strict();
const actionEnvelope = z.custom<InventoryOrganizationActionAttempt['request']>((value) => {
  try {
    return parseOrganizationInventoryRequestEnvelope(value).purpose === 'action';
  } catch {
    return false;
  }
});
export const inventoryOrganizationActionAttemptSchema = z
  .object({
    target,
    operationId: identifier,
    requestSha256: sha,
    originalDesktopSessionId: uuid,
    createdAt: timestamp,
    request: actionEnvelope,
  })
  .strict()
  .refine((value) => {
    try {
      const request = parseOrganizationInventoryRequestEnvelope(value.request);
      return (
        request.purpose === 'action' &&
        equal(value.target, request.body.target) &&
        value.operationId === request.body.operationId &&
        value.requestSha256 === organizationInventoryRequestSha256(request)
      );
    } catch {
      return false;
    }
  }, 'Attempt does not match its exact original action.');
type Accepted = Extract<OrganizationInventoryDisposition, { kind: 'action-accepted' }>;
type Refused = Extract<OrganizationInventoryDisposition, { kind: 'action-refused' }>;
const accepted = z.custom<Accepted>((value) => {
  try {
    return parseOrganizationInventoryDisposition(value).kind === 'action-accepted';
  } catch {
    return false;
  }
});
const refused = z.custom<Refused>((value) => {
  try {
    return parseOrganizationInventoryDisposition(value).kind === 'action-refused';
  } catch {
    return false;
  }
});
function matchesAttempt(value: {
  session: InventoryOrganizationSessionIdentity;
  attempt: InventoryOrganizationActionAttempt;
  disposition: Accepted | Refused;
}): boolean {
  try {
    const request = parseOrganizationInventoryRequestEnvelope(value.attempt.request);
    if (request.purpose !== 'action') return false;
    const disposition = parseOrganizationInventoryDisposition(value.disposition);
    if (disposition.kind !== 'action-accepted' && disposition.kind !== 'action-refused')
      return false;
    return (
      equal(disposition.target, value.attempt.target) &&
      disposition.operationId === value.attempt.operationId &&
      disposition.requestSha256 === value.attempt.requestSha256 &&
      disposition.originClientId === request.body.clientId &&
      disposition.submitterAccountId === value.session.accountId &&
      (disposition.kind === 'action-refused' ||
        (disposition.baseRevision === request.body.expectedRevision &&
          disposition.planDigest === request.body.expectedPlanDigest &&
          disposition.accessGenerationAtDecision === request.body.accessGeneration))
    );
  } catch {
    return false;
  }
}
const attemptFields = {
  session: inventoryOrganizationSessionIdentitySchema,
  attempt: inventoryOrganizationActionAttemptSchema,
};
export const inventoryOrganizationActionAttemptReadSchema = z.union([
  z
    .object({
      ...attemptFields,
      kind: z.literal('never-sent'),
      failure: unavailable.nullable(),
    })
    .strict(),
  z
    .object({ ...attemptFields, kind: z.literal('sent-unknown'), failure: unavailable.nullable() })
    .strict(),
  z
    .object({
      ...attemptFields,
      kind: z.literal('accepted'),
      disposition: accepted,
      delivery: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('pending'), failure: unavailable.nullable() }).strict(),
        z.object({ kind: z.literal('current'), confirmedRevision: timestamp }).strict(),
      ]),
    })
    .strict()
    .refine(
      (value) =>
        matchesAttempt(value) &&
        (value.delivery.kind !== 'current' ||
          value.delivery.confirmedRevision >= value.disposition.revision),
      'Accepted outcome does not match its original attempt or delivery.'
    ),
  z
    .object({ ...attemptFields, kind: z.literal('refused'), disposition: refused })
    .strict()
    .refine(matchesAttempt, 'Refusal does not match its original attempt.'),
  unavailable,
]);
export const inventoryOrganizationAttemptReadSchema = z.union([
  inventoryOrganizationActionAttemptReadSchema,
  z
    .object({
      kind: z.literal('none'),
      session: inventoryOrganizationSessionIdentitySchema,
      target,
    })
    .strict(),
]);
export const inventoryOrganizationCancelPreviewReadSchema = z.union([
  z
    .object({
      kind: z.enum(['cancelled', 'not-live']),
      session: inventoryOrganizationSessionIdentitySchema,
      target,
      previewHandleId: uuid,
    })
    .strict(),
  z.object({ ...attemptFields, kind: z.literal('retained') }).strict(),
  unavailable,
]);
