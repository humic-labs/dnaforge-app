import type { OpenStrategy } from '../../canvas/public/document-presentation';
import { presentDocument } from '../../canvas/public/present-document';
import { useCanvasStore } from '../../canvas/public/store';
import { stripDisplayExtension } from '../../../utils/fileTypes';

export const GENOME_VIEW_OPEN_REQUESTED = 'dnaforge:genome-view-open-requested';
export const GENOME_VIEW_OPEN_FINISHED = 'dnaforge:genome-view-open-finished';

interface PendingGenomeViewOpen {
  readonly id: number;
  readonly path: string;
  readonly placement?: OpenStrategy;
  readonly tabId: string;
  readonly promise: Promise<string | null>;
  phase: 'awaiting-admission' | 'ready' | 'reading';
  resolve: (tabId: string | null) => void;
  cleanupAbort?: () => void;
  cleanupTabClose?: () => void;
}

let pending: PendingGenomeViewOpen | null = null;
let nextRequestId = 0;

export function requestGenomeViewFileOpen(
  path: string,
  placement?: OpenStrategy,
  signal?: AbortSignal,
  label?: string,
  readAdmission: 'pending' | 'granted' = 'granted'
): Promise<string | null> {
  if (signal?.aborted) return Promise.resolve(null);
  if (pending) {
    if (pending.path === path) {
      focusTab(pending.tabId);
      return pending.promise;
    }
    finishGenomeViewFileOpen(null, pending.id);
  }
  const existing = Object.entries(useCanvasStore.getState().panels)
    .flatMap(([panelId, panel]) => panel.tabs.map((tab) => ({ panelId, tab })))
    .find(({ tab }) => tab.trackView?.path === path && !tab.openingTrackViewPath);
  if (existing) {
    useCanvasStore.getState().setActiveTab(existing.panelId, existing.tab.id);
    return Promise.resolve(existing.tab.id);
  }
  const requestId = ++nextRequestId;
  const openingId = `track-view-opening-${requestId}`;
  const presentation = presentDocument(
    {
      type: 'sequence',
      entityId: openingId,
      label: stripDisplayExtension(label?.trim() || path.split(/[\\/]/).pop() || 'Saved view'),
      sequenceDocument: { kind: 'indexed-sequence', documentId: openingId },
      loadStatus: 'pending',
      openingTrackViewPath: path,
    },
    placement
  );
  if (presentation.status !== 'presented') return Promise.resolve(null);
  let resolveRequest!: (tabId: string | null) => void;
  const promise = new Promise<string | null>((resolve) => {
    resolveRequest = resolve;
  });
  const request: PendingGenomeViewOpen = {
    id: requestId,
    path,
    placement,
    tabId: presentation.tabId,
    phase: readAdmission === 'pending' ? 'awaiting-admission' : 'ready',
    promise,
    resolve: resolveRequest,
  };
  pending = request;
  request.cleanupTabClose = useCanvasStore.subscribe((state) => {
    if (pending !== request) return;
    const stillOpen = Object.values(state.panels).some((panel) =>
      panel.tabs.some((tab) => tab.id === request.tabId)
    );
    if (!stillOpen) finishGenomeViewFileOpen(null, request.id);
  });
  if (signal) {
    const onAbort = () => {
      if (pending === request) finishGenomeViewFileOpen(null, request.id);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    request.cleanupAbort = () => signal.removeEventListener('abort', onAbort);
  }
  window.dispatchEvent(new Event(GENOME_VIEW_OPEN_REQUESTED));
  return promise;
}

export function pendingGenomeViewFileOpen(): Readonly<PendingGenomeViewOpen> | null {
  return pending;
}

export function admitGenomeViewFileOpen(request: Readonly<PendingGenomeViewOpen>): boolean {
  if (pending !== request) {
    return (
      !pending &&
      Object.values(useCanvasStore.getState().panels).some((panel) =>
        panel.tabs.some((tab) => tab.id === request.tabId && !tab.openingTrackViewPath)
      )
    );
  }
  if (pending.phase === 'awaiting-admission') {
    pending.phase = 'ready';
    window.dispatchEvent(new Event(GENOME_VIEW_OPEN_REQUESTED));
  }
  return true;
}

export function startPendingGenomeViewFileOpen(): string | null {
  if (!pending || pending.phase !== 'ready') return null;
  pending.phase = 'reading';
  return pending.path;
}

export function finishGenomeViewFileOpen(tabId: string | null, requestId?: number): void {
  if (requestId !== undefined && pending?.id !== requestId) return;
  const request = pending;
  pending = null;
  request?.cleanupAbort?.();
  request?.cleanupTabClose?.();
  if (request) {
    const location = Object.entries(useCanvasStore.getState().panels).find(([, panel]) =>
      panel.tabs.some((tab) => tab.id === request.tabId)
    );
    if (location) {
      if (tabId === request.tabId) {
        useCanvasStore.getState().updateTab(location[0], request.tabId, {
          openingTrackViewPath: undefined,
        });
      } else {
        useCanvasStore.getState().closeTab(location[0], request.tabId);
      }
    }
  }
  request?.resolve(tabId);
  if (request) window.dispatchEvent(new Event(GENOME_VIEW_OPEN_FINISHED));
}

function focusTab(tabId: string): void {
  for (const [panelId, panel] of Object.entries(useCanvasStore.getState().panels)) {
    if (panel.tabs.some((tab) => tab.id === tabId)) {
      useCanvasStore.getState().setActiveTab(panelId, tabId);
      return;
    }
  }
}

import.meta.hot?.dispose(() => finishGenomeViewFileOpen(null));
