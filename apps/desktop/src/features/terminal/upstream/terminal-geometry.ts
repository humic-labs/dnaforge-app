/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See LICENSE.txt in this directory.
 *--------------------------------------------------------------------------------------------*/
import type { IBuffer } from '@xterm/xterm';

export function longestTerminalViewportLine(buffer: IBuffer, cols: number): number {
  let longest = 0;
  for (let index = buffer.length - 1; index >= buffer.viewportY; index--) {
    let line = buffer.getLine(index);
    if (!line) continue;
    let current = index;
    let endSpaces = 0;
    for (let cell = Math.min(line.length, cols) - 1; cell >= 0; cell--) {
      if (!line.getCell(cell)?.getChars()) endSpaces++;
      else break;
    }
    while (line?.isWrapped && current > 0) {
      current--;
      line = buffer.getLine(current);
    }
    longest = Math.max(longest, (index - current + 1) * cols - endSpaces);
    index = current;
  }
  return longest;
}
