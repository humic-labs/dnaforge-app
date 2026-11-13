import { useCanvasStore } from '../features/canvas/store';
import { observeWorkflowAction } from './workflow-telemetry';
import {
  observeCanvasReadableGeneration,
  type CanvasNavigationOperation,
} from '../features/canvas/navigation-observation';
import type { Tab } from '../features/canvas/types';

type PendingReadableContent = Readonly<{
  tabId: string;
}>;

const pendingByContentKey = new Map<string, PendingReadableContent>();

type ReadableOwnerState = 'loading' | 'readable' | 'failed';
type ReadableOwner = {
  generationId: string;
  tabId: string;
  type: Tab['type'];
  entityId: string;
  state: ReadableOwnerState;
};
type CanvasReadRequest = {
  panelId: string;
  tabId: string;
  type: Tab['type'];
  entityId: string;
  operation: CanvasNavigationOperation;
  placed: boolean;
  unsubscribe: (() => void) | null;
};
const readableOwners = new Map<string, ReadableOwner>();
const canvasReadRequests = new Map<string, CanvasReadRequest>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ReadableContentOwner {
  readonly generationId: string;
  readable(): boolean;
  fail(): boolean;
  release(): void;
}

function requestStillCurrent(request: CanvasReadRequest): boolean {
  const state = useCanvasStore.getState();
  const panel = state.panels[request.panelId];
  const tab = panel?.tabs.find((candidate) => candidate.id === request.tabId);
  return (
    state.focusedPanelId === request.panelId &&
    panel?.activeTabId === request.tabId &&
    !!tab &&
    tab.type === request.type &&
    tab.entityId === request.entityId &&
    tab.loadStatus !== 'missing' &&
    tab.loadStatus !== 'error' &&
    tab.loadStatus !== 'deferred-oversized' &&
    tab.loadStatus !== 'indexed-error'
  );
}

function removeCanvasReadRequest(request: CanvasReadRequest): void {
  if (canvasReadRequests.get(request.panelId) !== request) return;
  canvasReadRequests.delete(request.panelId);
  request.unsubscribe?.();
}

function settleCanvasReadRequest(request: CanvasReadRequest): boolean {
  if (!request.placed) return false;
  if (!requestStillCurrent(request)) {
    removeCanvasReadRequest(request);
    return false;
  }
  const owner = readableOwners.get(request.tabId);
  if (
    !owner ||
    owner.type !== request.type ||
    owner.entityId !== request.entityId ||
    owner.state === 'loading'
  )
    return false;
  removeCanvasReadRequest(request);
  return observeCanvasReadableGeneration(
    request.operation,
    owner.generationId,
    owner.state === 'readable' ? 'readable' : 'failed'
  );
}

export function beginReadableContentOwner(input: {
  tabId?: string;
  contentKey: string;
}): ReadableContentOwner | null {
  if (!input.tabId) return null;
  const tab = Object.values(useCanvasStore.getState().panels)
    .flatMap((panel) => panel.tabs)
    .find((candidate) => candidate.id === input.tabId);
  if (!tab || tab.entityId !== input.contentKey) return null;
  let generationId: string;
  try {
    generationId = crypto.randomUUID();
  } catch {
    return null;
  }
  if (!UUID.test(generationId)) return null;
  const owner: ReadableOwner = {
    generationId,
    tabId: tab.id,
    type: tab.type,
    entityId: tab.entityId,
    state: 'loading',
  };
  readableOwners.set(tab.id, owner);
  const settle = (next: ReadableOwnerState): boolean => {
    if (readableOwners.get(owner.tabId) !== owner) return false;
    if (owner.state !== 'loading' && owner.state !== next) return false;
    owner.state = next;
    let accepted = false;
    for (const request of canvasReadRequests.values()) {
      if (request.tabId === owner.tabId) accepted = settleCanvasReadRequest(request) || accepted;
    }
    return accepted;
  };
  return {
    generationId,
    readable: () => settle('readable'),
    fail: () => settle('failed'),
    release: () => {
      if (readableOwners.get(owner.tabId) === owner) readableOwners.delete(owner.tabId);
    },
  };
}

export function registerCanvasReadRequest(input: {
  panelId: string;
  tabId: string;
  operation: CanvasNavigationOperation | null;
}): void {
  const previous = canvasReadRequests.get(input.panelId);
  if (previous) removeCanvasReadRequest(previous);
  if (!input.operation || !UUID.test(input.operation.id)) return;
  const state = useCanvasStore.getState();
  const panel = state.panels[input.panelId];
  const tab = panel?.tabs.find((candidate) => candidate.id === input.tabId);
  if (!tab || panel?.activeTabId !== tab.id || state.focusedPanelId !== input.panelId) return;
  const request: CanvasReadRequest = {
    panelId: input.panelId,
    tabId: tab.id,
    type: tab.type,
    entityId: tab.entityId,
    operation: input.operation,
    placed: false,
    unsubscribe: null,
  };
  canvasReadRequests.set(input.panelId, request);
  request.unsubscribe = useCanvasStore.subscribe(() => {
    if (!requestStillCurrent(request)) removeCanvasReadRequest(request);
  });
}

export function commitCanvasReadPlacement(operation: CanvasNavigationOperation | null): boolean {
  if (!operation) return false;
  for (const request of canvasReadRequests.values()) {
    if (request.operation.id !== operation.id) continue;
    request.placed = true;
    return settleCanvasReadRequest(request);
  }
  return false;
}

export function cancelCanvasReadRequest(operation: CanvasNavigationOperation | null): void {
  if (!operation) return;
  for (const request of canvasReadRequests.values()) {
    if (request.operation.id === operation.id) removeCanvasReadRequest(request);
  }
}

export function registerPendingReadableContent(input: { contentKey: string; tabId: string }): void {
  if (!input.contentKey || !input.tabId) return;
  pendingByContentKey.set(input.contentKey, { tabId: input.tabId });
}

export function commitReadableContent(contentKey: string): boolean {
  const pending = pendingByContentKey.get(contentKey);
  if (!pending) return false;
  const tabStillExists = Object.values(useCanvasStore.getState().panels).some((panel) =>
    panel.tabs.some((tab) => tab.id === pending.tabId)
  );
  if (!tabStillExists) {
    pendingByContentKey.delete(contentKey);
    return false;
  }
  pendingByContentKey.delete(contentKey);
  try {
    return observeWorkflowAction({
      workflow: 'content',
      action: 'view',
      status: 'viewed',
      phase: 'result',
    });
  } catch {
    return false;
  }
}

export function failReadableContent(contentKey: string): void {
  pendingByContentKey.delete(contentKey);
}

export function __resetReadableContentTelemetryForTests(): void {
  pendingByContentKey.clear();
  readableOwners.clear();
  for (const request of canvasReadRequests.values()) removeCanvasReadRequest(request);
  canvasReadRequests.clear();
}
