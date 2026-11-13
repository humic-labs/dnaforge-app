import { AnnotationViewportDetailAuthWorkerClient } from './annotation-viewport-detail-auth-worker-client';
import AnnotationViewportDetailAuthWorker from './annotation-viewport-detail-auth-worker?worker&inline';

const DEFAULT_MAX_ACTIVE_AUTHENTICATIONS = 2;
const DEFAULT_MAX_TOTAL_AUTHENTICATIONS = 8;

type AuthenticationResult = Readonly<{
  payload: Uint8Array<ArrayBuffer>;
  sha256: string;
}>;
type DigestSha256 = (payload: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>;
type AuthenticatePayload = (
  payload: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal
) => Promise<AuthenticationResult>;

interface AuthenticationRequest {
  readonly payload: Uint8Array<ArrayBuffer>;
  readonly signal?: AbortSignal;
  readonly resolve: (result: AuthenticationResult) => void;
  readonly reject: (error: Error) => void;
  settled: boolean;
  abortListener: (() => void) | null;
}

export interface AnnotationViewportDetailAuthLifecycleSnapshot {
  readonly active: number;
  readonly queued: number;
  readonly started: number;
  readonly settled: number;
  readonly peakActive: number;
  readonly peakQueued: number;
  readonly maxActive: number;
  readonly maxTotal: number;
}

export interface AnnotationViewportDetailAuthenticatorV1 {
  authenticate(payload: Uint8Array, signal?: AbortSignal): Promise<AuthenticationResult>;
  snapshot(): AnnotationViewportDetailAuthLifecycleSnapshot;
}

export function createAnnotationViewportDetailAuthenticatorV1(options?: {
  readonly digest?: DigestSha256;
  readonly authenticatePayload?: AuthenticatePayload;
  readonly maxActive?: number;
  readonly maxTotal?: number;
}): AnnotationViewportDetailAuthenticatorV1 {
  if (options?.digest && options.authenticatePayload) {
    throw new Error('annotation viewport detail authentication accepts one execution strategy');
  }
  const digest =
    options?.digest ??
    ((payload: Uint8Array<ArrayBuffer>) => crypto.subtle.digest('SHA-256', payload));
  const authenticatePayload: AuthenticatePayload =
    options?.authenticatePayload ??
    (async (payload) => ({ payload, sha256: bytesToHex(new Uint8Array(await digest(payload))) }));
  const maxActive = options?.maxActive ?? DEFAULT_MAX_ACTIVE_AUTHENTICATIONS;
  const maxTotal = options?.maxTotal ?? DEFAULT_MAX_TOTAL_AUTHENTICATIONS;
  if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
    throw new Error('annotation viewport detail authentication maxActive must be at least 1');
  }
  if (!Number.isSafeInteger(maxTotal) || maxTotal < maxActive) {
    throw new Error(
      'annotation viewport detail authentication maxTotal must be at least maxActive'
    );
  }

  let active = 0;
  let started = 0;
  let settled = 0;
  let peakActive = 0;
  let peakQueued = 0;
  const queue: AuthenticationRequest[] = [];

  const snapshot = (): AnnotationViewportDetailAuthLifecycleSnapshot => ({
    active,
    queued: queue.length,
    started,
    settled,
    peakActive,
    peakQueued,
    maxActive,
    maxTotal,
  });

  const settleRejected = (request: AuthenticationRequest, error: Error): void => {
    if (request.settled) return;
    request.settled = true;
    request.reject(error);
  };

  const settleResolved = (request: AuthenticationRequest, result: AuthenticationResult): void => {
    if (request.settled) return;
    request.settled = true;
    request.resolve(result);
  };

  const pump = (): void => {
    while (active < maxActive && queue.length > 0) {
      const request = queue.shift();
      if (!request) return;
      if (request.abortListener) {
        request.signal?.removeEventListener('abort', request.abortListener);
        request.abortListener = null;
      }
      if (request.signal?.aborted) {
        settleRejected(request, abortError());
        continue;
      }

      active += 1;
      started += 1;
      peakActive = Math.max(peakActive, active);
      const onActiveAbort = (): void => settleRejected(request, abortError());
      request.abortListener = onActiveAbort;
      request.signal?.addEventListener('abort', onActiveAbort, { once: true });

      void Promise.resolve()
        .then(() => {
          if (request.signal?.aborted) throw abortError();
          return authenticatePayload(request.payload, request.signal);
        })
        .then(
          (result) => {
            if (request.signal?.aborted) {
              settleRejected(request, abortError());
              return;
            }
            settleResolved(request, result);
          },
          (error: unknown) => {
            settleRejected(request, error instanceof Error ? error : new Error(String(error)));
          }
        )
        .finally(() => {
          if (request.abortListener) {
            request.signal?.removeEventListener('abort', request.abortListener);
            request.abortListener = null;
          }
          active -= 1;
          settled += 1;
          pump();
        });
    }
  };

  return {
    authenticate(payload, signal) {
      if (
        !(payload.buffer instanceof ArrayBuffer) ||
        payload.byteOffset !== 0 ||
        payload.byteLength !== payload.buffer.byteLength
      ) {
        return Promise.reject(
          new Error('annotation viewport detail packet must use an owned ArrayBuffer')
        );
      }
      if (signal?.aborted) return Promise.reject(abortError());
      if (active + queue.length >= maxTotal) {
        return Promise.reject(capacityError(maxTotal));
      }

      return new Promise<AuthenticationResult>((resolve, reject) => {
        const request: AuthenticationRequest = {
          payload: payload as Uint8Array<ArrayBuffer>,
          signal,
          resolve,
          reject,
          settled: false,
          abortListener: null,
        };
        request.abortListener = () => {
          const index = queue.indexOf(request);
          if (index >= 0) queue.splice(index, 1);
          settleRejected(request, abortError());
          pump();
        };
        signal?.addEventListener('abort', request.abortListener, { once: true });
        queue.push(request);
        peakQueued = Math.max(peakQueued, queue.length);
        pump();
      });
    },
    snapshot,
  };
}

const productionAuthenticator = createAnnotationViewportDetailAuthenticatorV1({
  authenticatePayload: (payload, signal) => {
    if (typeof Worker === 'undefined') {
      return crypto.subtle.digest('SHA-256', payload).then((digest) => ({
        payload,
        sha256: bytesToHex(new Uint8Array(digest)),
      }));
    }
    return new AnnotationViewportDetailAuthWorkerClient(
      new AnnotationViewportDetailAuthWorker()
    ).authenticate(payload, signal);
  },
});

export function authenticateAnnotationViewportDetailPayloadV1(
  payload: Uint8Array,
  signal?: AbortSignal
): Promise<AuthenticationResult> {
  return productionAuthenticator.authenticate(payload, signal);
}

export function getAnnotationViewportDetailAuthLifecycleSnapshot(): AnnotationViewportDetailAuthLifecycleSnapshot {
  return productionAuthenticator.snapshot();
}

function abortError(): Error {
  const error = new Error('Annotation viewport detail authentication was cancelled.');
  error.name = 'AbortError';
  return error;
}

function capacityError(limit: number): Error {
  const error = new Error(`Annotation viewport detail authentication capacity reached (${limit}).`);
  error.name = 'AnnotationViewportDetailAuthCapacityError';
  return error;
}

function bytesToHex(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0');
  return value;
}
