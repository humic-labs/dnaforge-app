import { useCanvasStore } from '../canvas/public/store';
import type { DocumentOpenResult } from '../canvas/public/document-presentation';
import {
  beginWorkflowAction,
  observeWorkflowAction,
  type WorkflowOperation,
} from '../../lib/workflow-telemetry';
import {
  getAnalyticsIdentifiedAccountId,
  getMeaningfulActivityAuthority,
  isAnalyticsCaptureReady,
  isAnalyticsIdentityIdentified,
  subscribeAnalyticsCaptureReady,
  trackRendererEvent,
} from '../../lib/analytics';
import { getTelemetryCorrelationContext } from '../../lib/telemetry-correlation';
import { storePendingMeaningfulActivityReceipt } from '../../lib/meaningful-activity-pending';
import type { WorkflowOutcomeKind } from '../../shared/scientific-workflow-vocab';

type Dependencies = NonNullable<Parameters<typeof beginWorkflowAction>[1]>;
export type ImageReadFailure = 'read_unknown' | 'decode_unknown' | 'prepare_unknown';
type Binding = { tabId: string; filePath: string; sourceFileName?: string };
type Owner = {
  binding: Binding;
  generationId: string | null;
  phase: 'created' | 'reading' | 'decoding' | 'ready' | 'failed';
  failure: ImageReadFailure;
  disposed: boolean;
};
interface ImageOpenRequest {
  expected: { filePath: string; sourceFileName?: string };
  candidates: Map<string, { sourceFileName?: string; owner: Owner | undefined }>;
  id: string;
  operation: WorkflowOperation | null;
  dependencies: Dependencies;
  binding: Binding | null;
  owner: Owner | null;
  disposition: 'created' | 'reused' | 'retry';
  settled: boolean;
  unsubscribe: (() => void) | null;
  removeAbort: (() => void) | null;
  releaseOrigin: () => void;
}
const owners = new Map<string, Owner>();
const requests = new Map<string, ImageOpenRequest>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function opaqueId(create: () => string = () => crypto.randomUUID()): string | null {
  try {
    const id = create();
    return UUID.test(id) ? id : null;
  } catch {
    return null;
  }
}
function locate(binding: Binding) {
  const state = useCanvasStore.getState();
  for (const panel of Object.values(state.panels)) {
    const tab = panel.tabs.find((candidate) => candidate.id === binding.tabId);
    if (
      tab?.type === 'image' &&
      tab.entityId === binding.filePath &&
      tab.sourceFileName === binding.sourceFileName
    )
      return { panel, tab, focused: state.focusedPanelId === panel.id };
  }
  return null;
}
function visible(binding: Binding): boolean {
  const found = locate(binding);
  return !!found && found.focused && found.panel.activeTabId === binding.tabId;
}
function current(owner: Owner): boolean {
  return !owner.disposed && owners.get(owner.binding.tabId) === owner && !!locate(owner.binding);
}

function captureImageOrigin(dependencies: Dependencies): {
  dependencies: Dependencies;
  release: () => void;
} {
  const usesRenderer = dependencies.track === undefined;
  const track = dependencies.track ?? trackRendererEvent;
  const storePending = dependencies.storePending ?? storePendingMeaningfulActivityReceipt;
  const correlation = { ...getTelemetryCorrelationContext() };
  const accountId = usesRenderer ? getAnalyticsIdentifiedAccountId() : null;
  const identified = (dependencies.isIdentified ?? isAnalyticsIdentityIdentified)();
  const authority = { ...(dependencies.activityAuthority ?? getMeaningfulActivityAuthority)() };
  let active = !usesRenderer || isAnalyticsCaptureReady();
  const allowed = () => {
    if (!active) return false;
    const now = getTelemetryCorrelationContext();
    if (
      now.appSessionId !== correlation.appSessionId ||
      now.episodeCorrelationId !== correlation.episodeCorrelationId ||
      (usesRenderer &&
        (!isAnalyticsCaptureReady() || getAnalyticsIdentifiedAccountId() !== accountId))
    )
      active = false;
    return active;
  };
  const unsubscribe = usesRenderer
    ? subscribeAnalyticsCaptureReady(() => {
        allowed();
      })
    : () => undefined;
  return {
    dependencies: {
      ...dependencies,
      track: (event, properties) => allowed() && track(event, properties),
      isIdentified: () => allowed() && identified,
      activityAuthority: () => authority,
      storePending: (receipt) => (allowed() ? storePending(receipt) : Promise.resolve()),
    },
    release: () => {
      active = false;
      unsubscribe();
    },
  };
}
function finish(
  request: ImageOpenRequest,
  result: 'ready' | 'failed' | 'cancelled',
  kind: WorkflowOutcomeKind,
  reason: ImageReadFailure | 'open_refused' = 'open_refused'
): void {
  if (request.settled) return;
  request.settled = true;
  request.unsubscribe?.();
  request.removeAbort?.();
  if (request.binding && requests.get(request.binding.tabId) === request)
    requests.delete(request.binding.tabId);
  const operationId = request.owner?.generationId ?? undefined;
  try {
    const accepted =
      result === 'ready'
        ? request.operation?.complete({ status: 'ready', outcomeKind: kind, operationId })
        : result === 'failed'
          ? request.operation?.fail(reason, { status: 'failed', outcomeKind: kind, operationId })
          : request.operation?.cancel({ status: 'cancelled', outcomeKind: kind, operationId });
    if (accepted && result === 'ready' && request.binding && visible(request.binding)) {
      observeWorkflowAction(
        {
          workflow: 'content',
          action: 'view',
          phase: 'result',
          status: 'viewed',
          actionId: request.id,
          operationId,
        },
        request.dependencies
      );
    }
  } catch (_error) {
    void _error;
  } finally {
    request.releaseOrigin();
  }
}
function stage(request: ImageOpenRequest, kind: WorkflowOutcomeKind): void {
  if (request.settled || request.operation?.startAccepted !== true) return;
  try {
    observeWorkflowAction(
      {
        workflow: 'image',
        action: request.disposition === 'retry' ? 'run' : 'open',
        actionId: request.id,
        operationId: request.owner?.generationId ?? undefined,
        phase: 'commit',
        status: 'started',
        outcomeKind: kind,
        initiator: 'system',
      },
      request.dependencies
    );
  } catch (_error) {
    void _error;
  }
}
function attach(request: ImageOpenRequest, owner: Owner): void {
  if (request.settled || !current(owner)) return;
  if (
    !request.binding ||
    owner.binding.filePath !== request.binding.filePath ||
    owner.binding.sourceFileName !== request.binding.sourceFileName
  ) {
    finish(request, 'cancelled', 'image_cancelled');
    return;
  }
  request.owner = owner;
  if (!owner.generationId) {
    finish(request, 'cancelled', 'image_cancelled');
    return;
  }
  if (owner.phase === 'ready')
    finish(
      request,
      'ready',
      request.disposition === 'reused' ? 'image_reuse_ready' : 'image_decode_ready'
    );
  else if (owner.phase === 'failed') finish(request, 'failed', 'image_reuse_failed', owner.failure);
  else if (owner.phase === 'reading') stage(request, 'image_read_inflight');
  else if (owner.phase === 'decoding') stage(request, 'image_bytes_ready');
}

export function beginImageOpenRequest(
  expected: { filePath: string; sourceFileName?: string },
  signal?: AbortSignal,
  dependencies: Dependencies = {},
  origin: 'open' | 'retry' = 'open'
): ImageOpenRequest | null {
  const expectedTarget = { ...expected };
  const candidates = new Map<string, { sourceFileName?: string; owner: Owner | undefined }>();
  for (const panel of Object.values(useCanvasStore.getState().panels)) {
    for (const tab of panel.tabs)
      if (tab.type === 'image' && tab.entityId === expectedTarget.filePath) {
        const owner = owners.get(tab.id);
        candidates.set(tab.id, {
          sourceFileName: tab.sourceFileName,
          owner: owner && current(owner) ? owner : undefined,
        });
      }
  }
  const id = opaqueId(dependencies.createId);
  if (!id) return null;
  let originAuthority: ReturnType<typeof captureImageOrigin>;
  try {
    originAuthority = captureImageOrigin(dependencies);
  } catch {
    originAuthority = {
      dependencies: { ...dependencies, track: () => false },
      release: () => undefined,
    };
  }
  dependencies = originAuthority.dependencies;
  let operation: WorkflowOperation | null = null;
  try {
    operation = beginWorkflowAction(
      {
        workflow: 'image',
        action: origin === 'retry' ? 'run' : 'open',
        actionId: id,
        initiator: 'system',
      },
      dependencies
    );
  } catch (_error) {
    void _error;
  }
  const request: ImageOpenRequest = {
    expected: expectedTarget,
    candidates,
    id,
    operation,
    dependencies,
    binding: null,
    owner: null,
    disposition: origin === 'retry' ? 'retry' : 'created',
    settled: false,
    unsubscribe: null,
    removeAbort: null,
    releaseOrigin: originAuthority.release,
  };
  if (signal) {
    const abort = () => finish(request, 'cancelled', 'image_cancelled');
    signal.addEventListener('abort', abort, { once: true });
    request.removeAbort = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) abort();
  }
  return request;
}

export function admitImageOpen(request: ImageOpenRequest | null, result: DocumentOpenResult): void {
  if (!request || request.settled) return;
  if (request.binding && result.status === 'presented') return;
  if (result.status !== 'presented' || result.tabType !== 'image') {
    finish(
      request,
      result.status === 'cancelled' ? 'cancelled' : 'failed',
      result.status === 'cancelled' ? 'image_cancelled' : 'image_open_refused'
    );
    return;
  }
  const tab = useCanvasStore
    .getState()
    .panels[result.panelId]?.tabs.find((candidate) => candidate.id === result.tabId);
  if (!tab || tab.type !== 'image' || tab.entityId !== request.expected.filePath) {
    finish(request, 'cancelled', 'image_cancelled');
    return;
  }
  const candidate = request.candidates.get(tab.id);
  if (
    (result.disposition === 'reused' &&
      (!candidate ||
        tab.sourceFileName !== candidate.sourceFileName ||
        (candidate.owner && owners.get(tab.id) !== candidate.owner))) ||
    (result.disposition === 'created' && tab.sourceFileName !== request.expected.sourceFileName) ||
    (request.expected.sourceFileName !== undefined &&
      tab.sourceFileName !== request.expected.sourceFileName)
  ) {
    finish(request, 'cancelled', 'image_cancelled');
    return;
  }
  request.binding = { tabId: tab.id, filePath: tab.entityId, sourceFileName: tab.sourceFileName };
  if (request.disposition !== 'retry') request.disposition = result.disposition;
  const previous = requests.get(tab.id);
  if (previous) finish(previous, 'cancelled', 'image_cancelled');
  requests.set(tab.id, request);
  request.unsubscribe = useCanvasStore.subscribe(() => {
    if (request.binding && !visible(request.binding))
      finish(request, 'cancelled', 'image_cancelled');
  });
  if (!visible(request.binding)) {
    finish(request, 'cancelled', 'image_cancelled');
    return;
  }
  stage(
    request,
    request.disposition === 'retry'
      ? 'image_retry'
      : result.disposition === 'created'
        ? 'image_open_created'
        : 'image_open_reused'
  );
  if (request.settled) return;
  const owner = owners.get(tab.id);
  if (owner) attach(request, owner);
}

export interface ImageReadLease {
  isCurrent(): boolean;
  isVisible(): boolean;
  readStarted(): void;
  bytesReady(): void;
  decoded(): void;
  fail(reason: ImageReadFailure): void;
  dispose(): void;
}

export function beginImageRead(
  input: { tabId?: string; filePath: string; sourceFileName?: string; retry?: boolean },
  dependencies: Dependencies = {}
): ImageReadLease {
  const binding = input.tabId
    ? { tabId: input.tabId, filePath: input.filePath, sourceFileName: input.sourceFileName }
    : null;
  const owner: Owner | null = binding
    ? {
        binding,
        generationId: opaqueId(dependencies.createId),
        phase: 'created',
        failure: 'read_unknown',
        disposed: false,
      }
    : null;
  if (owner && locate(owner.binding)) {
    const previous = owners.get(owner.binding.tabId);
    if (previous) {
      previous.disposed = true;
      const pending = requests.get(owner.binding.tabId);
      if (pending?.owner === previous) finish(pending, 'cancelled', 'image_cancelled');
    }
    owners.set(owner.binding.tabId, owner);
    if (input.retry && visible(owner.binding)) {
      const retry = beginImageOpenRequest(
        { filePath: input.filePath, sourceFileName: input.sourceFileName },
        undefined,
        dependencies,
        'retry'
      );
      if (retry) {
        const found = locate(owner.binding);
        if (found) {
          admitImageOpen(retry, {
            status: 'presented',
            panelId: found.panel.id,
            tabId: found.tab.id,
            tabType: 'image',
            disposition: 'reused',
            content: 'loading',
          });
        }
      }
    }
    const pending = requests.get(owner.binding.tabId);
    if (pending) attach(pending, owner);
  }
  let disposed = false;
  const valid = () => !disposed && (!owner || current(owner));
  const pending = () => (owner ? requests.get(owner.binding.tabId) : undefined);
  return {
    isCurrent: valid,
    isVisible: () => !binding || visible(binding),
    readStarted: () => {
      if (!valid() || !owner || owner.phase !== 'created') return;
      owner.phase = 'reading';
      const request = pending();
      if (request) stage(request, 'image_read_started');
    },
    bytesReady: () => {
      if (!valid() || !owner || owner.phase !== 'reading') return;
      owner.phase = 'decoding';
      const request = pending();
      if (request) stage(request, 'image_bytes_ready');
    },
    decoded: () => {
      if (!valid() || !owner || owner.phase !== 'decoding') return;
      owner.phase = 'ready';
      const request = pending();
      if (request) finish(request, 'ready', 'image_decode_ready');
    },
    fail: (reason) => {
      if (!valid() || !owner || owner.phase === 'ready' || owner.phase === 'failed') return;
      owner.phase = 'failed';
      owner.failure = reason;
      const request = pending();
      if (request)
        finish(
          request,
          'failed',
          reason === 'decode_unknown'
            ? 'image_decode_failed'
            : reason === 'prepare_unknown'
              ? 'image_prepare_failed'
              : 'image_read_failed',
          reason
        );
    },
    dispose: () => {
      disposed = true;
      if (!owner || owners.get(owner.binding.tabId) !== owner) return;
      owner.disposed = true;
      owners.delete(owner.binding.tabId);
      const request = pending();
      if (request?.owner === owner) finish(request, 'cancelled', 'image_cancelled');
    },
  };
}

export function resetImageViewLifecycleForTests(): void {
  for (const request of requests.values()) finish(request, 'cancelled', 'image_cancelled');
  owners.clear();
  requests.clear();
}
