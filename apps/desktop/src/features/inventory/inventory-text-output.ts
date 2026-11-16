export interface InventoryTextOutputPort {
  chooseDestination(defaultPath: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  read(path: string): Promise<string>;
}

interface InventoryOutputCopy<T> {
  artifact: T;
  path: string;
}

export type InventoryTextOutput<T> =
  | { kind: 'not-exported' }
  | { kind: 'choosing'; artifact: T }
  | ({ kind: 'writing' | 'confirming' | 'exported' } & InventoryOutputCopy<T>)
  | { kind: 'failed'; artifact: T; path?: string; message: string }
  | ({ kind: 'output-unconfirmed'; message: string } & InventoryOutputCopy<T>);

export function inventoryTextOutputPending(output: { kind: string }): boolean {
  return ['choosing', 'writing', 'confirming'].includes(output.kind);
}

export function inventoryTextOutputLocked(output: { kind: string }): boolean {
  return inventoryTextOutputPending(output) || output.kind === 'output-unconfirmed';
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export class InventoryTextOutputSession<T> {
  private output: InventoryTextOutput<T> = { kind: 'not-exported' };
  private disposed = false;

  constructor(
    private readonly port: InventoryTextOutputPort,
    private readonly content: (artifact: T) => string,
    private readonly mismatchMessage: string,
    private readonly onChange: (output: InventoryTextOutput<T>) => void
  ) {}

  private set(output: InventoryTextOutput<T>): void {
    this.output = output;
    this.onChange(output);
  }

  async export(artifact: T, defaultPath: string): Promise<void> {
    if (this.disposed || inventoryTextOutputLocked(this.output)) return;
    const previous = this.output;
    this.set({ kind: 'choosing', artifact });
    let path: string | null;
    try {
      path = await this.port.chooseDestination(defaultPath);
    } catch (cause) {
      this.set({ kind: 'failed', artifact, message: message(cause) });
      return;
    }
    if (path === null) {
      this.set(previous);
      return;
    }
    await this.write({ artifact, path });
  }

  private async write(copy: InventoryOutputCopy<T>): Promise<void> {
    this.set({ kind: 'writing', ...copy });
    try {
      await this.port.write(copy.path, this.content(copy.artifact));
    } catch (cause) {
      this.set({
        kind: 'output-unconfirmed',
        ...copy,
        message: `The write could not be confirmed. ${message(cause)}`,
      });
      return;
    }
    await this.confirm(copy);
  }

  private async confirm(copy: InventoryOutputCopy<T>): Promise<void> {
    this.set({ kind: 'confirming', ...copy });
    try {
      const saved = await this.port.read(copy.path);
      this.set(
        saved === this.content(copy.artifact)
          ? { kind: 'exported', ...copy }
          : { kind: 'failed', ...copy, message: this.mismatchMessage }
      );
    } catch (cause) {
      this.set({
        kind: 'output-unconfirmed',
        ...copy,
        message: `The saved file could not be checked. ${message(cause)}`,
      });
    }
  }

  async check(): Promise<void> {
    const copy = this.output;
    if (
      this.disposed ||
      !['output-unconfirmed', 'failed', 'exported'].includes(copy.kind) ||
      !('path' in copy) ||
      copy.path === undefined
    )
      return;
    await this.confirm({ artifact: copy.artifact, path: copy.path });
  }

  async retry(): Promise<void> {
    const copy = this.output;
    if (
      this.disposed ||
      !['output-unconfirmed', 'failed'].includes(copy.kind) ||
      !('path' in copy) ||
      copy.path === undefined
    )
      return;
    await this.write({ artifact: copy.artifact, path: copy.path });
  }

  forget(): void {
    if (this.disposed || inventoryTextOutputPending(this.output)) return;
    this.set({ kind: 'not-exported' });
  }

  dispose(): void {
    this.disposed = true;
  }
}
