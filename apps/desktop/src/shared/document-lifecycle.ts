import { saveDocumentTargetId, type SaveDocumentTarget } from './save-document-events';

export type NativeDocumentKind =
  | 'text'
  | 'csv'
  | 'tsv'
  | 'sequence'
  | 'notebook'
  | 'design'
  | 'protein'
  | 'primer'
  | 'protocol'
  | 'scientific'
  | 'binary'
  | 'unsupported';
export interface DocumentCapability {
  availability: 'native' | 'editing-client' | 'read-only' | 'unsupported';
  commands: readonly string[];
  reason?: string;
}
export interface DocumentLifecycleCapabilities {
  inspect: DocumentCapability;
  edit: DocumentCapability;
  history: DocumentCapability;
  save: DocumentCapability;
  recovery: DocumentCapability;
}
export function documentLifecycleCapabilities(input: {
  readOnly: boolean;
  commands: readonly string[];
  reason?: string;
}): DocumentLifecycleCapabilities {
  const capability = (commands: readonly string[]): DocumentCapability => ({
    availability: input.readOnly ? 'read-only' : commands.length ? 'native' : 'unsupported',
    commands,
    ...(!commands.length && input.reason ? { reason: input.reason } : {}),
  });
  return {
    inspect: { availability: 'native', commands: ['inspect'] },
    edit: capability(
      input.commands.filter(
        (command) =>
          !['inspect', 'save', 'reload', 'undo', 'redo', 'discard', 'restore-recovery'].includes(
            command
          )
      )
    ),
    history: capability(input.commands.filter((command) => ['undo', 'redo'].includes(command))),
    save: capability(input.commands.filter((command) => command === 'save')),
    recovery: capability(
      input.commands.filter((command) =>
        ['reload', 'discard', 'restore-recovery'].includes(command)
      )
    ),
  };
}

export interface DocumentLifecycleOwner {
  readonly target: SaveDocumentTarget;
  readonly tabId?: string;
  isDirty(): boolean;
  save(): Promise<boolean>;
  discard?(): void | Promise<void>;
  reload?(): Promise<boolean>;
}

export class DocumentLifecycle {
  private readonly owners = new Set<DocumentLifecycleOwner>();
  private readonly listeners = new Set<() => void>();
  private readonly saves = new Map<DocumentLifecycleOwner, Promise<boolean>>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly changed = (): void => {
    for (const listener of this.listeners) listener();
  };

  register(owner: DocumentLifecycleOwner): { changed: () => void; release: () => void } {
    this.owners.add(owner);
    this.changed();
    return {
      changed: this.changed,
      release: () => {
        this.owners.delete(owner);
        this.changed();
      },
    };
  }

  private matching(target: SaveDocumentTarget, tabId?: string): DocumentLifecycleOwner[] {
    const matches = [...this.owners].filter(
      (owner) =>
        owner.target.kind === target.kind &&
        saveDocumentTargetId(owner.target) === saveDocumentTargetId(target)
    );
    if (!tabId) return matches;
    const exact = matches.filter((owner) => owner.tabId === tabId);
    return exact.length ? exact : matches.filter((owner) => !owner.tabId);
  }

  dirty(target: SaveDocumentTarget, tabId?: string): boolean | undefined {
    const owners = this.matching(target, tabId);
    return owners.length ? owners.some((owner) => owner.isDirty()) : undefined;
  }

  has(target: SaveDocumentTarget, tabId?: string): boolean {
    return this.matching(target, tabId).length === 1;
  }

  async save(target: SaveDocumentTarget, tabId?: string): Promise<boolean> {
    const owners = this.matching(target, tabId);
    if (owners.length !== 1) {
      console.warn('[DocumentLifecycle] Save not completed:', {
        target,
        tabId,
        reason: 'owner-not-unique',
        ownerCount: owners.length,
      });
      return false;
    }
    const owner = owners[0];
    const pending = this.saves.get(owner);
    if (pending) return pending;
    let run: Promise<boolean>;
    try {
      run = owner.save().then(
        (success) => {
          if (!success)
            console.warn('[DocumentLifecycle] Save not completed:', {
              target,
              tabId,
              reason: 'owner-returned-false',
            });
          return success;
        },
        (error: unknown) => {
          console.error('[DocumentLifecycle] Save failed:', { target, tabId }, error);
          return false;
        }
      );
    } catch (error) {
      console.error('[DocumentLifecycle] Save failed:', { target, tabId }, error);
      return false;
    }
    this.saves.set(owner, run);
    try {
      return await run;
    } finally {
      if (this.saves.get(owner) === run) this.saves.delete(owner);
      this.changed();
    }
  }

  async reload(
    target: SaveDocumentTarget,
    tabId?: string,
    discardChanges = false
  ): Promise<boolean> {
    const owners = this.matching(target, tabId);
    if (owners.length !== 1 || !owners[0].reload || (!discardChanges && owners[0].isDirty()))
      return false;
    try {
      return await owners[0].reload();
    } catch {
      return false;
    } finally {
      this.changed();
    }
  }

  async discard(target: SaveDocumentTarget, tabId?: string): Promise<boolean> {
    const owners = this.matching(target, tabId);
    if (owners.length !== 1 || !owners[0].discard) return false;
    try {
      await owners[0].discard();
      this.changed();
      return true;
    } catch {
      return false;
    }
  }
}

export const documentLifecycle = new DocumentLifecycle();
