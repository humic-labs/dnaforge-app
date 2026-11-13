import { randomUUID } from 'node:crypto';

interface PasteTerminal {
  flush(owner: number, id: string): Promise<void>;
  bracketedPasteMode(owner: number, id: string): boolean;
  paste(owner: number, id: string, text: string): void;
}

export class TerminalClipboard {
  private readonly pending = new Map<
    string,
    { owner: number; id: string; text: string; warnMultiline: boolean; expires: number }
  >();

  constructor(
    private readonly terminal: PasteTerminal,
    private readonly readText: () => string | Promise<string>
  ) {}

  async request(owner: number, id: string, warnMultiline: boolean): Promise<string> {
    if (typeof warnMultiline !== 'boolean') throw new Error('Invalid terminal paste request.');
    await this.terminal.flush(owner, id);
    this.terminal.bracketedPasteMode(owner, id);
    const text = await this.readText();
    this.terminal.bracketedPasteMode(owner, id);
    for (const [token, value] of this.pending)
      if (value.expires <= Date.now()) this.pending.delete(token);
    if (
      this.pending.size >= 32 ||
      [...this.pending.values()].filter((value) => value.owner === owner).length >= 8
    )
      throw new Error('Too many pending terminal pastes.');
    if (text.length > 1_000_000) throw new Error('Clipboard text is too large.');
    const token = randomUUID();
    this.pending.set(token, { owner, id, text, warnMultiline, expires: Date.now() + 300_000 });
    return token;
  }

  async commit(owner: number, id: string, token: string): Promise<boolean> {
    await this.terminal.flush(owner, id);
    const bracketed = this.terminal.bracketedPasteMode(owner, id);
    const value = this.staged(owner, id, token);
    if (value.warnMultiline && /[\r\n]/.test(value.text) && !bracketed) return false;
    this.pending.delete(token);
    this.terminal.paste(owner, id, value.text);
    return true;
  }

  private staged(owner: number, id: string, token: string) {
    const value = this.pending.get(token);
    if (!value || value.owner !== owner || value.id !== id || value.expires <= Date.now())
      throw new Error(
        'Terminal paste confirmation has expired or does not belong to this session.'
      );
    return value;
  }

  confirm(owner: number, id: string, token: string, accept: boolean): void {
    if (typeof accept !== 'boolean') throw new Error('Invalid terminal paste confirmation.');
    const value = this.staged(owner, id, token);
    this.pending.delete(token);

    this.terminal.bracketedPasteMode(owner, id);
    if (accept) this.terminal.paste(owner, id, value.text);
  }

  clear(owner: number, id?: string): void {
    for (const [token, value] of this.pending)
      if (value.owner === owner && (id === undefined || value.id === id))
        this.pending.delete(token);
  }
}
