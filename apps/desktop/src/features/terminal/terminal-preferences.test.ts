import { expect, it } from 'vitest';
import { parseTerminalPreferences } from './terminal-preferences';

it('defaults to automatic graphics and keeps joined programming symbols optional', () => {
  for (const saved of [null, {}, { gpuAcceleration: 'invalid', fontLigatures: 'true' }]) {
    expect(parseTerminalPreferences(saved)).toMatchObject({
      gpuAcceleration: 'auto',
      fontLigatures: false,
    });
  }
  expect(parseTerminalPreferences({ gpuAcceleration: 'off', fontLigatures: true })).toMatchObject({
    gpuAcceleration: 'off',
    fontLigatures: true,
  });
});

it('retains live font, inactive cursor, width and contrast choices with bounded fallback', () => {
  expect(
    parseTerminalPreferences({
      fontWeight: 500,
      fontWeightBold: 800,
      cursorInactiveStyle: 'bar',
      cursorWidth: 3,
      minimumContrastRatio: 7,
    })
  ).toMatchObject({
    fontWeight: 500,
    fontWeightBold: 800,
    cursorInactiveStyle: 'bar',
    cursorWidth: 3,
    minimumContrastRatio: 7,
  });
  expect(
    parseTerminalPreferences({
      fontWeight: 10000,
      fontWeightBold: -1,
      cursorInactiveStyle: 'invalid',
      cursorWidth: 0,
      minimumContrastRatio: Infinity,
    })
  ).toMatchObject({
    fontWeight: 900,
    fontWeightBold: 100,
    cursorInactiveStyle: 'outline',
    cursorWidth: 1,
    minimumContrastRatio: 1,
  });
  expect(parseTerminalPreferences(null)).toMatchObject({
    fontWeight: 400,
    fontWeightBold: 700,
    cursorInactiveStyle: 'outline',
    cursorWidth: 1,
    minimumContrastRatio: 1,
  });
});

it('preserves mouse/scroll/link choices and repairs malformed saved values', () => {
  expect(parseTerminalPreferences({})).toMatchObject({
    altClickMovesCursor: true,
    smoothScrolling: false,
    enableFileLinks: true,
  });
  expect(
    parseTerminalPreferences({
      altClickMovesCursor: false,
      smoothScrolling: true,
      enableFileLinks: false,
      wordSeparators: '',
    })
  ).toMatchObject({
    altClickMovesCursor: false,
    smoothScrolling: true,
    enableFileLinks: false,
    wordSeparators: '',
  });
  const defaults = parseTerminalPreferences({});
  for (const wordSeparators of [null, 42, 'x'.repeat(257), 'bad\u0000value']) {
    expect(parseTerminalPreferences({ wordSeparators })).toMatchObject({
      wordSeparators: defaults.wordSeparators,
    });
  }
});

it('keeps valid saved settings and repairs malformed or out-of-range values', () => {
  const valid = parseTerminalPreferences({
    fontFamily: 'Menlo, monospace',
    cursorStyle: 'bar',
    cursorBlink: false,
    lineHeight: 1.4,
    copyOnSelection: true,
    enableVisualBell: true,
    bellDuration: 5000,
  });
  expect(valid).toMatchObject({
    fontFamily: 'Menlo, monospace',
    cursorStyle: 'bar',
    cursorBlink: false,
    lineHeight: 1.4,
    copyOnSelection: true,
    enableVisualBell: true,
    bellDuration: 5000,
  });
  expect(
    parseTerminalPreferences({
      fontSize: Infinity,
      lineHeight: -2,
      cursorStyle: 'invisible',
      fontFamily: 3,
    })
  ).toMatchObject({ colorScheme: 'system', fontSize: 14, lineHeight: 1, cursorStyle: 'block' });
});
