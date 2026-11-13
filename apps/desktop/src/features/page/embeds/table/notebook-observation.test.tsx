// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { Editor, Extension, Node, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Plugin } from '@tiptap/pm/state';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../../main/__tests__/test-db';
import { contentFingerprint } from '../../../../db/entity-substrate/adapter';
import { usePageStore } from '../../store';
import { useEditorAutosave } from '../../hooks/useEditorAutosave';
import { withNotebookAuthorityOperation } from '../../notebook-authority-queue';
import { openWorkspaceDocument } from '../../open-workspace-document';
import { useCanvasStore } from '../../../canvas/public/store';
import { presentDocument } from '../../../canvas/public/present-document';
import { beginTelemetryEpisode } from '../../../../lib/telemetry-correlation';
import {
  TABLE_NOTEBOOK_UPDATE_META,
  bindTableNotebookSource,
  captureTableNotebookDocumentUpdate,
  captureNativeTableNotebookSave,
  confirmNativeTableNotebookSave,
  requireNotebookCommitFingerprint,
  resetTableNotebookObservationsForTests,
  retireTableNotebookSource,
  updateTableNotebookAttributes,
  openTableNotebookView,
} from './notebook-observation';
import { useTableData } from './hooks/useTableData';
import { useClipboardOperations } from './hooks/useClipboardOperations';
import { tableOperationObservation } from './utils/operation-observation';
import { evaluateTableRevision } from './utils/formulas';
import type { TableData } from './types';
import type { TableSurface } from '../../../../shared/table-notebook-observation';

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  ready: true,
  lookupThrows: false,
  captureThrows: false,
  account: null as string | null,
  origin: null as import('../../../../shared/analytics-types').OptionalTelemetryOrigin | null,
  captures: [] as Array<{ event: string; properties: Record<string, unknown> }>,
  subscribers: new Set<() => void>(),
  disk: '',
  publish: vi.fn(),
  settle: vi.fn(),
  read: vi.fn(),
  writeReceipt: vi.fn(),
  repair: vi.fn(),
}));
vi.mock('../../../../lib/analytics', () => ({
  captureAnalyticsOptionalOrigin: () => {
    if (state.lookupThrows) throw new Error('synthetic optional origin lookup failure');
    return state.ready ? state.origin : null;
  },
  getAnalyticsIdentifiedAccountId: () => state.account,
  getAnalyticsCaptureGeneration: () => 0,
  isAnalyticsCaptureReady: () => state.ready,
  isAnalyticsIdentityIdentified: () => false,
  getMeaningfulActivityAuthority: () => ({
    actorKind: 'test',
    executionMode: 'synthetic',
    impersonated: false,
  }),
  subscribeAnalyticsCaptureReady: (listener: () => void) => {
    state.subscribers.add(listener);
    return () => state.subscribers.delete(listener);
  },
  trackRendererEvent: (event: string, properties: Record<string, unknown>) => {
    if (state.captureThrows) throw new Error('synthetic optional observation sink failure');
    if (!state.ready) return false;
    state.captures.push({ event, properties });
    return true;
  },
}));
vi.mock('../../../../platform', () => ({
  platform: () => ({
    db: {
      select: async (sql: string, params: unknown[] = []) => state.db!.prepare(sql).all(...params),
      execute: async (sql: string, params: unknown[] = []) => state.db!.prepare(sql).run(...params),
    },
    analytics: { writeTableNotebookReceipt: (...args: unknown[]) => state.writeReceipt(...args) },
  }),
  initPlatform: vi.fn(),
}));
vi.mock('../../../../db/workspace-artifacts', () => ({
  artifactStemFromFileName: (name: string) => name,
  resolveNotebookArtifactWorkspaceOwner: async () => ({
    status: 'bound',
    workspaceRoot: '/T1-private-root',
    path: '/T1-private-root/Book',
  }),
  writeNotebookArtifactSnapshot: (...args: unknown[]) => state.publish(...args),
  renameNotebookArtifactFile: vi.fn(),
  trashNotebookArtifactForPage: vi.fn(),
}));
vi.mock('../../../../db/entity-substrate/notebook-adapter', () => ({
  settlePublishedNotebookProjection: async (input: {
    pageId: string;
    title: string;
    content: unknown;
  }) => {
    const result = await state.settle(input);
    if (result === true)
      state
        .db!.prepare('UPDATE pages SET title=?,content=?,updated_at=? WHERE id=?')
        .run(input.title, JSON.stringify(input.content), Date.now(), input.pageId);
    return result;
  },
}));
vi.mock('../../../../db/workspace-catalog', () => ({
  findWorkspaceRootForPath: () => '/T1-private-root',
  resolveWorkspaceId: async () => 1,
  resolveWorkspaceScope: async () => 't1-scope',
  getCatalogEntityForFilePath: async () => null,
  getCurrentCatalogFileForEntity: async () => ({
    path: ROOT + '/Book',
    file_kind: 'waypoint-notebook',
  }),
}));
vi.mock('../../entity-ref/repair-page-references', () => ({
  repairPageReferences: (...args: unknown[]) => state.repair(...args),
}));
vi.mock('../../../../services/workspace-mutation-transaction', () => ({
  withRendererWorkspaceMutation: async (
    _root: string,
    operation: (token: string) => Promise<unknown>
  ) => operation('synthetic-lease'),
  isWorkspaceMutationBusyError: () => false,
}));
vi.mock('../../../../services/workspace-artifact-open', () => ({
  withWorkspaceArtifactOpen: (...args: unknown[]) => state.read(...args),
}));
vi.mock('../../../../main/ipc/database', () => ({
  getAnalyticsConsentStateFromDb: () => {
    const rows = state
      .db!.prepare(
        "SELECT key, value FROM settings WHERE key IN ('analytics_consent', 'analytics_consent_version', 'analytics_consent_basis')"
      )
      .all() as Array<{ key: string; value: string }>;
    const values = new Map(rows.map(({ key, value }) => [key, value]));
    return {
      consent: values.get('analytics_consent') ?? null,
      version: values.get('analytics_consent_version') ?? null,
      basis: values.get('analytics_consent_basis') ?? null,
    };
  },
  getDb: () => state.db!,
}));
vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '1.0.0', getPath: () => '/T1-owned-test' },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  ipcRenderer: {},
}));
vi.mock('posthog-node', () => ({
  PostHog: class {
    private listeners = new Map<string, Set<(value: unknown) => void>>();
    private queued: unknown[] = [];
    capture(input: Record<string, unknown>) {
      const message = { ...input, distinct_id: input.distinctId };
      this.queued.push(message);
      queueMicrotask(() => {
        for (const listener of this.listeners.get('capture') ?? []) listener(message);
      });
    }
    async flush() {
      const batch = this.queued.splice(0);
      for (const listener of this.listeners.get('flush') ?? []) listener(batch);
      return batch;
    }
    async shutdown() {}
    optIn() {}
    optOut() {}
    on(event: string, listener: (value: unknown) => void) {
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return () => {
        listeners.delete(listener);
      };
    }
    setPersistedProperty(key: string) {
      if (key === 'queue') this.queued.splice(0);
    }
  },
}));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, existsSync: () => true, writeFileSync: vi.fn() };
});

const ROOT = '/T1-private-root';
const PAGE = 'T1_PRIVATE_PAGE_ID';
const REF = 'T1_PRIVATE_TABLE_ID';
const TITLE = 'Synthetic native authority owner';
const CONTEXT = {
  distinctId: '69800000-0000-4000-8000-000000000001',
  sessionId: '69800000-0000-4000-8000-000000000002',
  kind: 'anonymous' as const,
  generation: 1,
};
let native: typeof import('../../../../main/analytics');
const editors: Editor[] = [];
const initial: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'embed',
      attrs: {
        type: 'table',
        refId: REF,
        data: {
          rows: 1,
          cols: 1,
          cells: [[{ type: 'text', value: 'PRIVATE_ORIGINAL_CELL' }]],
          columnLabels: ['PRIVATE_LABEL'],
        },
      },
    },
    { type: 'paragraph', content: [{ type: 'text', text: 'tail' }] },
  ],
};
const observed = () => [
  ...state.captures,
  ...(
    (state.db
      ?.prepare(
        "SELECT event_name, properties_json FROM analytics_event_outbox WHERE reference_kind = 'table_notebook_revision'"
      )
      .all() ?? []) as { event_name: string; properties_json: string }[]
  ).map((row) => ({
    event: row.event_name,
    properties: JSON.parse(row.properties_json) as Record<string, unknown>,
  })),
];
const events = (outcome: string) =>
  observed().filter(
    (x) => x.properties.workflow === 'table' && x.properties.outcome_kind === outcome
  );
const idle = () => withNotebookAuthorityOperation(PAGE, async () => {});
const tableNode = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  addAttributes: () => ({
    type: { default: 'table' },
    refId: { default: REF },
    data: { default: {} },
  }),
  renderHTML: () => ['div'],
});
function source(
  mode?: 'append' | 'filter' | 'rollback' | 'replace',
  initialContent: JSONContent = initial
) {
  let content = initialContent;
  let onChange: ((value: JSONContent) => void) | undefined;
  const normalizer = Extension.create({
    name: 't1AdmissionOracle',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          filterTransaction: (tr) => mode !== 'filter' || !tr.getMeta(TABLE_NOTEBOOK_UPDATE_META),
          appendTransaction: (transactions, oldState, next) => {
            if (!transactions.some((tr) => tr.getMeta(TABLE_NOTEBOOK_UPDATE_META))) return null;
            if (mode === 'append') return next.tr.insertText('!', next.doc.content.size - 1);
            if (mode === 'rollback')
              return next.tr.setNodeMarkup(0, undefined, oldState.doc.nodeAt(0)!.attrs);
            if (mode === 'replace')
              return next.tr.setNodeMarkup(0, undefined, {
                ...next.doc.nodeAt(0)!.attrs,
                data: { rows: 1, cols: 1, cells: [[{ type: 'text', value: 'replacement' }]] },
              });
            return null;
          },
        }),
      ];
    },
  });
  const editor = new Editor({
    extensions: [StarterKit, tableNode, normalizer],
    content: initialContent,
    onUpdate: ({ editor, transaction }) => {
      content = editor.getJSON();
      captureTableNotebookDocumentUpdate({
        owner: editor,
        pageId: PAGE,
        workspaceRoot: ROOT,
        transaction,
        content,
      });
      onChange?.(content);
    },
  });
  bindTableNotebookSource(editor, PAGE, ROOT);
  editors.push(editor);
  return {
    editor,
    get content() {
      return content;
    },
    set onChange(value: typeof onChange) {
      onChange = value;
    },
  };
}
function edit(owner: ReturnType<typeof source>, value = 'PRIVATE_NEW_CELL') {
  const attrs = {
    rows: 1,
    cols: 1,
    cells: [[{ type: 'text' as const, value }]],
    columnLabels: ['PRIVATE_LABEL'],
  };
  updateTableNotebookAttributes(
    owner.editor,
    0,
    REF,
    attrs,
    tableOperationObservation(
      'edit',
      'inline',
      attrs.cells,
      evaluateTableRevision(attrs.cells).calculation
    )
  );
}
function mountedTable(owner: ReturnType<typeof source>, surface: TableSurface = 'inline') {
  return renderHook(() => {
    const [data, setData] = useState<TableData>(owner.editor.state.doc.nodeAt(0)!.attrs.data);
    const table = useTableData({
      data,
      observationSurface: surface,
      onUpdateAttrs: (attrs, observation) => {
        updateTableNotebookAttributes(owner.editor, 0, REF, attrs, observation);
        setData(owner.editor.state.doc.nodeAt(0)!.attrs.data);
      },
    });
    const clipboard = useClipboardOperations({
      displayCells: table.displayCells,
      focusedCell: { row: 1, col: 1 },
      selection: null,
      isEditing: false,
      rows: table.rows,
      cols: table.cols,
      onPaste: table.pasteCSV,
      onPasteHTML: table.pasteHTMLTable,
      onPasteCells: table.pasteCells,
      onCellChange: table.updateCell,
      onExpandAndSetCell: table.expandAndSetCell,
    });
    return { table, clipboard };
  });
}
function closeTabs() {
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
  });
}
const open = () =>
  openWorkspaceDocument({
    target: {
      kind: 'file',
      path: ROOT + '/Book/.forge/notebook.json',
      tabType: 'page',
    },
    label: 'Synthetic book',
  });

describe('real table admission → notebook save → independent open correlation', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    resetTableNotebookObservationsForTests();
    state.captures = [];
    state.ready = true;
    state.account = null;
    state.lookupThrows = false;
    state.captureThrows = false;
    state.db = createTestDb();
    state.db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
      INSERT INTO settings VALUES ('analytics_consent','true',0),('analytics_consent_version','3',0),
      ('analytics_consent_basis','explicit',0);
      CREATE TABLE pages (id TEXT PRIMARY KEY,title TEXT,content TEXT,date INTEGER,created_at INTEGER,updated_at INTEGER);
      CREATE TABLE analytics_event_outbox (event_id TEXT PRIMARY KEY,event_name TEXT,payload_schema_version INTEGER,
      reference_kind TEXT,reference_id TEXT,properties_json TEXT,created_at_ms INTEGER,send_attempts INTEGER,
      last_attempt_at_ms INTEGER,sent_at_ms INTEGER,origin_json TEXT);`);
    state.db
      .prepare('INSERT INTO pages VALUES (?,?,?,?,?,?)')
      .run(PAGE, TITLE, JSON.stringify(initial), null, 0, 0);
    usePageStore.setState({
      initialized: true,
      listError: null,
      pages: {
        [PAGE]: {
          id: PAGE,
          title: TITLE,
          content: initial,
          date: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      },
      pageList: [{ id: PAGE, title: TITLE, updatedAt: new Date(0) }],
      dirtyIds: new Set([PAGE]),
    });
    vi.stubEnv('POSTHOG_API_KEY', 'phc_t1_nonfunctional_unit_sentinel');
    native = await import('../../../../main/analytics');
    native.initAnalyticsMain(undefined, { consent: 'true', version: '3', basis: 'explicit' });
    native.syncAnalyticsIdentityContext(CONTEXT);
    state.origin = native.captureOptionalTelemetryOrigin();
    expect(state.origin).not.toBeNull();
    state.writeReceipt.mockImplementation(async (request) =>
      native.mutateTableNotebookReceipt(request)
    );
    state.settle.mockResolvedValue(true);
    state.repair.mockImplementation(async (content: JSONContent) => ({
      content,
      repaired: 0,
      skipped: [],
      changed: false,
    }));
    state.disk = JSON.stringify(initial);
    state.publish.mockImplementation(async ({ content }: { content: JSONContent }) => {
      state.disk = JSON.stringify(content);
      return {
        path: ROOT + '/Book',
        fileKind: 'waypoint-notebook',
        authorityFingerprint: contentFingerprint(state.disk),
      };
    });
    state.read.mockImplementation(async ({ consume }) => {
      const content = JSON.parse(state.disk);
      return consume(
        {
          artifact: { kind: 'notebook', title: TITLE, content },
          entity: { id: PAGE },
          authorityFingerprint: contentFingerprint(state.disk),
        },
        'independent-open-lease'
      );
    });
    closeTabs();
  });
  afterEach(async () => {
    await idle();
    resetTableNotebookObservationsForTests();
    for (const editor of editors.splice(0)) if (!editor.isDestroyed) editor.destroy();
    await native.shutdownAnalytics();
    state.db?.close();
    state.db = null;
    vi.unstubAllEnvs();
  });

  it('correlates actual admitted attrs, real autosave/store commit and independent created-tab readback', async () => {
    const owner = source('append');
    const contentRef = { current: owner.editor.getJSON() };
    const saved = vi.fn();
    const hook = renderHook(() =>
      useEditorAutosave({
        pageId: PAGE,
        workspaceRoot: ROOT,
        contentRef,
        debounceMs: 10000,
        onSave: async (content, id) => {
          requireNotebookCommitFingerprint(
            await usePageStore.getState().savePage(id, content, { preserveDirtyState: true })
          );
        },
        onSaved: saved,
      })
    );
    try {
      owner.onChange = (content) => {
        contentRef.current = content;
        hook.result.current.markDirty();
      };
      act(() => edit(owner));
      await idle();
      expect(owner.editor.state.doc.lastChild!.textContent).toBe('tail!');
      expect(events('table_edit_accepted')).toHaveLength(1);
      expect(
        state.captures.filter(
          (x) => x.properties.workflow === 'table' && x.properties.action_phase === 'start'
        )
      ).toHaveLength(1);
      expect(events('table_save_committed')).toHaveLength(0);
      await act(async () => {
        await hook.result.current.saveNow();
      });
      expect(saved).toHaveBeenCalledWith(PAGE);
      expect(events('table_save_committed')).toHaveLength(1);
      expect(events('reopened_confirmed')).toHaveLength(0);
      expect(await open()).toMatchObject({ status: 'presented', disposition: 'created' });
      expect(events('reopened_confirmed')).toHaveLength(1);
      const commit = events('table_save_committed')[0].properties;
      const reopened = events('reopened_confirmed')[0].properties;
      expect(reopened.action_id).toBe(commit.action_id);
      expect(reopened.artifact_correlation_id).toBe(commit.artifact_correlation_id);
      expect(reopened.occurred_at_ms).toBeGreaterThanOrEqual(commit.occurred_at_ms as number);
      expect(JSON.parse(state.disk).content[0].attrs.data.cells[0][0].value).toBe(
        'PRIVATE_NEW_CELL'
      );
      const wire = JSON.stringify(observed());
      for (const privateValue of [
        ROOT,
        PAGE,
        REF,
        'PRIVATE_NEW_CELL',
        'PRIVATE_LABEL',
        state.origin!.consentScope,
        state.origin!.contextId,
        contentFingerprint(state.disk),
      ]) {
        expect(wire).not.toContain(privateValue);
      }
      expect(state.captures.filter((x) => x.event === 'meaningful_activity_completed')).toEqual([]);
    } finally {
      act(() => hook.result.current.discardPendingChanges());
      hook.unmount();
      await idle();
    }
  });

  it.each(['filter', 'rollback', 'replace'] as const)(
    'does not admit a %s transaction or infer acceptance from dispatch return',
    async (mode) => {
      const owner = source(mode);
      expect(() => edit(owner)).toThrow();
      await idle();
      expect(events('table_edit_accepted')).toEqual([]);
      expect(events('table_save_committed')).toEqual([]);
      if (mode !== 'replace')
        expect(owner.editor.state.doc.nodeAt(0)!.attrs.data.cells[0][0].value).toBe(
          'PRIVATE_ORIGINAL_CELL'
        );
      else
        expect(owner.editor.state.doc.nodeAt(0)!.attrs.data.cells[0][0].value).toBe('replacement');
    }
  );

  it('does not turn an absent page/undefined save into Saved or reopen fulfillment', async () => {
    const owner = source();
    edit(owner);
    await idle();
    usePageStore.setState({ pages: {} });
    const result = await usePageStore.getState().savePage(PAGE, owner.content);
    expect(result).toBeUndefined();
    expect(() => requireNotebookCommitFingerprint(result)).toThrow();
    const saved = vi.fn();
    const contentRef = { current: owner.content };
    const hook = renderHook(() =>
      useEditorAutosave({
        pageId: PAGE,
        workspaceRoot: ROOT,
        contentRef,
        debounceMs: 10000,
        onSave: async (content, id) => {
          requireNotebookCommitFingerprint(await usePageStore.getState().savePage(id, content));
        },
        onSaved: saved,
      })
    );
    try {
      act(() => hook.result.current.markDirty());
      await act(async () => {
        await hook.result.current.saveNow();
      });
      expect(hook.result.current.saveStatus).toBe('dirty');
      expect(saved).not.toHaveBeenCalled();
      expect(events('table_save_unconfirmed')).toHaveLength(2);
      expect(events('table_save_committed')).toEqual([]);
      await open();
      expect(events('reopened_confirmed')).toEqual([]);
    } finally {
      act(() => hook.result.current.discardPendingChanges());
      hook.unmount();
      await idle();
    }
  });

  it('retains failed/conflicted revisions for a real retry and never uses void projection settlement as confirmation', async () => {
    const owner = source();
    edit(owner);
    await idle();
    const conflict = Object.assign(new Error('private path deliberately omitted from egress'), {
      code: 'NOTEBOOK_EXTERNAL_CONFLICT',
    });
    state.publish.mockRejectedValueOnce(conflict);
    await expect(usePageStore.getState().savePage(PAGE, owner.content)).rejects.toBe(conflict);
    expect(events('table_save_conflict')).toHaveLength(1);
    expect(events('table_save_committed')).toEqual([]);
    state.settle.mockResolvedValueOnce(undefined);
    await expect(usePageStore.getState().savePage(PAGE, owner.content)).rejects.toThrow(
      'checked native projection'
    );
    expect(events('table_save_failed')).toHaveLength(1);
    expect(events('table_save_committed')).toEqual([]);
    await usePageStore.getState().savePage(PAGE, owner.content);
    await open();
    expect(events('table_save_committed')).toHaveLength(1);
    expect(events('reopened_confirmed')).toHaveLength(1);
  });

  it('rejects a fresh equal JSON snapshot and an unrelated save as edit authority', async () => {
    const owner = source();
    edit(owner);
    await idle();
    await usePageStore.getState().savePage(PAGE, JSON.parse(JSON.stringify(owner.content)));
    expect(events('table_save_committed')).toEqual([]);
    await open();
    expect(events('reopened_confirmed')).toEqual([]);
  });

  it('confirms a native save only for the admitted edit and its exact persisted revision', async () => {
    const owner = source();
    edit(owner);
    await idle();
    const observation = captureNativeTableNotebookSave(PAGE, owner.content);
    expect(observation).not.toBeNull();
    expect(
      captureNativeTableNotebookSave(PAGE, JSON.parse(JSON.stringify(owner.content)))
    ).toBeNull();
    const artifact = await state.publish({ content: owner.content });
    const capture = {
      documentId: PAGE,
      revision: 'native:1',
      copy: { content: JSON.parse(JSON.stringify(owner.content)), title: TITLE },
    };
    const committed = {
      documentId: PAGE,
      persistedRevision: capture.revision,
      workspaceRoot: ROOT,
      path: artifact.path,
      canonicalFingerprint: artifact.authorityFingerprint,
    };
    await confirmNativeTableNotebookSave(observation, capture, {
      ...committed,
      persistedRevision: 'native:0',
    });
    expect(events('table_save_committed')).toEqual([]);
    await confirmNativeTableNotebookSave(observation, capture, committed);
    expect(events('table_save_committed')).toHaveLength(1);
    expect(events('table_save_committed')[0].properties.action_id).toBe(
      events('table_edit_accepted')[0].properties.action_id
    );
    await open();
    expect(events('reopened_confirmed')).toHaveLength(1);
  });

  it('does not confirm superseded held saves or a replaced source', async () => {
    const owner = source();
    edit(owner);
    await idle();
    let release!: (value: unknown) => void;
    state.publish.mockImplementationOnce(
      () =>
        new Promise((yes) => {
          release = yes;
        })
    );
    const old = usePageStore.getState().savePage(PAGE, owner.content);
    await vi.waitFor(() => expect(state.publish).toHaveBeenCalledTimes(1));
    edit(owner, 'PRIVATE_NEWER_CELL');
    release({
      path: ROOT + '/Book',
      fileKind: 'waypoint-notebook',
      authorityFingerprint: 'old-authority',
    });
    await old;
    await idle();
    expect(events('table_save_committed')).toEqual([]);
    retireTableNotebookSource(owner.editor);
    await usePageStore.getState().savePage(PAGE, owner.content);
    expect(events('table_save_committed')).toEqual([]);
  });

  it('retains an admitted save receipt when the editor is replaced before IPC returns', async () => {
    const owner = source();
    edit(owner);
    await idle();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.writeReceipt.mockImplementation(async (request) => {
      const written = native.mutateTableNotebookReceipt(request);
      if (request.kind === 'write' && JSON.parse(request.value).phase === 'committed') await hold;
      return written;
    });
    const saving = usePageStore.getState().savePage(PAGE, owner.content);
    await vi.waitFor(() => expect(events('table_save_committed')).toHaveLength(1));
    source(undefined, JSON.parse(state.disk));
    release();
    await saving;
    await idle();
    await open();
    expect(events('reopened_confirmed')).toHaveLength(1);
  });

  it('does not recreate a private marker when native receipt admission is held across revoke/regrant', async () => {
    let release!: () => void;
    const hold = new Promise<void>((yes) => {
      release = yes;
    });
    state.writeReceipt.mockImplementationOnce(async (request) => {
      await hold;
      return native.mutateTableNotebookReceipt(request);
    });
    const owner = source();
    edit(owner);
    await vi.waitFor(() => expect(state.writeReceipt).toHaveBeenCalledTimes(1));
    native.persistAnalyticsConsent(false);
    state.ready = false;
    for (const fn of state.subscribers) fn();
    expect(await native.grantMainAnalyticsConsent('explicit')).toBe(true);
    native.syncAnalyticsIdentityContext({ ...CONTEXT, generation: 2 });
    state.origin = native.captureOptionalTelemetryOrigin();
    state.ready = true;
    edit(owner, 'PRIVATE_NEW_GRANT_CELL');
    release();
    await idle();
    const rows = state
      .db!.prepare("SELECT value FROM settings WHERE key GLOB 'table_notebook_reopen_v1:*'")
      .all() as { value: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].value).origin).toEqual(state.origin);
    await usePageStore.getState().savePage(PAGE, owner.content);
    await open();
    expect(events('table_save_committed')).toHaveLength(1);
    expect(events('reopened_confirmed')).toHaveLength(1);
  });

  it.each(['account', 'episode', 'consent'] as const)(
    'permanently retires an operation after observed %s authority change',
    async (kind) => {
      const owner = source();
      edit(owner);
      await idle();
      if (kind === 'account') state.account = '69800000-0000-4000-8000-000000000099';
      else if (kind === 'episode') {
        beginTelemetryEpisode();
      } else state.ready = false;
      for (const fn of state.subscribers) fn();
      state.account = null;
      state.ready = true;
      await usePageStore.getState().savePage(PAGE, owner.content);
      expect(events('table_save_committed')).toEqual([]);
    }
  );

  it('requires a created independent file read and exact committed authority, not cached tab reuse or equal table text', async () => {
    const owner = source();
    edit(owner);
    await idle();
    await usePageStore.getState().savePage(PAGE, owner.content);
    state.disk = JSON.stringify({
      ...owner.content,
      content: [...owner.content.content!, { type: 'paragraph' }],
    });
    await open();
    expect(events('table_reopen_mismatch')).toHaveLength(1);
    expect(events('reopened_confirmed')).toEqual([]);
    closeTabs();
    state.disk = JSON.stringify(owner.content);
    await open();
    expect(events('reopened_confirmed')).toEqual([]);
  });

  it('keeps the admitted data and normal editor Undo history through an appended transaction', async () => {
    const owner = source('append');
    edit(owner);
    await idle();
    expect(owner.editor.state.doc.nodeAt(0)!.attrs.data.cells[0][0].value).toBe('PRIVATE_NEW_CELL');
    expect(owner.editor.commands.undo()).toBe(true);
    await idle();
    expect(owner.editor.state.doc.nodeAt(0)!.attrs.data.cells[0][0].value).toBe(
      'PRIVATE_ORIGINAL_CELL'
    );
    expect(events('table_save_committed')).toEqual([]);
  });

  it('retires a committed receipt after editor-level Undo instead of reviving it from saved equal bytes', async () => {
    const owner = source();
    edit(owner);
    await idle();
    await usePageStore.getState().savePage(PAGE, owner.content);
    expect(owner.editor.commands.undo()).toBe(true);
    await idle();
    await open();
    expect(events('reopened_confirmed')).toEqual([]);
  });

  it('retains a committed receipt when native projection updates editor editability', async () => {
    const owner = source();
    edit(owner);
    await idle();
    await usePageStore.getState().savePage(PAGE, owner.content);
    owner.editor.setEditable(false);
    owner.editor.setEditable(true);
    await idle();
    await open();
    expect(events('reopened_confirmed')).toHaveLength(1);
    expect(events('reopened_confirmed')[0].properties.action_id).toBe(
      events('table_edit_accepted')[0].properties.action_id
    );
  });

  it('permits a clean source remount of the independently read committed revision', async () => {
    const owner = source();
    edit(owner);
    await idle();
    await usePageStore.getState().savePage(PAGE, owner.content);
    source(undefined, JSON.parse(state.disk));
    await idle();
    await open();
    expect(events('reopened_confirmed')).toHaveLength(1);
  });

  it('keeps the actual notebook save successful when optional metadata admission fails', async () => {
    state.writeReceipt.mockRejectedValueOnce(new Error('optional metadata unavailable'));
    const owner = source();
    edit(owner);
    await idle();
    const fingerprint = await usePageStore.getState().savePage(PAGE, owner.content);
    expect(requireNotebookCommitFingerprint(fingerprint)).toBe(contentFingerprint(state.disk));
    expect(JSON.parse(state.disk).content[0].attrs.data.cells[0][0].value).toBe('PRIVATE_NEW_CELL');
    expect(events('table_save_committed')).toEqual([]);
    await open();
    expect(events('reopened_confirmed')).toEqual([]);
  });

  it('does not substitute a cached/reused tab or the same page ID at another path for independent reopen', async () => {
    const owner = source();
    edit(owner);
    await idle();
    await usePageStore.getState().savePage(PAGE, owner.content);
    presentDocument({ type: 'page', entityId: PAGE, label: 'Synthetic existing tab' });
    expect(await open()).toMatchObject({ status: 'presented', disposition: 'reused' });
    expect(events('reopened_confirmed')).toEqual([]);
    closeTabs();
    await openWorkspaceDocument({
      target: { kind: 'file', path: ROOT + '/Other/.forge/notebook.json', tabType: 'page' },
      label: 'Other',
    });
    expect(events('reopened_confirmed')).toEqual([]);
    closeTabs();
    await open();
    expect(events('reopened_confirmed')).toHaveLength(1);
  });

  it('can reopen a committed receipt after losing editor/module owners, only in the same native-admissible scope', async () => {
    const owner = source();
    edit(owner);
    await idle();
    await usePageStore.getState().savePage(PAGE, owner.content);
    resetTableNotebookObservationsForTests();
    owner.editor.destroy();
    state.origin = { ...state.origin!, processId: '69800000-0000-4000-8000-000000000077' };
    await open();
    expect(events('reopened_confirmed')).toHaveLength(1);
  });

  it('does not call a repaired or rewritten source the exact committed reopen revision', async () => {
    const owner = source();
    edit(owner);
    await idle();
    await usePageStore.getState().savePage(PAGE, owner.content);
    state.repair.mockImplementationOnce(async (content: JSONContent) => ({
      content: { ...content, content: [...content.content!, { type: 'paragraph' }] },
      repaired: 1,
      skipped: [],
      changed: true,
    }));
    expect(await open()).toMatchObject({ status: 'presented', disposition: 'created' });
    expect(events('reopened_confirmed')).toEqual([]);
  });

  it.each(['inline', 'expanded'] as const)(
    'retains explicit %s edit/paste/fill/structure provenance through commit and independent reopen',
    async (surface) => {
      const owner = source();
      const hook = mountedTable(owner, surface);
      try {
        act(() => hook.result.current.table.updateCell(0, 0, 'PRIVATE_TYPED_VALUE'));
        await idle();
        expect(events('table_edit_accepted').at(-1)!.properties).toMatchObject({
          table_operation: 'edit',
          table_surface: surface,
        });
        act(() =>
          hook.result.current.table.pasteCSV('PRIVATE_PASTE_A\tPRIVATE_PASTE_B\n2\t3', 0, 0)
        );
        await idle();
        expect(events('table_paste_accepted')).toHaveLength(1);
        act(() =>
          hook.result.current.table.fillRange(
            { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
            { startRow: 1, endRow: 1, startCol: 1, endCol: 1 }
          )
        );
        await idle();
        expect(events('table_fill_accepted')).toHaveLength(1);
        act(() => hook.result.current.table.addColumn());
        await idle();
        const accepted = events('table_structure_accepted').at(-1)!.properties;
        expect(accepted).toMatchObject({
          table_operation: 'structure',
          table_surface: surface,
          table_rows: 2,
          table_columns: 3,
        });
        await usePageStore.getState().savePage(PAGE, owner.content);
        await open();
        for (const outcome of ['table_save_committed', 'reopened_confirmed']) {
          expect(events(outcome).at(-1)!.properties).toMatchObject({
            action_id: accepted.action_id,
            artifact_correlation_id: accepted.artifact_correlation_id,
            table_operation: 'structure',
            table_surface: surface,
            table_rows: 2,
            table_columns: 3,
          });
        }
        const wire = JSON.stringify(observed());
        for (const privateValue of [
          'PRIVATE_TYPED_VALUE',
          'PRIVATE_PASTE_A',
          'PRIVATE_PASTE_B',
          PAGE,
          REF,
          ROOT,
        ])
          expect(wire).not.toContain(privateValue);
      } finally {
        hook.unmount();
      }
    }
  );

  it('classifies a real single-cell paste as paste rather than a typed edit, including ghost expansion', async () => {
    const owner = source();
    const hook = mountedTable(owner);
    try {
      const target = document.createElement('div');
      const clipboardData = {
        getData: (type: string) => (type === 'text/plain' ? 'PRIVATE_SINGLE_PASTE' : ''),
        setData: () => {},
      };
      act(() =>
        hook.result.current.clipboard.handlePaste({
          clipboardData,
          target,
          currentTarget: target,
          preventDefault: () => {},
        })
      );
      await idle();
      expect(events('table_edit_accepted')).toEqual([]);
      expect(events('table_paste_accepted')).toHaveLength(1);
      expect(events('table_paste_accepted')[0].properties).toMatchObject({
        table_rows: 2,
        table_columns: 2,
      });
      expect(owner.editor.state.doc.nodeAt(0)!.attrs.data.cells[1][1].value).toBe(
        'PRIVATE_SINGLE_PASTE'
      );
    } finally {
      hook.unmount();
    }
  });

  it('keeps compute failure separate from successful authority save and a later commit failure/retry', async () => {
    const owner = source();
    const hook = mountedTable(owner);
    try {
      act(() => hook.result.current.table.updateCell(0, 0, '=SOURCE_NOT_SUPPORTED()'));
      await idle();
      const computed = events('table_calculation_failed')[0].properties;
      expect(computed).toMatchObject({
        workflow_action: 'update',
        action_phase: 'result',
        workflow_status: 'failed',
        success: false,
        error_class: 'table_formula_evaluation',
        table_calculation_result: 'failed',
        table_formula_count: 1,
        table_calculation_error_count: 1,
      });
      expect(hook.result.current.table.displayCells[0][0].computed).toBe('#NAME?');
      state.publish.mockRejectedValueOnce(new Error('PRIVATE_NATIVE_SAVE_ERROR'));
      await expect(usePageStore.getState().savePage(PAGE, owner.content)).rejects.toThrow(
        'PRIVATE_NATIVE_SAVE_ERROR'
      );
      expect(events('table_save_failed')).toHaveLength(1);
      expect(events('table_save_committed')).toEqual([]);
      await usePageStore.getState().savePage(PAGE, owner.content);
      await open();
      expect(events('table_calculation_failed')).toHaveLength(1);
      expect(events('table_save_committed')[0].properties).toMatchObject({
        action_id: computed.action_id,
        success: true,
        table_calculation_result: 'failed',
        table_calculation_error_count: 1,
      });
      expect(events('reopened_confirmed')[0].properties).toMatchObject({
        action_id: computed.action_id,
        table_calculation_result: 'failed',
      });
      expect(JSON.stringify(observed())).not.toContain('SOURCE_NOT_SUPPORTED');
      expect(JSON.stringify(observed())).not.toContain('PRIVATE_NATIVE_SAVE_ERROR');
    } finally {
      hook.unmount();
    }
  });

  it('does not invent user-operation or historical calculation provenance for programmatic updates or old receipts', async () => {
    const owner = source();
    updateTableNotebookAttributes(owner.editor, 0, REF, {
      rows: 1,
      cols: 1,
      cells: [[{ value: 'PRIVATE_PROGRAMMATIC_VALUE', type: 'text' }]],
    });
    await idle();
    await usePageStore.getState().savePage(PAGE, owner.content);
    await open();
    expect(observed().filter((event) => event.properties.workflow === 'table')).toEqual([]);
    closeTabs();
    edit(owner);
    await idle();
    await usePageStore.getState().savePage(PAGE, owner.content);
    const row = state
      .db!.prepare("SELECT key, value FROM settings WHERE key GLOB 'table_notebook_reopen_v1:*'")
      .get() as { key: string; value: string };
    const legacy = JSON.parse(row.value);
    delete legacy.observation;
    state
      .db!.prepare('UPDATE settings SET value = ? WHERE key = ?')
      .run(JSON.stringify(legacy), row.key);
    await open();
    expect(events('reopened_confirmed')).toEqual([]);
    native.recoverTableNotebookTelemetry();
    expect(events('table_save_committed')).toHaveLength(1);
  });

  it.each(['filter', 'rollback', 'replace'] as const)(
    'does not count a real owning paste refused by %s admission',
    async (mode) => {
      const owner = source(mode);
      const hook = mountedTable(owner, 'expanded');
      try {
        act(() =>
          expect(() => hook.result.current.table.pasteCSV('PRIVATE_A\tPRIVATE_B', 0, 0)).toThrow()
        );
        await idle();
        expect(events('table_paste_accepted')).toEqual([]);
        expect(events('table_calculation_failed')).toEqual([]);
        expect(events('table_save_committed')).toEqual([]);
        expect(hook.result.current.table.undo()).toBeNull();
      } finally {
        hook.unmount();
      }
    }
  );

  it('observes a checked source-owned open only after placement and never treats it as a save', async () => {
    const owner = source();
    openTableNotebookView(owner.editor, 0, REF, () => false);
    expect(events('table_open_accepted')).toEqual([]);
    openTableNotebookView(owner.editor, 0, REF, () => {
      return true;
    });
    expect(events('table_open_accepted')).toHaveLength(1);
    expect(events('table_open_accepted')[0].properties.table_surface).toBe('expanded');
    expect(events('table_save_committed')).toEqual([]);
    openTableNotebookView(owner.editor, 0, REF, () => {
      edit(owner);
      return true;
    });
    expect(events('table_open_accepted')).toHaveLength(1);
    state.ready = false;
    for (const listener of state.subscribers) listener();
    openTableNotebookView(owner.editor, 0, REF, () => true);
    expect(events('table_open_accepted')).toHaveLength(1);
    await idle();
  });

  it.each(['invalid_position', 'origin_lookup', 'sink'] as const)(
    'opens exactly once through %s observation failure',
    (kind) => {
      const owner = source();
      const listeners = state.subscribers.size;
      state.lookupThrows = kind === 'origin_lookup';
      state.captureThrows = kind === 'sink';
      const productOpen = vi.fn(() => true);
      expect(() =>
        openTableNotebookView(owner.editor, kind === 'invalid_position' ? -1 : 0, REF, productOpen)
      ).not.toThrow();
      expect(productOpen).toHaveBeenCalledTimes(1);
      expect(state.subscribers.size).toBe(listeners);
      expect(events('table_open_accepted')).toEqual([]);
      state.lookupThrows = false;
      state.captureThrows = false;
    }
  );

  it('preserves a product-open failure without retrying and releases its optional guard', () => {
    const owner = source();
    const primary = new Error('synthetic primary product open failure');
    const listeners = state.subscribers.size;
    const productOpen = vi.fn(() => {
      throw primary;
    });
    expect(() => openTableNotebookView(owner.editor, 0, REF, productOpen)).toThrow(primary);
    expect(productOpen).toHaveBeenCalledTimes(1);
    expect(state.subscribers.size).toBe(listeners);
    expect(events('table_open_accepted')).toEqual([]);
  });

  it('joins a checked expanded open to an already accepted exact revision without replacing its mutation operation', async () => {
    const owner = source();
    edit(owner);
    await idle();
    const accepted = events('table_edit_accepted')[0].properties;
    openTableNotebookView(owner.editor, 0, REF, () => true);
    const opened = events('table_open_accepted')[0].properties;
    expect(opened.action_id).not.toBe(accepted.action_id);
    expect(opened.parent_action_id).toBe(accepted.action_id);
    expect(opened.artifact_correlation_id).toBe(accepted.artifact_correlation_id);
    await usePageStore.getState().savePage(PAGE, owner.content);
    expect(events('table_save_committed')[0].properties.action_id).toBe(accepted.action_id);
  });

  it.each(['text', 'formula'] as const)(
    'preserves imported %s evidence through the real accepted/commit/readback seam without claiming fresh evaluation',
    async (type) => {
      const saved =
        type === 'text'
          ? {
              type,
              value: '42',
              sourceFormula: '=PRIVATE_SOURCE()',
              sourceRenderedValue: '42',
              formulaCompatibility: 'unsupported' as const,
            }
          : {
              type,
              value: '=PRIVATE_SOURCE()',
              computed: '42',
              formulaCompatibility: 'unsupported' as const,
            };
      const content: JSONContent = {
        type: 'doc',
        content: [
          {
            type: 'embed',
            attrs: {
              type: 'table',
              refId: REF,
              data: { rows: 1, cols: 2, cells: [[{ value: '2', type: 'number' }, saved]] },
            },
          },
        ],
      };
      const owner = source(undefined, content);
      const hook = mountedTable(owner);
      try {
        act(() => hook.result.current.table.updateCell(0, 0, '7'));
        await idle();
        expect(events('table_calculation_saved_stale')).toHaveLength(1);
        expect(events('table_calculation_saved_stale')[0].properties).toMatchObject({
          table_calculation_result: 'saved_stale',
          table_formula_count: 0,
          table_calculation_error_count: 0,
          table_saved_result_count: 1,
          table_stale_result_count: 1,
        });
        expect(events('table_calculation_evaluated')).toEqual([]);
        expect(events('table_calculation_failed')).toEqual([]);
        await usePageStore.getState().savePage(PAGE, owner.content);
        await open();
        expect(events('reopened_confirmed')[0].properties).toMatchObject({
          table_calculation_result: 'saved_stale',
          table_formula_count: 0,
          table_saved_result_count: 1,
          table_stale_result_count: 1,
        });
        expect(JSON.parse(state.disk).content[0].attrs.data.cells[0][1]).toEqual({
          ...saved,
          stale: true,
        });
        expect(JSON.stringify(observed())).not.toContain('PRIVATE_SOURCE');
      } finally {
        hook.unmount();
      }
    }
  );

  it('keeps an unavailable imported result distinct from compute failure and a successful product commit', async () => {
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'embed',
          attrs: {
            type: 'table',
            refId: REF,
            data: {
              rows: 1,
              cols: 2,
              cells: [
                [
                  { value: '2', type: 'number' },
                  {
                    value: '=PRIVATE_SOURCE()',
                    type: 'formula',
                    formulaCompatibility: 'unsupported',
                  },
                ],
              ],
            },
          },
        },
      ],
    };
    const owner = source(undefined, content);
    const hook = mountedTable(owner);
    try {
      act(() => hook.result.current.table.updateCell(0, 0, '7'));
      await idle();
      expect(events('table_calculation_unavailable')[0].properties).toMatchObject({
        workflow_status: 'needs_action',
        success: false,
        table_calculation_result: 'unavailable',
        table_formula_count: 0,
        table_calculation_error_count: 0,
        table_saved_result_count: 0,
        table_saved_result_unavailable_count: 1,
      });
      expect(events('table_calculation_failed')).toEqual([]);
      await usePageStore.getState().savePage(PAGE, owner.content);
      expect(events('table_save_committed')[0].properties).toMatchObject({
        success: true,
        table_calculation_result: 'unavailable',
      });
    } finally {
      hook.unmount();
    }
  });

  it('refuses a detached old writer while allowing the real new source operation to commit', async () => {
    const owner = source();
    const stale = mountedTable(owner, 'expanded');
    const replacement = source();
    const fresh = mountedTable(replacement, 'expanded');
    try {
      owner.editor.destroy();
      act(() =>
        expect(() => stale.result.current.table.pasteCSV('PRIVATE_OLD\tVALUE', 0, 0)).toThrow()
      );
      await idle();
      expect(events('table_paste_accepted')).toEqual([]);
      act(() => fresh.result.current.table.pasteCSV('PRIVATE_CURRENT\tVALUE', 0, 0));
      await idle();
      expect(events('table_paste_accepted')).toHaveLength(1);
      await usePageStore.getState().savePage(PAGE, replacement.content);
      await open();
      expect(events('reopened_confirmed')[0].properties).toMatchObject({
        table_operation: 'paste',
        table_surface: 'expanded',
      });
    } finally {
      stale.unmount();
      fresh.unmount();
    }
  });
});
