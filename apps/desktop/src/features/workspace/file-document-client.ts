import { platform } from '../../platform';
import type { FileDocumentFlushPurpose } from '../../shared/file-document-client-sync';
import type { TextFileAtomicWriteInput } from '../../shared/text-file-atomic';
import type {
  FileDocumentClientOperation,
  FileDocumentRequest,
  FileDocumentSnapshot,
} from '../../shared/file-document';
import type { TableData } from '../../shared/table-document-types';
import { serializeDelimitedRows } from '../../shared/tabular-file';

const clients = new Map<string, FileDocumentClient>();
let subscribed = false;
let flushUnsubscribe: (() => void) | undefined;
let nativeReadiness: Promise<void> = Promise.resolve();
const nativeClientFlushers = new Set<(purpose: FileDocumentFlushPurpose) => Promise<void>>();

export function registerNativeDocumentClientFlush(
  flush: (purpose: FileDocumentFlushPurpose) => Promise<void>
): () => void {
  nativeClientFlushers.add(flush);
  return () => {
    nativeClientFlushers.delete(flush);
  };
}
export function setNativeFileDocumentReadiness(readiness: Promise<void>): void {
  nativeReadiness = readiness;
  void readiness.catch(() => {});
}
export async function waitForNativeFileDocumentReadiness(): Promise<void> {
  for (;;) {
    const current = nativeReadiness;
    await current;
    if (current === nativeReadiness) return;
  }
}

function subscribeNativeDocuments() {
  if (subscribed) return;
  const subscribe = platform().fs.subscribeFileDocuments;
  if (!subscribe) throw new Error('The native file-document service is unavailable.');
  subscribed = true;
  subscribe((snapshot) => clients.get(snapshot.path)?.observe(snapshot));
}

export function installFileDocumentClientSync(loadId: string): () => void {
  subscribeNativeDocuments();
  flushUnsubscribe?.();
  const unsubscribe = platform().fs.onFileDocumentFlush((request) => {
    if (request.loadId !== loadId) return;
    void flushFileDocumentClients(request.purpose)
      .then(
        () => platform().fs.acknowledgeFileDocumentFlush({ ...request, success: true }),
        (error) =>
          platform().fs.acknowledgeFileDocumentFlush({
            ...request,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          })
      )
      .catch(() => {});
  });
  flushUnsubscribe = unsubscribe;
  return () => {
    if (flushUnsubscribe === unsubscribe) {
      unsubscribe();
      flushUnsubscribe = undefined;
    }
  };
}

export function getFileDocumentClient(path: string): FileDocumentClient {
  let client = clients.get(path);
  if (!client) {
    client = new FileDocumentClient(path);
    clients.set(path, client);
  }
  return client;
}

export function ownsNativeFileDocument(path: string): boolean {
  return clients.has(path);
}

export async function flushFileDocumentClients(
  purpose: FileDocumentFlushPurpose = 'synchronize'
): Promise<void> {
  await waitForNativeFileDocumentReadiness();
  await Promise.all([
    ...[...new Set(clients.values())].map((client) => client.flush(purpose)),
    ...[...nativeClientFlushers].map((flush) => flush(purpose)),
  ]);
}

export class FileDocumentClient {
  content: string | null = null;
  persistedContent: string | null = null;
  diskContent: string | null = null;
  snapshot: FileDocumentSnapshot | null = null;
  error: string | null = null;
  private pending = 0;
  private saves = 0;
  private epoch = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly capturedSaves = new Map<number, Promise<unknown>>();
  private loading: Promise<void> | null = null;

  constructor(readonly filePath: string) {}
  get revisionId() {
    return this.snapshot?.revision ?? `file-loading:${this.filePath}`;
  }
  get dirty() {
    return this.content !== this.persistedContent;
  }
  get saving() {
    return this.saves > 0 || Boolean(this.snapshot?.saving);
  }
  get revision() {
    return this.epoch;
  }
  get pendingChanges() {
    return this.pending;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  observe(snapshot: FileDocumentSnapshot): void {
    if (
      (snapshot.path !== this.filePath && snapshot.documentId !== this.snapshot?.documentId) ||
      this.pending > 0
    )
      return;
    this.accept(snapshot, true);
  }

  load(fallback?: string): Promise<void> {
    if (this.loading) return this.loading;
    const loading = this.loadCurrent(fallback).finally(() => {
      if (this.loading === loading) this.loading = null;
    });
    this.loading = loading;
    return loading;
  }

  private async loadCurrent(fallback?: string): Promise<void> {
    await waitForNativeFileDocumentReadiness();
    subscribeNativeDocuments();
    await this.flush();
    await Promise.allSettled([...this.capturedSaves.values()]);
    const snapshot = await platform().fs.fileDocument({
      target: { path: this.filePath },
      projection: 'document',
      operation: {
        kind: 'inspect',
        offset: 0,
        limit: 2000,
        rowOffset: 0,
        rowLimit: 20,
        columnOffset: 0,
        columnLimit: 20,
      },
    });
    const current =
      !snapshot.dirty && snapshot.ready && !snapshot.recoveryId
        ? await platform().fs.fileDocument({
            target: { documentId: snapshot.documentId },
            operation: { kind: 'reload' },
            expectedRevision: snapshot.revision,
            projection: 'document',
          })
        : snapshot;
    clients.set(current.path, this);
    this.accept(current, true);
    if (snapshot.content === null && fallback !== undefined) {
      this.content = fallback;
      this.persistedContent = fallback;
      this.diskContent = fallback;
    }
  }

  change(content: string | null): void {
    if (content === null || this.content === content) return;
    const before = (this.content ?? '').replace(/\r\n/g, '\n');
    const after = content.replace(/\r\n/g, '\n');
    this.content = content;
    this.epoch += 1;
    this.emit();
    if (this.snapshot?.type !== 'text') return;
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start])
      start += 1;
    let end = before.length,
      afterEnd = after.length;
    while (end > start && afterEnd > start && before[end - 1] === after[afterEnd - 1]) {
      end -= 1;
      afterEnd -= 1;
    }
    void this.enqueue({
      kind: 'text-transaction',
      changes: [{ from: start, to: end, text: after.slice(start, afterEnd) }],
      userEvent: 'input.type',
    }).catch(() => {});
  }

  changeTable(data: TableData, firstRowAsHeader: boolean): void {
    const rows = (data.cells ?? []).map((row) => row.map((cell) => cell.value));
    if (firstRowAsHeader) rows.unshift(data.columnLabels ?? []);
    const next = serializeDelimitedRows(
      rows,
      this.snapshot?.type === 'tsv' ? '\t' : ',',
      this.diskContent ?? undefined
    );
    this.content = next;
    this.epoch += 1;
    this.emit();
    void this.enqueue({
      kind: 'replace-table',
      data: structuredClone(data),
      firstRowAsHeader,
    }).catch(() => {});
  }

  changeTableView(
    sort: { column: number; direction: 'asc' | 'desc' | null } | null,
    filters: Record<number, string>
  ): void {
    void this.enqueue({ kind: 'table-view', sort, filters }).catch(() => {});
  }

  execute(operation: FileDocumentClientOperation): Promise<FileDocumentSnapshot> {
    return this.enqueue(operation, true);
  }

  discard(): void {
    this.content = this.persistedContent;
    this.epoch += 1;
    this.emit();
    void this.enqueue({ kind: 'discard' }, true).catch(() => {});
  }

  async save(
    _write: (input: TextFileAtomicWriteInput) => Promise<void>,
    assertCurrent: () => void = () => {},
    afterPublish?: () => Promise<void>
  ): Promise<FileDocumentSnapshot> {
    const revision = this.epoch;
    const previous = this.capturedSaves.get(revision);
    if (previous) return previous as Promise<FileDocumentSnapshot>;
    assertCurrent();
    this.saves += 1;
    const run = this.enqueue({ kind: 'capture-save' }).then(async (capture) => {
      if (!capture.saveCaptureId)
        throw new Error('The native file owner did not acknowledge its save capture.');
      await platform().fs.fileDocument({
        target: { documentId: capture.documentId },
        operation: { kind: 'await-save', saveCaptureId: capture.saveCaptureId },
        projection: 'document',
      });
      const snapshot = await this.enqueue({
        kind: 'inspect',
        offset: 0,
        limit: 2000,
        rowOffset: 0,
        rowLimit: 20,
        columnOffset: 0,
        columnLimit: 20,
      });
      if (afterPublish) await afterPublish();
      return snapshot;
    });
    this.capturedSaves.set(revision, run);
    try {
      return await run;
    } finally {
      this.saves -= 1;
      this.capturedSaves.delete(revision);
      this.emit();
    }
  }

  async flush(purpose: FileDocumentFlushPurpose = 'synchronize'): Promise<void> {
    if (purpose === 'discard') {
      await Promise.allSettled([this.tail, ...this.capturedSaves.values()]);
      return;
    }
    await this.tail;
    if (this.error && this.content !== this.snapshot?.content) throw new Error(this.error);
  }

  private enqueue(
    operation: FileDocumentClientOperation,
    replaceContent = false,
    assertCurrent: () => void = () => {}
  ): Promise<FileDocumentSnapshot> {
    const epoch = this.epoch;
    this.pending += 1;
    const run = this.tail
      .then(async () => {
        assertCurrent();
        if (!this.snapshot) throw new Error('The native file document has not loaded.');
        if (
          (operation.kind === 'save' || operation.kind === 'capture-save') &&
          this.error &&
          this.content !== this.snapshot.content
        )
          throw new Error(`FILE_DOCUMENT_CLIENT_UNSYNCHRONIZED: ${this.error}`);
        const request: FileDocumentRequest = {
          target: { documentId: this.snapshot.documentId },
          operation,
          expectedRevision: this.snapshot.revision,
          projection: 'document',
        };
        const snapshot = await platform().fs.fileDocument(request);
        this.error = null;
        this.accept(snapshot, replaceContent && this.epoch === epoch);
        return snapshot;
      })
      .catch((error: unknown) => {
        this.error = error instanceof Error ? error.message : String(error);
        this.emit();
        throw error;
      })
      .finally(() => {
        this.pending -= 1;
        this.emit();
      });
    this.tail = run.catch(() => {});
    return run;
  }

  private accept(snapshot: FileDocumentSnapshot, content: boolean): void {
    this.snapshot = snapshot;
    this.persistedContent = snapshot.persistedContent;
    this.diskContent = snapshot.diskContent;
    if (content) this.content = snapshot.content;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
