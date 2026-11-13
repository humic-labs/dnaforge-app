import { describe, expect, it } from 'vitest';

import type { Tab } from '../../canvas/types';
import {
  findIndexedTab,
  findOpenIndexedTab,
  projectIndexedCurrentView,
} from './indexed-current-view';

function indexedTab(partial: Partial<Tab> = {}): Tab {
  return {
    id: 'tab-1',
    type: 'sequence',
    entityId: '/ws/chrI.fa',
    label: 'chrI',
    indexedGenome: {
      sourcePath: 'refs/chrI.fa',
      sourceExt: '.fa',
      chrom: 'chrI',
      scope: { kind: 'chromosome', chrom: 'chrI' },
    },
    ...partial,
  };
}

describe('projectIndexedCurrentView', () => {
  it('keeps live start0 0 as real and omits a missing assembly id', () => {
    const result = projectIndexedCurrentView(indexedTab(), {
      chrom: 'chrI',
      start0: 0,
      end0: 100,
    });
    expect(result).toMatchObject({
      ok: true,
      tabId: 'tab-1',
      sourcePath: 'refs/chrI.fa',
      chrom: 'chrI',
      scopeKind: 'chromosome',
      start0: 0,
      end0: 100,
    });
    expect(result).not.toHaveProperty('assemblyId');
    expect(Object.prototype.hasOwnProperty.call(result, 'start0')).toBe(true);
  });

  it('converts inclusive highlightRange once and omits an empty live camera', () => {
    const result = projectIndexedCurrentView(
      indexedTab({
        viewState: { highlightRange: { start: 9, end: 19 } },
      }),
      { chrom: 'chrI', start0: 10, end0: 10 }
    );
    expect(result).toMatchObject({
      highlight: { start0: 9, end0: 20 },
    });
    expect(result).not.toHaveProperty('start0');
    expect((result as { start0?: number }).start0).not.toBe(0);
  });

  it('does not substitute persisted coordinates for an unrepresentable mounted camera', () => {
    const tab = indexedTab({
      indexedGenome: {
        ...indexedTab().indexedGenome!,
        scope: { kind: 'locus', chrom: 'chrII', start: 25, end: 50 },
      },
      viewState: { indexedViewport: { start0: 25, end0: 50 } },
    });
    const mountedUnknown = projectIndexedCurrentView(tab, null);
    expect(mountedUnknown).toMatchObject({ chrom: 'chrII' });
    expect(mountedUnknown).not.toHaveProperty('start0');
    expect(mountedUnknown).not.toHaveProperty('end0');

    expect(projectIndexedCurrentView(tab)).toMatchObject({
      chrom: 'chrII',
      start0: 25,
      end0: 50,
    });
  });

  it('returns NO_INDEXED_VIEW for a plain sequence tab and rejects a reversed interval', () => {
    const missing = projectIndexedCurrentView({
      id: 'seq',
      type: 'sequence',
      entityId: '/ws/pUC19.gb',
      label: 'pUC19',
    });
    expect(missing).toMatchObject({ ok: false, error: 'NO_INDEXED_VIEW' });
    const malformed = projectIndexedCurrentView(indexedTab(), {
      chrom: 'chrI',
      start0: 20,
      end0: 10,
    });
    expect(malformed).toMatchObject({ ok: false, error: 'MALFORMED_INTERVAL' });
  });
});

describe('findIndexedTab', () => {
  it('prefers the active indexed tab and otherwise the first indexed tab', () => {
    const chat: Tab = { id: 'chat', type: 'chat', entityId: 'c1', label: 'Chat' };
    const indexed = indexedTab({ id: 'idx' });
    expect(findIndexedTab([chat, indexed], 'chat')?.id).toBe('idx');
    expect(findIndexedTab([chat, indexed], 'idx')?.id).toBe('idx');
    expect(findIndexedTab([chat], 'chat')).toBeUndefined();
  });
});

describe('findOpenIndexedTab', () => {
  it('prefers an indexed tab in the focused panel', () => {
    const main = indexedTab({ id: 'main-indexed' });
    const side = indexedTab({
      id: 'side-indexed',
      indexedGenome: {
        sourcePath: 'refs/chrII.fa',
        sourceExt: '.fa',
        chrom: 'chrII',
      },
    });
    const found = findOpenIndexedTab({
      focusedPanelId: 'side',
      panels: {
        main: { tabs: [main], activeTabId: main.id },
        side: { tabs: [side], activeTabId: side.id },
      },
    });
    expect(found?.panelId).toBe('side');
    expect(found?.tab.id).toBe('side-indexed');
  });
});
