import type { IMarker, Terminal } from '@xterm/headless';

export interface TerminalPromptPosition {
  line: number;
  column: number;
}

type PromptTerminal = Pick<
  Terminal,
  'buffer' | 'cols' | 'rows' | 'write' | 'resize' | 'parser' | 'registerMarker'
>;

export class TerminalPromptResize {
  private marker: IMarker | undefined;
  private column = 0;
  private active = false;
  private disposed = false;
  private previousRows: number | undefined;
  private readonly subscription;
  private readonly cursorSubscription;

  constructor(
    private readonly terminal: PromptTerminal,
    private shellPath = ''
  ) {
    this.subscription = terminal.parser.registerOscHandler(633, (data) => {
      const operation = data.split(';', 1)[0];
      if (operation === 'A') {
        this.restoreViewport();
        const buffer = terminal.buffer.normal;
        this.seed({ line: buffer.baseY + buffer.cursorY, column: buffer.cursorX });
        this.active = false;
      } else if (operation === 'B') this.active = Boolean(this.marker);
      else if (operation === 'C' || operation === 'D' || operation === 'E') {
        this.active = false;
        this.restoreViewport();
      }
      return false;
    });
    this.cursorSubscription = terminal.parser.registerCsiHandler({ final: 'A' }, () => {
      this.exposePrompt();
      return false;
    });
  }

  seed(position: TerminalPromptPosition | undefined): void {
    this.marker?.dispose();
    this.marker = undefined;
    this.active = false;
    const buffer = this.terminal.buffer.normal;
    if (
      !position ||
      this.terminal.buffer.active.type !== 'normal' ||
      !Number.isInteger(position.line) ||
      position.line < 0 ||
      position.line >= buffer.length ||
      !Number.isInteger(position.column) ||
      position.column < 0 ||
      position.column >= this.terminal.cols
    )
      return;
    this.marker = this.terminal.registerMarker(position.line - buffer.baseY - buffer.cursorY);
    this.column = position.column;
    this.active = Boolean(this.marker);
  }

  position(): TerminalPromptPosition | undefined {
    if (!this.active || !this.marker || this.marker.isDisposed) return undefined;
    return { line: this.marker.line, column: this.column };
  }

  prepare(cols: number, shellPath: string): Promise<void> | undefined {
    this.shellPath = shellPath;
    if (
      this.disposed ||
      cols === this.terminal.cols ||
      !/(?:^|[\\/])zsh(?:\.exe)?$/i.test(shellPath) ||
      !this.position()
    )
      return;
    return this.write('').then(async () => {
      const position = this.position();
      const buffer = this.terminal.buffer.normal;
      if (
        this.disposed ||
        !position ||
        this.terminal.buffer.active.type !== 'normal' ||
        position.line < buffer.baseY ||
        position.line > buffer.baseY + buffer.cursorY
      )
        return;
      const row = position.line - buffer.baseY + 1;
      const cursorRow = buffer.cursorY + 1;
      const cursorColumn = Math.min(this.terminal.cols, buffer.cursorX + 1);
      await this.write(
        `\x1b[${row};${position.column + 1}H\x1b[J\x1b[${cursorRow};${cursorColumn}H`
      );
    });
  }

  revealPrompt(shellPath: string): void {
    this.shellPath = shellPath;
    this.restoreViewport();
    const position = this.position();
    const buffer = this.terminal.buffer.normal;
    if (
      this.disposed ||
      !/(?:^|[\\/])zsh(?:\.exe)?$/i.test(shellPath) ||
      !position ||
      this.terminal.buffer.active.type !== 'normal' ||
      position.line >= buffer.baseY
    )
      return;
    const rows = this.terminal.rows;
    const cursorRows = buffer.cursorY + 1;
    if (cursorRows + buffer.baseY - position.line > rows) return;
    for (let line = buffer.baseY + cursorRows; line < buffer.baseY + rows; line++)
      if (buffer.getLine(line)?.translateToString(true).trim()) return;
    this.terminal.resize(this.terminal.cols, cursorRows);
    this.terminal.resize(this.terminal.cols, rows);
  }

  private exposePrompt(): void {
    const position = this.position();
    const buffer = this.terminal.buffer.normal;
    if (
      this.disposed ||
      !/(?:^|[\\/])bash(?:\.exe)?$/i.test(this.shellPath) ||
      !position ||
      this.terminal.buffer.active.type !== 'normal' ||
      position.line >= buffer.baseY
    )
      return;
    const cursorRows = buffer.cursorY + 1;
    for (let line = buffer.baseY + cursorRows; line < buffer.baseY + this.terminal.rows; line++)
      if (buffer.getLine(line)?.translateToString(true).trim()) return;
    const rows = Math.max(this.terminal.rows, cursorRows + buffer.baseY - position.line);
    this.previousRows ??= this.terminal.rows;
    this.terminal.resize(this.terminal.cols, cursorRows);
    this.terminal.resize(this.terminal.cols, rows);
  }

  private restoreViewport(): void {
    if (this.previousRows === undefined) return;
    const rows = this.previousRows;
    this.previousRows = undefined;
    this.terminal.resize(this.terminal.cols, rows);
  }

  private write(data: string): Promise<void> {
    return new Promise((resolve) => this.terminal.write(data, resolve));
  }

  dispose(): void {
    this.restoreViewport();
    this.disposed = true;
    this.subscription.dispose();
    this.cursorSubscription.dispose();
    this.marker?.dispose();
    this.marker = undefined;
  }
}
