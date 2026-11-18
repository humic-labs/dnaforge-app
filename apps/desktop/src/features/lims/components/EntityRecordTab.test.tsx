import { userMessage } from '@waypoint/user-messages';
/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tab } from '../../canvas/public/types';

const mocks = vi.hoisted(() => ({
  sessions: new Map<
    string,
    import('../../entity-details/public/session-model').EntityDetailsSession
  >(),
  load: vi.fn(),
  update: vi.fn(),
  queryTargets: vi.fn(),
  updateTab: vi.fn(),
  accountId: null as string | null,
  syncStatus: vi.fn(),
  syncReview: vi.fn(),
  syncOrganization: vi.fn(),
  resolveOrganization: vi.fn(),
  readOwner: vi.fn(),
  readWorkspaceRoot: vi.fn(),
  panels: {} as Record<string, { tabs: Tab[] }>,
  folders: [{ path: '/project', name: 'Home', pinned: false, lifecycle: 'active' as const }],
  mountedFolders: [{ path: '/project' }],
}));
vi.mock('../../../platform', () => ({
  platform: () => ({
    lims: { queryRegistrySummaries: mocks.queryTargets, getEntityHistory: async () => [] },
    cloudSync: {
      getOrganizationRegistryRecordSyncStatus: mocks.syncStatus,
      getOrganizationRegistrySavedRecordReview: mocks.syncReview,
      syncOrganizationRegistry: mocks.syncOrganization,
      onOrganizationRegistryChanged: () => () => {},
      resolveOrganizationRegistrySavedRecord: mocks.resolveOrganization,
    },
  }),
}));
vi.mock('../../../stores/auth-store', () => {
  const state = () => ({
    state: mocks.accountId
      ? { status: 'signed-in', session: { accountId: mocks.accountId } }
      : { status: 'signed-out' },
  });
  return {
    useAuthStore: Object.assign(
      (select: (value: ReturnType<typeof state>) => unknown) => select(state()),
      {
        getState: state,
      }
    ),
  };
});
vi.mock('../entity-record-document', () => ({
  loadSavedEntityRecord: async (...args: unknown[]) => {
    const loaded = await mocks.load(...args);
    return {
      ...loaded,
      preview: {
        ...loaded.preview,
        summary: {
          ...loaded.preview.summary,
          ...loaded.preview.entity,
          name: loaded.artifact.name,
          fieldValues: loaded.artifact.fields,
        },
      },
    };
  },
}));
vi.mock('../open-target', () => ({ getLimsEntityById: mocks.readOwner }));
vi.mock('../../../db/workspace-catalog', async (original) => ({
  ...(await original<typeof import('../../../db/workspace-catalog')>()),
  getWorkspaceRootById: mocks.readWorkspaceRoot,
  getCurrentCatalogFileForEntity: async () => ({ path: '/project/record.entity.json' }),
}));
vi.mock('../../workspace-loader/project-edit-folders', async (original) => ({
  ...(await original<typeof import('../../workspace-loader/public/project-edit-folders')>()),
  listProjectEditFolders: async () => mocks.folders,
}));
vi.mock('../../entity-details/editing-sessions', () => ({
  sessions: mocks.sessions,
  peekEntityDetailsSession: (id: string) => mocks.sessions.get(id),
  findUnsettledEntityDetailsSession: () => undefined,
}));
vi.mock('../public/use-actionable-pending-refs', () => ({
  useActionablePendingRefs: () => ({ refs: [], reload: async () => {} }),
}));
vi.mock('../../../services/lims-entity-mutations', () => ({ updateLimsEntity: mocks.update }));
vi.mock('../../canvas/public/store', () => ({
  useCanvasStore: Object.assign(
    (
      selector: (state: {
        updateTab: typeof mocks.updateTab;
        panels: typeof mocks.panels;
      }) => unknown
    ) => selector({ updateTab: mocks.updateTab, panels: mocks.panels }),
    { getState: () => ({ panels: mocks.panels, updateTabByEntityId: () => {} }) }
  ),
}));
vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: Object.assign(
    (select: (state: { folders: typeof mocks.mountedFolders }) => unknown) =>
      select({ folders: mocks.mountedFolders }),
    { getState: () => ({ folders: mocks.mountedFolders }) }
  ),
}));
vi.mock('../../../lib/readable-content-telemetry', () => ({
  commitReadableContent: vi.fn(),
  failReadableContent: vi.fn(),
}));
vi.mock('../../../shared/unsaved-draft-recovery', () => ({
  fingerprintText: (value: string) => value,
  useUnsavedDraftRecovery: vi.fn(),
}));
vi.mock('../events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../events')>()),
  emitLimsRegistryChanged: vi.fn(),
}));

import { EntityRecordTab } from './EntityRecordTab';
import { RegistryPendingRecordResolution } from './registry/RegistryPendingRecordResolution';
import { emitLimsRegistryChanged } from '../events';
import { emitRegistryChanged } from '../../../shared/registry-events';
import { deliverWorkspaceDisplay } from '../../../services/workspace-display-participants';
import type { OrganizationRegistrySavedRecordResolutionRequest } from '../../../shared/org-registry-sync';

function fixture() {
  const artifact = {
    schema: 'waypoint.entity.v2',
    id: '10000000-0000-4000-8000-000000000001',
    kind: 'custom',
    name: 'Saved record',
    fields: {
      lot: 'A',
      futureMetadata: { retained: [false, 42] },
      artifact: { schema: 'waypoint.entity.v2', relativePath: 'record.entity.json' },
    },
    registrationStatus: 'registered',
    domainStatus: null,
    archived: false,
    schemaRevisionId: 'custom-v1',
    schemaSnapshot: {
      schemaId: 'custom-schema',
      schemaRevisionId: 'custom-v1',
      name: 'custom',
      displayName: 'Custom record',
      baseKind: 'record',
      version: 1,
      fields: [{ key: 'lot', label: 'Lot', type: 'text' }],
    },
    source: { type: 'manual', values: {} },
    relationships: [
      {
        type: 'associated_with',
        fromEntityId: '10000000-0000-4000-8000-000000000001',
        toEntityId: 'parent-1',
        payload: { evidence: 'retained' },
      },
    ],
  };
  const entity = {
    ...artifact,
    workspaceId: 7,
    eventSeq: 12,
    registryId: 'REC1',
    tombstone: false,
  };
  return {
    artifact,
    content: JSON.stringify(artifact),
    workspaceRoot: '/project',
    path: '/project/record.entity.json',
    workspaceId: 7,
    importSource: false,
    preview: {
      entity,
      schemaSnapshot: artifact.schemaSnapshot,
      summary: {
        ...entity,
        schemaSnapshot: artifact.schemaSnapshot,
        fieldValues: artifact.fields,
        representation: {
          kind: 'record',
          label: 'Saved record',
          canOpen: true,
          openTarget: { kind: 'record_file', entityId: entity.id },
        },
        summary: '',
        linkSummary: { outgoingCount: 1, incomingCount: 0, notable: [] },
        searchableText: '',
        updatedAt: 0,
      },
      incomingLinks: [],
      outgoingLinks: [
        {
          link: artifact.relationships[0],
          entity: { id: 'parent-1', name: 'Stored parent' },
          summary: {
            id: 'parent-1',
            name: 'Stored parent',
            representation: { kind: 'record', label: 'Saved record', canOpen: false },
          },
        },
      ],
    },
  };
}

function Harness() {
  const [tab, setTab] = useState<Tab>({
    id: 'tab-record',
    entityId: '10000000-0000-4000-8000-000000000001',
    type: 'record',
    label: 'Saved record',
    isDirty: false,
  });
  mocks.updateTab.mockImplementation((_panel: string, _id: string, patch: Partial<Tab>) =>
    setTab((current) => ({ ...current, ...patch }))
  );
  return <EntityRecordTab tab={tab} panelId="main" />;
}

function currentSession() {
  const session = mocks.sessions.get('10000000-0000-4000-8000-000000000001');
  if (!session) throw new Error('The shared record session has not mounted.');
  return session;
}

async function editName() {
  const existing = screen.queryByRole('textbox', { name: 'Name', exact: true });
  if (existing) return existing;
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Name', exact: true }));
  return screen.findByRole('textbox', { name: 'Name', exact: true });
}

function saveControl() {
  return screen.getByRole('button', { name: 'Update entity', exact: true });
}

async function savedView() {
  await waitFor(() => {
    const session = currentSession();
    expect(session.dirty).toBe(false);
    expect(session.getSnapshot()).toMatchObject({
      saving: false,
      requiresReload: false,
      completionPending: false,
      mutationBlock: null,
      error: null,
    });
  });
  return screen.getByTestId('entity-details-panel');
}

afterEach(async () => {
  cleanup();
  for (const session of mocks.sessions.values()) {
    session.discard();
    session.dispose();
  }
  mocks.sessions.clear();
  await act(async () => {});
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(emitLimsRegistryChanged).mockImplementation(emitRegistryChanged);
  mocks.accountId = null;
  mocks.folders = [{ path: '/project', name: 'Home', pinned: false, lifecycle: 'active' as const }];
  mocks.mountedFolders = [{ path: '/project' }];
  mocks.panels = {};
  mocks.readOwner.mockResolvedValue(fixture().preview.entity);
  mocks.readWorkspaceRoot.mockResolvedValue('/project');
  mocks.load.mockResolvedValue(fixture());
});

describe('saved record explicit Save', () => {
  it('preserves an entity search across an unchanged index refresh and blocks editing during explicit discard and reload', async () => {
    const initial = fixture();
    initial.artifact.schemaSnapshot.fields.push({
      key: 'parent',
      label: 'Parent entity',
      type: 'record_relationship',
    });
    mocks.load.mockResolvedValue(initial);
    mocks.queryTargets.mockResolvedValue({ summaries: [], totalCount: 0 });
    render(<Harness />);
    const choose = await screen.findByRole('button', { name: 'Choose Parent entity' });
    await waitFor(() => expect(choose).toBeEnabled());
    fireEvent.click(choose);
    const search = await screen.findByRole('searchbox');
    fireEvent.change(search, { target: { value: 'Keep this search' } });
    const beforeRefresh = mocks.load.mock.calls.length;
    await act(async () => emitRegistryChanged());
    await waitFor(() => expect(mocks.load.mock.calls.length).toBeGreaterThan(beforeRefresh));
    expect(screen.getByRole('searchbox')).toHaveValue('Keep this search');
    fireEvent.keyDown(document, { key: 'Escape' });
    let finish!: (value: ReturnType<typeof fixture>) => void;
    mocks.load.mockReturnValueOnce(
      new Promise<ReturnType<typeof fixture>>((resolve) => {
        finish = resolve;
      })
    );
    const name = await editName();
    fireEvent.change(name, { target: { value: 'Discard me' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes', exact: true }));
    expect(screen.getByRole('button', { name: 'Choose Parent entity' })).toBeDisabled();
    await act(async () => finish(initial));
    expect(screen.getByRole('button', { name: 'Choose Parent entity' })).toBeEnabled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('saves a chosen entity through target IDs while preserving unrelated metadata', async () => {
    const initial = fixture();
    initial.artifact.schemaSnapshot.fields.push({
      key: 'parent',
      label: 'Parent entity',
      type: 'record_relationship',
    });
    mocks.load.mockResolvedValue(initial);
    mocks.queryTargets.mockResolvedValue({
      summaries: [
        {
          id: 'target-record',
          name: 'Parent strain',
          kind: 'strain',
          registryId: 'STRAIN2',
          archived: false,
        },
      ],
      totalCount: 1,
    });
    render(<Harness />);
    const choose = await screen.findByRole('button', { name: 'Choose Parent entity' });
    await waitFor(() => expect(choose).toBeEnabled());
    fireEvent.click(choose);
    fireEvent.click(await screen.findByRole('option', { name: /Parent strain/ }));
    await waitFor(() => expect(saveControl()).toBeEnabled());
    expect(mocks.update).not.toHaveBeenCalled();
    const saved = fixture();
    saved.artifact.schemaSnapshot.fields = initial.artifact.schemaSnapshot.fields;
    Object.assign(saved.artifact.fields, {
      parent: {
        origin: 'native',
        destinationEntityId: 'target-record',
        relationType: 'references',
        label: 'Parent strain',
        resolution: 'exact',
      },
    });
    saved.preview.entity = { ...saved.preview.entity, fields: saved.artifact.fields, eventSeq: 13 };
    saved.content = JSON.stringify(saved.artifact);
    mocks.update.mockImplementation(async () => {
      mocks.load.mockResolvedValue(saved);
      return saved.preview.entity;
    });
    mocks.load.mockResolvedValue(saved);
    fireEvent.click(saveControl());
    expect(await savedView()).toBeVisible();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '10000000-0000-4000-8000-000000000001',
        expectedEventSeq: 12,
        relationshipTargets: { parent: 'target-record' },
        fields: {},
      })
    );
    expect(mocks.update.mock.calls[0][0].fields).not.toHaveProperty('parent');
    expect(currentSession().getSnapshot().definition?.record.fields.futureMetadata).toEqual({
      retained: [false, 42],
    });
    expect(screen.getByTestId('entity-record-tab')).toHaveAttribute('data-workspace-id', '7');
  });

  it.each([
    [null, 'owner-account'],
    ['owner-account', 'different-account'],
  ])('finishes loading after the account changes from %s to %s', async (before, after) => {
    mocks.accountId = before;
    mocks.syncStatus.mockImplementation(async () => ({
      ok: true,
      accountId: mocks.accountId,
      status: null,
    }));
    let finishPrevious!: (value: ReturnType<typeof fixture>) => void;
    mocks.load.mockReturnValueOnce(
      new Promise<ReturnType<typeof fixture>>((resolve) => {
        finishPrevious = resolve;
      })
    );
    const view = render(<Harness />);
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Loading metadata…')).toBeVisible();

    mocks.accountId = after;
    view.rerender(<Harness />);
    await act(async () => finishPrevious(fixture()));

    const name = await editName();
    await waitFor(() => expect(name).toBeEnabled());
    expect(name).toHaveValue('Saved record');
    expect(screen.queryByText('Loading metadata…')).not.toBeInTheDocument();
    expect(screen.getByTestId('entity-record-tab')).toHaveAttribute('data-workspace-id', '7');

    expect(name).toHaveValue('Saved record');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('preserves an editable draft when project reconstruction confirms the same saved record', async () => {
    render(<Harness />);
    const name = await editName();
    await waitFor(() => expect(name).toBeEnabled());
    fireEvent.change(name, { target: { value: 'Offline draft' } });
    await act(async () => {
      const report = await deliverWorkspaceDisplay({
        workspaceRoot: '/project',
        operationId: 'unchanged-reconstruction',
        assertCurrent: () => undefined,
      });
      expect(report.errors).toEqual([]);
    });
    expect(name).toHaveValue('Offline draft');
    expect(saveControl()).toBeEnabled();
    const saved = fixture();
    saved.artifact.name = 'Offline draft';
    saved.preview.entity = { ...saved.preview.entity, name: saved.artifact.name, eventSeq: 13 };
    saved.content = JSON.stringify(saved.artifact);
    mocks.load.mockResolvedValue(saved);
    mocks.update.mockImplementation(async () => {
      mocks.load.mockResolvedValue(saved);
      return saved.preview.entity;
    });
    fireEvent.click(saveControl());
    expect(await savedView()).toBeVisible();
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it('retains a draft and refuses Save when reconstruction finds a different saved revision', async () => {
    render(<Harness />);
    const name = await editName();
    await waitFor(() => expect(name).toBeEnabled());
    fireEvent.change(name, { target: { value: 'Local draft' } });
    const external = fixture();
    external.preview.entity.eventSeq = 13;
    mocks.load.mockResolvedValue(external);
    await act(async () => {
      const report = await deliverWorkspaceDisplay({
        workspaceRoot: '/project',
        operationId: 'changed-reconstruction',
        assertCurrent: () => undefined,
      });
      expect(report.errors).toHaveLength(1);
    });
    expect(name).toHaveValue('Local draft');
    expect(saveControl()).toBeDisabled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('allows Save during an index refresh and ignores the older read after Save settles', async () => {
    render(<Harness />);
    const name = await editName();
    await waitFor(() => expect(name).toBeEnabled());
    fireEvent.change(name, { target: { value: 'New saved value' } });
    let finishRead!: (value: ReturnType<typeof fixture>) => void;
    mocks.load.mockReturnValueOnce(
      new Promise<ReturnType<typeof fixture>>((resolve) => {
        finishRead = resolve;
      })
    );
    act(() => emitRegistryChanged());
    expect(saveControl()).toBeEnabled();
    const saved = fixture();
    saved.artifact.name = 'New saved value';
    saved.preview.entity = { ...saved.preview.entity, name: saved.artifact.name, eventSeq: 13 };
    saved.content = JSON.stringify(saved.artifact);
    mocks.load.mockResolvedValue(saved);
    mocks.update.mockImplementation(async () => {
      mocks.load.mockResolvedValue(saved);
      return saved.preview.entity;
    });
    fireEvent.click(saveControl());
    expect(await savedView()).toBeVisible();
    await act(async () => finishRead(fixture()));
    expect(screen.getByRole('button', { name: 'Edit Name', exact: true })).toHaveTextContent(
      saved.artifact.name
    );
    expect(screen.getByTestId('entity-details-panel')).toBeVisible();
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it('loads a restored record when its home project is mounted after the initial read failed', async () => {
    mocks.mountedFolders = [];
    mocks.load.mockImplementation(async () => {
      if (mocks.mountedFolders.length === 0)
        throw new Error('The saved record home is not mounted.');
      return fixture();
    });
    const view = render(<Harness />);
    expect(await screen.findByRole('alert')).toHaveTextContent(userMessage('operation.failed'));
    expect(screen.getByTestId('entity-record-tab')).not.toHaveAttribute('data-workspace-id');

    mocks.mountedFolders = [{ path: '/project' }];
    view.rerender(<Harness />);
    const name = await editName();
    await waitFor(() => expect(name).toBeEnabled());
    expect(name).toHaveValue('Saved record');
    expect(screen.getByTestId('entity-record-tab')).toHaveAttribute(
      'data-entity-id',
      '10000000-0000-4000-8000-000000000001'
    );
    expect(screen.getByTestId('entity-record-tab')).toHaveAttribute('data-workspace-id', '7');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('preserves an open draft when another project is mounted', async () => {
    const view = render(<Harness />);
    const name = await editName();
    await waitFor(() => expect(name).toBeEnabled());
    fireEvent.change(name, { target: { value: 'Unsaved local draft' } });

    mocks.folders = [
      ...mocks.folders,
      { path: '/other-project', name: 'Other', pinned: false, lifecycle: 'active' },
    ];
    mocks.mountedFolders = [{ path: '/project' }, { path: '/other-project' }];
    view.rerender(<Harness />);
    expect(name).toHaveValue('Unsaved local draft');
    expect(saveControl()).toBeEnabled();
    expect(currentSession().getSnapshot().draft?.name).toBe('Unsaved local draft');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('stages edits, preserves unknown fields and read-only links, and retries the identical audited request after failure', async () => {
    mocks.update.mockRejectedValueOnce(new Error('Publication is temporarily unavailable.'));
    render(<Harness />);
    const name = await editName();
    await waitFor(() => expect(name).toBeEnabled());
    expect(screen.getByText(/Stored parent/)).toBeVisible();
    fireEvent.change(name, { target: { value: 'Edited record' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Lot' }));
    const lot = screen.getByRole('textbox', { name: 'Lot' });
    fireEvent.change(lot, { target: { value: 'B' } });
    fireEvent.blur(lot);
    expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.click(saveControl());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      userMessage('document.saveUnconfirmed')
    );
    const firstRequest = mocks.update.mock.calls[0][0];
    expect(firstRequest).toEqual({
      id: '10000000-0000-4000-8000-000000000001',
      expectedEventSeq: 12,
      operationId: expect.any(String),
      name: 'Edited record',
      fields: { lot: 'B' },
    });
    expect(firstRequest.operationId).not.toBe('');
    expect(firstRequest).not.toHaveProperty('relationshipTargets');
    expect(screen.getByRole('button', { name: 'Edit Name', exact: true })).toBeDisabled();
    expect(
      currentSession().getSnapshot().saveConfirmed
        ? screen.getByTestId('entity-details-panel')
        : null
    ).not.toBeInTheDocument();
    const next = fixture();
    next.artifact.name = 'Edited record';
    next.artifact.fields.lot = 'B';
    next.preview.entity = {
      ...next.preview.entity,
      name: 'Edited record',
      fields: next.artifact.fields,
      eventSeq: 13,
    };
    next.content = JSON.stringify(next.artifact);
    mocks.update.mockResolvedValueOnce(next.preview.entity);
    mocks.load.mockResolvedValueOnce(next);
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    expect(await savedView()).toBeVisible();
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.update.mock.calls[1][0]).toEqual(firstRequest);
    expect(currentSession().getSnapshot().definition?.record.fields.futureMetadata).toEqual({
      retained: [false, 42],
    });
    expect(screen.getByTestId('entity-record-tab')).toHaveAttribute(
      'data-entity-id',
      '10000000-0000-4000-8000-000000000001'
    );
    expect(screen.getByTestId('entity-record-tab')).toHaveAttribute('data-workspace-id', '7');
    expect(screen.getByText(/Stored parent/)).toBeVisible();
  });

  it('retains the checked Save confirmation across unchanged Registry refreshes and clears it for a different saved revision', async () => {
    const saved = fixture();
    saved.artifact.name = 'Confirmed record';
    saved.preview.entity = { ...saved.preview.entity, name: saved.artifact.name, eventSeq: 13 };
    saved.content = JSON.stringify(saved.artifact);
    mocks.update.mockImplementation(async () => {
      mocks.load.mockResolvedValue(saved);
      return saved.preview.entity;
    });
    mocks.load.mockResolvedValue(fixture());
    render(<Harness />);
    const name = await editName();
    await waitFor(() => expect(name).toBeEnabled());
    fireEvent.change(name, { target: { value: saved.artifact.name } });
    fireEvent.click(saveControl());
    expect(await savedView()).toBeVisible();

    const readsAfterSave = mocks.load.mock.calls.length;
    act(() => emitRegistryChanged());
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(readsAfterSave + 1));
    await waitFor(() => expect(name).toBeEnabled());
    expect(screen.getByTestId('entity-details-panel')).toHaveTextContent('Metadata');
    expect(mocks.update).toHaveBeenCalledTimes(1);

    const external = fixture();
    external.artifact.name = 'Changed elsewhere';
    external.preview.entity = {
      ...external.preview.entity,
      name: external.artifact.name,
      eventSeq: 14,
    };
    external.content = JSON.stringify(external.artifact);
    mocks.load.mockResolvedValue(external);
    act(() => emitRegistryChanged());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit Name', exact: true })).toHaveTextContent(
        external.artifact.name
      )
    );
    expect(
      currentSession().getSnapshot().saveConfirmed
        ? screen.getByTestId('entity-details-panel')
        : null
    ).not.toBeInTheDocument();
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it('shows the full record but refuses editing in a reference project', async () => {
    mocks.folders[0].pinned = true;
    render(<Harness />);
    expect(await screen.findByRole('button', { name: 'Edit Name', exact: true })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Update entity' })).not.toBeInTheDocument();
    expect(screen.getByTestId('registry-record-read-only')).toBeVisible();
    expect(screen.getByText(/Stored parent/)).toBeVisible();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe('saved record organization publication status', () => {
  const status = (value: 'queued' | 'conflict' | 'synced') => ({
    ok: true,
    accountId: 'owner-account',
    status: {
      orgId: 'organization',
      entityId: '10000000-0000-4000-8000-000000000001',
      homeWorkspaceId: 'remote-home',
      acknowledgedRevision: 1,
      baseRevision: 1,
      baseProvenance: 'receipt',
      status: value,
      mutationId: 'saved-operation',
      message: null,
    },
  });

  it('keeps a completed local save successful when organization synchronization fails, and retries only synchronization', async () => {
    mocks.accountId = 'owner-account';
    mocks.syncStatus.mockResolvedValue(status('queued'));
    mocks.syncOrganization.mockResolvedValue({ ok: false, code: 'NETWORK', message: 'Offline' });
    mocks.update.mockImplementation(async () => {
      mocks.load.mockResolvedValue(saved);
      return { id: '10000000-0000-4000-8000-000000000001', workspaceId: 7 };
    });
    const saved = fixture();
    saved.artifact.name = 'Saved while offline';
    mocks.load.mockResolvedValue(fixture());
    render(<Harness />);
    const name = await editName();
    await waitFor(() => expect(name).toBeEnabled());
    fireEvent.change(name, { target: { value: 'Saved while offline' } });
    fireEvent.click(saveControl());
    await expect(savedView()).resolves.toHaveTextContent('Metadata');
    await waitFor(() => expect(mocks.syncOrganization).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('entity-record-organization-sync')).toHaveAttribute(
      'data-status',
      'queued'
    );
    expect(mocks.update).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId('entity-record-organization-sync-now')).toBeEnabled()
    );
    fireEvent.click(screen.getByTestId('entity-record-organization-sync-now'));
    await waitFor(() => expect(mocks.syncOrganization).toHaveBeenCalledTimes(2));
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Update entity' })).not.toBeInTheDocument();
  });

  it('shows the unresolved organization conflict without changing the saved record', async () => {
    mocks.accountId = 'owner-account';
    mocks.syncStatus.mockResolvedValue(status('conflict'));
    mocks.syncReview.mockResolvedValue({
      ok: true,
      review: {
        accountId: 'owner-account',
        orgId: 'organization',
        entityId: '10000000-0000-4000-8000-000000000001',
        sourceRevision: 'a'.repeat(64),
        localEventSeq: 12,
        organizationRevision: 2,
        local: fixture().artifact,
        organization: {
          ...fixture().artifact,
          name: 'Organization record',
          fields: { lot: 'Remote lot' },
        },
      },
    });
    render(<Harness />);
    await expect(
      screen.findByTestId('entity-record-organization-conflict')
    ).resolves.toHaveTextContent('Both versions are retained');
    expect(screen.getByTestId('entity-record-organization-sync')).toHaveAttribute(
      'data-status',
      'conflict'
    );
    await waitFor(() =>
      expect(screen.getByTestId('entity-record-organization-conflict')).toHaveTextContent(
        'Organization record'
      )
    );
    expect(screen.getByTestId('entity-record-organization-conflict')).toHaveTextContent(
      'Remote lot'
    );
    expect(screen.getByTestId('entity-record-organization-conflict')).toHaveTextContent(
      'Saved record'
    );
    expect(mocks.syncReview).toHaveBeenCalledWith(
      'organization',
      '10000000-0000-4000-8000-000000000001'
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('does not display a delayed previous-account synchronization status', async () => {
    mocks.accountId = 'owner-account';
    let finish!: (value: unknown) => void;
    mocks.syncStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const view = render(<Harness />);
    await waitFor(() => expect(mocks.syncStatus).toHaveBeenCalledTimes(1));
    mocks.accountId = 'different-account';
    mocks.syncStatus.mockResolvedValue({ ok: true, accountId: 'different-account', status: null });
    view.rerender(<Harness />);
    await act(async () => {
      finish(status('conflict'));
    });
    expect(screen.queryByTestId('entity-record-organization-sync')).not.toBeInTheDocument();
    expect(screen.queryByTestId('entity-record-organization-conflict')).not.toBeInTheDocument();
    expect(mocks.syncOrganization).not.toHaveBeenCalled();
  });
});

function resolutionStatus(
  status: 'conflict' | 'publication_pending' | 'queued' | 'synced' = 'conflict',
  pendingResolution: OrganizationRegistrySavedRecordResolutionRequest | null = null
) {
  return {
    ok: true,
    accountId: 'owner-account',
    status: {
      orgId: 'organization',
      entityId: '10000000-0000-4000-8000-000000000001',
      homeWorkspaceId: 'remote-home',
      acknowledgedRevision: 1,
      baseRevision: 1,
      baseProvenance: 'receipt',
      status,
      mutationId: 'saved-operation',
      message: null,
      pendingResolution,
    },
  };
}

function resolutionReview(sourceRevision = 'a'.repeat(64)) {
  return {
    ok: true,
    review: {
      accountId: 'owner-account',
      orgId: 'organization',
      entityId: '10000000-0000-4000-8000-000000000001',
      sourceRevision,
      localEventSeq: 12,
      organizationRevision: 2,
      local: fixture().artifact,
      organization: {
        ...fixture().artifact,
        name: 'Organization record',
        fields: { ...fixture().artifact.fields, lot: 'Remote lot' },
      },
    },
  };
}

function resolvedFile(choice: 'use_remote' | 'keep_saved') {
  const next = fixture();
  if (choice === 'use_remote') {
    next.artifact.name = 'Organization record';
    next.artifact.fields.lot = 'Remote lot';
  }
  next.preview.entity = { ...next.preview.entity, ...next.artifact, eventSeq: 13 };
  next.content = JSON.stringify(next.artifact);
  return next;
}

function setupResolutionReview() {
  mocks.accountId = 'owner-account';
  mocks.syncStatus.mockResolvedValue(resolutionStatus());
  mocks.syncReview.mockResolvedValue(resolutionReview());
  mocks.syncOrganization.mockResolvedValue({ ok: false, code: 'SYNC_ERROR', message: 'Offline' });
}

describe('explicit saved-record organization resolution', () => {
  it.each([
    ['use_remote', 'entity-record-use-organization'],
    ['keep_saved', 'entity-record-keep-saved'],
  ] as const)(
    'applies %s only after an explicit choice, reloads the file and keeps local success when sync fails',
    async (choice, buttonId) => {
      setupResolutionReview();
      const next = resolvedFile(choice);
      mocks.resolveOrganization.mockImplementationOnce(async () => {
        mocks.load.mockResolvedValue(next);
        mocks.syncStatus.mockResolvedValue(
          resolutionStatus(choice === 'use_remote' ? 'synced' : 'queued')
        );
        return { ok: true, entity: next.preview.entity, replayed: false };
      });
      render(<Harness />);
      const button = await screen.findByTestId(buttonId);
      await waitFor(() => expect(button).toBeEnabled());
      expect(mocks.resolveOrganization).not.toHaveBeenCalled();
      fireEvent.click(button);
      expect(await savedView()).toHaveTextContent('Metadata');
      expect(mocks.resolveOrganization).toHaveBeenCalledWith('organization', {
        entityId: '10000000-0000-4000-8000-000000000001',
        resolutionId: expect.stringMatching(/^[a-f0-9-]{36}$/),
        choice,
        sourceRevision: 'a'.repeat(64),
      });
      expect(currentSession().getSnapshot().definition?.savedRecord?.loaded.artifact.name).toBe(
        next.artifact.name
      );
      expect(screen.getByRole('button', { name: 'Edit Name', exact: true })).toHaveTextContent(
        next.artifact.name
      );
      expect(emitLimsRegistryChanged).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(mocks.syncOrganization).toHaveBeenCalledWith('organization'));
      expect(await screen.findByText(userMessage('account.failed'))).toBeVisible();
      expect(screen.getByTestId('entity-details-panel')).toBeVisible();
      expect(mocks.update).not.toHaveBeenCalled();
    }
  );

  it('retries the identical approved choice and fingerprint after a failed response', async () => {
    setupResolutionReview();
    mocks.resolveOrganization.mockResolvedValueOnce({
      ok: false,
      code: 'SYNC_ERROR',
      message: 'Publication interrupted',
    });
    render(<Harness />);
    const button = await screen.findByTestId('entity-record-use-organization');
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByText(userMessage('account.failed'))).toBeVisible();
    const first = mocks.resolveOrganization.mock.calls[0][1];
    const retry = screen.getByTestId('entity-record-retry-organization-resolution');
    await waitFor(() => expect(retry).toBeEnabled());
    expect(screen.queryByTestId('entity-record-keep-saved')).not.toBeInTheDocument();
    expect(mocks.load).toHaveBeenCalledTimes(1);
    const next = resolvedFile('use_remote');
    mocks.load.mockResolvedValue(next);
    mocks.resolveOrganization.mockResolvedValueOnce({
      ok: true,
      entity: next.preview.entity,
      replayed: true,
    });
    mocks.syncStatus.mockResolvedValue(resolutionStatus('synced'));
    fireEvent.click(retry);
    expect(await savedView()).toBeVisible();
    expect(mocks.resolveOrganization.mock.calls[1]).toEqual(['organization', first]);
    expect(mocks.resolveOrganization).toHaveBeenCalledTimes(2);
  });

  it('retries the durable approved request after restart even when the initial file read refuses', async () => {
    setupResolutionReview();
    const approved: OrganizationRegistrySavedRecordResolutionRequest = {
      entityId: '10000000-0000-4000-8000-000000000001',
      resolutionId: '20000000-0000-4000-8000-000000000001',
      choice: 'keep_saved',
      sourceRevision: 'c'.repeat(64),
    };
    mocks.syncStatus.mockResolvedValue(resolutionStatus('publication_pending', approved));
    mocks.load.mockRejectedValueOnce(new Error('Saved file and projection disagree'));
    render(<Harness />);
    const retry = await screen.findByTestId('entity-record-retry-organization-resolution');
    await waitFor(() => expect(retry).toBeEnabled());
    expect(mocks.readOwner).toHaveBeenCalledWith('10000000-0000-4000-8000-000000000001');
    expect(mocks.readWorkspaceRoot).toHaveBeenCalledWith(7);
    expect(mocks.syncReview).not.toHaveBeenCalled();
    expect(screen.queryByTestId('entity-record-use-organization')).not.toBeInTheDocument();
    const next = resolvedFile('keep_saved');
    mocks.load.mockResolvedValue(next);
    mocks.resolveOrganization.mockResolvedValueOnce({
      ok: true,
      entity: next.preview.entity,
      replayed: true,
    });
    mocks.syncStatus.mockResolvedValue(resolutionStatus('queued'));
    fireEvent.click(retry);
    expect(await savedView()).toBeVisible();
    expect(mocks.resolveOrganization).toHaveBeenCalledWith('organization', approved);
  });

  it('blocks both choices over an unsaved draft and an interrupted ordinary Save', async () => {
    setupResolutionReview();
    mocks.update.mockRejectedValueOnce(new Error('Ordinary save interrupted'));
    render(<Harness />);
    const choice = await screen.findByTestId('entity-record-use-organization');
    await waitFor(() => expect(choice).toBeEnabled());
    fireEvent.change(await editName(), {
      target: { value: 'Unsaved draft' },
    });
    expect(choice).toBeDisabled();
    expect(screen.getByTestId('entity-record-keep-saved')).toBeDisabled();
    fireEvent.click(choice);
    expect(mocks.resolveOrganization).not.toHaveBeenCalled();
    fireEvent.click(saveControl());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      userMessage('document.saveUnconfirmed')
    );
    expect(choice).toBeDisabled();
    expect(screen.getByTestId('entity-record-keep-saved')).toBeDisabled();
    expect(mocks.resolveOrganization).not.toHaveBeenCalled();
  });

  it('refuses applying a choice in a reference home project', async () => {
    setupResolutionReview();
    mocks.folders[0].pinned = true;
    render(<Harness />);
    expect(await screen.findByTestId('entity-record-use-organization')).toBeDisabled();
    expect(screen.getByTestId('entity-record-keep-saved')).toBeDisabled();
    expect(mocks.resolveOrganization).not.toHaveBeenCalled();
  });

  it('refreshes a changed unapproved review without automatically choosing again', async () => {
    setupResolutionReview();
    mocks.resolveOrganization.mockResolvedValueOnce({
      ok: false,
      code: 'REVIEW_CHANGED',
      message: 'Review the changed versions again.',
    });
    render(<Harness />);
    const choice = await screen.findByTestId('entity-record-use-organization');
    await waitFor(() => expect(choice).toBeEnabled());
    mocks.syncReview.mockResolvedValue(resolutionReview('b'.repeat(64)));
    fireEvent.click(choice);
    await waitFor(() => expect(mocks.syncReview).toHaveBeenCalledTimes(2));
    expect(mocks.resolveOrganization).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByTestId('entity-record-retry-organization-resolution')
    ).not.toBeInTheDocument();
    const keep = await screen.findByTestId('entity-record-keep-saved');
    await waitFor(() => expect(keep).toBeEnabled());
    mocks.resolveOrganization.mockResolvedValueOnce({
      ok: false,
      code: 'SYNC_ERROR',
      message: 'Offline',
    });
    fireEvent.click(keep);
    await waitFor(() => expect(mocks.resolveOrganization).toHaveBeenCalledTimes(2));
    const [first, second] = mocks.resolveOrganization.mock.calls.map((call) => call[1]);
    expect(second).toMatchObject({ choice: 'keep_saved', sourceRevision: 'b'.repeat(64) });
    expect(second.resolutionId).not.toBe(first.resolutionId);
  });

  it('does not install or announce a late resolution result after the active account changes', async () => {
    setupResolutionReview();
    let finish!: (value: unknown) => void;
    mocks.resolveOrganization.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const view = render(<Harness />);
    const button = await screen.findByTestId('entity-record-use-organization');
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(mocks.resolveOrganization).toHaveBeenCalledTimes(1));
    mocks.accountId = 'different-account';
    mocks.syncStatus.mockResolvedValue({ ok: true, accountId: 'different-account', status: null });
    view.rerender(<Harness />);
    const loadsBeforeResult = mocks.load.mock.calls.length;
    await act(async () => {
      finish({ ok: true, entity: resolvedFile('use_remote').preview.entity, replayed: false });
    });
    expect(emitLimsRegistryChanged).toHaveBeenCalledTimes(1);
    expect(mocks.load).toHaveBeenCalledTimes(loadsBeforeResult + 1);
    expect(mocks.syncOrganization).not.toHaveBeenCalled();
    expect(
      currentSession().getSnapshot().saveConfirmed
        ? screen.getByTestId('entity-details-panel')
        : null
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('entity-record-organization-sync')).not.toBeInTheDocument();
  });

  it('keeps the exact approved Retry reachable from Registry Details without first opening the file tab', async () => {
    setupResolutionReview();
    const approved: OrganizationRegistrySavedRecordResolutionRequest = {
      entityId: '10000000-0000-4000-8000-000000000001',
      resolutionId: '20000000-0000-4000-8000-000000000002',
      choice: 'use_remote',
      sourceRevision: 'd'.repeat(64),
    };
    mocks.syncStatus.mockResolvedValue(resolutionStatus('publication_pending', approved));
    render(
      <RegistryPendingRecordResolution
        entityId="10000000-0000-4000-8000-000000000001"
        workspaceId={7}
        workspaceFolders={mocks.folders}
        actionBusy={false}
      />
    );
    const retry = await screen.findByTestId('registry-record-retry-organization-resolution');
    await waitFor(() => expect(retry).toBeEnabled());
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.syncReview).not.toHaveBeenCalled();
    const next = resolvedFile('use_remote');
    mocks.resolveOrganization.mockImplementationOnce(async () => {
      mocks.load.mockResolvedValue(next);
      mocks.syncStatus.mockResolvedValue(resolutionStatus('synced'));
      return { ok: true, entity: next.preview.entity, replayed: true };
    });
    fireEvent.click(retry);
    expect(await screen.findByText('Approved change saved on this device.')).toBeVisible();
    expect(mocks.resolveOrganization).toHaveBeenCalledWith('organization', approved);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(emitLimsRegistryChanged).toHaveBeenCalledTimes(1);
  });
});
