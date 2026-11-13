export type PdfStage =
  | 'accepted'
  | 'parsed'
  | 'canvas_complete'
  | 'text_ready'
  | 'text_unavailable'
  | 'page_presented'
  | 'first_page_presented'
  | 'failed'
  | 'cancelled'
  | 'retry'
  | 'identity_refused'
  | 'citation_requested'
  | 'citation_arrived';
export type PdfReason =
  | 'none'
  | 'load'
  | 'page'
  | 'canvas'
  | 'text'
  | 'closed'
  | 'superseded'
  | 'source_identity';
export type PdfReadOperation = {
  readonly id: string;
  readonly origin: 'explicit' | 'restored' | 'reload';
  emit(stage: PdfStage, generation: string, reason?: PdfReason, citationId?: string): boolean;
  cancel(generation: string, reason: 'closed' | 'superseded'): void;
};
const pending = new Map<string, PdfReadOperation>();

export function setPendingPdfRead(tabId: string, operation: PdfReadOperation): void {
  pending.set(tabId, operation);
}

export function takePendingPdfRead(tabId: string): PdfReadOperation | undefined {
  const operation = pending.get(tabId);
  pending.delete(tabId);
  return operation;
}

export function cancelPendingPdfRead(tabId: string): void {
  const operation = takePendingPdfRead(tabId);
  if (!operation) return;
  try {
    operation.cancel(crypto.randomUUID(), 'closed');
  } catch {}
}
