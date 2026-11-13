interface MenuTarget {
  isDestroyed(): boolean;
  setIgnoreMenuShortcuts(ignore: boolean): void;
}

export class TerminalKeyboardFocus {
  private focused = new Map<number, string>();

  constructor(
    private readonly target: (owner: number) => MenuTarget | undefined,
    private readonly owns: (owner: number, id: string) => boolean,
    private readonly host: NodeJS.Platform = process.platform
  ) {}

  focus(owner: number, id: string | null): void {
    if (id === null) {
      this.clear(owner);
      return;
    }
    if (!this.owns(owner, id)) throw new Error('Terminal does not belong to this window.');
    this.focused.set(owner, id);
    const target = this.target(owner);
    if (target && !target.isDestroyed()) target.setIgnoreMenuShortcuts(this.host !== 'darwin');
  }

  clear(owner: number, id?: string): void {
    if (id !== undefined && this.focused.get(owner) !== id) return;
    this.focused.delete(owner);
    const target = this.target(owner);
    if (target && !target.isDestroyed()) target.setIgnoreMenuShortcuts(false);
  }
}
