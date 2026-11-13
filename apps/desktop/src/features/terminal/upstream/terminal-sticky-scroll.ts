/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/
import type { TerminalCommandRange } from '../../../shared/terminal-ipc';

export function terminalStickyScrollCommand<T extends { range: TerminalCommandRange }>(
  commands: T[],
  viewportY: number
): T | undefined {
  for (let index = commands.length - 1; index >= 0; index--)
    if (commands[index].range.startLine <= viewportY) return commands[index];
  return undefined;
}

export function terminalStickyScrollRange(
  command: TerminalCommandRange,
  viewportY: number,
  rows: number,
  maxLineCount: number
): { start: number; end: number; truncated: boolean } | undefined {
  if (viewportY <= command.startLine) return undefined;
  const promptRows = Math.max(1, command.outputStartLine - command.startLine);
  const cap = Math.min(maxLineCount, Math.floor(rows * 0.4));
  const rowOffset =
    command.endLine === undefined ? 0 : Math.max(viewportY - command.endLine + 1, 0);
  const count = Math.min(promptRows, cap) - rowOffset;
  if (count < 1) return undefined;
  return {
    start: command.startLine + rowOffset,
    end: command.startLine + rowOffset + count - 1,
    truncated: count < promptRows,
  };
}
