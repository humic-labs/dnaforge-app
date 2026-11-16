import type { InventoryLabelMediaProfileId } from '@waypoint/domain-services/inventory-label-types';
import type {
  InventoryClient,
  InventoryLabelArtifact,
  InventoryPrepareLabelRequest,
} from '../../shared/inventory-client';

export interface InventoryLabelOutputPort {
  chooseDestination(defaultPath: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  read(path: string): Promise<string>;
}

export type InventoryLabelPreparation =
  | { kind: 'draft' }
  | { kind: 'rendering' }
  | { kind: 'rendered'; artifact: InventoryLabelArtifact }
  | { kind: 'failed'; message: string };

interface InventoryLabelOutputCopy {
  artifact: InventoryLabelArtifact;
  path: string;
}

export type InventoryLabelOutput =
  | { kind: 'not-exported' }
  | { kind: 'choosing'; artifact: InventoryLabelArtifact }
  | ({ kind: 'writing' | 'confirming' | 'exported' } & InventoryLabelOutputCopy)
  | { kind: 'failed'; artifact: InventoryLabelArtifact; path?: string; message: string }
  | ({ kind: 'output-unconfirmed'; message: string } & InventoryLabelOutputCopy);

export interface InventoryLabelSessionSnapshot {
  mediaProfileId: InventoryLabelMediaProfileId;
  preparation: InventoryLabelPreparation;
  output: InventoryLabelOutput;
}

export function inventoryLabelOutputPending(output: InventoryLabelOutput): boolean {
  return ['choosing', 'writing', 'confirming'].includes(output.kind);
}

export function inventoryLabelSpecificationLocked(output: InventoryLabelOutput): boolean {
  return inventoryLabelOutputPending(output) || output.kind === 'output-unconfirmed';
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

  constructor(
    private readonly source: Omit<InventoryPrepareLabelRequest, 'mediaProfileId'>,
    private readonly client: Pick<InventoryClient, 'prepareLabel'>,
    private readonly output: InventoryLabelOutputPort
  ) {}

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
    const artifact = preparation.artifact;
    this.set({ output: { kind: 'choosing', artifact } });
    let path: string | null;
    try {
      path = await this.output.chooseDestination(
        `inventory-label-${artifact.svgSha256.replace(/^sha256:/, '').slice(0, 16)}.svg`
      );
    } catch (cause) {
      this.set({ output: { kind: 'failed', artifact, message: message(cause) } });
      return;
    }
    if (path === null) {
      this.set({ output: previous });
      return;
    }
    await this.writeCopy({ artifact, path });
  }

  private async writeCopy(copy: InventoryLabelOutputCopy): Promise<void> {
    this.set({ output: { kind: 'writing', ...copy } });
    try {
      await this.output.write(copy.path, copy.artifact.rendered.svg);
    } catch (cause) {
      this.set({
        output: {
          kind: 'output-unconfirmed',
          ...copy,
          message: `The write could not be confirmed. ${message(cause)}`,
        },
      });
      return;
    }
    await this.confirmCopy(copy);
  }

  private async confirmCopy(copy: InventoryLabelOutputCopy): Promise<void> {
    this.set({ output: { kind: 'confirming', ...copy } });
    try {
      const saved = await this.output.read(copy.path);
      this.set({
        output:
          saved === copy.artifact.rendered.svg
            ? { kind: 'exported', ...copy }
            : {
                kind: 'failed',
                ...copy,
                message: 'The saved file differs from this label. It is not a confirmed export.',
              },
      });
    } catch (cause) {
      this.set({
        output: {
          kind: 'output-unconfirmed',
          ...copy,
          message: `The saved file could not be checked. ${message(cause)}`,
        },
      });
    }
  }

  async checkOutput(): Promise<void> {
    const copy = this.snapshot.output;
    if (
      this.disposed ||
      !['output-unconfirmed', 'failed', 'exported'].includes(copy.kind) ||
      !('path' in copy) ||
      copy.path === undefined
    )
      return;
    await this.confirmCopy({ artifact: copy.artifact, path: copy.path });
  }

  async retryOutput(): Promise<void> {
    const copy = this.snapshot.output;
    if (
      this.disposed ||
      !['output-unconfirmed', 'failed'].includes(copy.kind) ||
      !('path' in copy) ||
      copy.path === undefined
    )
      return;
    await this.writeCopy({ artifact: copy.artifact, path: copy.path });
  }

  forgetOutput(): void {
    if (this.disposed || inventoryLabelOutputPending(this.snapshot.output)) return;
    this.set({ output: { kind: 'not-exported' } });
  }

  dispose(): void {
    this.disposed = true;
    ++this.generation;
    this.listeners.clear();
  }
}
