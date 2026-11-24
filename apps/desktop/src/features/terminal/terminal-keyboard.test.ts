import { expect, it } from 'vitest';
import {
  terminalClipboardAction,
  terminalFindShortcut,
  terminalHistoryShortcut,
  terminalLinkShortcut,
  terminalSplitShortcut,
  terminalResizeDirection,
  terminalNavigateGroupDirection,
} from './terminal-keyboard';

it('navigates terminal subtabs with distinct platform chords and preserves workspace and shell keys', () => {
  const plain = { code: 'Tab', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const previous =
      platform === 'darwin'
        ? { ...plain, code: 'BracketLeft', metaKey: true, shiftKey: true }
        : { ...plain, code: 'PageUp', ctrlKey: true };
    const next = { ...previous, code: platform === 'darwin' ? 'BracketRight' : 'PageDown' };
    expect(terminalNavigateGroupDirection(platform, previous)).toBe(-1);
    expect(terminalNavigateGroupDirection(platform, next)).toBe(1);
    expect(terminalNavigateGroupDirection(platform, { ...next, altKey: true })).toBe(null);
    expect(terminalNavigateGroupDirection(platform, { ...next, shiftKey: !next.shiftKey })).toBe(
      null
    );
    expect(terminalNavigateGroupDirection(platform, { ...next, metaKey: !next.metaKey })).toBe(
      null
    );
    expect(terminalNavigateGroupDirection(platform, { ...next, ctrlKey: !next.ctrlKey })).toBe(
      null
    );
    for (const shiftKey of [false, true]) {
      expect(terminalNavigateGroupDirection(platform, { ...plain, ctrlKey: true, shiftKey })).toBe(
        null
      );
      expect(
        terminalNavigateGroupDirection(platform, {
          ...plain,
          code: 'Backquote',
          ctrlKey: true,
          shiftKey,
        })
      ).toBe(null);
    }
    expect(
      terminalNavigateGroupDirection(platform, { ...plain, code: 'ArrowLeft', altKey: true })
    ).toBe(null);
  }
});

it('uses upstream resize chords without capturing unbound Windows shell keys', () => {
  const mac = { code: 'ArrowLeft', ctrlKey: true, metaKey: true, shiftKey: false, altKey: false };
  expect(terminalResizeDirection('darwin', mac)).toBe('left');
  expect(terminalResizeDirection('darwin', { ...mac, code: 'ArrowDown' })).toBe('down');
  expect(terminalResizeDirection('darwin', { ...mac, altKey: true })).toBe(null);
  const linux = { ...mac, metaKey: false, shiftKey: true };
  expect(terminalResizeDirection('linux', linux)).toBe('left');
  expect(terminalResizeDirection('linux', { ...linux, code: 'ArrowRight' })).toBe('right');
  expect(terminalResizeDirection('linux', { ...linux, code: 'ArrowUp' })).toBe(null);
  expect(terminalResizeDirection('win32', linux)).toBe(null);
  expect(terminalResizeDirection('win32', mac)).toBe(null);
});

it('matches upstream split chords while leaving other shell keys untouched', () => {
  const command = {
    code: 'Backslash',
    ctrlKey: false,
    metaKey: true,
    shiftKey: false,
    altKey: false,
  };
  const control = { ...command, code: 'Digit5', ctrlKey: true, metaKey: false, shiftKey: true };
  expect(terminalSplitShortcut('darwin', command)).toBe(true);
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    expect(terminalSplitShortcut(platform, control)).toBe(true);
    expect(terminalSplitShortcut(platform, { ...control, altKey: true })).toBe(false);
    expect(terminalSplitShortcut(platform, { ...control, shiftKey: false })).toBe(false);
  }
  expect(terminalSplitShortcut('linux', command)).toBe(false);
  expect(terminalSplitShortcut('win32', command)).toBe(false);
  expect(terminalSplitShortcut('darwin', { ...command, ctrlKey: true })).toBe(false);
});

it('matches each platform clipboard convention without swallowing interrupt when nothing is selected', () => {
  const ctrlC = { key: 'c', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
  expect(terminalClipboardAction('win32', ctrlC, true)).toBe('copy');
  expect(terminalClipboardAction('win32', ctrlC, false)).toBe(null);
  expect(terminalClipboardAction('linux', ctrlC, true)).toBe(null);
  expect(terminalClipboardAction('linux', { ...ctrlC, shiftKey: true }, true)).toBe('copy');
  expect(terminalClipboardAction('win32', { ...ctrlC, key: 'v' }, false)).toBe('paste');
  expect(terminalClipboardAction('darwin', { ...ctrlC, ctrlKey: false, metaKey: true }, true)).toBe(
    'copy'
  );
  expect(
    terminalClipboardAction(
      'linux',
      { ...ctrlC, key: 'Insert', ctrlKey: false, shiftKey: true },
      false
    )
  ).toBe('paste');
});

it('preserves shell editing keys and separates terminal actions from native import shortcuts', () => {
  const ctrl = { code: 'KeyF', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
  for (const host of ['darwin', 'win32', 'linux'] as const) {
    expect(terminalFindShortcut(host, ctrl)).toBe(false);
    expect(terminalHistoryShortcut(host, { ...ctrl, code: 'KeyR' })).toBe(null);
    expect(terminalHistoryShortcut(host, { ...ctrl, code: 'KeyG' })).toBe(null);
    expect(terminalHistoryShortcut(host, { ...ctrl, code: 'KeyR', altKey: true })).toBe('command');
    const modifier = host === 'darwin' ? { ctrlKey: false, metaKey: true } : {};
    expect(terminalLinkShortcut(host, { ...ctrl, ...modifier, code: 'KeyO', shiftKey: true })).toBe(
      false
    );
    expect(terminalLinkShortcut(host, { ...ctrl, ...modifier, code: 'KeyO', altKey: true })).toBe(
      true
    );
  }
  expect(terminalFindShortcut('darwin', { ...ctrl, ctrlKey: false, metaKey: true })).toBe(true);
  expect(
    terminalFindShortcut('darwin', { ...ctrl, ctrlKey: false, metaKey: true, shiftKey: true })
  ).toBe(false);
  expect(terminalFindShortcut('linux', { ...ctrl, shiftKey: true })).toBe(true);
  expect(terminalFindShortcut('win32', { ...ctrl, shiftKey: true })).toBe(true);
});
