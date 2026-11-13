/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { IBufferRange, IBufferLine } from '@xterm/xterm';
interface IRange {
  startLineNumber: number;
  endLineNumber: number;
  startColumn: number;
  endColumn: number;
}
export function convertLinkRangeToBuffer(
  lines: IBufferLine[],
  bufferWidth: number,
  range: IRange,
  startLine: number
): IBufferRange {
  const bufferRange: IBufferRange = {
    start: {
      x: range.startColumn,
      y: range.startLineNumber + startLine,
    },
    end: {
      x: range.endColumn - 1,
      y: range.endLineNumber + startLine,
    },
  };

  let startOffset = 0;
  const startWrappedLineCount = Math.ceil(range.startColumn / bufferWidth);
  for (let y = 0; y < Math.min(startWrappedLineCount); y++) {
    const lineLength = Math.min(bufferWidth, range.startColumn - 1 - y * bufferWidth);
    let lineOffset = 0;
    const line = lines[y];
    if (!line) {
      break;
    }
    for (let x = 0; x < Math.min(bufferWidth, lineLength + lineOffset); x++) {
      const cell = line.getCell(x);
      if (!cell) {
        break;
      }
      const width = cell.getWidth();
      if (width === 2) {
        lineOffset++;
      }
      const char = cell.getChars();
      if (char.length > 1) {
        lineOffset -= char.length - 1;
      }
    }
    startOffset += lineOffset;
  }

  let endOffset = 0;
  const endWrappedLineCount = Math.ceil(range.endColumn / bufferWidth);
  for (let y = Math.max(0, startWrappedLineCount - 1); y < endWrappedLineCount; y++) {
    const start =
      y === startWrappedLineCount - 1 ? (range.startColumn - 1 + startOffset) % bufferWidth : 0;
    const lineLength = Math.min(bufferWidth, range.endColumn + startOffset - y * bufferWidth);
    let lineOffset = 0;
    const line = lines[y];
    if (!line) {
      break;
    }
    for (let x = start; x < Math.min(bufferWidth, lineLength + lineOffset); x++) {
      const cell = line.getCell(x);
      if (!cell) {
        break;
      }
      const width = cell.getWidth();
      const chars = cell.getChars();
      if (width === 2) {
        lineOffset++;
      }
      if (x === bufferWidth - 1 && chars === '') {
        lineOffset++;
      }
      if (chars.length > 1) {
        lineOffset -= chars.length - 1;
      }
    }
    endOffset += lineOffset;
  }

  bufferRange.start.x += startOffset;
  bufferRange.end.x += startOffset + endOffset;

  while (bufferRange.start.x > bufferWidth) {
    bufferRange.start.x -= bufferWidth;
    bufferRange.start.y++;
  }
  while (bufferRange.end.x > bufferWidth) {
    bufferRange.end.x -= bufferWidth;
    bufferRange.end.y++;
  }

  return bufferRange;
}
