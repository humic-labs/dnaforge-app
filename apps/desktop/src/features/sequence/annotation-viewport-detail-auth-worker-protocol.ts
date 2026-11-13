export type AnnotationViewportDetailAuthWorkerRequest = Readonly<{
  id: number;
  type: 'authenticate';
  payload: Uint8Array<ArrayBuffer>;
}>;

export type AnnotationViewportDetailAuthWorkerResponse =
  | Readonly<{
      id: number;
      type: 'result';
      payload: Uint8Array<ArrayBuffer>;
      sha256: string;
    }>
  | Readonly<{
      id: number;
      type: 'error';
      error: Readonly<{ name: string; message: string }>;
    }>;

export interface AnnotationViewportDetailAuthWorkerLike {
  postMessage(message: AnnotationViewportDetailAuthWorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  terminate(): void;
}
