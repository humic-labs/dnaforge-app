/* Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See LICENSE.txt in this directory.
 */

export interface TerminalWord {
  text: string;
  startIndex: number;
  endIndex: number;
}
export function parseTerminalWords(text: string, separators = ' ()[]{}\',"`'): TerminalWord[] {
  if (!text || text.length > 2000) return [];
  const escaped = separators.replace(/[\\\][\-^]/g, '\\$&');
  const split = text.split(new RegExp(`[${escaped}\ue0b0-\ue0bf]`, 'g'));
  let index = 0;
  const words: TerminalWord[] = [];
  for (const part of split) {
    const word = part.endsWith(':') ? part.slice(0, -1) : part;
    if (word && word.length <= 100)
      words.push({ text: word, startIndex: index, endIndex: index + word.length });
    index += part.length + 1;
  }
  return words;
}
