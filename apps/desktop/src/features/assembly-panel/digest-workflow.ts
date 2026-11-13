import { getAnalyticsCaptureGeneration, isAnalyticsCaptureReady } from '../../lib/analytics';
import { getTelemetryCorrelationContext } from '../../lib/telemetry-correlation';
import {
  beginWorkflowAction,
  observeWorkflowAction,
  type WorkflowOperation,
  type WorkflowResultMetadata,
} from '../../lib/workflow-telemetry';
import { MAX_DIGEST_OBSERVATION_COUNT } from '../../shared/scientific-workflow-vocab';
import type { VirtualDigestFragment, VirtualDigestResult } from './hooks/useVirtualDigest';

export const DIGEST_RESULT_MIME_TYPE = 'application/x-dnaforge-digest-result';
const resultReceipts = new WeakMap<object, DigestResultReceipt>();
interface DigestTransferBinding {
  receipt: DigestResultReceipt;
  fragment: object;
  material: string;
}
const transferReceipts = new WeakMap<object, DigestTransferBinding>();
const activeTransfers = new Map<string, DigestTransferBinding>();
const fragmentDragKeys = new WeakMap<object, string>();
const boundedCount = (count: number) =>
  Math.min(MAX_DIGEST_OBSERVATION_COUNT, Math.max(0, Math.trunc(count)));

function captureContext(): string | null {
  if (!isAnalyticsCaptureReady()) return null;
  const context = getTelemetryCorrelationContext();
  return `${getAnalyticsCaptureGeneration()}:${context.appSessionId}:${context.episodeCorrelationId}`;
}

export interface DigestWorkflowPorts {
  context: () => string | null;
  createId: () => string;
  begin: typeof beginWorkflowAction;
  observe: typeof observeWorkflowAction;
}

export type DigestUseOperation = Pick<
  WorkflowOperation,
  'actionId' | 'consumed' | 'complete' | 'fail'
>;

export interface DigestResultReceipt {
  readonly resultId: string;
  isCurrent(): boolean;
  ownsFragment(fragment: object): boolean;
  beginUse(fragment: object, action: 'select' | 'copy' | 'place'): DigestUseOperation | null;
}

export function safelyObserveDigest<T>(observe: () => T): T | undefined {
  try {
    return observe();
  } catch {
    return undefined;
  }
}

export function digestReceiptFor(fragments: object): DigestResultReceipt | undefined {
  return safelyObserveDigest(() => resultReceipts.get(fragments));
}

function materialFor(target: object): string | null {
  const value = target as Record<string, unknown>;
  const sourceId = value.sourceSequenceId ?? value.sourceId;
  const start = value.sourceStart ?? value.start;
  const end = value.sourceEnd ?? value.end;
  if (
    typeof value.sequence !== 'string' ||
    typeof sourceId !== 'string' ||
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    (value.sourceType !== 'rd' && value.type !== 'rd-fragment')
  )
    return null;
  return JSON.stringify({
    sequence: value.sequence,
    sourceId,
    start,
    end,
    sourceSequence: value.sourceSequence,
    sourceIsCircular: value.sourceIsCircular,
    annotations: value.annotations ?? [],
    sourceAnnotations: value.sourceAnnotations,
    ggType: value.ggType,
    rdOverhangs: value.rdOverhangs ?? {
      upstream: value.upstreamOverhang,
      downstream: value.downstreamOverhang,
    },
    rdSourceEnzyme: value.rdSourceEnzyme,
    rdSourceEnzymeName: value.rdSourceEnzymeName,
    rdEnds: value.rdEnds,
    rdSiblingOverhangs: value.rdSiblingOverhangs ?? value.siblingOverhangs,
  });
}

function matchesDigestTransfer(target: object, binding: DigestTransferBinding): boolean {
  const value = target as { type?: unknown; fragmentIndex?: unknown };
  return (
    materialFor(target) === binding.material &&
    (value.type !== 'rd-fragment' ||
      value.fragmentIndex === (binding.fragment as VirtualDigestFragment).index)
  );
}

export function bindDigestTransfer(
  target: object | null,
  receipt: DigestResultReceipt | undefined,
  fragment: object
): void {
  safelyObserveDigest(() => {
    if (target) transferReceipts.delete(target);
    if (!target || !receipt?.ownsFragment(fragment)) return;
    const intended = fragment as VirtualDigestFragment;
    const value = target as Record<string, unknown>;
    const end = intended.wrapsOrigin
      ? intended.startPosition + intended.length
      : intended.endPosition;
    if (
      (value.sourceStart ?? value.start) !== intended.startPosition ||
      (value.sourceEnd ?? value.end) !== end ||
      typeof value.sequence !== 'string' ||
      value.sequence.length !== intended.length ||
      (value.type === 'rd-fragment' && value.fragmentIndex !== intended.index)
    )
      return;
    const material = materialFor(target);
    if (material) transferReceipts.set(target, { receipt, fragment, material });
  });
}

export function inheritDigestTransfer(target: object, source: object): void {
  safelyObserveDigest(() => {
    const binding = transferReceipts.get(source);
    transferReceipts.delete(target);
    if (
      binding?.receipt.ownsFragment(binding.fragment) &&
      matchesDigestTransfer(source, binding) &&
      matchesDigestTransfer(target, binding)
    )
      transferReceipts.set(target, binding);
  });
}

export function createDigestDrag(
  target: object,
  receipt: DigestResultReceipt | undefined,
  fragment: object
): string | undefined {
  return safelyObserveDigest(() => {
    bindDigestTransfer(target, receipt, fragment);
    const binding = transferReceipts.get(target);
    if (!binding) return undefined;
    const previousKey = fragmentDragKeys.get(fragment);
    const key =
      previousKey && activeTransfers.get(previousKey)?.receipt === receipt
        ? previousKey
        : crypto.randomUUID();
    fragmentDragKeys.set(fragment, key);
    activeTransfers.set(key, binding);
    return key;
  });
}

export function bindDigestDrag(target: object, key: string): void {
  safelyObserveDigest(() => {
    transferReceipts.delete(target);
    const binding = activeTransfers.get(key);
    if (binding?.receipt.ownsFragment(binding.fragment) && matchesDigestTransfer(target, binding)) {
      transferReceipts.set(target, binding);
    }
  });
}

export function refuseDigestTransfer(source: object | null | undefined): void {
  safelyObserveDigest(() => {
    const binding = source ? transferReceipts.get(source) : undefined;
    if (!source || !binding || !matchesDigestTransfer(source, binding)) return;
    binding.receipt.beginUse(binding.fragment, 'place')?.fail('validation', {
      status: 'blocked',
      outcomeKind: 'digest_use_refused',
      affectedCount: 0,
    });
  });
}

export function placeDigestTransfer<T>(
  source: object | null | undefined,
  readRegions: () => readonly object[] | undefined,
  place: () => T
): T {
  const binding = safelyObserveDigest(() => (source ? transferReceipts.get(source) : undefined));
  const before = safelyObserveDigest(readRegions);
  const operation = safelyObserveDigest(() =>
    source && binding && Array.isArray(before) && matchesDigestTransfer(source, binding)
      ? binding.receipt.beginUse(binding.fragment, 'place')
      : null
  );
  try {
    const result = place();
    safelyObserveDigest(() => {
      if (!operation || !binding || !before) return;
      const after = safelyObserveDigest(readRegions);
      if (!after) {
        operation.fail('unknown', { status: 'needs_action', outcomeKind: 'digest_use_unattested' });
        return;
      }
      const accepted = after.some((region) => {
        const id = (region as { id?: unknown }).id;
        if (typeof id !== 'string' || materialFor(region) !== binding.material) return false;
        const prior = before.find((old) => (old as { id?: unknown }).id === id);
        return !prior || (prior !== region && materialFor(prior) !== binding.material);
      });
      if (accepted) operation.complete({ outcomeKind: 'digest_use_accepted', affectedCount: 1 });
      else
        operation.fail('validation', {
          status: 'blocked',
          outcomeKind: 'digest_use_refused',
          affectedCount: 0,
        });
    });
    return result;
  } catch (error) {
    safelyObserveDigest(() => operation?.fail('unknown', { outcomeKind: 'digest_use_refused' }));
    throw error;
  }
}

export function createDigestWorkflow(overrides: Partial<DigestWorkflowPorts> = {}) {
  const ports: DigestWorkflowPorts = {
    context: captureContext,
    createId: () => crypto.randomUUID(),
    begin: beginWorkflowAction,
    observe: observeWorkflowAction,
    ...overrides,
  };
  let current: DigestResultReceipt | undefined;
  let currentResult: VirtualDigestResult | null = null;
  let lastCalculation: object | undefined;
  let acceptedContext: string | null = null;
  let pending: { key: string; context: string | null; initiator: 'user' | 'system' } | undefined;
  let retiredOperationId: string | undefined;
  let retiredResultId: string | undefined;

  const retire = () => {
    for (const [key, binding] of activeTransfers) {
      if (binding.receipt === current) activeTransfers.delete(key);
    }
    current = undefined;
    currentResult = null;
  };
  return {
    request(key: string, initiator: 'user' | 'system' = 'user') {
      const context = ports.context();
      if (acceptedContext !== context) {
        retiredOperationId = undefined;
        retiredResultId = undefined;
      }
      pending = { key, context, initiator };
      retire();
    },
    retireIfContextChanged() {
      const context = ports.context();
      if (
        (pending && pending.context !== context) ||
        (acceptedContext && acceptedContext !== context)
      ) {
        pending = undefined;
        acceptedContext = null;
        retiredOperationId = undefined;
        retiredResultId = undefined;
        retire();
      }
    },
    retire() {
      pending = undefined;
      acceptedContext = null;
      retiredOperationId = undefined;
      retiredResultId = undefined;
      lastCalculation = undefined;
      retire();
    },
    commit(
      key: string,
      result: VirtualDigestResult | null,
      errorClass?: 'limit' | 'unknown',
      calculation?: object
    ) {
      const context = ports.context();
      if (pending && pending.key !== key) {
        pending = undefined;
        return;
      }
      const request = pending?.key === key ? pending : undefined;
      if (request) pending = undefined;
      if (request && !key) {
        retire();
        acceptedContext = null;
        if (context && request.context === context)
          ports.observe({
            workflow: 'digest',
            action: 'deactivate',
            workflowOrigin: 'direct',
            initiator: request.initiator,
            operationId: retiredOperationId,
            artifactCorrelationId: retiredResultId,
            status: 'stopped',
            outcomeKind: 'digest_deactivated',
          });
        return;
      }
      if (!key) {
        retire();
        acceptedContext = null;
        return;
      }
      if (request) acceptedContext = request.context;
      if (!context || acceptedContext !== context) {
        retire();
        acceptedContext = null;
        retiredOperationId = undefined;
        retiredResultId = undefined;
        return;
      }
      if (
        !request &&
        (calculation
          ? lastCalculation === calculation
          : currentResult === result && current?.isCurrent())
      )
        return;
      lastCalculation = calculation;
      retire();
      const operationId = ports.createId();
      const resultId = ports.createId();
      const metadata: WorkflowResultMetadata = {
        operationId,
        artifactCorrelationId: resultId,
        digestTrigger: request ? 'activation' : 'recompute',
        ...(result
          ? {
              digestTopology: result.circular ? 'circular' : 'linear',
              digestReadiness:
                result.digestKind === 'goldengate' ? result.ggStatus : 'not_applicable',
              digestCutCount: boundedCount(result.cutSiteCount),
              digestEnzymeCount: boundedCount(result.enzymeNames.length),
              resultCount: boundedCount(result.fragments.length),
            }
          : {}),
      };
      const operation = ports.begin({
        workflow: 'digest',
        action: 'compute',
        actionId: operationId,
        workflowOrigin: 'direct',
        initiator: request?.initiator ?? 'system',
        ...metadata,
      });
      const remember = (published: boolean) => {
        retiredOperationId = published ? operationId : undefined;
        retiredResultId = published ? resultId : undefined;
        if (!published) acceptedContext = null;
      };
      if (errorClass) {
        const published = operation.fail(errorClass === 'limit' ? 'validation' : 'unknown', {
          outcomeKind: errorClass === 'limit' ? 'digest_limit' : 'digest_error',
        });
        remember(published);
        return;
      }
      if (!result) {
        remember(
          operation.fail('validation', { status: 'blocked', outcomeKind: 'digest_input_missing' })
        );
        return;
      }
      const published = operation.complete({
        status: result.cutSiteCount === 0 ? 'no_match' : 'completed',
        outcomeKind: result.cutSiteCount === 0 ? 'digest_no_cuts' : 'digest_fragments',
        usableResult: false,
        valueDelivered: false,
      });
      remember(published);
      if (!published) return;
      const receipt: DigestResultReceipt = {
        resultId,
        isCurrent: () => {
          if (current !== receipt) return false;
          if (ports.context() !== context) {
            acceptedContext = null;
            retiredOperationId = undefined;
            retiredResultId = undefined;
            retire();
            return false;
          }
          return true;
        },
        ownsFragment: (fragment) =>
          receipt.isCurrent() && result.fragments.some((candidate) => candidate === fragment),
        beginUse(fragment, action) {
          if (!receipt.isCurrent() || !fragment || !receipt.ownsFragment(fragment)) return null;
          const use = ports.begin({
            workflow: 'digest',
            action,
            workflowOrigin: 'direct',
            operationId,
            artifactCorrelationId: resultId,
          });
          return {
            actionId: use.actionId,
            get consumed() {
              return use.consumed;
            },
            complete: (extra) => (receipt.isCurrent() ? use.complete(extra) : false),
            fail: (error, extra) => (receipt.isCurrent() ? use.fail(error, extra) : false),
          };
        },
      };
      current = receipt;
      currentResult = result;
      resultReceipts.set(result.fragments, receipt);
    },
  };
}
