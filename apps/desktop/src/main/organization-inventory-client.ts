import {
  ORGANIZATION_INVENTORY_REQUEST_SCHEMA,
  ORGANIZATION_INVENTORY_RESPONSE_MAX_BYTES,
  assertOrganizationInventoryResponse,
  organizationInventoryCanonicalJson,
  organizationInventoryOperationRequestSchema,
  parseOrganizationInventoryRequestEnvelope,
  parseOrganizationInventoryResponseEnvelope,
  type InventoryOrganizationTarget,
  type OrganizationInventoryApplyResponse,
  type OrganizationInventoryDirectoryResponse,
  type OrganizationInventoryLookupResponse,
  type OrganizationInventoryOperationRequest,
  type OrganizationInventoryPreviewRequest,
  type OrganizationInventoryPreviewResponse,
  type OrganizationInventoryRequestEnvelope,
  type OrganizationInventorySnapshotResponse,
} from '@waypoint/domain-services';
import {
  inventoryOrganizationDirectoryRequestSchema,
  inventoryOrganizationSnapshotRequestSchema,
} from '../shared/inventory-organization-client';
import {
  createDesktopSyncClient,
  DesktopSyncClientError,
  type DesktopSyncClient,
} from './desktop-sync-client';

interface SessionPins {
  readonly accountId: string;
  readonly desktopSessionId: string;
}

export interface OrganizationInventoryHttpClient {
  listDirectory(
    input: SessionPins & { orgId: string }
  ): Promise<OrganizationInventoryDirectoryResponse>;
  readSnapshot(
    input: SessionPins & { target: InventoryOrganizationTarget }
  ): Promise<OrganizationInventorySnapshotResponse>;
  preview(
    input: SessionPins & { request: OrganizationInventoryPreviewRequest }
  ): Promise<OrganizationInventoryPreviewResponse>;
  applyAction(
    input: SessionPins & {
      request: Extract<OrganizationInventoryRequestEnvelope, { purpose: 'action' }>;
    }
  ): Promise<OrganizationInventoryApplyResponse>;
  readOperation(
    input: SessionPins & { request: OrganizationInventoryOperationRequest }
  ): Promise<OrganizationInventoryLookupResponse>;
}

const directoryPath = (orgId: string) =>
  `/api/desktop-sync/organizations/${encodeURIComponent(orgId)}/inventories/v1`;
const inventoryPath = (target: InventoryOrganizationTarget) =>
  `${directoryPath(target.orgId)}/${encodeURIComponent(target.inventoryId)}`;
const sameTarget = (a: InventoryOrganizationTarget, b: InventoryOrganizationTarget) =>
  organizationInventoryCanonicalJson(a) === organizationInventoryCanonicalJson(b);
const pinOptions = (input: { expectedAccountId: string; expectedDesktopSessionId: string }) => ({
  expectedAccountId: input.expectedAccountId,
  expectedDesktopSessionId: input.expectedDesktopSessionId,
  maxResponseBytes: ORGANIZATION_INVENTORY_RESPONSE_MAX_BYTES,
});

function checked<T>(read: () => T): T {
  try {
    return read();
  } catch {
    throw new DesktopSyncClientError(
      'BAD_RESPONSE',
      'Organization inventory returned an invalid or mismatched response.',
      { retryable: true, terminal: false }
    );
  }
}

export function createOrganizationInventoryClient(
  client: Pick<DesktopSyncClient, 'requestJson'> = createDesktopSyncClient()
): OrganizationInventoryHttpClient {
  return {
    async listDirectory(input) {
      const request = inventoryOrganizationDirectoryRequestSchema.parse({
        expectedAccountId: input.accountId,
        expectedDesktopSessionId: input.desktopSessionId,
        orgId: input.orgId,
      });
      const raw = await client.requestJson<unknown>(directoryPath(request.orgId), {
        method: 'GET',
        ...pinOptions(request),
      });
      return checked(() => {
        const answer = parseOrganizationInventoryResponseEnvelope(raw);
        if (answer.purpose !== 'directory') throw new TypeError('Directory purpose mismatch.');
        if (
          answer.result.kind !== 'unavailable' &&
          (answer.result.accountId !== request.expectedAccountId ||
            answer.result.orgId !== request.orgId)
        )
          throw new TypeError('Directory viewer or organization mismatch.');
        return answer.result;
      });
    },
    async readSnapshot(input) {
      const request = inventoryOrganizationSnapshotRequestSchema.parse({
        expectedAccountId: input.accountId,
        expectedDesktopSessionId: input.desktopSessionId,
        target: input.target,
      });
      const raw = await client.requestJson<unknown>(inventoryPath(request.target), {
        method: 'GET',
        ...pinOptions(request),
      });
      return checked(() => {
        const answer = parseOrganizationInventoryResponseEnvelope(raw);
        if (answer.purpose !== 'snapshot') throw new TypeError('Snapshot purpose mismatch.');
        if (
          answer.result.kind !== 'unavailable' &&
          (answer.result.header.accountId !== request.expectedAccountId ||
            !sameTarget(answer.result.header.target, request.target))
        )
          throw new TypeError('Snapshot viewer or target mismatch.');
        return answer.result;
      });
    },
    async preview(input) {
      const request = parseOrganizationInventoryRequestEnvelope({
        schema: ORGANIZATION_INVENTORY_REQUEST_SCHEMA,
        purpose: 'preview',
        body: input.request,
      });
      if (request.purpose !== 'preview') throw new TypeError('Preview request required.');
      const pins = inventoryOrganizationDirectoryRequestSchema.parse({
        expectedAccountId: input.accountId,
        expectedDesktopSessionId: input.desktopSessionId,
        orgId: request.body.target.orgId,
      });
      const raw = await client.requestJson<unknown>(
        `${inventoryPath(request.body.target)}/preview`,
        {
          method: 'POST',
          ...pinOptions(pins),
          body: request,
        }
      );
      return checked(() => {
        const answer = parseOrganizationInventoryResponseEnvelope(raw);
        if (answer.purpose !== 'preview') throw new TypeError('Preview purpose mismatch.');
        assertOrganizationInventoryResponse(request, answer);
        if (
          answer.result.kind !== 'unavailable' &&
          (answer.result.header.accountId !== pins.expectedAccountId ||
            !sameTarget(answer.result.header.target, request.body.target))
        )
          throw new TypeError('Preview viewer or target mismatch.');
        return answer.result;
      });
    },
    async applyAction(input) {
      const request = parseOrganizationInventoryRequestEnvelope(input.request);
      if (request.purpose !== 'action') throw new TypeError('Action request required.');
      const pins = inventoryOrganizationDirectoryRequestSchema.parse({
        expectedAccountId: input.accountId,
        expectedDesktopSessionId: input.desktopSessionId,
        orgId: request.body.target.orgId,
      });
      const raw = await client.requestJson<unknown>(
        `${inventoryPath(request.body.target)}/actions`,
        {
          method: 'POST',
          ...pinOptions(pins),
          idempotencyKey: request.body.operationId,
          body: request,
        }
      );
      return checked(() => {
        const answer = parseOrganizationInventoryResponseEnvelope(raw);
        if (answer.purpose !== 'action') throw new TypeError('Action purpose mismatch.');
        assertOrganizationInventoryResponse(request, answer);
        if (
          answer.result.kind !== 'unavailable' &&
          (answer.result.header.accountId !== pins.expectedAccountId ||
            !sameTarget(answer.result.header.target, request.body.target))
        )
          throw new TypeError('Action viewer or target mismatch.');
        return answer.result;
      });
    },
    async readOperation(input) {
      const request = organizationInventoryOperationRequestSchema.parse(input.request);
      const pins = inventoryOrganizationDirectoryRequestSchema.parse({
        expectedAccountId: input.accountId,
        expectedDesktopSessionId: input.desktopSessionId,
        orgId: request.target.orgId,
      });
      const raw = await client.requestJson<unknown>(
        `${inventoryPath(request.target)}/operations/${encodeURIComponent(request.operationId)}?requestSha256=${encodeURIComponent(request.requestSha256)}`,
        { method: 'GET', ...pinOptions(pins) }
      );
      return checked(() => {
        const answer = parseOrganizationInventoryResponseEnvelope(raw);
        if (answer.purpose !== 'operation') throw new TypeError('Operation purpose mismatch.');
        if (answer.result.kind === 'unavailable') return answer.result;
        if (
          answer.result.header.accountId !== pins.expectedAccountId ||
          !sameTarget(answer.result.header.target, request.target)
        )
          throw new TypeError('Operation viewer or target mismatch.');
        const identity = answer.result.kind === 'known' ? answer.result.disposition : answer.result;
        if (
          identity.operationId !== request.operationId ||
          identity.requestSha256 !== request.requestSha256
        )
          throw new TypeError('Operation identity mismatch.');
        return answer.result;
      });
    },
  };
}
