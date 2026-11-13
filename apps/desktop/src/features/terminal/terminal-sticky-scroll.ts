import { safeFocus } from '../../shared/utils/safeFocus';
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See upstream/LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import { Terminal, type IDisposable } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { TerminalCommand, TerminalCommandRange } from '../../shared/terminal-ipc';
import type { TerminalPreferences } from './terminal-preferences';
import { TerminalRendering } from './terminal-rendering';
import {
  terminalStickyScrollRange,
  terminalStickyScrollCommand,
} from './upstream/terminal-sticky-scroll';

export interface TerminalLocatedCommand {
  command: TerminalCommand;
  range: TerminalCommandRange;
}

export class TerminalStickyScroll {
  private readonly element = document.createElement('div');
  private readonly overlay = new Terminal({
    cols: 80,
    rows: 1,
    scrollback: 0,
    disableStdin: true,
    allowProposedApi: true,
    cursorBlink: false,
    cursorInactiveStyle: 'none',
    overviewRuler: { width: 0 },
  });
  private readonly serialize = new SerializeAddon();
  private readonly rendering = new TerminalRendering(this.overlay);
  private readonly listeners: IDisposable[];
  private readonly lifetime = new AbortController();
  private frame: number | undefined;
  private disposed = false;
  private epoch = 0;
  private contentKey = '';
  private current: TerminalLocatedCommand | undefined;
  private preferences: TerminalPreferences;

  constructor(
    private readonly terminal: Terminal,
    private readonly surface: HTMLElement,
    private readonly commands: () => TerminalLocatedCommand[],
    preferences: TerminalPreferences,
    onChoose: (command: TerminalCommand) => void
  ) {
    this.preferences = preferences;
    this.element.className = 'dnaforge-terminal-sticky-scroll';
    this.element.hidden = true;
    this.element.setAttribute('role', 'button');
    this.element.tabIndex = 0;
    const display = document.createElement('div');
    display.inert = true;
    display.setAttribute('aria-hidden', 'true');
    this.element.appendChild(display);
    surface.appendChild(this.element);
    this.overlay.loadAddon(new Unicode11Addon());
    this.overlay.unicode.activeVersion = '11';
    this.overlay.open(display);
    this.overlay.textarea?.remove();
    terminal.loadAddon(this.serialize);
    const options = { signal: this.lifetime.signal };
    const reveal = () => {
      if (!this.current) return;
      terminal.scrollToLine(this.current.range.startLine);
      safeFocus(terminal.textarea, { preventScroll: true });
    };
    this.element.addEventListener('click', reveal, options);
    this.element.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          reveal();
        }
      },
      options
    );
    this.element.addEventListener(
      'mousedown',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
      },
      options
    );
    this.element.addEventListener(
      'contextmenu',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.current) onChoose(this.current.command);
      },
      options
    );
    this.element.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        terminal.element?.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
          })
        );
      },
      { ...options, passive: false }
    );
    this.listeners = [
      terminal.onScroll(() => this.refresh()),
      terminal.onResize(() => this.configure(this.preferences)),
      terminal.onWriteParsed(() => this.refresh()),
      terminal.buffer.onBufferChange(() => this.refresh()),
    ];
    this.configure(preferences);
  }

  configure(preferences: TerminalPreferences): void {
    this.preferences = preferences;
    this.contentKey = '';
    const source = this.terminal.options;
    this.overlay.options = {
      fontFamily: source.fontFamily,
      fontSize: source.fontSize,
      fontWeight: source.fontWeight,
      fontWeightBold: source.fontWeightBold,
      lineHeight: source.lineHeight,
      letterSpacing: source.letterSpacing,
      theme: { ...source.theme },
    };
    this.rendering.configure({ gpuAcceleration: 'off', fontLigatures: preferences.fontLigatures });
    this.refresh();
  }

  refresh(): void {
    if (this.disposed || this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.render();
    });
  }

  private hide(): void {
    this.epoch++;
    this.element.hidden = true;
    this.current = undefined;
    this.contentKey = '';
  }

  private render(): void {
    const buffer = this.terminal.buffer.active;
    if (!this.preferences.stickyScrollEnabled || buffer.type !== 'normal') {
      this.hide();
      return;
    }
    const current = terminalStickyScrollCommand(this.commands(), buffer.viewportY);
    if (
      !current ||
      this.preferences.stickyScrollIgnoredCommands.some(
        (ignored) => ignored.toLowerCase() === current.command.command.trim().toLowerCase()
      )
    ) {
      this.hide();
      return;
    }
    if (
      current.command.finishedAt === null &&
      buffer.viewportY === buffer.baseY &&
      buffer.cursorY === this.terminal.rows - 1
    ) {
      const text = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? '';
      if (
        (buffer.cursorX === 1 && text.startsWith(':')) ||
        (buffer.cursorX === 5 && text.startsWith('(END)'))
      ) {
        this.hide();
        return;
      }
    }
    const range = terminalStickyScrollRange(
      current.range,
      buffer.viewportY,
      this.terminal.rows,
      this.preferences.stickyScrollMaxLineCount
    );
    if (!range) {
      this.hide();
      return;
    }
    const content =
      this.serialize.serialize({ range, excludeModes: true, excludeAltBuffer: true }) +
      (range.truncated ? '\x1b[0m …' : '');
    const screen = this.terminal.element?.querySelector('.xterm-screen');
    if (!screen) {
      this.hide();
      return;
    }
    const bounds = screen.getBoundingClientRect();
    const parent = this.surface.getBoundingClientRect();
    const count = range.end - range.start + 1;
    this.element.style.left = `${bounds.left - parent.left}px`;
    this.element.style.top = `${bounds.top - parent.top}px`;
    this.element.style.width = `${bounds.width}px`;
    this.element.style.height = `${(bounds.height / this.terminal.rows) * count}px`;
    this.element.dataset.commandId = current.command.id;
    this.element.setAttribute(
      'aria-label',
      `Pinned command: ${current.command.command}. Go to command`
    );
    this.element.title = 'Go to command · Right-click for command actions';
    this.current = current;
    const key = `${this.terminal.cols}:${count}:${content}`;
    if (key === this.contentKey) {
      this.element.hidden = false;
      return;
    }
    this.contentKey = key;
    const epoch = ++this.epoch;
    this.overlay.reset();
    this.overlay.resize(this.terminal.cols, count);
    this.overlay.write(content, () => {
      if (!this.disposed && epoch === this.epoch) this.element.hidden = false;
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.lifetime.abort();
    for (const listener of this.listeners) listener.dispose();
    this.serialize.dispose();
    this.rendering.dispose();
    this.overlay.dispose();
    this.element.remove();
  }
}
