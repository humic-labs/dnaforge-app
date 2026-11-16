import type { InventoryLabelMediaProfileId } from '@waypoint/domain-services/inventory-label-types';
import type {
  InventoryClient,
  InventoryLabelArtifact,
  InventoryPrepareLabelRequest,
} from '../../shared/inventory-client';

import {
  InventoryTextOutputSession,
  inventoryTextOutputPending,
  inventoryTextOutputLocked,
  type InventoryTextOutput,
  type InventoryTextOutputPort,
} from './inventory-text-output';

export type InventoryLabelOutputPort = InventoryTextOutputPort;

export type InventoryLabelPreparation =
  | { kind: 'draft' }
  | { kind: 'rendering' }
  | { kind: 'rendered'; artifact: InventoryLabelArtifact }
  | { kind: 'failed'; message: string };

export type InventoryLabelOutput = InventoryTextOutput<InventoryLabelArtifact>;

export interface InventoryLabelSessionSnapshot {
  mediaProfileId: InventoryLabelMediaProfileId;
  preparation: InventoryLabelPreparation;
  output: InventoryLabelOutput;
}

export function inventoryLabelOutputPending(output: InventoryLabelOutput): boolean {
  return inventoryTextOutputPending(output);
}

export function inventoryLabelSpecificationLocked(output: InventoryLabelOutput): boolean {
  return inventoryTextOutputLocked(output);
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class InventoryLabelSession {
  private snapshot: InventoryLabelSessionSnapshot = {
    mediaProfileId: 'qr-50x30-300dpi',
    preparation: { kind: 'draft' },
    output: { kind: 'not-exported' },
  };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;
  private readonly fileOutput: InventoryTextOutputSession<InventoryLabelArtifact>;

  constructor(
    private readonly source: Omit<InventoryPrepareLabelRequest, 'mediaProfileId'>,
    private readonly client: Pick<InventoryClient, 'prepareLabel'>,
    output: InventoryLabelOutputPort
  ) {
    this.fileOutput = new InventoryTextOutputSession(
      output,
      (artifact) => artifact.rendered.svg,
      'The saved file differs from this label. It is not a confirmed export.',
      (next) => this.set({ output: next })
    );
  }

  getSnapshot = (): InventoryLabelSessionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(update: Partial<InventoryLabelSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }

  selectMedia(mediaProfileId: InventoryLabelMediaProfileId): void {
    if (
      this.disposed ||
      mediaProfileId === this.snapshot.mediaProfileId ||
      inventoryLabelSpecificationLocked(this.snapshot.output)
    )
      return;
    ++this.generation;
    this.fileOutput.forget();
    this.set({
      mediaProfileId,
      preparation: { kind: 'draft' },
      output: { kind: 'not-exported' },
    });
  }

  async prepare(): Promise<void> {
    if (
      this.disposed ||
      this.snapshot.preparation.kind === 'rendering' ||
      inventoryLabelSpecificationLocked(this.snapshot.output)
    )
      return;
    const generation = ++this.generation;
    const mediaProfileId = this.snapshot.mediaProfileId;
    this.fileOutput.forget();
    this.set({ preparation: { kind: 'rendering' }, output: { kind: 'not-exported' } });
    try {
      const artifact = await this.client.prepareLabel({ ...this.source, mediaProfileId });
      if (this.disposed || generation !== this.generation) return;
      if (
        artifact.projectId !== this.source.project ||
        artifact.inventoryId !== this.source.inventoryId ||
        artifact.binding.id !== this.source.codeId ||
        artifact.rendered.spec.mediaProfileId !== mediaProfileId
      )
        throw new Error('The rendered label belongs to a different item code or media profile.');
      this.set({ preparation: { kind: 'rendered', artifact } });
    } catch (cause) {
      if (!this.disposed && generation === this.generation)
        this.set({ preparation: { kind: 'failed', message: message(cause) } });
    }
  }

  async exportLabel(): Promise<void> {
    const { preparation, output: previous } = this.snapshot;
    if (
      this.disposed ||
      preparation.kind !== 'rendered' ||
      inventoryLabelSpecificationLocked(previous)
    )
      return;
    await this.fileOutput.export(
      preparation.artifact,
      `inventory-label-${preparation.artifact.svgSha256.replace(/^sha256:/, '').slice(0, 16)}.svg`
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
    this.fileOutput.dispose();
    ++this.generation;
    this.listeners.clear();
  }
}
