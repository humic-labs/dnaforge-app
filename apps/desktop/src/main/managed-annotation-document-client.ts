import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { DocumentJournalResponse, DocumentWriteSettlement } from '@waypoint/api-client/models';
import type {
  ManagedDocumentOperationTarget,
  ManagedDocumentSelection,
} from '@waypoint/domain-services';
import {
  assertManagedAnnotationAuthority,
  type TrustedManagedAnnotationAuthority,
} from '../shared/annotation-managed-operation-contract';
import type { NativeAnnotationDocumentCommandDependencies } from './managed-annotation-document-command';
import type { SidecarFetch } from './sidecar-request-auth';

const responseSchema: z.ZodType<DocumentJournalResponse> = z
  .object({
    status: z.enum(['permitted', 'recorded', 'existing', 'conflict', 'unavailable']),
    record: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

class NativeDocumentHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

class NativeDocumentResponseLostError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'The native response was lost.', { cause });
  }
}

function selectionKey(selection: ManagedDocumentSelection): string {
  return JSON.stringify([
    selection.operationId,
    selection.targetDocumentId,
    selection.expectedOperationVersion,
    selection.expectedResultSha256,
    selection.expectedTargetDocumentRevision,
    [...selection.selectedCandidateIds].sort(),
  ]);
}

export class NativeAnnotationDocumentActionClient {
  private readonly actionId: string;
  private readonly requestSha256: string;
  private readonly selection: ManagedDocumentSelection;
  private readonly fetch: SidecarFetch;
  private readonly timeoutMs: number;

  constructor(options: {
    actionId: string;
    requestSha256: string;
    selection: ManagedDocumentSelection;
    fetch: SidecarFetch;
    timeoutMs?: number;
  }) {
    if (
      !/^[A-Za-z0-9:_-]{1,128}$/.test(options.actionId) ||
      !/^sha256:[a-f0-9]{64}$/.test(options.requestSha256)
    ) {
      throw new Error('A valid admitted action identity is required.');
    }
    this.actionId = options.actionId;
    this.requestSha256 = options.requestSha256;
    this.selection = Object.freeze({
      ...options.selection,
      selectedCandidateIds: Object.freeze([...options.selection.selectedCandidateIds]),
    });
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) {
      throw new Error('Native document requests require a bounded deadline.');
    }
  }

  readonly authorize = async (
    target: ManagedDocumentOperationTarget
  ): Promise<TrustedManagedAnnotationAuthority> => {
    if (
      target.operationId !== this.selection.operationId ||
      target.targetDocumentId !== this.selection.targetDocumentId
    ) {
      throw new Error('The native request does not match its admitted action.');
    }
    const authority = await this.post('authority', { selection: this.selection });
    assertManagedAnnotationAuthority(target, authority);
    return authority;
  };

  readonly recordWriteIntent: NativeAnnotationDocumentCommandDependencies['recordWriteIntent'] =
    async (input) => {
      if (
        input.actionId !== this.actionId ||
        selectionKey(input.selection) !== selectionKey(this.selection)
      ) {
        throw new Error('The native request does not match its admitted action.');
      }
      let response: DocumentJournalResponse;
      try {
        response = responseSchema.parse(
          await this.post('intent', { selection: this.selection, intent: input.intent })
        );
      } catch (error) {
        if (error instanceof NativeDocumentHttpError && error.status >= 400 && error.status < 500) {
          return { status: 'refused', reason: error.message };
        }
        throw error;
      }
      if (response.status === 'existing') return { status: 'existing' };
      if (response.status === 'conflict' || response.status === 'unavailable') {
        return {
          status: 'refused',
          reason:
            response.status === 'conflict'
              ? 'The recorded document action no longer matches this request.'
              : 'The retained result is no longer available.',
        };
      }
      if (response.status !== 'permitted')
        throw new Error('The owner did not confirm write permission.');
      const details = this.receiptDetails(response, 'document_writing');
      if (!isDeepStrictEqual(details.write_intent, input.intent)) {
        throw new Error('The owner did not confirm the intended file in its write permission.');
      }
      return { status: 'permitted' };
    };

  async settle(settlement: DocumentWriteSettlement): Promise<DocumentJournalResponse> {
    const observed = structuredClone(settlement);
    const body = { request_sha256: this.requestSha256, settlement: observed };
    let receipt: unknown;
    try {
      receipt = await this.post('settlement', body);
    } catch (error) {
      if (!(error instanceof NativeDocumentResponseLostError)) throw error;
      receipt = await this.post('settlement', body);
    }
    const response = responseSchema.parse(receipt);
    if (response.status !== 'recorded' && response.status !== 'existing') {
      throw new Error('The document outcome was not confirmed by its owner.');
    }
    const details = this.receiptDetails(
      response,
      'document_' + observed.status.replaceAll('-', '_')
    );
    const expected = Object.fromEntries(
      Object.entries(observed).filter(([, value]) => value !== null && value !== undefined)
    );
    if (!isDeepStrictEqual(details.settlement, expected)) {
      throw new Error('The recorded document outcome does not match the native observation.');
    }
    return response;
  }

  private receiptDetails(
    response: DocumentJournalResponse,
    outcome: string
  ): Record<string, unknown> {
    const row = response.record;
    const parsed = z.record(z.string(), z.unknown()).safeParse(row?.details_json);
    if (
      !row ||
      row.id !== this.actionId ||
      row.operation_id !== this.selection.operationId ||
      row.action !== 'apply_to_document' ||
      row.outcome !== outcome ||
      !parsed.success ||
      parsed.data.request_sha256 !== this.requestSha256 ||
      parsed.data.target_document_id !== this.selection.targetDocumentId
    ) {
      throw new Error('The owner returned no matching admitted action receipt.');
    }
    return parsed.data;
  }

  private async post(
    command: 'authority' | 'intent' | 'settlement',
    body: unknown
  ): Promise<unknown> {
    const encoded = JSON.stringify(body);
    let response: Response;
    try {
      response = await this.fetch(
        `/internal/managed-documents/actions/${encodeURIComponent(this.actionId)}/${command}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: encoded,
          signal: AbortSignal.timeout(this.timeoutMs),
        }
      );
    } catch (error) {
      throw new NativeDocumentResponseLostError(error);
    }
    if (!response.ok) {
      let reason = `Native document request failed (HTTP ${response.status}).`;
      try {
        const parsed = z
          .object({ detail: z.object({ message: z.string().max(2048) }) })
          .safeParse(await response.json());
        if (parsed.success) reason = parsed.data.detail.message;
      } catch {}
      throw new NativeDocumentHttpError(response.status, reason);
    }
    try {
      return await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) throw error;
      throw new NativeDocumentResponseLostError(error);
    }
  }
}
