import type {
  AnnotationViewportDetailAuthWorkerRequest,
  AnnotationViewportDetailAuthWorkerResponse,
} from './annotation-viewport-detail-auth-worker-protocol';

interface AnnotationViewportDetailAuthWorkerScope {
  onmessage: ((event: MessageEvent<AnnotationViewportDetailAuthWorkerRequest>) => void) | null;
  postMessage(message: AnnotationViewportDetailAuthWorkerResponse, transfer?: Transferable[]): void;
}

const scope = globalThis as typeof globalThis & AnnotationViewportDetailAuthWorkerScope;

scope.onmessage = (event) => {
  void authenticate(event.data);
};

async function authenticate(request: AnnotationViewportDetailAuthWorkerRequest): Promise<void> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', request.payload);
    const sha256 = bytesToHex(new Uint8Array(digest));
    scope.postMessage({ id: request.id, type: 'result', payload: request.payload, sha256 }, [
      request.payload.buffer,
    ]);
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    scope.postMessage({
      id: request.id,
      type: 'error',
      error: { name: normalized.name, message: normalized.message },
    });
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0');
  return value;
}
