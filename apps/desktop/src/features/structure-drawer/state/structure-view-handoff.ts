export interface StructureViewHandoffDestination {
  tabId: string;
  panelId: string;
  viewerInstanceId: string;
  createdTab: boolean;
  createdPanelId?: string;
}

export interface StructureViewHandoffDescriptor {
  transactionId: string;
  structureViewId: string;
  bindingId: string;
  generation: number;
}

export type StructureViewHandoffCompletion =
  | { status: 'committed'; destination: StructureViewHandoffDestination }
  | { status: 'failed'; reason: string; destination?: StructureViewHandoffDestination };

export interface StructureViewHandoffHandle {
  transactionId: string;
  generation: number;
  created: boolean;
  completion: Promise<StructureViewHandoffCompletion>;
}

interface StructureViewHandoffTransaction {
  transactionId: string;
  generation: number;
  structureViewId: string;
  bindingId: string;
  sourceGeneration: number;
  destination?: StructureViewHandoffDestination;
  completion: Promise<StructureViewHandoffCompletion>;
  resolve: (completion: StructureViewHandoffCompletion) => void;
  timeout: ReturnType<typeof setTimeout>;
  settled: boolean;
}

const transactions = new Map<string, StructureViewHandoffTransaction>();
const transactionIdByView = new Map<string, string>();
const interactiveHosts = new Set<string>();
let nextTransaction = 0;
let nextGeneration = 0;

export function beginStructureViewHandoff(input: {
  structureViewId: string;
  bindingId: string;
  sourceGeneration: number;
  timeoutMs?: number;
}): StructureViewHandoffHandle {
  const existingId = transactionIdByView.get(input.structureViewId);
  const existing = existingId ? transactions.get(existingId) : undefined;
  if (existing && !existing.settled && existing.bindingId === input.bindingId) {
    return handleFor(existing, false);
  }

  const transactionId = `structure-handoff:${++nextTransaction}`;
  const generation = ++nextGeneration;
  let resolve!: (completion: StructureViewHandoffCompletion) => void;
  const completion = new Promise<StructureViewHandoffCompletion>((done) => {
    resolve = done;
  });
  const transaction: StructureViewHandoffTransaction = {
    transactionId,
    generation,
    structureViewId: input.structureViewId,
    bindingId: input.bindingId,
    sourceGeneration: input.sourceGeneration,
    completion,
    resolve,
    timeout: setTimeout(
      () => settleFailure(transactionId, 'destination viewer load timed out'),
      input.timeoutMs ?? 30_000
    ),
    settled: false,
  };
  transactions.set(transactionId, transaction);
  transactionIdByView.set(input.structureViewId, transactionId);
  return handleFor(transaction, true);
}

export function attachStructureViewHandoffDestination(
  transactionId: string,
  destination: StructureViewHandoffDestination
): boolean {
  const transaction = transactions.get(transactionId);
  if (!transaction || transaction.settled) return false;
  transaction.destination = destination;
  if (interactiveHosts.has(hostKey(transaction.structureViewId, destination.viewerInstanceId))) {
    settleCommitted(transaction);
  }
  return true;
}

export function markStructureViewHostInteractive(
  structureViewId: string,
  viewerInstanceId: string
): void {
  interactiveHosts.add(hostKey(structureViewId, viewerInstanceId));
  const transactionId = transactionIdByView.get(structureViewId);
  const transaction = transactionId ? transactions.get(transactionId) : undefined;
  if (
    transaction &&
    !transaction.settled &&
    transaction.destination?.viewerInstanceId === viewerInstanceId
  ) {
    settleCommitted(transaction);
  }
}

export function markStructureViewHostReleased(
  structureViewId: string,
  viewerInstanceId: string
): void {
  interactiveHosts.delete(hostKey(structureViewId, viewerInstanceId));
}

export function acknowledgeStructureViewHandoff(input: {
  transactionId: string;
  structureViewId: string;
  viewerInstanceId: string;
  generation: number;
}): boolean {
  const transaction = transactions.get(input.transactionId);
  if (
    !transaction ||
    transaction.settled ||
    transaction.generation !== input.generation ||
    transaction.structureViewId !== input.structureViewId ||
    transaction.destination?.viewerInstanceId !== input.viewerInstanceId
  ) {
    return false;
  }
  markStructureViewHostInteractive(input.structureViewId, input.viewerInstanceId);
  return true;
}

export function failStructureViewHandoff(transactionId: string, reason: string): boolean {
  return settleFailure(transactionId, reason);
}

export function resetStructureViewHandoffsForTesting(): void {
  for (const transaction of transactions.values()) clearTimeout(transaction.timeout);
  transactions.clear();
  transactionIdByView.clear();
  interactiveHosts.clear();
  nextTransaction = 0;
  nextGeneration = 0;
}

export function getStructureViewHandoffDiagnostics(): {
  transactionCount: number;
  interactiveHostCount: number;
} {
  return {
    transactionCount: transactions.size,
    interactiveHostCount: interactiveHosts.size,
  };
}

function settleFailure(transactionId: string, reason: string): boolean {
  const transaction = transactions.get(transactionId);
  if (!transaction || transaction.settled) return false;
  settle(transaction, {
    status: 'failed',
    reason,
    ...(transaction.destination ? { destination: transaction.destination } : {}),
  });
  return true;
}

function settleCommitted(transaction: StructureViewHandoffTransaction): void {
  if (!transaction.destination) return;
  settle(transaction, { status: 'committed', destination: transaction.destination });
}

function settle(
  transaction: StructureViewHandoffTransaction,
  completion: StructureViewHandoffCompletion
): void {
  if (transaction.settled) return;
  transaction.settled = true;
  clearTimeout(transaction.timeout);
  if (transactionIdByView.get(transaction.structureViewId) === transaction.transactionId) {
    transactionIdByView.delete(transaction.structureViewId);
  }
  transactions.delete(transaction.transactionId);
  transaction.resolve(completion);
}

function handleFor(
  transaction: StructureViewHandoffTransaction,
  created: boolean
): StructureViewHandoffHandle {
  return {
    transactionId: transaction.transactionId,
    generation: transaction.generation,
    created,
    completion: transaction.completion,
  };
}

function hostKey(structureViewId: string, viewerInstanceId: string): string {
  return `${structureViewId}\u0000host\u0000${viewerInstanceId}`;
}
