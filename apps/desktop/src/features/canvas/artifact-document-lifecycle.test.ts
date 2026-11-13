/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import type { Tab } from './types';
import {
  isEphemeralArtifactDraft,
  requestTabClose,
  saveTargetForTab,
  shouldRememberClosedTab,
} from './artifact-document-lifecycle';

function tab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'tab-1',
    type: 'text',
    entityId: '/workspace/notes.txt',
    label: 'notes.txt',
    ...overrides,
  };
}

describe('artifact document lifecycle', () => {
  it('saves a published design by its owning tab rather than treating its ID as a path', () => {
    expect(saveTargetForTab(tab({ type: 'design', entityId: 'design-1' }))).toEqual({
      kind: 'tab',
      tabId: 'tab-1',
    });
  });

  it('keeps a notebook page distinct from a file with the same locator text', () => {
    expect(saveTargetForTab(tab({ type: 'page', entityId: 'page-1' }))).toEqual({
      kind: 'page',
      pageId: 'page-1',
    });
    expect(saveTargetForTab(tab({ type: 'text', entityId: 'page-1' }))).toEqual({
      kind: 'file',
      filePath: 'page-1',
    });
  });

  it('uses one tab-scoped save identity for every unsaved artifact kind', () => {
    for (const kind of ['primer', 'protein', 'assembly'] as const) {
      const draft = tab({
        type: kind === 'assembly' ? 'design' : kind,
        entityId: `${kind}-draft:1`,
        artifactDocument: {
          kind,
          persistence: 'draft',
          workspaceRoot: '/workspace',
          destinationPath: '/workspace/designs',
        },
      });

      expect(isEphemeralArtifactDraft(draft)).toBe(true);
      expect(saveTargetForTab(draft)).toEqual({ kind: 'tab', tabId: draft.id });
      expect(shouldRememberClosedTab(draft)).toBe(false);
    }
  });

  it('saves a stable-ID record through its tab owner and remembers it after closing', () => {
    const record = tab({ type: 'record', entityId: 'saved-record', isDirty: true });
    expect(saveTargetForTab(record)).toEqual({ kind: 'tab', tabId: record.id });
    expect(isEphemeralArtifactDraft(record)).toBe(false);
    expect(shouldRememberClosedTab(record)).toBe(true);
  });

  it('keeps the established saved-file and sequence save identities', () => {
    expect(saveTargetForTab(tab())).toEqual({
      kind: 'file',
      filePath: '/workspace/notes.txt',
    });
    expect(
      saveTargetForTab(
        tab({
          type: 'sequence',
          entityId: 'sequence-document-1',
          sequenceDocument: { kind: 'catalog-sequence', entityId: 'sequence-document-1' },
        })
      )
    ).toEqual({ kind: 'sequence-document', documentId: 'sequence-document-1' });
  });

  it.each(['indexed-pending', 'indexed', 'indexed-error'] as const)(
    'routes an %s genome view to its view owner without creating a sequence document',
    (loadStatus) => {
      const view = tab({
        type: 'sequence',
        entityId: 'track-view-draft-02a8dc44-585f-4a7d-b0d6-cb9bd808634d',
        sequenceDocument: {
          kind: 'indexed-sequence',
          documentId: 'track-view-draft-02a8dc44-585f-4a7d-b0d6-cb9bd808634d',
        },
        isDirty: true,
        loadStatus,
      });
      expect(saveTargetForTab(view)).toEqual({ kind: 'tab', tabId: view.id });
      expect(saveTargetForTab({ ...view, sequenceDocument: undefined })).toEqual({
        kind: 'tab',
        tabId: view.id,
      });
    }
  );

  it('routes every user close gesture through one request event', () => {
    const listener = vi.fn();
    window.addEventListener('artifact-document-close-request', listener);

    requestTabClose('panel-1', 'tab-1');

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      panelId: 'panel-1',
      tabIds: ['tab-1'],
    });
    window.removeEventListener('artifact-document-close-request', listener);
  });
});
