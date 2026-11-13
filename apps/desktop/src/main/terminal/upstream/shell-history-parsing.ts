/*
MIT License

Copyright (c) 2015 - present Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Adapted from Microsoft VS Code 9ed1adf18f4e746adad3e6ed3264cca607e1bbb8
src/vs/workbench/contrib/terminalContrib/history/common/history.ts.
Only pure parsers are retained; native file access lives in ../history.ts.
*/

export function parseBashHistory(content: string): string[] {
  const fileLines = content.split('\n');
  const result: Set<string> = new Set();
  let currentLine: string;
  let currentCommand: string | undefined = undefined;
  let wrapChar: string | undefined = undefined;
  for (let i = 0; i < fileLines.length; i++) {
    currentLine = fileLines[i];
    if (currentCommand === undefined) {
      currentCommand = currentLine;
    } else {
      currentCommand += `\n${currentLine}`;
    }
    for (let c = 0; c < currentLine.length; c++) {
      if (wrapChar) {
        if (currentLine[c] === wrapChar) {
          wrapChar = undefined;
        }
      } else {
        if (currentLine[c].match(/['"]/)) {
          wrapChar = currentLine[c];
        }
      }
    }
    if (wrapChar === undefined) {
      if (currentCommand.length > 0) {
        result.add(currentCommand.trim());
      }
      currentCommand = undefined;
    }
  }

  return Array.from(result.values());
}

export function parseZshHistory(content: string): string[] {
  const isExtendedHistory = /^:\s\d+:\d+;/.test(content);
  const fileLines = content.split(isExtendedHistory ? /:\s\d+:\d+;/ : /(?<!\\)\n/);
  const result: Set<string> = new Set();
  for (let i = 0; i < fileLines.length; i++) {
    const sanitized = fileLines[i].replace(/\\\n/g, '\n').trim();
    if (sanitized.length > 0) {
      result.add(sanitized);
    }
  }
  return Array.from(result.values());
}

export function parsePowerShellHistory(content: string): string[] {
  const fileLines = content.split('\n');
  const result: Set<string> = new Set();
  let currentLine: string;
  let currentCommand: string | undefined = undefined;
  let wrapChar: string | undefined = undefined;
  for (let i = 0; i < fileLines.length; i++) {
    currentLine = fileLines[i];
    if (currentCommand === undefined) {
      currentCommand = currentLine;
    } else {
      currentCommand += `\n${currentLine}`;
    }
    if (!currentLine.endsWith('`')) {
      const sanitized = currentCommand.trim();
      if (sanitized.length > 0) {
        result.add(sanitized);
      }
      currentCommand = undefined;
      continue;
    }
    for (let c = 0; c < currentLine.length; c++) {
      if (wrapChar) {
        if (currentLine[c] === wrapChar) {
          wrapChar = undefined;
        }
      } else {
        if (currentLine[c].match(/`/)) {
          wrapChar = currentLine[c];
        }
      }
    }
    if (!wrapChar) {
      const sanitized = currentCommand.trim();
      if (sanitized.length > 0) {
        result.add(sanitized);
      }
      currentCommand = undefined;
    } else {
      currentCommand = currentCommand.replace(/`$/, '');
      wrapChar = undefined;
    }
  }

  return Array.from(result.values());
}

export function parseFishHistory(content: string): string[] {
  const result: Set<string> = new Set();
  const cmds = content
    .split('\n')
    .filter((x) => x.startsWith('- cmd:'))
    .map((x) => x.substring(6).trimStart());
  for (let i = 0; i < cmds.length; i++) {
    const sanitized = sanitizeFishHistoryCmd(cmds[i]).trim();
    if (sanitized.length > 0) {
      result.add(sanitized);
    }
  }
  return Array.from(result.values());
}

export function sanitizeFishHistoryCmd(cmd: string): string {
  return repeatedReplace(/(^|[^\\])((?:\\\\)*)(\\n)/g, cmd, '$1$2\n');
}

function repeatedReplace(pattern: RegExp, value: string, replaceValue: string): string {
  let last;
  let current = value;
  do {
    last = current;
    current = current.replace(pattern, replaceValue);
  } while (current !== last);
  return current;
}
