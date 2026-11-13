import { describe, expect, it } from 'vitest';
import { parseTerminalWords } from './upstream/terminal-word-links';

describe('upstream terminal word fallback', () => {
  it('preserves source positions and trims punctuation without dropping filename suffixes', () => {
    const text = 'Build failed: "notes.txt:3:2" (README.md), report[1].txt';
    const words = parseTerminalWords(text);
    expect(words).toContainEqual(
      expect.objectContaining({ text: 'notes.txt:3:2', startIndex: text.indexOf('notes.txt:3:2') })
    );
    expect(words).toContainEqual(expect.objectContaining({ text: 'README.md' }));
    expect(words.some((word) => word.text === 'failed:')).toBe(false);
  });
  it('retains configured separators and bounds pathological terminal lines', () => {
    expect(parseTerminalWords('alpha|beta', '|').map((word) => word.text)).toEqual([
      'alpha',
      'beta',
    ]);
    expect(parseTerminalWords('x'.repeat(2001))).toEqual([]);
    expect(parseTerminalWords('first\ue0b0second').map((word) => word.text)).toEqual([
      'first',
      'second',
    ]);
  });
});
