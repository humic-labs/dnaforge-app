/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See upstream/LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/
import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm';
import type {
  TerminalCommand,
  TerminalCommandState,
  TerminalCommandRange,
} from '../../shared/terminal-ipc';
import type { TerminalPreferences } from './terminal-preferences';

interface CommandMarker {
  command: TerminalCommand;
  marker: IMarker;
  output?: IMarker;
  end?: IMarker;
  decoration?: IDecoration;
  render?: IDisposable;
}

export class TerminalCommandDecorations {
  private readonly commands = new Map<string, CommandMarker>();
  private visibility: TerminalPreferences['commandDecorations'] = 'both';
  private readonly listeners: IDisposable[];

  constructor(
    private readonly terminal: Terminal,
    private readonly surface: HTMLElement,
    private readonly onChoose: (command: TerminalCommand) => void
  ) {
    this.listeners = [
      terminal.onResize(() => this.refresh()),
      terminal.buffer.onBufferChange(() => this.refresh()),
    ];
  }

  sync(state: TerminalCommandState): void {
    if (this.terminal.buffer.active.type !== 'normal') return;
    this.clear();
    const buffer = this.terminal.buffer.normal;
    const offset = (state.bufferBaseY ?? 0) - buffer.baseY;
    for (const command of state.commands) {
      if (!command.id || !command.command.trim() || !command.range) continue;
      const line = command.range.startLine - offset;
      if (line < 0 || line >= buffer.length) continue;
      const marker = this.terminal.registerMarker(line - buffer.baseY - buffer.cursorY);
      const atLine = (line: number) =>
        line >= 0 && line < buffer.length
          ? this.terminal.registerMarker(line - buffer.baseY - buffer.cursorY)
          : undefined;
      if (marker)
        this.commands.set(command.id, {
          command,
          marker,
          output: atLine(command.range.outputStartLine - offset),
          end:
            command.range.endLine === undefined
              ? undefined
              : atLine(command.range.endLine - offset),
        });
    }
    this.refresh();
  }

  locations(): Array<{ command: TerminalCommand; range: TerminalCommandRange }> {
    return [...this.commands.values()].flatMap((entry) => {
      if (
        entry.marker.isDisposed ||
        !entry.output ||
        entry.output.isDisposed ||
        entry.end?.isDisposed
      )
        return [];
      return [
        {
          command: entry.command,
          range: {
            startLine: entry.marker.line,
            outputStartLine: entry.output.line,
            ...(entry.end ? { endLine: entry.end.line } : {}),
          },
        },
      ];
    });
  }

  configure(preferences: TerminalPreferences): void {
    this.visibility = preferences.commandDecorations;
    this.surface.dataset.commandDecorations = this.visibility;
    this.refresh();
  }

  refresh(): void {
    const normal = this.terminal.buffer.active.type === 'normal';
    const gutter = this.visibility === 'both' || this.visibility === 'gutter';
    const ruler = this.visibility === 'both' || this.visibility === 'overviewRuler';
    this.terminal.options.overviewRuler = { width: normal && ruler ? 10 : 0 };
    for (const entry of this.commands.values()) {
      entry.render?.dispose();
      entry.decoration?.dispose();
      entry.decoration = undefined;
      entry.render = undefined;
      if (!normal || this.visibility === 'never' || entry.marker.isDisposed) continue;
      const command = entry.command;
      const status =
        command.finishedAt === null
          ? 'running'
          : command.exitCode === null
            ? 'unknown'
            : command.exitCode === 0
              ? 'success'
              : 'error';
      const color = status === 'error' ? '#f14c4c' : status === 'success' ? '#389458' : '#888888';
      const decoration = this.terminal.registerDecoration({
        marker: entry.marker,
        layer: 'top',
        overviewRulerOptions: ruler
          ? { color, position: status === 'error' ? 'right' : 'left' }
          : undefined,
      });
      if (!decoration) continue;
      entry.decoration = decoration;
      entry.render = decoration.onRender((element) => {
        element.classList.add('dnaforge-terminal-command-decoration');
        element.style.visibility = gutter ? '' : 'hidden';
        if (element.firstChild) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.commandId = command.id;
        button.dataset.status = status;
        button.textContent = status === 'error' ? '×' : status === 'success' ? '✓' : '◌';
        const outcome =
          status === 'running'
            ? 'Running'
            : command.exitCode === null
              ? 'Finished'
              : `Exit code ${command.exitCode}`;
        const duration =
          command.finishedAt === null
            ? ''
            : ` · ${Math.max(0, command.finishedAt - command.startedAt)} ms`;
        button.setAttribute('aria-label', `${outcome}: ${command.command}`);
        button.title = `${outcome}${duration}\n${command.command}\nShow command actions`;
        button.addEventListener('mousedown', (event) => event.stopPropagation());
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.onChoose(command);
        });
        element.appendChild(button);
      });
    }
  }

  clear(): void {
    for (const entry of this.commands.values()) {
      entry.render?.dispose();
      entry.decoration?.dispose();
      entry.marker.dispose();
      entry.output?.dispose();
      entry.end?.dispose();
    }
    this.commands.clear();
  }

  dispose(): void {
    for (const listener of this.listeners) listener.dispose();
    this.clear();
  }
}
