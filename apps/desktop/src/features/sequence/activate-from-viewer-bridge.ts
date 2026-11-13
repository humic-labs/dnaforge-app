export interface ActivateFromViewerBridge {
  _activateFromViewer?: Record<string, unknown>;
  activateAnnotationFromViewer?: unknown;
  _editFromViewer?: Record<string, unknown>;
  editAnnotationFromViewer?: unknown;
  _getAnnotationDraft?: Record<string, unknown>;
  getAnnotationDraft?: unknown;
  _saves?: Record<string, unknown>;
  saveActiveSequence?: unknown;
  _selectAnnotationInViewer?: Record<string, unknown>;
  selectAnnotationInViewer?: unknown;
}

interface LatestBridgeHandlerRegistration {
  handlers: Record<string, unknown>;
  ownerId: string;
  handler: unknown;
  getAlias: () => unknown;
  setAlias: (handler: unknown) => void;
}

function registerLatestBridgeHandler({
  handlers,
  ownerId,
  handler,
  getAlias,
  setAlias,
}: LatestBridgeHandlerRegistration): () => void {
  handlers[ownerId] = handler;
  setAlias(handler);

  return () => {
    if (handlers[ownerId] === handler) delete handlers[ownerId];

    if (getAlias() !== handler) return;

    const remaining = Object.values(handlers);
    setAlias(remaining[remaining.length - 1]);
  };
}

export function registerActivateFromViewer(
  bridge: ActivateFromViewerBridge,
  filePath: string,
  handler: unknown
): () => void {
  if (!bridge._activateFromViewer) bridge._activateFromViewer = {};
  return registerLatestBridgeHandler({
    handlers: bridge._activateFromViewer,
    ownerId: filePath,
    handler,
    getAlias: () => bridge.activateAnnotationFromViewer,
    setAlias: (nextHandler) => {
      bridge.activateAnnotationFromViewer = nextHandler;
    },
  });
}

export function registerEditFromViewer(
  bridge: ActivateFromViewerBridge,
  filePath: string,
  handler: unknown
): () => void {
  if (!bridge._editFromViewer) bridge._editFromViewer = {};
  return registerLatestBridgeHandler({
    handlers: bridge._editFromViewer,
    ownerId: filePath,
    handler,
    getAlias: () => bridge.editAnnotationFromViewer,
    setAlias: (nextHandler) => {
      bridge.editAnnotationFromViewer = nextHandler;
    },
  });
}

export function registerGetAnnotationDraft(
  bridge: ActivateFromViewerBridge,
  filePath: string,
  handler: unknown
): () => void {
  if (!bridge._getAnnotationDraft) bridge._getAnnotationDraft = {};
  return registerLatestBridgeHandler({
    handlers: bridge._getAnnotationDraft,
    ownerId: filePath,
    handler,
    getAlias: () => bridge.getAnnotationDraft,
    setAlias: (nextHandler) => {
      bridge.getAnnotationDraft = nextHandler;
    },
  });
}

export function registerSaveActiveSequence(
  bridge: ActivateFromViewerBridge,
  filePath: string,
  handler: unknown
): () => void {
  if (!bridge._saves) bridge._saves = {};
  return registerLatestBridgeHandler({
    handlers: bridge._saves,
    ownerId: filePath,
    handler,
    getAlias: () => bridge.saveActiveSequence,
    setAlias: (nextHandler) => {
      bridge.saveActiveSequence = nextHandler;
    },
  });
}

export function registerSelectAnnotationInViewer(
  bridge: ActivateFromViewerBridge,
  filePath: string,
  handler: unknown
): () => void {
  if (!bridge._selectAnnotationInViewer) bridge._selectAnnotationInViewer = {};
  return registerLatestBridgeHandler({
    handlers: bridge._selectAnnotationInViewer,
    ownerId: filePath,
    handler,
    getAlias: () => bridge.selectAnnotationInViewer,
    setAlias: (nextHandler) => {
      bridge.selectAnnotationInViewer = nextHandler;
    },
  });
}
