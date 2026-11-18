import type { InventoryClient } from '../../shared/inventory-client';
import { inventoryTableCanonicalJson, inventoryTableSha256 } from '@waypoint/domain-services';
import {
  inventoryAcceptedRequestSchema,
  inventoryReceiptSchema,
  type InventoryAcceptedRequest,
  type NativeInventoryExecution,
  type NativeInventoryReceipt,
} from '../../shared/inventory-command';

export interface InventoryAttempt {
  request: InventoryAcceptedRequest;
  summary: string;
  receipt?: NativeInventoryReceipt;
}
export interface InventoryAttemptStorage {
  read(): readonly InventoryAttempt[];
  write(attempts: readonly InventoryAttempt[]): void;
}
type Scope = { project: string; inventoryId: string };
export type InventoryPendingToken = Scope & { operationId: string; requestJson: string };
type Flight = { token: InventoryPendingToken; phase: 'send' | 'inspect'; identity: object };
const STORAGE_KEY = 'dnaforge.inventory.pending.v1';
const key = (scope: Scope) => JSON.stringify([scope.project, scope.inventoryId]);
function checked(attempt: InventoryAttempt): InventoryAttempt {
  if (!attempt || typeof attempt !== 'object' || typeof attempt.summary !== 'string')
    throw Error('Saved inventory changes could not be read.');
  inventoryAcceptedRequestSchema.parse(attempt.request);
  if (attempt.receipt) assertInventoryReceiptForAttempt(attempt, attempt.receipt);
  return attempt;
}
function token(attempt: InventoryAttempt): InventoryPendingToken {
  return {
    project: attempt.request.project,
    inventoryId: attempt.request.inventoryId,
    operationId: attempt.request.operationId,
    requestJson: JSON.stringify(attempt.request),
  };
}
function same(left: InventoryPendingToken, right: InventoryPendingToken) {
  return (
    key(left) === key(right) &&
    left.operationId === right.operationId &&
    left.requestJson === right.requestJson
  );
}
export function assertInventoryReceiptForAttempt(
  attempt: Pick<InventoryAttempt, 'request'>,
  receipt: NativeInventoryReceipt
) {
  inventoryReceiptSchema.parse(receipt);
  const request = attempt.request;
  if (
    receipt.inventoryId !== request.inventoryId ||
    receipt.operationId !== request.operationId ||
    !Number.isSafeInteger(request.expectedRevision + 1) ||
    receipt.revision !== request.expectedRevision + 1 ||
    receipt.requestDigest !== inventoryTableSha256(inventoryTableCanonicalJson(request))
  )
    throw Error('The inventory receipt does not match the exact retained change.');
}
export function inventoryAttemptStorage(
  storage: Pick<Storage, 'getItem' | 'setItem'>
): InventoryAttemptStorage {
  return {
    read() {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value)) throw Error('Saved inventory changes could not be read.');
      return value.map((entry) => checked(entry));
    },
    write: (attempts) => storage.setItem(STORAGE_KEY, JSON.stringify(attempts)),
  };
}
export class InventoryPendingCoordinator {
  private snapshot: { attempts: readonly InventoryAttempt[]; flights: readonly Flight[] } = {
    attempts: [],
    flights: [],
  };
  private listeners = new Set<() => void>();
  private flights = new Map<string, Flight>();
  constructor(private readonly storage: InventoryAttemptStorage) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(attempts: readonly InventoryAttempt[]) {
    const next = { attempts, flights: [...this.flights.values()] };
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  refresh() {
    const attempts = this.storage.read().map(checked),
      seen = new Set<string>();
    for (const attempt of attempts) {
      const scope = key(attempt.request);
      if (seen.has(scope))
        throw Error('More than one unfinished change was saved for this inventory.');
      seen.add(scope);
    }
    this.publish(attempts);
    return attempts;
  }
  peek(scope: Scope) {
    return this.refresh().find((attempt) => key(attempt.request) === key(scope));
  }
  retain(attempt: InventoryAttempt): InventoryPendingToken {
    checked(attempt);
    const attempts = this.refresh(),
      wanted = token(attempt),
      existing = attempts.find((entry) => key(entry.request) === key(wanted));
    if (existing) {
      if (!same(token(existing), wanted))
        throw Error('A previous inventory change needs confirmation before another change.');
      return token(existing);
    }
    if (this.flights.has(key(wanted))) throw Error('An inventory change is still being confirmed.');
    const retained = JSON.parse(JSON.stringify(attempt)) as InventoryAttempt;
    this.storage.write([...attempts, retained]);
    this.publish([...attempts, retained]);
    return token(retained);
  }
  confirm(wanted: InventoryPendingToken, receipt: NativeInventoryReceipt) {
    assertInventoryReceiptForAttempt({ request: JSON.parse(wanted.requestJson) }, receipt);
    const attempts = this.refresh(),
      index = attempts.findIndex((entry) => key(entry.request) === key(wanted));
    if (index < 0 || !same(token(attempts[index]!), wanted))
      throw Error('The retained inventory change was replaced.');
    const current = attempts[index]!;
    if (current.receipt) {
      if (JSON.stringify(current.receipt) !== JSON.stringify(receipt))
        throw Error('The saved inventory receipt changed.');
      return;
    }
    const next = [...attempts];
    next[index] = { ...current, receipt };
    this.storage.write(next);
    this.publish(next);
  }
  clear(wanted: InventoryPendingToken) {
    const attempts = this.refresh(),
      current = attempts.find((entry) => key(entry.request) === key(wanted));
    if (!current) return;
    if (!same(token(current), wanted)) throw Error('The retained inventory change was replaced.');
    const next = attempts.filter((entry) => key(entry.request) !== key(wanted));
    this.storage.write(next);
    this.publish(next);
  }
  acquire(wanted: InventoryPendingToken, phase: 'send' | 'inspect') {
    const current = this.peek(wanted);
    if (!current || !same(token(current), wanted))
      throw Error('The exact retained inventory change is unavailable.');
    if (phase === 'send' && current.receipt)
      throw Error('This change was already saved. Reload its result.');
    if (this.flights.has(key(wanted)))
      throw Error('This inventory change is already being confirmed.');
    const identity = {},
      flight = { token: wanted, phase, identity };
    this.flights.set(key(wanted), flight);
    this.publish(this.snapshot.attempts);
    return () => {
      if (this.flights.get(key(wanted))?.identity !== identity) return;
      this.flights.delete(key(wanted));
      this.publish(this.snapshot.attempts);
    };
  }
}
const coordinators = new WeakMap<InventoryAttemptStorage, InventoryPendingCoordinator>();
export function coordinatorForStorage(storage: InventoryAttemptStorage) {
  let owner = coordinators.get(storage);
  if (!owner) {
    owner = new InventoryPendingCoordinator(storage);
    coordinators.set(storage, owner);
  }
  return owner;
}
let runtime: InventoryPendingCoordinator | undefined;
export function sharedInventoryPendingCoordinator() {
  if (!runtime)
    runtime = coordinatorForStorage(
      inventoryAttemptStorage({
        getItem: (key) => localStorage.getItem(key),
        setItem: (key, value) => localStorage.setItem(key, value),
      })
    );
  return runtime;
}
export function executeInventoryAcceptedRequest(
  client: InventoryClient,
  request: InventoryAcceptedRequest
): Promise<NativeInventoryExecution> {
  if (!('kind' in request)) return client.execute(request);
  switch (request.kind) {
    case 'adopt-archive':
      return client.applyImport(request);
    case 'receive-table':
      return client.applyTable(request);
    case 'apply-stocktake':
      return client.applyStocktake(request);
    case 'acknowledge-table-source':
      return client.acknowledgeSource(request);
    case 'import-hierarchy':
      return client.applyHierarchy(request);
    case 'receive-mapped-table':
      return client.applyMappedTable(request);
    case 'import-benchling-capture':
      return client.applyBenchlingCapture(request);
    case 'receive-arrival':
      return client.applyArrival(request);
    case 'record-scientific-transfer':
      return client.applyScientificTransfer(request);
    case 'record-scientific-transfer-v2':
      return client.applyScientificTransferV2(request);
    case 'record-scientific-citation':
      return client.applyScientificCitation(request);
    case 'withdraw-scientific-citation':
      return client.applyScientificCitationWithdrawal(request);
    case 'save-plate-plan-version':
      return client.applyPlatePlanVersion(request);
    case 'record-plate-plan-observation':
      return client.applyPlatePlanObservation(request);
    case 'record-run-value-attribution':
      return client.applyRunValueAttribution(request);
    case 'withdraw-run-value-attribution':
      return client.applyRunValueAttributionWithdrawal(request);
    case 'record-scientific-production':
      return client.applyScientificProduction(request);
  }
}
