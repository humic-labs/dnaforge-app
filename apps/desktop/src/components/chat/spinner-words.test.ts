import { describe, it, expect } from 'vitest';

import { SPINNER_WORDS, pickRandomWord } from './spinner-words';

describe('spinner-words', () => {
  it('has at least 40 words', () => {
    expect(SPINNER_WORDS.length).toBeGreaterThanOrEqual(40);
  });

  it('all words end in "ing"', () => {
    for (const word of SPINNER_WORDS) {
      expect(word).toMatch(/ing$/);
    }
  });

  it('pickRandomWord returns a word from the list', () => {
    const word = pickRandomWord();
    expect(SPINNER_WORDS).toContain(word);
  });

  it('pickRandomWord avoids the excluded word', () => {
    const excluded = SPINNER_WORDS[0];
    for (let i = 0; i < 100; i++) {
      expect(pickRandomWord(excluded)).not.toBe(excluded);
    }
  });
});
