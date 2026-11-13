export interface IndexedViewportCommandReceipt {
  commandId: number;
  requested: { chrom: string; start0: number; end0: number };
  committed: { chrom: string; start0: number; end0: number };
  globalRange?: { start: number; end: number };
}

export interface IndexedLiveViewport {
  tabId: string;
  chrom: string;
  start0: number;
  end0: number;
  commandId: number | null;
  commandReceipt?: IndexedViewportCommandReceipt | null;
  globalRange?: { start: number; end: number };
}

type IndexedLiveViewportReader = () => Omit<IndexedLiveViewport, 'tabId'> | null;

const readers = new Map<string, { token: symbol; read: IndexedLiveViewportReader }>();

export function registerIndexedLiveViewportReader(
  tabId: string,
  read: IndexedLiveViewportReader
): () => void {
  const token = Symbol(tabId);
  readers.set(tabId, { token, read });
  return () => {
    if (readers.get(tabId)?.token === token) readers.delete(tabId);
  };
}

export function readIndexedLiveViewport(tabId: string): IndexedLiveViewport | null {
  const current = readers.get(tabId)?.read() ?? null;
  if (!current) return null;
  if (
    current.chrom.trim().length === 0 ||
    !Number.isFinite(current.start0) ||
    !Number.isFinite(current.end0) ||
    current.start0 < 0 ||
    current.end0 <= current.start0
  ) {
    return null;
  }
  return { tabId, ...current };
}

export function hasIndexedLiveViewportReader(tabId: string): boolean {
  return readers.has(tabId);
}

export function waitForIndexedLiveViewport(input: {
  tabId: string;
  chrom: string;
  start0: number;
  end0: number;
  commandId: number;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}): Promise<IndexedLiveViewport | null> {
  if (input.abortSignal?.aborted) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: IndexedLiveViewport | null): void => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearTimeout(pollTimer);
      clearTimeout(timeoutTimer);
      input.abortSignal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const check = (): void => {
      if (settled) return;
      const current = readIndexedLiveViewport(input.tabId);
      const receipt = current?.commandReceipt;
      const matchesCommand = receipt
        ? receipt.commandId === input.commandId &&
          receipt.requested.chrom === input.chrom &&
          receipt.requested.start0 === input.start0 &&
          receipt.requested.end0 === input.end0 &&
          receipt.committed.chrom === current?.chrom &&
          receipt.committed.start0 === current?.start0 &&
          receipt.committed.end0 === current?.end0 &&
          (!receipt.globalRange ||
            (receipt.globalRange.start === current?.globalRange?.start &&
              receipt.globalRange.end === current?.globalRange?.end))
        : current?.start0 === input.start0 && current?.end0 === input.end0;
      if (
        current?.commandId === input.commandId &&
        current.chrom === input.chrom &&
        matchesCommand
      ) {
        finish(current);
        return;
      }
      pollTimer = setTimeout(check, 16);
    };
    const onAbort = (): void => finish(null);
    const timeoutTimer = setTimeout(() => finish(null), input.timeoutMs ?? 15_000);
    input.abortSignal?.addEventListener('abort', onAbort, { once: true });
    check();
  });
}

export function resetIndexedLiveViewportForTests(): void {
  readers.clear();
}
