// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  registerEditFromViewer,
  registerActivateFromViewer,
  registerGetAnnotationDraft,
  registerSaveActiveSequence,
  registerSelectAnnotationInViewer,
  type ActivateFromViewerBridge,
} from './activate-from-viewer-bridge';

describe('activateAnnotationFromViewer bridge ', () => {
  it('clears BOTH the keyed entry and the singular alias when the only tab unmounts', () => {
    const bridge: ActivateFromViewerBridge = {};
    const handler = () => 'ecoli';

    const dispose = registerActivateFromViewer(bridge, '/ws/ecoli.gb', handler);
    expect(bridge.activateAnnotationFromViewer).toBe(handler);
    expect(bridge._activateFromViewer).toEqual({ '/ws/ecoli.gb': handler });

    dispose();

    expect(bridge._activateFromViewer).toEqual({});
    expect(bridge.activateAnnotationFromViewer).toBeUndefined();
  });

  it('hands the alias to a still-open tab rather than dangling or clearing', () => {
    const bridge: ActivateFromViewerBridge = {};
    const first = () => 'first';
    const second = () => 'second';

    const disposeFirst = registerActivateFromViewer(bridge, '/ws/a.gb', first);
    registerActivateFromViewer(bridge, '/ws/b.gb', second);
    expect(bridge.activateAnnotationFromViewer).toBe(second);

    disposeFirst();
    expect(bridge.activateAnnotationFromViewer).toBe(second);
    expect(bridge._activateFromViewer).toEqual({ '/ws/b.gb': second });
  });

  it('falls back to a remaining tab when the ALIAS holder closes', () => {
    const bridge: ActivateFromViewerBridge = {};
    const first = () => 'first';
    const second = () => 'second';

    registerActivateFromViewer(bridge, '/ws/a.gb', first);
    const disposeSecond = registerActivateFromViewer(bridge, '/ws/b.gb', second);
    expect(bridge.activateAnnotationFromViewer).toBe(second);

    disposeSecond();
    expect(bridge.activateAnnotationFromViewer).toBe(first);
  });

  it('leaves no reference to ANY closed tab after every tab closes', () => {
    const bridge: ActivateFromViewerBridge = {};
    const handlers = ['/ws/a.gb', '/ws/b.gb', '/ws/c.gb'].map((p) => {
      const h = () => p;
      return { path: p, handler: h, dispose: registerActivateFromViewer(bridge, p, h) };
    });

    for (const { dispose } of handlers) dispose();

    expect(bridge._activateFromViewer).toEqual({});
    expect(bridge.activateAnnotationFromViewer).toBeUndefined();
    const reachable = [
      ...Object.values(bridge._activateFromViewer ?? {}),
      bridge.activateAnnotationFromViewer,
    ].filter(Boolean);
    expect(reachable).toEqual([]);
  });

  it('re-registering the same path replaces rather than accumulates', () => {
    const bridge: ActivateFromViewerBridge = {};
    const stale = () => 'stale';
    const fresh = () => 'fresh';

    registerActivateFromViewer(bridge, '/ws/a.gb', stale);
    const dispose = registerActivateFromViewer(bridge, '/ws/a.gb', fresh);

    expect(Object.values(bridge._activateFromViewer ?? {})).toEqual([fresh]);
    dispose();
    expect(bridge.activateAnnotationFromViewer).toBeUndefined();
  });
});

describe('SequenceTab callback bridge ownership ', () => {
  it('releases saveActiveSequence when the owning tab unmounts', () => {
    const bridge: ActivateFromViewerBridge = {};
    const handler = () => 'saved';

    const dispose = registerSaveActiveSequence(bridge, '/ws/ecoli.gb', handler);
    expect(bridge.saveActiveSequence).toBe(handler);
    expect(bridge._saves).toEqual({ '/ws/ecoli.gb': handler });

    dispose();

    expect(bridge._saves).toEqual({});
    expect(bridge.saveActiveSequence).toBeUndefined();
  });

  it('releases editAnnotationFromViewer and hands the alias to a remaining tab', () => {
    const bridge: ActivateFromViewerBridge = {};
    const first = () => 'first';
    const second = () => 'second';
    registerEditFromViewer(bridge, '/ws/a.gb', first);
    const disposeSecond = registerEditFromViewer(bridge, '/ws/b.gb', second);

    disposeSecond();

    expect(bridge._editFromViewer).toEqual({ '/ws/a.gb': first });
    expect(bridge.editAnnotationFromViewer).toBe(first);
  });

  it('releases selectAnnotationInViewer when the owning tab unmounts', () => {
    const bridge: ActivateFromViewerBridge = {};
    const handler = () => 'selected';

    const dispose = registerSelectAnnotationInViewer(bridge, '/ws/ecoli.gb', handler);
    dispose();

    expect(bridge._selectAnnotationInViewer).toEqual({});
    expect(bridge.selectAnnotationInViewer).toBeUndefined();
  });

  it('releases getAnnotationDraft when the owning tab unmounts', () => {
    const bridge: ActivateFromViewerBridge = {};
    const handler = () => 'draft';

    const dispose = registerGetAnnotationDraft(bridge, '/ws/ecoli.gb', handler);
    dispose();

    expect(bridge._getAnnotationDraft).toEqual({});
    expect(bridge.getAnnotationDraft).toBeUndefined();
  });

  it('does not let an older cleanup delete a newer same-document registration', () => {
    const bridge: ActivateFromViewerBridge = {};
    const stale = () => 'stale';
    const fresh = () => 'fresh';
    const disposeStale = registerEditFromViewer(bridge, '/ws/ecoli.gb', stale);
    registerEditFromViewer(bridge, '/ws/ecoli.gb', fresh);

    disposeStale();

    expect(bridge._editFromViewer).toEqual({ '/ws/ecoli.gb': fresh });
    expect(bridge.editAnnotationFromViewer).toBe(fresh);
  });
});
