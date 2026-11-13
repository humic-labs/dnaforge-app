// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTerminalPreferences } from './terminal-preferences';
import { TERMINAL_SETTINGS_GROUPS } from './terminal-settings-fields';
import { searchSettings } from '../../components/settings-catalog';
import {
  TERMINAL_APPEARANCE_KEY,
  saveTerminalPreferences,
  useTerminalPreferences,
} from './terminal-settings-store';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('application Settings and live terminal consumers', () => {
  it('preserves old saved values and updates every mounted consumer without reopening a terminal', () => {
    localStorage.setItem(
      TERMINAL_APPEARANCE_KEY,
      JSON.stringify({ fontSize: 19, fontFamily: 'custom mono', copyOnSelection: true })
    );
    const first = renderHook(useTerminalPreferences);
    const second = renderHook(useTerminalPreferences);
    expect(first.result.current).toMatchObject({
      fontSize: 19,
      fontFamily: 'custom mono',
      copyOnSelection: true,
    });
    act(() =>
      saveTerminalPreferences({
        ...first.result.current,
        gpuAcceleration: 'off',
        fontLigatures: true,
      })
    );
    expect(second.result.current).toMatchObject({
      gpuAcceleration: 'off',
      fontLigatures: true,
      fontSize: 19,
    });
    expect(JSON.parse(localStorage.getItem(TERMINAL_APPEARANCE_KEY)!)).toMatchObject({
      gpuAcceleration: 'off',
      fontLigatures: true,
      fontFamily: 'custom mono',
    });
  });

  it('receives changes made in another window and falls back safely on invalid stored data', () => {
    const consumer = renderHook(useTerminalPreferences);
    act(() => {
      localStorage.setItem(
        TERMINAL_APPEARANCE_KEY,
        JSON.stringify({ fontSize: 22, fontLigatures: true })
      );
      window.dispatchEvent(new StorageEvent('storage', { key: TERMINAL_APPEARANCE_KEY }));
    });
    expect(consumer.result.current).toMatchObject({ fontSize: 22, fontLigatures: true });
    act(() => {
      localStorage.setItem(TERMINAL_APPEARANCE_KEY, '{broken');
      window.dispatchEvent(new StorageEvent('storage', { key: TERMINAL_APPEARANCE_KEY }));
    });
    expect(consumer.result.current).toEqual(parseTerminalPreferences({}));
  });

  it('does not present an unsuccessful preference write as a live change', () => {
    const consumer = renderHook(useTerminalPreferences);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('write failed');
    });
    expect(() => saveTerminalPreferences({ ...consumer.result.current, fontSize: 22 })).toThrow(
      'write failed'
    );
    expect(consumer.result.current.fontSize).toBe(14);
  });

  it('keeps every existing preference available and searchable in Settings', () => {
    const fields = TERMINAL_SETTINGS_GROUPS.flatMap((group) => group.fields);
    expect(fields.map((field) => field.key).sort()).toEqual(
      Object.keys(parseTerminalPreferences({})).sort()
    );
    for (const field of fields) {
      expect(
        searchSettings(field.label, ['terminal']).some(
          (result) => result.targetId === `terminal-${field.key}`
        )
      ).toBe(true);
    }
    expect(
      searchSettings('ligatures', ['terminal']).some(
        (result) => result.targetId === 'terminal-fontLigatures'
      )
    ).toBe(true);
    expect(
      searchSettings('shell profiles', ['terminal']).some(
        (result) => result.targetId === 'terminal-profiles'
      )
    ).toBe(true);
  });
});
