export interface DraftSaveOperation {
  readonly generation: number;
  readonly revision: number;
}

export interface DraftReloadOperation {
  readonly generation: number;
  readonly revision: number;
  readonly request: number;
}

type DraftSaveState = { phase: 'idle' } | { phase: 'saving'; operation: DraftSaveOperation };

export class DraftSaveOwner {
  private generation = 0;
  private state: DraftSaveState = { phase: 'idle' };
  private revision = 0;
  readonly readRevision = (): number => this.revision;

  edited(): void {
    this.revision++;
  }
  private reloadRequest = 0;

  beginReload(): DraftReloadOperation {
    return { generation: this.generation, revision: this.revision, request: ++this.reloadRequest };
  }

  reloadDisposition(operation: DraftReloadOperation): 'adopt' | 'preserve-draft' | 'stale' {
    if (
      this.state.phase !== 'idle' ||
      operation.generation !== this.generation ||
      operation.request !== this.reloadRequest
    )
      return 'stale';
    return operation.revision === this.revision ? 'adopt' : 'preserve-draft';
  }

  canAdoptReload(operation: DraftReloadOperation): boolean {
    return this.reloadDisposition(operation) === 'adopt';
  }

  begin(): DraftSaveOperation | null {
    if (this.state.phase === 'saving') return null;
    const operation = { generation: ++this.generation, revision: this.revision };
    this.state = { phase: 'saving', operation };
    return operation;
  }

  isCurrent(operation: DraftSaveOperation): boolean {
    return operation.generation === this.generation;
  }

  finish(operation: DraftSaveOperation): 'saved' | 'newer-draft' | 'retired' {
    if (this.state.phase !== 'saving' || this.state.operation !== operation) return 'retired';
    this.state = { phase: 'idle' };
    return this.revision === operation.revision ? 'saved' : 'newer-draft';
  }

  retire(): void {
    this.generation += 1;
    this.state = { phase: 'idle' };
  }
}
