/**
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import type { ILink, Terminal, IBufferLine } from '@xterm/xterm';

export const strictUrlRegex =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;

function isUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const parsedBase =
      url.password && url.username
        ? `${url.protocol}//${url.username}:${url.password}@${url.host}`
        : url.username
          ? `${url.protocol}//${url.username}@${url.host}`
          : `${url.protocol}//${url.host}`;
    return urlString.toLocaleLowerCase().startsWith(parsedBase.toLocaleLowerCase());
  } catch (e) {
    return false;
  }
}

export class LinkComputer {
  public static computeLink(
    y: number,
    regex: RegExp,
    terminal: Pick<Terminal, 'buffer'>,
    activate: (event: MouseEvent, uri: string) => void
  ): ILink[] {
    const rex = new RegExp(regex.source, (regex.flags || '') + 'g');

    const [lines, startLineIndex] = LinkComputer._getWindowedLineStrings(y - 1, terminal);
    const line = lines.join('');

    let match;
    const result: ILink[] = [];

    while ((match = rex.exec(line))) {
      const text = match[0];

      if (!isUrl(text)) {
        continue;
      }

      const [startY, startX] = LinkComputer._mapStrIdx(terminal, startLineIndex, 0, match.index);
      const [endY, endX] = LinkComputer._mapStrIdx(terminal, startY, startX, text.length);

      if (startY === -1 || startX === -1 || endY === -1 || endX === -1) {
        continue;
      }

      const range = {
        start: {
          x: startX + 1,
          y: startY + 1,
        },
        end: {
          x: endX,
          y: endY + 1,
        },
      };

      result.push({ range, text, activate });
    }

    return result;
  }

  private static _getWindowedLineStrings(
    lineIndex: number,
    terminal: Pick<Terminal, 'buffer'>
  ): [string[], number] {
    let line: IBufferLine | undefined;
    let topIdx = lineIndex;
    let bottomIdx = lineIndex;
    let length = 0;
    let content = '';
    const lines: string[] = [];

    if ((line = terminal.buffer.active.getLine(lineIndex))) {
      const currentContent = line.translateToString(true);

      if (line.isWrapped && currentContent[0] !== ' ') {
        length = 0;
        while ((line = terminal.buffer.active.getLine(--topIdx)) && length < 2048) {
          content = line.translateToString(true);
          length += content.length;
          lines.push(content);
          if (!line.isWrapped || content.indexOf(' ') !== -1) {
            break;
          }
        }
        lines.reverse();
      }

      lines.push(currentContent);

      length = 0;
      while (
        (line = terminal.buffer.active.getLine(++bottomIdx)) &&
        line.isWrapped &&
        length < 2048
      ) {
        content = line.translateToString(true);
        length += content.length;
        lines.push(content);
        if (content.indexOf(' ') !== -1) {
          break;
        }
      }
    }
    return [lines, topIdx];
  }

  private static _mapStrIdx(
    terminal: Pick<Terminal, 'buffer'>,
    lineIndex: number,
    rowIndex: number,
    stringIndex: number
  ): [number, number] {
    const buf = terminal.buffer.active;
    const cell = buf.getNullCell();
    let start = rowIndex;
    while (stringIndex) {
      const line = buf.getLine(lineIndex);
      if (!line) {
        return [-1, -1];
      }
      for (let i = start; i < line.length; ++i) {
        line.getCell(i, cell);
        const chars = cell.getChars();
        const width = cell.getWidth();
        if (width) {
          stringIndex -= chars.length || 1;

          if (i === line.length - 1 && chars === '') {
            const line = buf.getLine(lineIndex + 1);
            if (line && line.isWrapped) {
              line.getCell(0, cell);
              if (cell.getWidth() === 2) {
                stringIndex += 1;
              }
            }
          }
        }
        if (stringIndex < 0) {
          return [lineIndex, i];
        }
      }
      lineIndex++;
      start = 0;
    }
    return [lineIndex, start];
  }
}
