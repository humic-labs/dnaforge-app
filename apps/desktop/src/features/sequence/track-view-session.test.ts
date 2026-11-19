import { act, cleanup, renderHook } from '@testing-library/react';
import type { Tab } from '../canvas/types';
import { useTrackViewSessionSource } from './components/useTrackViewSessionSource';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentLifecycle } from '../../shared/document-lifecycle';
import { trackViewFixture } from '../../shared/track-view-fixture';
import { validateTrackViewDocument } from '../../shared/track-view';
import { useCanvasStore } from '../canvas/store';
import { getTrackViewSession } from './track-view-control';
const boundary = vi.hoisted(() => ({ save: vi.fn(), open: vi.fn() }));
vi.mock('./track-view-library', () => ({ saveTrackView: boundary.save }));
vi.mock('./open-track-view', () => ({ openTrackView: boundary.open }));
vi.mock('../../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));
function open() {
  const document = validateTrackViewDocument(trackViewFixture());
  const tabId = useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: document.id,
    label: document.name,
    sequenceDocument: { kind: 'indexed-sequence', documentId: document.id },
    trackView: { document, revision: 'a'.repeat(64), path: '/project/view.json' },
  });
  const owner = getTrackViewSession(tabId)!;
  return { owner, document, tabId };
}
beforeEach(() => {
  useCanvasStore.getState().closeAllTabs();
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    focusedPanelId: 'main',
  });
  vi.clearAllMocks();
  boundary.save.mockImplementation(async ({ document }) => ({
    saved: { document, revision: 'b'.repeat(64), path: '/project/view.json' },
  }));
});
afterEach(() => useCanvasStore.getState().closeAllTabs());
describe('Track view command settlement', () => {
  it('preserves canonical unsaved changes while restored metadata cannot be captured', () => {
    const { owner, document, tabId } = open();
    const token = Symbol();
    const capture = vi.fn(() => document);
    owner.attachSource(token, {
      referenceName: 'Reference',
      readyForDirtyCheck: false,
      capture,
    });
    useCanvasStore.getState().updateTab('main', tabId, { isDirty: true });

    expect(documentLifecycle.dirty({ kind: 'tab', tabId }, tabId)).toBe(true);
    expect(capture).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().panels.main.tabs[0].isDirty).toBe(true);

    owner.attachSource(token, {
      referenceName: 'Reference',
      readyForDirtyCheck: true,
      capture,
    });

    expect(documentLifecycle.dirty({ kind: 'tab', tabId }, tabId)).toBe(false);
    expect(capture).toHaveBeenCalled();
  });
  it('does not reopen a copy after its source tab closes during native writing', async () => {
    const { owner, document, tabId } = open();
    owner.attachSource(Symbol(), {
      referenceName: 'Reference',
      readyForDirtyCheck: true,
      capture: () => document,
    });
    const pending = Promise.withResolvers<unknown>();
    boundary.save.mockReturnValue(pending.promise);
    const write = owner.save({
      mode: 'copy',
      name: 'Late copy',
      expectedRevision: owner.inspect().revision,
    });
    await vi.waitFor(() => expect(boundary.save).toHaveBeenCalledOnce());
    useCanvasStore.getState().closeTab('main', tabId);
    pending.resolve({
      saved: {
        document: boundary.save.mock.calls[0][0].document,
        revision: 'b'.repeat(64),
        path: '/project/copy.json',
      },
    });
    expect((await write).ok).toBe(false);
    expect(boundary.open).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
  });
  it('settles a close request false immediately when its tab is removed during a write', async () => {
    const { owner, document, tabId } = open();
    owner.attachSource(Symbol(), {
      referenceName: 'Reference',
      readyForDirtyCheck: true,
      capture: () => document,
    });
    const pending = Promise.withResolvers<unknown>();
    boundary.save.mockReturnValue(pending.promise);
    const requested = documentLifecycle.save({ kind: 'tab', tabId }, tabId);
    await vi.waitFor(() => expect(boundary.save).toHaveBeenCalledOnce());
    useCanvasStore.getState().closeTab('main', tabId);
    expect(await requested).toBe(false);
    pending.resolve({ saved: { document, revision: 'b'.repeat(64), path: '/project/view.json' } });
  });
  it('acknowledges a merged save against the submitted edit and restores the merged configuration', async () => {
    const { owner, document, tabId } = open();
    const edited = { ...document, viewport: { start0: 200, end0: 400 } };
    const merged = {
      ...edited,
      annotation: { ...edited.annotation, visibilityByTrackId: { gene: true } },
    };
    owner.attachSource(Symbol(), {
      referenceName: 'Reference',
      readyForDirtyCheck: true,
      capture: () => edited,
    });
    boundary.save.mockResolvedValue({
      saved: {
        document: merged,
        path: '/project/view.json',
        revision: 'b'.repeat(64),
        reconciliation: 'merged',
      },
    });
    expect(await documentLifecycle.save({ kind: 'tab', tabId }, tabId)).toBe(true);
    expect(boundary.save.mock.calls[0][0]).toMatchObject({
      baseDocument: document,
      expectedRevision: 'a'.repeat(64),
    });
    expect(owner.inspect().document).toMatchObject(merged);
    expect(owner.isDirty()).toBe(false);
    const tab = useCanvasStore.getState().panels.main.tabs[0];
    expect(tab.viewState?.indexedGenomeViewRestoreCommand?.visibleAnnotationTrackIds).toEqual([
      'gene',
    ]);
  });

  it('renames the saved baseline without committing unsaved viewport edits', async () => {
    const { owner, document } = open();
    const edited = { ...document, viewport: { start0: 500, end0: 1000 } };
    owner.attachSource(Symbol(), {
      referenceName: 'Reference',
      readyForDirtyCheck: true,
      capture: () => edited,
    });
    const result = await owner.save({
      mode: 'rename',
      name: 'Renamed',
      expectedRevision: owner.inspect().revision,
    });
    expect(result).toMatchObject({
      ok: true,
      dirty: true,
      saved: { document: { viewport: document.viewport } },
    });
    expect(owner.inspect().document.viewport).toEqual(edited.viewport);
    expect(owner.inspect().dirty).toBe(true);
  });
  it('ignores an old viewer detaching after a new viewer attaches', () => {
    const { owner, document } = open();
    const first = Symbol();
    owner.attachSource(first, {
      referenceName: 'Old',
      readyForDirtyCheck: true,
      capture: () => document,
    });
    const edited = { ...document, viewport: { start0: 500, end0: 1000 } };
    owner.attachSource(Symbol(), {
      referenceName: 'New',
      readyForDirtyCheck: true,
      capture: () => edited,
    });
    owner.detachSource(first);
    expect(owner.inspect().document.viewport).toEqual(edited.viewport);
    expect(owner.inspect().dirty).toBe(true);
  });
  it('retires an outstanding save when the same tab is retargeted to another document', async () => {
    const { owner, document, tabId } = open();
    owner.attachSource(Symbol(), {
      referenceName: 'Reference',
      readyForDirtyCheck: true,
      capture: () => document,
    });
    const pending = Promise.withResolvers<unknown>();
    boundary.save.mockReturnValue(pending.promise);
    const write = owner.save({
      mode: 'save',
      name: 'Old document',
      expectedRevision: owner.inspect().revision,
    });
    await vi.waitFor(() => expect(boundary.save).toHaveBeenCalledOnce());
    const replacement = { ...document, id: 'track-view-22222222', name: 'Replacement' };
    useCanvasStore
      .getState()
      .retargetTab(
        'main',
        tabId,
        {
          type: 'sequence',
          sequenceDocument: { kind: 'indexed-sequence', documentId: replacement.id },
        },
        {
          trackView: {
            document: replacement,
            revision: 'c'.repeat(64),
            path: '/project/replacement.json',
          },
        }
      );
    pending.resolve({ saved: { document, revision: 'b'.repeat(64), path: '/project/view.json' } });
    expect((await write).ok).toBe(false);
    expect(
      useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === tabId)?.entityId
    ).toBe(replacement.id);
    expect(getTrackViewSession(tabId)?.inspect().document.name).toBe('Replacement');
  });
});

describe('Track view source admission', () => {
  afterEach(cleanup);

  function directIndexedTab(sourceExt: 'gff3' | 'fa'): Tab {
    const documentId = '95c66604-88fb-4da8-a508-0419ea5a353c';
    const tabId = useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: documentId,
      label: 'slow',
      sequenceDocument: { kind: 'indexed-sequence', documentId },
      loadStatus: 'indexed',
      indexedGenome: {
        sourcePath: `/project/slow.${sourceExt}`,
        sourceExt,
        chrom: 'slow',
        manifest: {
          chrom: 'slow',
          fastaPath: '/project/.waypoint/genome-index/slow/slow.fa.gz',
          faiPath: '/project/.waypoint/genome-index/slow/slow.fa.gz.fai',
          gffPath:
            sourceExt === 'gff3' ? '/project/.waypoint/genome-index/slow/slow.gff3.gz' : null,
          tbiPath:
            sourceExt === 'gff3' ? '/project/.waypoint/genome-index/slow/slow.gff3.gz.tbi' : null,
          length: 2_000,
          circular: false,
        },
        metadata: { length: 2_000, circular: false },
      },
    });
    return useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === tabId)!;
  }

  it.each(['gff3', 'fa'] as const)(
    'keeps a ready direct %s viewport outside Track view ownership without crashing',
    (sourceExt) => {
      const tab = directIndexedTab(sourceExt);
      const capture = vi.fn(() => {
        throw new Error('A Track view must be built against a reference assembly.');
      });
      let session: ReturnType<typeof getTrackViewSession> | undefined;

      expect(() =>
        renderHook(() => {
          session = useTrackViewSessionSource(tab, {
            referenceName: 'slow',
            readyForDirtyCheck: true,
            capture,
          });
          return session;
        })
      ).not.toThrow();

      expect(session).toBeNull();
      expect(getTrackViewSession(tab.id)).toBeNull();
      expect(capture).not.toHaveBeenCalled();
    }
  );

  it('admits a reference arriving on the same mounted tab and document identity', () => {
    const tab = directIndexedTab('gff3');
    const document = trackViewFixture();
    const capture = vi.fn(() => document);
    const { result, rerender } = renderHook(
      ({ tab }: { tab: Tab }) =>
        useTrackViewSessionSource(tab, {
          referenceName: 'Slow reference',
          readyForDirtyCheck: Boolean(tab.indexedGenome?.assembly),
          capture,
        }),
      { initialProps: { tab } }
    );

    expect(result.current === null).toBe(true);
    expect(capture).not.toHaveBeenCalled();

    act(() => {
      useCanvasStore.getState().updateTab('main', tab.id, {
        indexedGenome: {
          ...tab.indexedGenome!,
          assembly: {
            assemblyId: 'local-slow',
            displayName: 'Slow reference',
            chromosomes: [
              {
                chrom: 'slow',
                displayName: 'slow',
                length: 2_000,
                manifest: tab.indexedGenome!.manifest!,
              },
            ],
          },
        },
      });
    });
    const admitted = useCanvasStore.getState().panels.main.tabs.find((item) => item.id === tab.id)!;
    expect(admitted.id).toBe(tab.id);
    expect(admitted.entityId).toBe(tab.entityId);

    rerender({ tab: admitted });

    expect(result.current).not.toBeNull();
    expect(result.current).toBe(getTrackViewSession(tab.id));
    expect(capture).toHaveBeenCalledOnce();
    expect(result.current!.inspect().document.viewport).toEqual(document.viewport);
  });

  it('retains a saved Track view session while its live indexed reference is absent', () => {
    const { tabId, document } = open();
    const tab = useCanvasStore.getState().panels.main.tabs.find((item) => item.id === tabId)!;
    const capture = vi.fn(() => document);

    expect(tab.indexedGenome).toBeUndefined();

    const { result } = renderHook(() =>
      useTrackViewSessionSource(tab, {
        referenceName: document.reference.name,
        readyForDirtyCheck: true,
        capture,
      })
    );

    expect(result.current).toBe(getTrackViewSession(tabId));
    expect(result.current).not.toBeNull();
    expect(capture).toHaveBeenCalledOnce();
    expect(result.current!.inspect().document.viewport).toEqual(document.viewport);
    expect(result.current!.inspect().dirty).toBe(false);
  });
});
