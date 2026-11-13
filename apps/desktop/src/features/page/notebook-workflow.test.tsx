import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { waitFor } from '@testing-library/react';
import { usePageStore } from './store';
import { contentFingerprint } from '../../db/entity-substrate/adapter';
import {
  beginTelemetryEpisode,
  __resetTelemetryCorrelationForTests,
} from '../../lib/telemetry-correlation';
import { sanitizeClosedBetaProperties } from '../../shared/analytics-allowlist';
import { sanitizeSdkEvent } from '@waypoint/analytics-policy';
import {
  CLOSED_BETA_EVENT_PROPERTIES,
  CLOSED_BETA_EVENT_VERSIONS,
} from '../../shared/analytics-registry.generated';
import {
  beginNotebookReopen,
  captureNotebookDocumentUpdate,
  confirmNotebookReopen,
  resetNotebookWorkflowForTests,
  retireNotebookDocumentSource,
} from './notebook-workflow';

const state = vi.hoisted(() => ({
  ready: true,
  generation: 1,
  captureThrows: false,
  originId: '550e8400-e29b-41d4-a716-446655440003',
  events: [] as Array<{ event: string; properties: Record<string, unknown> }>,
  publish: vi.fn(),
  settle: vi.fn(),
  execute: vi.fn(),
  select: vi.fn(),
  disk: new Map<string, { content: JSONContent; fingerprint: string }>(),
}));
vi.mock('../../lib/analytics', () => ({
  captureAnalyticsOptionalOrigin: () =>
    state.ready
      ? {
          consentScope: '550e8400-e29b-41d4-a716-446655440004',
          contextId: state.originId,
          processId: '550e8400-e29b-41d4-a716-446655440005',
          classification: 'synthetic',
        }
      : null,
  getAnalyticsCaptureGeneration: () => state.generation,
  getAnalyticsIdentifiedAccountId: () => '550e8400-e29b-41d4-a716-446655440006',
  isAnalyticsCaptureReady: () => state.ready,
  isAnalyticsIdentityIdentified: () => false,
  getMeaningfulActivityAuthority: () => ({
    actorKind: 'test',
    executionMode: 'automated',
    impersonated: false,
  }),
  subscribeAnalyticsCaptureReady: () => () => {},
  trackRendererEvent: (event: string, properties: Record<string, unknown>) => {
    if (state.captureThrows) throw new Error('PRIVATE_OBSERVER_FAILURE');
    if (!state.ready) return false;
    state.events.push({ event, properties });
    return true;
  },
}));
vi.mock('../../platform', () => ({
  platform: () => ({ db: { execute: state.execute, select: state.select } }),
  initPlatform: vi.fn(),
}));
vi.mock('../../db/workspace-artifacts', () => ({
  artifactStemFromFileName: (name: string) => name,
  writeNotebookArtifactSnapshot: (...args: unknown[]) => state.publish(...args),
  resolveNotebookArtifactWorkspaceOwner: async () => ({
    status: 'bound',
    workspaceRoot: '/PRIVATE_ROOT',
    path: '/PRIVATE_ROOT/Book',
  }),
  renameNotebookArtifactFile: vi.fn(),
  trashNotebookArtifactForPage: vi.fn(),
}));
vi.mock('../../db/entity-substrate/notebook-adapter', () => ({
  settlePublishedNotebookProjection: (...args: unknown[]) => state.settle(...args),
}));
vi.mock('../../db/workspace-catalog', () => ({
  resolveWorkspaceId: async () => 1,
  resolveWorkspaceScope: async () => 'private-scope',
}));
vi.mock('../../services/workspace-mutation-transaction', () => ({
  withRendererWorkspaceMutation: async (
    _root: string | null,
    action: (token: string) => Promise<unknown>
  ) => action('PRIVATE_TOKEN'),
}));
vi.mock('./entity-ref/repair-page-references', () => ({
  repairPageReferences: async (content: JSONContent) => ({
    content,
    repaired: 0,
    skipped: [],
    changed: false,
  }),
}));

const ROOT = '/PRIVATE_ROOT';
const PAGE = 'PRIVATE_PAGE';
const PATH = ROOT + '/Book';
const initial = (): JSONContent => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'PRIVATE_BODY' }] }],
});
const editors: Editor[] = [];
const fingerprint = (content: JSONContent) => contentFingerprint(JSON.stringify(content));
const results = (kind: string) =>
  state.events.filter(({ properties }) => properties.outcome_kind === kind);

function editorFixture(pageId = PAGE, root = ROOT) {
  let snapshot = initial();
  const editor = new Editor({
    extensions: [StarterKit],
    content: snapshot,
    onUpdate: ({ editor: owner, transaction }) => {
      snapshot = owner.getJSON();
      captureNotebookDocumentUpdate({
        owner,
        pageId,
        workspaceRoot: root,
        transaction,
        content: snapshot,
      });
      usePageStore.getState().setDirty(pageId, true);
    },
  });
  editors.push(editor);
  return {
    editor,
    content: () => snapshot,
    edit: (text = ' PRIVATE_EDIT') =>
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, text),
  };
}

function reopen(
  overrides: Partial<Parameters<typeof confirmNotebookReopen>[1]> = {},
  request = beginNotebookReopen()
) {
  confirmNotebookReopen(request, {
    pageId: PAGE,
    workspaceRoot: ROOT,
    path: PATH,
    authorityFingerprint: state.disk.get(PATH)?.fingerprint,
    created: true,
    cancelled: () => false,
    ...overrides,
  });
}

describe('authored notebook revision authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetNotebookWorkflowForTests();
    __resetTelemetryCorrelationForTests();
    state.ready = true;
    state.generation = 1;
    state.captureThrows = false;
    state.originId = '550e8400-e29b-41d4-a716-446655440003';
    state.events = [];
    state.disk.clear();
    state.execute.mockResolvedValue({ changes: 1, lastInsertRowid: 0 });
    state.select.mockResolvedValue([]);
    state.settle.mockResolvedValue(true);
    state.publish.mockImplementation(
      async (input: { content: JSONContent; workspaceRoot: string }) => {
        const content = structuredClone(input.content);
        const authorityFingerprint = fingerprint(content);
        const path = input.workspaceRoot + '/Book';
        state.disk.set(path, { content, fingerprint: authorityFingerprint });
        return { path, fileKind: 'waypoint-notebook', authorityFingerprint };
      }
    );
    usePageStore.setState({
      pages: {
        [PAGE]: {
          id: PAGE,
          title: 'PRIVATE_TITLE',
          content: initial(),
          date: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      },
      pageList: [{ id: PAGE, title: 'PRIVATE_TITLE' }],
      dirtyIds: new Set(),
      initialized: true,
      listError: null,
    });
  });
  afterEach(() => {
    editors.splice(0).forEach((editor) => editor.destroy());
    resetNotebookWorkflowForTests();
  });

  it('excludes hydration, dirty flags, store revision and automatic saves without an authored transaction', async () => {
    const h = editorFixture();
    h.editor.commands.setContent(initial(), { emitUpdate: false });
    usePageStore.getState().setDirty(PAGE, true);
    usePageStore.setState({ revision: usePageStore.getState().revision + 1 });
    await usePageStore.getState().savePage(PAGE, initial());
    expect(state.publish).toHaveBeenCalledOnce();
    expect(state.events).toEqual([]);
  });

  it('coalesces real editor changes and confirms once only after authority and projection settle', async () => {
    const h = editorFixture();
    h.edit();
    h.edit(' AGAIN');
    expect(state.events).toHaveLength(1);
    let finish!: (settled: boolean) => void;
    state.settle.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      })
    );
    const saving = usePageStore.getState().savePage(PAGE, h.content());
    await waitFor(() => expect(state.settle).toHaveBeenCalledOnce());
    expect(state.disk.get(PATH)?.content).toEqual(h.content());
    expect(results('notebook_committed')).toEqual([]);
    finish(true);
    await saving;
    expect(results('notebook_committed')).toHaveLength(1);
    expect(results('notebook_committed')[0].properties).toMatchObject({
      action_phase: 'result',
      workflow_status: 'saved',
      record_write_status: 'written',
      record_projection_status: 'ready',
      action_id: state.events[0].properties.action_id,
    });
    await usePageStore.getState().savePage(PAGE, h.content());
    expect(results('notebook_committed')).toHaveLength(1);
    expect(JSON.stringify(state.events)).not.toContain('PRIVATE_');
    expect(JSON.stringify(state.events)).not.toContain(state.disk.get(PATH)?.fingerprint);
    for (const { event, properties } of state.events) {
      const sanitized = sanitizeClosedBetaProperties(properties);
      expect(sanitized).toMatchObject(properties);
      const wire = sanitizeSdkEvent(
        { event, properties: sanitized },
        'desktop',
        'unknown',
        CLOSED_BETA_EVENT_PROPERTIES,
        undefined,
        CLOSED_BETA_EVENT_VERSIONS
      );
      expect(wire?.event).toBe(event);
      expect(wire?.properties).toMatchObject(properties);
    }
  });

  it.each(['denied', 'conflict-code', 'conflict-name'] as const)(
    'never qualifies a %s authority write',
    async (kind) => {
      const h = editorFixture();
      h.edit();
      const error = Object.assign(
        new Error('PRIVATE_WRITE_FAILURE'),
        kind === 'conflict-code'
          ? { code: 'NOTEBOOK_EXTERNAL_CONFLICT' }
          : kind === 'conflict-name'
            ? { name: 'NotebookExternalConflictError' }
            : {}
      );
      state.publish.mockRejectedValue(error);
      await expect(usePageStore.getState().savePage(PAGE, h.content())).rejects.toBe(error);
      expect(state.settle).not.toHaveBeenCalled();
      expect(results('notebook_committed')).toEqual([]);
      expect(
        results(kind === 'denied' ? 'notebook_save_failed' : 'notebook_save_conflict')
      ).toHaveLength(1);
      expect(usePageStore.getState().dirtyIds.has(PAGE)).toBe(true);
    }
  );

  it.each([
    'Notebook Markdown changed on disk before save: /PRIVATE_ROOT/PRIVATE_NOTE.md',
    'Notebook changed since it was opened: /PRIVATE_ROOT/PRIVATE_NOTE.md',
  ])('keeps a serialized conflict bounded: %s', async (message) => {
    const h = editorFixture();
    h.edit();
    const error = new Error(message);
    state.publish.mockRejectedValue(error);
    await expect(usePageStore.getState().savePage(PAGE, h.content())).rejects.toBe(error);
    expect(state.settle).not.toHaveBeenCalled();
    expect(results('notebook_committed')).toEqual([]);
    expect(results('notebook_save_conflict')).toHaveLength(1);
    expect(results('notebook_save_failed')).toEqual([]);
    expect(usePageStore.getState().dirtyIds.has(PAGE)).toBe(true);
    expect(JSON.stringify(state.events)).not.toContain('PRIVATE_');
    expect(JSON.stringify(state.events)).not.toContain(message);
  });

  it('does not treat a background transaction excluded from history as authored work', async () => {
    const h = editorFixture();
    h.editor.view.dispatch(
      h.editor.state.tr.insertText(' PRIVATE_BACKGROUND').setMeta('addToHistory', false)
    );
    await usePageStore.getState().savePage(PAGE, h.content());
    expect(state.events).toEqual([]);
  });

  it('reports startup refusal without writing or leaving a successful commit', async () => {
    const h = editorFixture();
    h.edit();
    usePageStore.setState({ initialized: false, listError: 'PRIVATE_STARTUP_FAILURE' });
    await expect(usePageStore.getState().savePage(PAGE, h.content())).rejects.toThrow(
      'PRIVATE_STARTUP_FAILURE'
    );
    expect(state.publish).not.toHaveBeenCalled();
    expect(results('notebook_save_failed')).toHaveLength(1);
    expect(results('notebook_committed')).toEqual([]);
  });

  it('keeps a projection database refusal distinct from a confirmed notebook commit', async () => {
    const h = editorFixture();
    h.edit();
    const error = new Error('PRIVATE_DATABASE_REFUSAL');
    state.settle.mockRejectedValueOnce(error);
    await expect(usePageStore.getState().savePage(PAGE, h.content())).rejects.toBe(error);
    expect(state.disk.has(PATH)).toBe(true);
    expect(state.settle).toHaveBeenCalledOnce();
    expect(results('notebook_committed')).toEqual([]);
    expect(results('notebook_save_failed')[0].properties).toMatchObject({
      record_write_status: 'written',
      record_projection_status: 'failed',
    });
  });

  it.each(['unconfirmed', 'error'] as const)(
    'keeps native-written %s projection distinct from a commit',
    async (kind) => {
      const h = editorFixture();
      h.edit();
      const error = new Error('PRIVATE_PROJECTION_FAILURE');
      if (kind === 'unconfirmed') state.settle.mockResolvedValue(false);
      else state.settle.mockRejectedValue(error);
      const saving = usePageStore.getState().savePage(PAGE, h.content());
      if (kind === 'error') await expect(saving).rejects.toBe(error);
      else await expect(saving).rejects.toThrow('checked native projection');
      expect(state.disk.has(PATH)).toBe(true);
      expect(results('notebook_committed')).toEqual([]);
      expect(state.events.at(-1)?.properties).toMatchObject({
        record_write_status: 'written',
        record_projection_status: 'failed',
      });
    }
  );

  it('keeps newer edits pending when an older captured revision commits', async () => {
    const h = editorFixture();
    h.edit(' A');
    const older = h.content();
    let finish!: (settled: boolean) => void;
    state.settle.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      })
    );
    const saving = usePageStore.getState().savePage(PAGE, older, { preserveDirtyState: true });
    await waitFor(() => expect(state.settle).toHaveBeenCalledOnce());
    h.edit(' B');
    const newer = h.content();
    finish(true);
    await saving;
    expect(usePageStore.getState().dirtyIds.has(PAGE)).toBe(true);
    expect(state.disk.get(PATH)?.content).toEqual(older);
    reopen();
    expect(results('notebook_reopened')).toEqual([]);
    await usePageStore.getState().savePage(PAGE, newer);
    expect(state.disk.get(PATH)?.content).toEqual(newer);
    expect(results('notebook_committed')).toHaveLength(2);
    expect(
      new Set(
        results('notebook_committed').map(({ properties }) => properties.artifact_correlation_id)
      ).size
    ).toBe(2);
  });

  it('gives a retry its own attempt while retaining the captured revision join', async () => {
    const h = editorFixture();
    h.edit();
    state.publish.mockRejectedValueOnce(new Error('PRIVATE_RETRY_FAILURE'));
    await expect(usePageStore.getState().savePage(PAGE, h.content())).rejects.toThrow(
      'PRIVATE_RETRY_FAILURE'
    );
    await usePageStore.getState().savePage(PAGE, h.content());
    const starts = state.events.filter(({ properties }) => properties.action_phase === 'start');
    expect(starts).toHaveLength(2);
    expect(starts[0].properties.action_id).not.toBe(starts[1].properties.action_id);
    expect(starts[0].properties.artifact_correlation_id).toBe(
      starts[1].properties.artifact_correlation_id
    );
    expect(results('notebook_committed')).toHaveLength(1);
  });

  it('pairs one later created presentation with the same document and exact committed revision', async () => {
    const h = editorFixture();
    h.edit();
    await usePageStore.getState().savePage(PAGE, h.content());
    beginTelemetryEpisode();
    reopen();
    reopen();
    expect(results('notebook_reopened')).toHaveLength(1);
    expect(results('notebook_reopened')[0].properties).toMatchObject({
      parent_action_id: results('notebook_committed')[0].properties.action_id,
      artifact_correlation_id: results('notebook_committed')[0].properties.artifact_correlation_id,
    });
  });

  it.each(['workspace', 'page', 'path', 'focus', 'cancelled', 'fingerprint'] as const)(
    'does not qualify %s as the exact reopen',
    async (kind) => {
      const h = editorFixture();
      h.edit();
      await usePageStore.getState().savePage(PAGE, h.content());
      const changes: Partial<Parameters<typeof confirmNotebookReopen>[1]> =
        kind === 'workspace'
          ? { workspaceRoot: '/PRIVATE_OTHER' }
          : kind === 'page'
            ? { pageId: 'PRIVATE_OTHER' }
            : kind === 'path'
              ? { path: '/PRIVATE_OTHER/Book' }
              : kind === 'focus'
                ? { created: false }
                : kind === 'cancelled'
                  ? { cancelled: () => true }
                  : { authorityFingerprint: 'PRIVATE_DIFFERENT_REVISION' };
      reopen(changes);
      expect(results('notebook_reopened')).toEqual([]);
      expect(results('notebook_reopen_mismatch')).toHaveLength(kind === 'fingerprint' ? 1 : 0);
      if (kind === 'fingerprint')
        expect(results('notebook_reopen_mismatch')[0].properties).toMatchObject({
          workflow_status: 'viewed',
          success: true,
        });
    }
  );

  it('never adopts a commit that happened after reopening was requested', async () => {
    const h = editorFixture();
    h.edit();
    const early = beginNotebookReopen();
    await usePageStore.getState().savePage(PAGE, h.content());
    reopen({}, early);
    expect(results('notebook_reopened')).toEqual([]);
  });

  it.each(['generation', 'episode', 'origin', 'opt-out'] as const)(
    'drops a late commit after %s retirement while preserving file behavior',
    async (kind) => {
      const h = editorFixture();
      h.edit();
      let finish!: (settled: boolean) => void;
      state.settle.mockReturnValue(
        new Promise<boolean>((resolve) => {
          finish = resolve;
        })
      );
      const saving = usePageStore.getState().savePage(PAGE, h.content());
      await waitFor(() => expect(state.settle).toHaveBeenCalledOnce());
      if (kind === 'generation') state.generation += 1;
      else if (kind === 'episode') beginTelemetryEpisode();
      else if (kind === 'origin') state.originId = '550e8400-e29b-41d4-a716-446655440007';
      else state.ready = false;
      finish(true);
      await saving;
      expect(state.disk.get(PATH)?.content).toEqual(h.content());
      expect(results('notebook_committed')).toEqual([]);
    }
  );

  it('does not backfill edits made before capture became available', async () => {
    state.ready = false;
    const h = editorFixture();
    h.edit();
    state.ready = true;
    await usePageStore.getState().savePage(PAGE, h.content());
    expect(state.events).toEqual([]);
  });

  it('does not promote an edit undone back to the known authority fingerprint', async () => {
    const h = editorFixture();
    const baseline = fingerprint(h.editor.getJSON());
    h.edit();
    h.editor.commands.undo();
    await usePageStore
      .getState()
      .savePage(PAGE, h.content(), { expectedCanonicalFingerprint: baseline });
    expect(results('notebook_committed')).toEqual([]);
    expect(results('notebook_unchanged')).toHaveLength(1);
  });

  it('retires an explicitly discarded editor cycle before a late write completes', async () => {
    const h = editorFixture();
    h.edit();
    let finish!: (settled: boolean) => void;
    state.settle.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      })
    );
    const saving = usePageStore.getState().savePage(PAGE, h.content());
    await waitFor(() => expect(state.settle).toHaveBeenCalledOnce());
    retireNotebookDocumentSource(h.editor, 'discarded');
    finish(true);
    await saving;
    expect(results('notebook_committed')).toEqual([]);
    expect(results('notebook_discarded')).toHaveLength(1);
  });

  it('distinguishes an owner moved to another document from an explicit discard', () => {
    const h = editorFixture();
    h.edit();
    const transaction = h.editor.state.tr.insertText(' PRIVATE_OTHER_PAGE');
    captureNotebookDocumentUpdate({
      owner: h.editor,
      pageId: 'PRIVATE_OTHER_PAGE',
      workspaceRoot: ROOT,
      transaction,
      content: transaction.doc.toJSON(),
    });
    expect(results('notebook_superseded')).toHaveLength(1);
    expect(results('notebook_discarded')).toEqual([]);
  });

  it.each(['edit', 'commit'] as const)(
    'keeps optional %s observation failure outside the file authority',
    async (phase) => {
      const h = editorFixture();
      if (phase === 'edit') state.captureThrows = true;
      h.edit();
      state.captureThrows = true;
      await expect(usePageStore.getState().savePage(PAGE, h.content())).resolves.toBeTypeOf(
        'string'
      );
      expect(state.disk.get(PATH)?.content).toEqual(h.content());
      expect(results('notebook_committed')).toEqual([]);
    }
  );
});
