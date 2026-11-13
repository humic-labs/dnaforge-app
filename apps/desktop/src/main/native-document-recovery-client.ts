import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { DocumentWriteSettlement } from '@waypoint/api-client/models';
import {
  pendingNativeDocumentActionSchema,
  type PendingNativeDocumentAction,
} from './native-document-recovery';
import type { SidecarFetch } from './sidecar-request-auth';

const identity = z.string().min(1).max(128);
const pageSchema = z
  .object({
    native_owner_instance_id: identity,
    actions: z.array(pendingNativeDocumentActionSchema).max(32),
    next_action_id: identity.nullable(),
  })
  .strict();
const responseSchema = z
  .object({
    status: z.enum(['recorded', 'existing']),
    record: z.record(z.string(), z.unknown()),
  })
  .strict();

export class NativeDocumentRecoveryClient {
  private readonly nativeOwnerInstanceId: string;
  private readonly fetch: SidecarFetch;
  private readonly timeoutMs: number;

  constructor(options: { nativeOwnerInstanceId: string; fetch: SidecarFetch; timeoutMs?: number }) {
    this.nativeOwnerInstanceId = identity.parse(options.nativeOwnerInstanceId);
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) {
      throw new Error('Native document requests require a bounded deadline.');
    }
  }

  async pending(afterActionId?: string): Promise<z.infer<typeof pageSchema>> {
    const params = new URLSearchParams({ limit: '32' });
    if (afterActionId !== undefined) params.set('after_action_id', identity.parse(afterActionId));
    const page = pageSchema.parse(await this.request(`/pending?${params}`, { method: 'GET' }));
    let previous = afterActionId ?? '';
    for (const action of page.actions) {
      if (action.id <= previous)
        throw new Error('The pending action page repeated or moved backward.');
      previous = action.id;
    }
    if (
      page.native_owner_instance_id !== this.nativeOwnerInstanceId ||
      (page.next_action_id !== null && (!page.actions.length || page.next_action_id !== previous))
    ) {
      throw new Error('The pending document evidence does not match this native owner and page.');
    }
    return page;
  }

  async recover(
    input: PendingNativeDocumentAction,
    settlement: DocumentWriteSettlement
  ): Promise<void> {
    const action = pendingNativeDocumentActionSchema.parse(input);
    if (
      action.details_json.native_owner_instance_id === this.nativeOwnerInstanceId ||
      settlement.write_disposition != null
    ) {
      throw new Error(
        'Recovery must observe a previous owner without claiming permission to write.'
      );
    }
    const expectedSettlement = Object.fromEntries(
      Object.entries(settlement).filter(([, value]) => value !== null && value !== undefined)
    );
    const response = responseSchema.parse(
      await this.request(`/actions/${encodeURIComponent(action.id)}/recovery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_sha256: action.details_json.request_sha256,
          previous_native_owner_instance_id: action.details_json.native_owner_instance_id,
          settlement,
        }),
      })
    );
    const row = response.record;
    const details = z.record(z.string(), z.unknown()).parse(row.details_json);
    for (const field of [
      'id',
      'operation_id',
      'action',
      'actor_kind',
      'actor_id',
      'channel',
      'recorded_at',
    ] as const) {
      if (row[field] !== action[field])
        throw new Error('The recovery receipt changed the original action or caller.');
    }
    for (const field of [
      'native_owner_instance_id',
      'target_document_id',
      'request_sha256',
      'write_intent',
    ] as const) {
      if (!isDeepStrictEqual(details[field], action.details_json[field]))
        throw new Error('The recovery receipt changed the original intent.');
    }
    if (
      row.outcome !== `document_${settlement.status.replaceAll('-', '_')}` ||
      !isDeepStrictEqual(details.settlement, expectedSettlement) ||
      (response.status === 'recorded' &&
        details.recovered_by_native_owner_instance_id !== this.nativeOwnerInstanceId)
    ) {
      throw new Error('The recovery receipt does not confirm this observation.');
    }
  }

  private async request(path: string, options: RequestInit): Promise<unknown> {
    const response = await this.fetch(`/internal/managed-documents${path}`, {
      ...options,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Native document recovery failed (HTTP ${response.status}).`);
    return response.json();
  }
}
