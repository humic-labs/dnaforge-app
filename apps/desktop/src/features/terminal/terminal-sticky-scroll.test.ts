import { expect, it } from 'vitest';
import {
  terminalStickyScrollRange,
  terminalStickyScrollCommand,
} from './upstream/terminal-sticky-scroll';

it('selects the prompt at the viewport boundary instead of pinning its previous command', () => {
  const previous = { range: { startLine: 3, outputStartLine: 6, endLine: 24 } };
  const current = { range: { startLine: 24, outputStartLine: 27, endLine: 120 } };
  const selected = terminalStickyScrollCommand([previous, current], 24);
  expect(selected).toBe(current);
  expect(terminalStickyScrollRange(selected!.range, 24, 20, 5)).toBeUndefined();
});

it('clips a pinned multiline prompt at the next command and caps occupied rows', () => {
  const command = { startLine: 3, outputStartLine: 6, endLine: 24 };
  expect(terminalStickyScrollRange(command, 3, 20, 5)).toBeUndefined();
  expect(terminalStickyScrollRange(command, 4, 20, 5)).toEqual({
    start: 3,
    end: 5,
    truncated: false,
  });
  expect(terminalStickyScrollRange(command, 24, 20, 5)).toEqual({
    start: 4,
    end: 5,
    truncated: true,
  });
  expect(terminalStickyScrollRange(command, 26, 20, 5)).toBeUndefined();
  expect(terminalStickyScrollRange(command, 7, 5, 5)).toEqual({
    start: 3,
    end: 4,
    truncated: true,
  });
});
