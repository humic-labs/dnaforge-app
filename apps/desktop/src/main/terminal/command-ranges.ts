import type { IMarker, Terminal } from '@xterm/headless';
import type { TerminalCommandRange } from '../../shared/terminal-ipc';
import { terminalCommandOutput } from './upstream/command-output';

interface CommandMarkers {
  prompt: IMarker;
  output: IMarker;
  end?: IMarker;
}

export function offsetTerminalCommandRange(
  range: TerminalCommandRange | undefined,
  firstLine: number
): TerminalCommandRange | undefined {
  if (!range || range.startLine < firstLine || range.outputStartLine < firstLine) return undefined;
  return {
    startLine: range.startLine - firstLine,
    outputStartLine: range.outputStartLine - firstLine,
    ...(range.endLine === undefined ? {} : { endLine: range.endLine - firstLine }),
  };
}

export class TerminalCommandRanges {
  private readonly commands = new Map<string, CommandMarkers>();
  private promptMarker: IMarker | undefined;
  private promptPrefix: string | undefined;
  generation = 0;

  constructor(
    private readonly screen: Terminal,
    saved: Array<{ id?: string; range?: TerminalCommandRange }> = []
  ) {
    for (const command of saved) {
      if (!command.id || !command.range) continue;
      const prompt = this.atLine(command.range.startLine);
      const output = this.atLine(command.range.outputStartLine);
      const end =
        command.range.endLine === undefined ? undefined : this.atLine(command.range.endLine);
      if (prompt && output) this.commands.set(command.id, { prompt, output, end });
      else {
        prompt?.dispose();
        output?.dispose();
        end?.dispose();
      }
    }
  }

  private atLine(line: number): IMarker | undefined {
    const buffer = this.screen.buffer.normal;
    if (!Number.isInteger(line) || line < 0 || line >= buffer.length) return undefined;
    return this.screen.registerMarker(line - buffer.baseY - buffer.cursorY);
  }

  prompt(): void {
    if (this.screen.buffer.active.type !== 'normal') return;
    this.promptMarker?.dispose();
    const buffer = this.screen.buffer.normal;
    const cursor = buffer.baseY + buffer.cursorY;
    let start = cursor;
    while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
    this.promptMarker = this.screen.registerMarker(start - cursor);
    this.promptPrefix = undefined;
    this.generation++;
  }

  promptEnd(): void {
    this.promptPrefix = this.promptText();
  }

  private promptText(): string | undefined {
    const buffer = this.screen.buffer.normal;
    const marker = this.promptMarker;
    if (this.screen.buffer.active.type !== 'normal' || !marker || marker.isDisposed)
      return undefined;
    const cursorLine = buffer.baseY + buffer.cursorY;
    if (marker.line > cursorLine || cursorLine - marker.line > 128) return undefined;
    let text = '';
    for (let y = marker.line; y <= cursorLine; y++) {
      const line = buffer.getLine(y);
      if (!line) return undefined;
      if (y > marker.line && !line.isWrapped) text += '\n';
      let row = '';
      const end = y === cursorLine ? buffer.cursorX : this.screen.cols;
      for (let x = 0; x < end; x++) {
        const cell = line.getCell(x);
        if (cell && cell.getWidth() !== 0) row += cell.getChars() || '\0';
      }
      if (y === cursorLine && row.endsWith('\0')) return undefined;
      text += row.replace(/\0+$/, '').replace(/\0/g, ' ');
      if (text.length > 8192) return undefined;
    }
    return text;
  }

  input(): string | undefined {
    if (this.promptPrefix === undefined) return undefined;
    const text = this.promptText();
    if (text === undefined || !text.startsWith(this.promptPrefix)) return undefined;

    const buffer = this.screen.buffer.normal;
    const cursorLine = buffer.baseY + buffer.cursorY;
    for (let y = cursorLine; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (!line || (y > cursorLine && !line.isWrapped)) break;
      for (let x = y === cursorLine ? buffer.cursorX : 0; x < this.screen.cols; x++)
        if (line.getCell(x)?.getChars()) return undefined;
    }
    return text.slice(this.promptPrefix.length);
  }

  start(id: string): void {
    this.promptPrefix = undefined;
    if (this.screen.buffer.active.type !== 'normal') return;
    const prompt =
      this.promptMarker && !this.promptMarker.isDisposed
        ? this.atLine(this.promptMarker.line)
        : this.screen.registerMarker(0);
    const output = this.screen.registerMarker(0);
    if (prompt && output) this.commands.set(id, { prompt, output });
    else {
      prompt?.dispose();
      output?.dispose();
    }
  }

  finish(id: string): void {
    const command = this.commands.get(id);
    if (!command || this.screen.buffer.active.type !== 'normal') return;
    command.end?.dispose();
    command.end = this.screen.registerMarker(0);
  }

  range(id: string): TerminalCommandRange | undefined {
    const command = this.commands.get(id);
    if (
      !command ||
      command.prompt.isDisposed ||
      command.output.isDisposed ||
      command.end?.isDisposed
    )
      return undefined;
    return {
      startLine: command.prompt.line,
      outputStartLine: command.output.line,
      ...(command.end ? { endLine: command.end.line } : {}),
    };
  }

  output(id: string): string | undefined {
    const range = this.range(id);
    if (!range || range.endLine === undefined || range.outputStartLine >= range.endLine)
      return undefined;
    return terminalCommandOutput(this.screen.buffer.normal, range.outputStartLine, range.endLine);
  }

  retain(ids: Array<string | undefined>): void {
    const keep = new Set(ids);
    for (const [id, command] of this.commands)
      if (!keep.has(id)) {
        command.prompt.dispose();
        command.output.dispose();
        command.end?.dispose();
        this.commands.delete(id);
      }
  }

  clear(): void {
    this.retain([]);
    this.promptMarker?.dispose();
    this.promptMarker = undefined;
    this.promptPrefix = undefined;
    this.generation++;
  }
}
