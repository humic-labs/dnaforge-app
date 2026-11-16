import type { InventoryClient, InventoryExportSnapshot } from '../../shared/inventory-client';
import type { InventoryReadRequest } from '../../shared/inventory-command';
import {
  InventoryTextOutputSession,
  inventoryTextOutputLocked,
  type InventoryTextOutput,
  type InventoryTextOutputPort,
} from './inventory-text-output';

export type InventoryArchiveCaptureState =
  | { kind: 'idle' }
  | { kind: 'capturing' }
  | { kind: 'captured'; artifact: InventoryExportSnapshot }
  | { kind: 'failed'; message: string };

export interface InventoryArchiveSessionSnapshot {
  capture: InventoryArchiveCaptureState;
  output: InventoryTextOutput<InventoryExportSnapshot>;
}

export class InventoryArchiveSession {
  private snapshot: InventoryArchiveSessionSnapshot = {
    capture: { kind: 'idle' },
    output: { kind: 'not-exported' },
  };
  private readonly listeners = new Set<() => void>();
  private readonly fileOutput: InventoryTextOutputSession<InventoryExportSnapshot>;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly source: InventoryReadRequest,
    private readonly client: Pick<InventoryClient, 'exportSnapshot'>,
    output: InventoryTextOutputPort
  ) {
    this.fileOutput = new InventoryTextOutputSession(
      output,
      (artifact) => artifact.sourceText,
      'The saved file differs from this archive. It is not a confirmed export.',
      (next) => this.set({ output: next })
    );
  }

  getSnapshot = (): InventoryArchiveSessionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(update: Partial<InventoryArchiveSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }

  async capture(): Promise<void> {
    if (
      this.disposed ||
      this.snapshot.capture.kind === 'capturing' ||
      inventoryTextOutputLocked(this.snapshot.output)
    )
      return;
    const generation = ++this.generation;
    this.fileOutput.forget();
    this.set({ capture: { kind: 'capturing' } });
    try {
      const artifact = await this.client.exportSnapshot({ ...this.source, format: 'native-v1' });
      if (this.disposed || generation !== this.generation) return;
      if (
        artifact.source.projectId !== this.source.project ||
        artifact.source.inventoryId !== this.source.inventoryId
      )
        throw new Error('The archive belongs to another project or inventory.');
      this.set({ capture: { kind: 'captured', artifact } });
    } catch (cause) {
      if (!this.disposed && generation === this.generation)
        this.set({
          capture: {
            kind: 'failed',
            message: cause instanceof Error ? cause.message : String(cause),
          },
        });
    }
  }

  async exportArchive(): Promise<void> {
    const capture = this.snapshot.capture;
    if (this.disposed || capture.kind !== 'captured') return;
    await this.fileOutput.export(
      capture.artifact,
      `inventory-r${capture.artifact.source.revision}-${capture.artifact.sourceSha256.slice(7, 23)}.dnaforge-inventory.json`
    );
  }

  checkOutput(): Promise<void> {
    return this.fileOutput.check();
  }
  retryOutput(): Promise<void> {
    return this.fileOutput.retry();
  }
  forgetOutput(): void {
    this.fileOutput.forget();
  }

  dispose(): void {
    this.disposed = true;
    ++this.generation;
    this.fileOutput.dispose();
    this.listeners.clear();
  }
}
