/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See LICENSE.txt in this directory.
 * Adapted from VS Code 9ed1adf18f4e746adad3e6ed3264cca607e1bbb8
 * src/vs/base/common/filters.ts:isPatternInWord. The optional score-table write
 * is omitted: this picker retains history order instead of ranking by score.
 *--------------------------------------------------------------------------------------------*/
export function isPatternInWord(
  patternLow: string,
  patternPos: number,
  patternLen: number,
  wordLow: string,
  wordPos: number,
  wordLen: number
): boolean {
  while (patternPos < patternLen && wordPos < wordLen) {
    if (patternLow[patternPos] === wordLow[wordPos]) {
      patternPos += 1;
    }
    wordPos += 1;
  }
  return patternPos === patternLen;
}
