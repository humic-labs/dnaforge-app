import {
  isAnalyticsCaptureReady,
  subscribeAnalyticsCaptureReady,
  trackRendererEvent,
} from '../../lib/analytics';
import { useCanvasStore } from '../canvas/public/store';

import { setPendingPdfRead, takePendingPdfRead, type PdfReadOperation } from './pending-read';
export type { PdfReadOperation, PdfReason, PdfStage } from './pending-read';

let authorityEpoch = 0;
subscribeAnalyticsCaptureReady(() => {
  authorityEpoch += 1;
});
const listeners = new Map<string, Set<() => void>>();

export function beginPdfRead(tabId: string): void {
  takePendingPdfRead(tabId)?.cancel(crypto.randomUUID(), 'superseded');
  const operation = createOperation(tabId, 'explicit');
  setPendingPdfRead(tabId, operation);
  operation.emit('accepted', crypto.randomUUID());
  listeners.get(tabId)?.forEach((listener) => listener());
}
export function subscribePdfRead(tabId: string, listener: () => void): () => void {
  const set = listeners.get(tabId) ?? new Set();
  set.add(listener);
  listeners.set(tabId, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(tabId);
  };
}
export function claimPdfRead(tabId: string, reloading: boolean): PdfReadOperation {
  return takePendingPdfRead(tabId) ?? createOperation(tabId, reloading ? 'reload' : 'restored');
}
function createOperation(tabId: string, origin: PdfReadOperation['origin']): PdfReadOperation {
  const id = crypto.randomUUID();
  const epoch = authorityEpoch;
  const eligible = isAnalyticsCaptureReady();
  const startedAt = Date.now();
  const emitted = new Set<string>();
  let settled = false;
  let presented = false;
  const emit: PdfReadOperation['emit'] = (stage, generation, reason = 'none', citationId) => {
    if (stage === 'first_page_presented') {
      if (presented) return false;
      presented = true;
    }
    const key = `${stage}:${generation}:${citationId ?? ''}`;
    if (emitted.has(key)) return false;
    emitted.add(key);
    if (
      stage === 'first_page_presented' ||
      stage === 'page_presented' ||
      stage === 'failed' ||
      stage === 'cancelled'
    )
      settled = true;
    if (!eligible || epoch !== authorityEpoch || !isAnalyticsCaptureReady()) return false;
    const foreground = Object.values(useCanvasStore.getState().panels).some(
      (panel) => panel.activeTabId === tabId
    );
    try {
      return trackRendererEvent('pdf_stage', {
        feature_area: 'file',
        operation_id: id,
        pdf_generation_id: generation,
        pdf_citation_id: citationId,
        pdf_stage: stage,
        pdf_reason: reason,
        pdf_origin: origin,
        pdf_visibility: foreground ? 'foreground' : 'background',
        pdf_started_at_ms: startedAt,
        occurred_at_ms: Date.now(),
      });
    } catch {
      return false;
    }
  };
  return {
    id,
    origin,
    emit,
    cancel(generation, reason) {
      if (!settled) emit('cancelled', generation, reason);
    },
  };
}
