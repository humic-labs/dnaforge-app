import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import {
  HOSTED_REQUEST_SIZE_WARNING_BYTES,
  MAX_HOSTED_WHOLE_REQUEST_BYTES,
  type HostedStreamEvent,
} from '@waypoint/hosted-ai-contract';

import {
  encodeSseFrame,
  ResponsesTranslationError,
  ResponsesTranslator,
} from './responses-adapter';
import {
  acceptResponsesRequest,
  ResponsesWireError,
  type AcceptedResponsesRequest,
  type ResponsesRejectionCode,
} from './responses-wire';
import type { HostedCodexTool } from './dynamic-tool-catalog';
import type { HostedCodexTurnResult } from '../../shared/hosted-codex-ipc';
import {
  observeHostedToolInventory,
  type HostedToolInventoryCounts,
  type HostedToolInventoryObservation,
} from './tool-inventory-observation';

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_TRANSPORT_TRACE_EVENTS = 512;

export interface ResponsesTransportValueShape {
  readonly type: 'array' | 'boolean' | 'null' | 'number' | 'object' | 'string';
  readonly utf8Bytes?: number;
  readonly length?: number;
  readonly fieldCount?: number;
}

export interface ResponsesTransportEventShape {
  readonly type: string;
  readonly fields: Readonly<Record<string, ResponsesTransportValueShape>>;
}

export interface ResponsesTransportTrace {
  readonly responseSequence: number;
  readonly requestSequence?: number;
  readonly toolInventory?: HostedToolInventoryObservation;
  readonly gatewayEventTotal: number;
  readonly gatewayEvents: readonly ResponsesTransportEventShape[];
  readonly responsesEventTotal: number;
  readonly responsesEvents: readonly ResponsesTransportEventShape[];
  readonly outcome: 'completed' | 'step_error' | 'translation_error';
  readonly errorCode: string | null;
  readonly responseDigest: string;
}

export interface ResponsesRequestSizeTrace {
  readonly requestSequence: number;
  readonly phase: 'initial' | 'continuation';
  readonly measuredBytes: number;
  readonly warningBytes: number;
  readonly maximumBytes: number;
  readonly threshold: 'normal' | 'warning' | 'maximum';
  readonly disposition: 'accepted' | 'rejected';
  readonly gatewayAttempted: boolean;
}

export type ResponsesStepFailureCode =
  | 'gateway_not_configured'
  | 'gateway_signed_out'
  | 'gateway_invalid_request'
  | 'gateway_request_too_large'
  | 'gateway_paused'
  | 'gateway_allowance_exhausted'
  | 'gateway_rate_limited'
  | 'gateway_provider_exposure_reconciliation_required'
  | 'gateway_allowance_or_policy_rejected'
  | 'gateway_unavailable';

export class ResponsesStepFailure extends Error {
  constructor(readonly code: ResponsesStepFailureCode) {
    super('the gateway step was refused');
    this.name = 'ResponsesStepFailure';
  }
}

export class HostedCodexStreamFailure extends Error {
  constructor(
    readonly code: Extract<HostedCodexTurnResult, { ok: false }>['code'],
    message: string
  ) {
    super(message);
    this.name = 'HostedCodexStreamFailure';
  }
}

const STATUS_BY_REJECTION: Readonly<Record<ResponsesRejectionCode, number>> = {
  not_loopback: 403,
  bad_credential: 401,
  bad_route: 404,
  oversized_body: 413,
  malformed_body: 400,
  unknown_field: 400,
  wrong_model: 400,
  incomplete_input: 400,
  store_not_disabled: 400,
  streaming_required: 400,
  unauthorized_tool: 400,
  tool_inventory_mismatch: 400,
  tool_schema_mismatch: 400,
  builtin_tool: 400,
  unsupported_tool_type: 400,
};

export interface ResponsesServerOptions {
  readonly model: string;
  readonly tools: readonly HostedCodexTool[];
  readonly dispatchedToolNames?: readonly string[];
  readonly step: (
    request: AcceptedResponsesRequest,
    diagnostics: ResponsesStepDiagnostics
  ) => AsyncIterable<HostedStreamEvent>;
  readonly maxRequestBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly port?: number;
  readonly now?: () => number;
  readonly onTransportTrace?: (trace: ResponsesTransportTrace) => void;
  readonly onRequestSizeTrace?: (trace: ResponsesRequestSizeTrace) => void;
}

export interface ResponsesStepDiagnostics {
  readonly observeToolInventory: (counts: HostedToolInventoryCounts) => void;
}

export interface ResponsesServer {
  readonly baseUrl: string;
  readonly port: number;
  readonly address: string;
  readonly bearerToken: string;
  readonly maxRequestBytes: number;
  close(): Promise<void>;
}

function transportValueShape(value: unknown): ResponsesTransportValueShape {
  if (value === null) return { type: 'null' };
  if (typeof value === 'string') {
    return { type: 'string', utf8Bytes: Buffer.byteLength(value, 'utf8') };
  }
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (typeof value === 'object') {
    return { type: 'object', fieldCount: Object.keys(value as Record<string, unknown>).length };
  }
  return { type: 'object', fieldCount: 0 };
}

function transportEventShape(type: string, value: unknown): ResponsesTransportEventShape {
  const fields =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, fieldValue]) => [name, transportValueShape(fieldValue)])
        )
      : { value: transportValueShape(value) };
  return { type, fields };
}

export async function startResponsesServer(
  options: ResponsesServerOptions
): Promise<ResponsesServer> {
  const bearerToken = randomBytes(32).toString('base64url');
  const maxRequestBytes = options.maxRequestBytes ?? MAX_HOSTED_WHOLE_REQUEST_BYTES;
  const requestSizeWarningBytes =
    maxRequestBytes === MAX_HOSTED_WHOLE_REQUEST_BYTES
      ? HOSTED_REQUEST_SIZE_WARNING_BYTES
      : Math.floor((maxRequestBytes * 3) / 4);
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let responseSequence = 0;
  let requestSequence = 0;
  let acceptedRequestCount = 0;

  const recordRequestSize = (trace: ResponsesRequestSizeTrace): void => {
    try {
      options.onRequestSizeTrace?.(trace);
    } catch {}
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.destroy();
    });
  });

  server.setTimeout(requestTimeoutMs, (socket) => socket.destroy());

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const currentRequestSequence = requestSequence++;
    const phase = acceptedRequestCount === 0 ? 'initial' : 'continuation';
    let accepted: AcceptedResponsesRequest;
    let measuredBytes = 0;
    try {
      const body = await readBoundedBody(request, maxRequestBytes);
      measuredBytes = body.byteLength;
      accepted = acceptResponsesRequest(
        {
          remoteAddress: request.socket.remoteAddress ?? '',
          method: request.method ?? '',
          path: (request.url ?? '').split('?')[0] ?? '',
          authorization: request.headers.authorization,
          body,
        },
        { bearerToken, model: options.model, tools: options.tools, maxRequestBytes }
      );
      acceptedRequestCount += 1;
    } catch (cause) {
      if (cause instanceof ResponsesBodyLimitError) {
        recordRequestSize({
          requestSequence: currentRequestSequence,
          phase,
          measuredBytes: cause.measuredBytes,
          warningBytes: requestSizeWarningBytes,
          maximumBytes: maxRequestBytes,
          threshold: 'maximum',
          disposition: 'rejected',
          gatewayAttempted: false,
        });
      }
      if (process.env.HOSTED_E2E_DIAGNOSTICS === '1') {
        console.error('[HostedCodex] Responses request refused:', cause);
      }
      refuse(response, cause);
      request.destroy();
      return;
    }

    request.socket.setTimeout(0);

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'close',
    });

    const currentResponseSequence = responseSequence++;
    const translator = new ResponsesTranslator({
      responseId: `resp_${randomBytes(12).toString('hex')}_${currentResponseSequence}`,
      model: options.model,
      createdAt: options.now?.() ?? Math.floor(Date.now() / 1000),
      dispatchedToolNames: options.dispatchedToolNames,
    });
    const gatewayEvents: ResponsesTransportEventShape[] = [];
    const responsesEvents: ResponsesTransportEventShape[] = [];
    let gatewayEventTotal = 0;
    let responsesEventTotal = 0;
    let outcome: ResponsesTransportTrace['outcome'] = 'completed';
    let errorCode: string | null = null;
    let inventory: HostedToolInventoryObservation = { status: 'incomplete' };
    let inventoryRecorded = false;
    let inventoryOpen = true;
    const diagnostics: ResponsesStepDiagnostics = {
      observeToolInventory: (counts) => {
        if (!inventoryOpen) return;
        try {
          inventory = inventoryRecorded
            ? { status: 'invalid' }
            : observeHostedToolInventory(currentRequestSequence, counts);
        } catch {
          inventory = { status: 'invalid' };
        }
        inventoryRecorded = true;
      },
    };

    const recordGatewayEvent = (event: HostedStreamEvent): void => {
      gatewayEventTotal += 1;
      if (gatewayEvents.length < MAX_TRANSPORT_TRACE_EVENTS) {
        gatewayEvents.push(transportEventShape(event.event, event));
      }
    };
    const recordResponsesEvent = (event: {
      readonly type: string;
      readonly payload: unknown;
    }): void => {
      responsesEventTotal += 1;
      if (responsesEvents.length < MAX_TRANSPORT_TRACE_EVENTS) {
        responsesEvents.push(transportEventShape(event.type, event.payload));
      }
    };

    try {
      recordRequestSize({
        requestSequence: currentRequestSequence,
        phase,
        measuredBytes,
        warningBytes: requestSizeWarningBytes,
        maximumBytes: maxRequestBytes,
        threshold: measuredBytes >= requestSizeWarningBytes ? 'warning' : 'normal',
        disposition: 'accepted',
        gatewayAttempted: true,
      });
      for await (const event of options.step(accepted, diagnostics)) {
        recordGatewayEvent(event);
        for (const emitted of translator.translate(event)) {
          recordResponsesEvent(emitted);
          await write(response, encodeSseFrame(emitted));
        }
      }
      translator.end();
    } catch (cause) {
      const code =
        cause instanceof ResponsesTranslationError
          ? `stream_${cause.code}`
          : cause instanceof ResponsesStepFailure
            ? cause.code
            : cause instanceof HostedCodexStreamFailure && cause.code === 'gateway_unavailable'
              ? 'gateway_unavailable'
              : 'stream_failed';
      outcome = cause instanceof ResponsesTranslationError ? 'translation_error' : 'step_error';
      errorCode = code;
      if (process.env.HOSTED_E2E_DIAGNOSTICS === '1') {
        console.error('[HostedCodex] Responses stream failed:', cause);
      }
      if (!translator.isTerminal && !response.destroyed && !response.writableEnded) {
        const emitted = {
          type: 'error',
          payload: {
            type: 'error',
            code,
            message: 'the turn could not be completed',
            param: null,
          },
        } as const;
        recordResponsesEvent(emitted);
        response.write(encodeSseFrame(emitted));
      }
    } finally {
      inventoryOpen = false;
      try {
        options.onTransportTrace?.({
          responseSequence: currentResponseSequence,
          requestSequence: currentRequestSequence,
          toolInventory: inventory,
          gatewayEventTotal,
          gatewayEvents,
          responsesEventTotal,
          responsesEvents,
          outcome,
          errorCode,
          responseDigest: translator.responseDigest(),
        });
      } catch {}
      response.end();
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  let closed = false;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    address: address.address,
    bearerToken,
    maxRequestBytes,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

function write(response: ServerResponse, frame: string): Promise<void> {
  if (response.write(frame)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('the Responses client disconnected during a backpressured write'));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
    if (response.destroyed || response.writableEnded) onClose();
  });
}

class ResponsesBodyLimitError extends ResponsesWireError {
  constructor(readonly measuredBytes: number) {
    super('oversized_body', 'the Responses request body is too large');
    this.name = 'ResponsesBodyLimitError';
  }
}

function readBoundedBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      request.pause();
      reject(new ResponsesBodyLimitError(declared));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        request.pause();
        reject(new ResponsesBodyLimitError(size));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', (error) => reject(error));
  });
}

function refuse(response: ServerResponse, cause: unknown): void {
  const wire = cause instanceof ResponsesWireError ? cause : null;
  const status = wire ? STATUS_BY_REJECTION[wire.code] : 400;
  const code = wire?.code ?? 'malformed_body';
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({ error: { type: 'invalid_request_error', code, message: code, param: null } })
  );
}
