/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetUiPersistence,
  EXPANDED_PATHS_PER_ROOT_CAP,
  EXPANDED_ROOTS_CAP,
  clearExpandedPaths,
  expandedPathsKey,
  readExpandedPaths,
  readSidebarState,
  sweepExpandedPathRoots,
  writeExpandedPaths,
  writeSidebarState,
} from './ui-persistence';

describe('ui-persistence: expanded paths', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetUiPersistence();
  });

  it('round-trips a set of paths under a root', () => {
    writeExpandedPaths('/ws', ['/ws/a', '/ws/a/b']);
    expect(readExpandedPaths('/ws')).toEqual(['/ws/a', '/ws/a/b']);
  });

  it('keys off the root path with any trailing separator trimmed', () => {
    writeExpandedPaths('/ws/', ['/ws/a']);
    expect(readExpandedPaths('/ws')).toEqual(['/ws/a']);
    expect(expandedPathsKey('/ws/')).toBe(expandedPathsKey('/ws'));
  });

  it('never throws on unreadable data — returns empty', () => {
    localStorage.setItem(expandedPathsKey('/ws'), 'not json {{{');
    expect(readExpandedPaths('/ws')).toEqual([]);

    localStorage.setItem(expandedPathsKey('/ws'), JSON.stringify({ v: 99, paths: ['/ws/a'] }));
    expect(readExpandedPaths('/ws')).toEqual([]);

    localStorage.setItem(expandedPathsKey('/ws'), JSON.stringify({ v: 1, paths: 'nope' }));
    expect(readExpandedPaths('/ws')).toEqual([]);
  });

  it('drops paths that are not under the root', () => {
    writeExpandedPaths('/ws', ['/ws/a', '/other/x', '/ws-sibling/y']);
    expect(readExpandedPaths('/ws')).toEqual(['/ws/a']);
  });

  it('keeps two roots independent', () => {
    writeExpandedPaths('/wsA', ['/wsA/one']);
    writeExpandedPaths('/wsB', ['/wsB/two']);
    expect(readExpandedPaths('/wsA')).toEqual(['/wsA/one']);
    expect(readExpandedPaths('/wsB')).toEqual(['/wsB/two']);
  });

  it('caps a root at EXPANDED_PATHS_PER_ROOT_CAP, dropping the DEEPEST first', () => {
    const shallow = Array.from(
      { length: 10 },
      (_, i) => `/ws/a-very-long-top-level-folder-name-for-experiment-${i}`
    );
    const deep = Array.from(
      { length: EXPANDED_PATHS_PER_ROOT_CAP },
      (_, i) => `/ws/a/b/c/d/e/${i}`
    );
    for (const s of shallow) {
      expect(s.length).toBeGreaterThan(deep[0].length);
    }
    writeExpandedPaths('/ws', [...shallow, ...deep]);

    const stored = readExpandedPaths('/ws');
    expect(stored).toHaveLength(EXPANDED_PATHS_PER_ROOT_CAP);
    for (const s of shallow) expect(stored).toContain(s);
  });

  it('clearExpandedPaths removes only its own root', () => {
    writeExpandedPaths('/wsA', ['/wsA/one']);
    writeExpandedPaths('/wsB', ['/wsB/two']);
    clearExpandedPaths('/wsA');
    expect(readExpandedPaths('/wsA')).toEqual([]);
    expect(readExpandedPaths('/wsB')).toEqual(['/wsB/two']);
  });

  it('sweeps beyond EXPANDED_ROOTS_CAP roots, evicting the oldest first', () => {
    const total = EXPANDED_ROOTS_CAP + 5;
    for (let i = 0; i < total; i += 1) {
      writeExpandedPaths(`/ws${i}`, [`/ws${i}/a`], { now: 1000 + i });
    }
    sweepExpandedPathRoots();

    const survivors: number[] = [];
    for (let i = 0; i < total; i += 1) {
      if (readExpandedPaths(`/ws${i}`).length > 0) survivors.push(i);
    }
    expect(survivors).toHaveLength(EXPANDED_ROOTS_CAP);
    expect(survivors).not.toContain(0);
    expect(survivors).toContain(total - 1);
  });

  it('a full disk does not throw and does not corrupt a prior value', () => {
    writeExpandedPaths('/ws', ['/ws/a']);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => writeExpandedPaths('/ws', ['/ws/a', '/ws/b'])).not.toThrow();

    setItem.mockRestore();
    expect(readExpandedPaths('/ws')).toEqual(['/ws/a']);
    warn.mockRestore();
  });
});

describe('ui-persistence: sidebar state', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults when nothing is stored', () => {
    expect(readSidebarState()).toEqual({
      activeView: 'files',
      sidebarVisible: true,
      sidebarWidth: 260,
    });
  });

  it.each(['search', 'references'] as const)('round-trips the allowed %s view', (activeView) => {
    writeSidebarState({ activeView, sidebarVisible: false, sidebarWidth: 340 });
    expect(readSidebarState()).toEqual({
      activeView,
      sidebarVisible: false,
      sidebarWidth: 340,
    });
  });

  it('restores Jobs as a reachable sidebar view', () => {
    writeSidebarState({ activeView: 'jobs', sidebarVisible: false, sidebarWidth: 180 });
    expect(readSidebarState()).toEqual({
      activeView: 'jobs',
      sidebarVisible: false,
      sidebarWidth: 180,
    });
  });

  it.each([
    'settings',
    'home',
    'organizations',
    'toolbox',
    'svg-gallery',
    'source-control',
    'garbage',
  ])('coerces %s to files AND forces the sidebar visible', (view) => {
    writeSidebarState({
      activeView: view as never,
      sidebarVisible: false,
      sidebarWidth: 300,
    });
    const restored = readSidebarState();
    expect(restored.activeView).toBe('files');
    expect(restored.sidebarVisible).toBe(true);
    expect(restored.sidebarWidth).toBe(300);
  });

  it('clamps width to the resize range', () => {
    writeSidebarState({ activeView: 'files', sidebarVisible: true, sidebarWidth: 9999 });
    expect(readSidebarState().sidebarWidth).toBe(500);
    writeSidebarState({ activeView: 'files', sidebarVisible: true, sidebarWidth: 10 });
    expect(readSidebarState().sidebarWidth).toBe(180);
    writeSidebarState({ activeView: 'files', sidebarVisible: true, sidebarWidth: NaN });
    expect(readSidebarState().sidebarWidth).toBe(260);
  });

  it('never throws on unreadable data', () => {
    localStorage.setItem('waypoint:sidebar-state', '{{{');
    expect(readSidebarState()).toEqual({
      activeView: 'files',
      sidebarVisible: true,
      sidebarWidth: 260,
    });
  });
});
