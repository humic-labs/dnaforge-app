import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userMessage } from '@waypoint/user-messages';
import { createTestDb } from '../../../main/__tests__/test-db';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { MentionExtension } from '../editor/extensions/mention';
import { useCanvasStore } from '../../canvas/public/store';
import {
  getRegistryPresentationForTest,
  observeRegistryPresentation,
  presentDocument,
  resetRegistryPresentationForTest,
} from '../../../test/fixtures/entity-reference-presentation';
import type { OpenDocumentRequest } from '../../document-opening/public/types';
import type { TabType } from '../../canvas/public/types';
import type { DocumentOpenResult } from '../../canvas/public/document-presentation';
import {
  beginTelemetryEpisode,
  __resetTelemetryCorrelationForTests,
} from '../../../lib/telemetry-correlation';
import { installEntityReferenceHandler } from './install-entity-reference-handler';
import {
  dispatchOpenExactCatalogEntity,
  dispatchOpenNativeEntityReference,
  openImportedProviderReference,
} from '../editor/native-entity-links';
import {
  sequenceDocumentKey,
  type CatalogSequenceDocumentRef,
} from '../../../shared/managed-sequence-document';
import { sanitizeClosedBetaProperties } from '../../../shared/analytics-allowlist';
import { sanitizeSdkEvent } from '@waypoint/analytics-policy';
import {
  CLOSED_BETA_EVENT_PROPERTIES,
  CLOSED_BETA_EVENT_VERSIONS,
} from '../../../shared/analytics-registry.generated';
import type { NativeCatalogDestination } from '../../../services/native-catalog-destination';

const state = vi.hoisted(() => ({
  ready: true,
  generation: 1,
  originId: '550e8400-e29b-41d4-a716-446655440003',
  accountId: '550e8400-e29b-41d4-a716-446655440006',
  captureThrows: false,
  events: [] as Array<{ event: string; properties: Record<string, unknown> }>,
  pages: {} as Record<string, unknown>,
  open: vi.fn<(request: OpenDocumentRequest) => Promise<DocumentOpenResult>>(),
  selected:
    vi.fn<
      (
        path: string,
        tabType: TabType,
        label?: string,
        signal?: AbortSignal
      ) => Promise<DocumentOpenResult>
    >(),
  native: vi.fn(),
  exact: vi.fn(),
  byUuid: vi.fn(),
  byHash: vi.fn(),
  sequence: vi.fn(),
  primer: vi.fn(),
  canonicalOligo: vi.fn(),
  canonicalEntity: vi.fn(),
  validate: vi.fn(),
  exists: vi.fn(),
  provider: vi.fn(),
  lims: vi.fn(),
  toast: vi.fn(),
  view: vi.fn(),
  fetchPage: vi.fn(),
  select: vi.fn(),
  projectRoot: vi.fn(),
}));

vi.mock('../../../lib/analytics', () => ({
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
  getAnalyticsIdentifiedAccountId: () => state.accountId,
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
vi.mock('../../../platform', () => ({
  platform: () => ({
    db: { select: state.select },
    fs: { validateWorkspacePath: state.validate, exists: state.exists, readTextFileSlice: vi.fn() },
    benchlingMigration: { resolveProviderReference: state.provider },
    lims: { queryEntities: state.canonicalEntity },
  }),
}));
vi.mock('../../../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: state.toast }) },
}));
vi.mock('../store', () => ({
  usePageStore: { getState: () => ({ pages: state.pages, fetchPage: state.fetchPage }) },
}));
vi.mock('../../../db', () => ({ getSequenceWithPath: state.sequence }));
vi.mock('../../../db/workspace-catalog', () => ({
  resolveWorkspaceScope: async (root: string) => (root.endsWith('BETA') ? 'beta' : 'alpha'),
}));
vi.mock('../../../db/resolve-by-object-uuid', () => ({ resolveFileByObjectUuid: state.byUuid }));
vi.mock('../../../db/resolve-by-content-hash', () => ({ resolveFileByContentHash: state.byHash }));
vi.mock('../../primers/public/primer-references', () => ({
  getCanonicalOligoEntity: state.canonicalOligo,
}));

vi.mock('../../../db/project-roots', () => ({ resolveProjectRoot: state.projectRoot }));
vi.mock('../../../db/primer-reference-search', () => ({
  findPrimerRegistryEntityId: state.primer,
}));
vi.mock('../../../services/native-catalog-destination', () => ({
  resolveNativeCatalogDestination: state.native,
  resolveExactNativeCatalogDestination: state.exact,
}));
vi.mock('../../../services/legacy-migration-sequence-destination', () => ({
  resolveMigrationSequenceDestinationPath: async ({ indexedPath }: { indexedPath: string }) =>
    indexedPath,
}));
vi.mock('../../../services/workspace-reconcile-lifecycle', () => ({
  waitForWorkspaceReconcileIdle: async () => {},
}));
vi.mock('../../sequence/public/sequence-package-product', () => ({
  resolveSequencePackageRootForProductPath: async () => null,
}));
vi.mock('../../document-opening/public/open-document', () => ({ openDocument: state.open }));
vi.mock('../../document-opening/public/open-selected-document', () => ({
  openSelectedDocument: state.selected,
}));
vi.mock('../../lims/public/open-entity', () => ({
  openLimsEntity: state.lims,
  isLimsEntityOpened: (result: { status: string }) => result.status.startsWith('opened'),
}));

let remove: (() => void) | undefined;
const roots = [{ path: '/PRIVATE_ALPHA' }, { path: '/PRIVATE_BETA' }];
const emit = (detail: object) =>
  window.dispatchEvent(new CustomEvent('waypoint:open-entity', { detail }));
const actions = () => state.events.filter(({ event }) => event === 'workflow_action_observed');
function expectJoined(outcome: string) {
  const events = actions();
  expect(events).toHaveLength(2);
  expect(events[0].properties).toMatchObject({ action_phase: 'start', workflow_action: 'link' });
  expect(events[1].properties).toMatchObject({
    action_id: events[0].properties.action_id,
    outcome_kind: outcome,
  });
  expect(JSON.stringify(events)).not.toContain('PRIVATE_');
  expect(state.events).toHaveLength(2);
}
function nativeTarget(locator: NativeCatalogDestination['locator']): NativeCatalogDestination {
  return {
    source: 'native_catalog',
    rawId: 'PRIVATE_RAW',
    entityId: 'beta::PRIVATE_NATIVE',
    title: 'PRIVATE_TITLE',
    entityType: 'file',
    locator,
  };
}

function ReferenceChipHarness() {
  const editor = useEditor({
    extensions: [
      StarterKit,
      MentionExtension.configure({
        referenceWorkspaceRoot: () => '/PRIVATE_BETA',
        onCreatePage: null,
        onMentionClick: (detail) => {
          window.dispatchEvent(new CustomEvent('waypoint:open-entity', { detail }));
        },
      }),
    ],
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'mention',
              attrs: {
                entityType: 'page',
                entityId: 'PRIVATE_NOTE',
                label: 'PRIVATE_CHIP_LABEL',
                path: null,
                objectUuid: null,
                contentHash: null,
              },
            },
          ],
        },
      ],
    },
  });
  return <EditorContent editor={editor} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.ready = true;
  state.generation = 1;
  state.events = [];
  state.pages = {};
  state.select.mockResolvedValue([]);
  state.originId = '550e8400-e29b-41d4-a716-446655440003';
  state.accountId = '550e8400-e29b-41d4-a716-446655440006';
  state.captureThrows = false;
  __resetTelemetryCorrelationForTests();
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    oversizeScanComplete: true,
  });
  resetRegistryPresentationForTest();
  state.byUuid.mockResolvedValue(null);
  state.byHash.mockResolvedValue(null);
  state.projectRoot.mockResolvedValue(null);
  state.native.mockResolvedValue(null);
  state.exact.mockResolvedValue(null);
  state.sequence.mockResolvedValue(null);
  state.primer.mockResolvedValue(null);
  state.canonicalOligo.mockReset();
  state.fetchPage.mockImplementation(async (id: string) => state.pages[id] ?? null);
  state.validate.mockResolvedValue(true);
  state.exists.mockResolvedValue(true);
  state.open.mockImplementation(async (request: OpenDocumentRequest) => {
    if (request.target.kind === 'record')
      return presentDocument(
        {
          type: request.target.tabType,
          entityId: request.target.entityId,
          label: request.label ?? 'PRIVATE_LABEL',
        },
        request.placement,
        'ready'
      );
    if (request.target.kind === 'file') {
      if (request.target.tabType === 'sequence') {
        const sequenceDocument: CatalogSequenceDocumentRef = {
          kind: 'catalog-sequence',
          entityId: request.target.path.includes('PRIVATE_BETA')
            ? 'PRIVATE_SEQUENCE_BETA'
            : 'PRIVATE_SEQUENCE_ALPHA',
        };
        return presentDocument(
          {
            type: 'sequence',
            entityId: sequenceDocumentKey(sequenceDocument),
            sequenceDocument,
            label: request.label ?? 'PRIVATE_LABEL',
          },
          request.placement,
          'ready'
        );
      }
      return presentDocument(
        {
          type: request.target.tabType ?? 'text',
          entityId: request.target.path,
          label: request.label ?? 'PRIVATE_LABEL',
        },
        request.placement,
        'ready'
      );
    }
    throw new Error('unexpected test destination');
  });
  state.selected.mockImplementation((path, tabType, label, signal) =>
    state.open({ target: { kind: 'file', path, tabType }, label, signal })
  );
  remove = installEntityReferenceHandler({ folders: roots, handleViewChange: state.view });
});
afterEach(() => {
  remove?.();
  remove = undefined;
});

describe('joined notebook reference dispositions', () => {
  it('opens the intended sibling page in the second root and reports its accepted destination', async () => {
    state.pages = { 'alpha::PRIVATE_NOTE': {}, 'beta::PRIVATE_NOTE': {} };
    emit({
      entityType: 'page',
      entityId: 'PRIVATE_NOTE',
      label: 'PRIVATE_LABEL',
      owningRoot: '/PRIVATE_BETA',
    });
    await waitFor(() =>
      expect(useCanvasStore.getState().panels.main.tabs[0]?.entityId).toBe('beta::PRIVATE_NOTE')
    );
    expectJoined('reference_page_presented');
  });

  it('distinguishes focusing the intended existing page from presenting a new one', async () => {
    state.pages = { 'beta::PRIVATE_NOTE': {} };
    presentDocument({ type: 'page', entityId: 'beta::PRIVATE_NOTE', label: 'PRIVATE_LABEL' });
    emit({ entityType: 'page', entityId: 'PRIVATE_NOTE', owningRoot: '/PRIVATE_BETA' });
    await waitFor(() => expect(state.open).toHaveBeenCalledOnce());
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(1);
    expectJoined('reference_page_focused');
  });

  it('retains the owning root when a durable identity resolves to a moved sequence', async () => {
    state.byUuid.mockResolvedValue({ absolutePath: '/PRIVATE_BETA/moved.gb' });
    emit({
      entityType: 'sequence',
      entityId: 'PRIVATE_ID',
      objectUuid: 'PRIVATE_UUID',
      owningRoot: '/PRIVATE_BETA',
    });
    await waitFor(() => expect(state.open).toHaveBeenCalledOnce());
    expect(state.byUuid).toHaveBeenCalledWith('PRIVATE_UUID', '/PRIVATE_BETA');
    expect(state.open).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'file', path: '/PRIVATE_BETA/moved.gb', tabType: 'sequence' },
      })
    );
    expectJoined('reference_file_presented');
  });

  it('opens a link inside its own project even when that project is closed and the notebook lives elsewhere', async () => {
    state.projectRoot.mockResolvedValue('/PRIVATE_GAMMA');
    emit({
      entityType: 'structure',
      entityId: 'PRIVATE_STRUCTURE',
      path: 'structures/1BNA.pdb',
      projectId: 'gamma',
      owningRoot: '/PRIVATE_BETA',
    });
    await waitFor(() => expect(state.open).toHaveBeenCalledOnce());
    expect(state.projectRoot).toHaveBeenCalledWith('gamma');
    expect(state.validate).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: '/PRIVATE_GAMMA' })
    );
    expect(state.open).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          kind: 'file',
          path: '/PRIVATE_GAMMA/structures/1BNA.pdb',
        }),
      })
    );
  });

  it('falls back to the notebook project when the linked project is no longer on this machine', async () => {
    emit({
      entityType: 'structure',
      entityId: 'PRIVATE_STRUCTURE',
      path: 'structures/1BNA.pdb',
      projectId: 'PRIVATE_GONE',
      owningRoot: '/PRIVATE_BETA',
    });
    await waitFor(() => expect(state.open).toHaveBeenCalledOnce());
    expect(state.open).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ path: '/PRIVATE_BETA/structures/1BNA.pdb' }),
      })
    );
  });

  it('keeps one gesture identity through durable-id and fingerprint redispatch to a portable path', async () => {
    emit({
      entityType: 'sequence',
      entityId: 'PRIVATE_ID',
      objectUuid: 'PRIVATE_UUID',
      contentHash: 'PRIVATE_HASH',
      path: 'sequences/PRIVATE_NOTE.gb',
      owningRoot: '/PRIVATE_BETA',
    });
    await waitFor(() => expect(state.open).toHaveBeenCalledOnce());
    expect(state.byHash).toHaveBeenCalledWith('PRIVATE_HASH', '/PRIVATE_BETA');
    expectJoined('reference_file_presented');
  });

  it('reports an actionable absent registry sequence without opening a placeholder', async () => {
    emit({ entityType: 'sequence', entityId: 'seq_17', label: 'PRIVATE_LABEL' });
    await waitFor(() => expect(state.sequence).toHaveBeenCalledWith(17));
    await Promise.resolve();
    expect(state.open).not.toHaveBeenCalled();
    expectJoined('reference_target_missing');
    expect(state.toast).toHaveBeenCalled();
  });

  it('attributes a supported external-provider request separately from a native presentation', async () => {
    state.provider.mockResolvedValue({
      resolution: { status: 'pending', reason: 'target_not_imported' },
      target: null,
    });
    const fallback = vi.fn();
    await expect(
      openImportedProviderReference({
        stableObjectId: 'seq_PRIVATE',
        objectClass: 'sequence',
        href: 'https://benchling.com/s/seq_PRIVATE/edit',
        label: 'PRIVATE_LABEL',
        owningRoot: '/PRIVATE_BETA',
        openFallbackUrl: fallback,
      })
    ).resolves.toBe('external');
    expect(fallback).toHaveBeenCalledOnce();
    expectJoined('reference_provider_requested');
    expect(actions()[1].properties).toMatchObject({
      workflow_status: 'needs_action',
      usable_result: false,
      value_delivered: false,
    });
  });

  it('accepts a valid nonsequence destination without requiring a sequence-open event', async () => {
    state.exact.mockResolvedValue(
      nativeTarget({
        kind: 'workspace_path',
        absolutePath: '/PRIVATE_BETA/PRIVATE_PROTEIN.faa',
        relativePath: 'PRIVATE_PROTEIN.faa',
        tabType: 'protein',
      })
    );
    emit({
      entityType: 'native-catalog-exact',
      entityId: 'beta::PRIVATE_NATIVE',
      owningRoot: '/PRIVATE_BETA',
    });
    await waitFor(() => expect(state.selected).toHaveBeenCalledOnce());
    expect(state.exact).toHaveBeenCalledWith({
      workspaceRoot: '/PRIVATE_BETA',
      entityId: 'beta::PRIVATE_NATIVE',
    });
    expect(useCanvasStore.getState().panels.main.tabs[0]?.type).toBe('protein');
    expectJoined('reference_document_presented');
  });

  it('returns the exact catalog result from the installed owner without another open activity', async () => {
    state.exact.mockResolvedValue(
      nativeTarget({
        kind: 'workspace_path',
        absolutePath: '/PRIVATE_BETA/PRIVATE_PROTEIN.faa',
        relativePath: 'PRIVATE_PROTEIN.faa',
        tabType: 'protein',
      })
    );
    const onResult = vi.fn();
    const accepted = dispatchOpenExactCatalogEntity({
      entityId: 'beta::PRIVATE_NATIVE',
      label: 'PRIVATE_TITLE',
      owningRoot: '/PRIVATE_BETA',
      onResult,
    });
    await waitFor(() => expect(state.selected).toHaveBeenCalledOnce());
    expect(accepted).toBe(true);
    expect(onResult).toHaveBeenCalledExactlyOnceWith({
      kind: 'document',
      result: expect.objectContaining({
        status: 'presented',
        content: 'ready',
        tabType: 'protein',
      }),
    });
    expect(state.events).toHaveLength(0);
  });

  it('does not equate a different page tab with the intended page result', async () => {
    state.pages = { 'beta::PRIVATE_NOTE': {} };
    state.open.mockImplementationOnce(async () =>
      presentDocument(
        { type: 'page', entityId: 'alpha::PRIVATE_OTHER', label: 'PRIVATE_OTHER' },
        undefined,
        'ready'
      )
    );
    emit({ entityType: 'page', entityId: 'PRIVATE_NOTE', owningRoot: '/PRIVATE_BETA' });
    await waitFor(() => expect(state.open).toHaveBeenCalledOnce());
    expectJoined('reference_target_mismatch');
    expect(actions()[1].properties.success).toBe(false);
    expect(state.toast).toHaveBeenCalled();
  });

  it('opens the persisted notebook in its mounted project when only another project has a cached copy', async () => {
    const db = createTestDb();
    try {
      db.exec('CREATE TABLE pages (id TEXT PRIMARY KEY)');
      db.prepare('INSERT INTO pages (id) VALUES (?)').run('beta::source');
      state.select.mockImplementation(async (sql: string, ids: string[]) =>
        db.prepare(sql).all(...ids)
      );
      state.pages = { 'alpha::source': {} };
      emit({ entityType: 'page', entityId: 'beta::source', owningRoot: '/PRIVATE_BETA' });
      await waitFor(() => expect(state.open).toHaveBeenCalledOnce());
      expect(state.open.mock.calls[0][0].target).toEqual({
        kind: 'record',
        tabType: 'page',
        entityId: 'beta::source',
      });
    } finally {
      db.close();
    }
  });

  it('refuses an ambiguous portable page across the two mounted roots', async () => {
    state.pages = { 'alpha::PRIVATE_NOTE': {}, 'beta::PRIVATE_NOTE': {} };
    emit({ entityType: 'page', entityId: 'PRIVATE_NOTE' });
    await waitFor(() => expect(state.toast).toHaveBeenCalledOnce());
    expect(state.open).not.toHaveBeenCalled();
    expectJoined('reference_ambiguous');
  });

  it('refuses an ownerless native catalog intent instead of selecting the first mounted root', async () => {
    dispatchOpenNativeEntityReference({
      entityId: 'beta::PRIVATE_NATIVE',
      label: 'PRIVATE_LABEL',
      owningRoot: null,
    });
    expect(state.native).not.toHaveBeenCalled();
    expectJoined('reference_missing_owner');
    expect(state.toast).toHaveBeenCalled();
  });

  it('requires a real notebook before presenting a native catalog page', async () => {
    state.native.mockResolvedValue(
      nativeTarget({ kind: 'workspace_page', pageId: 'beta::PRIVATE_ABSENT' })
    );
    dispatchOpenNativeEntityReference({
      entityId: 'beta::PRIVATE_NATIVE',
      label: 'PRIVATE_LABEL',
      owningRoot: '/PRIVATE_BETA',
    });
    await waitFor(() => expect(state.fetchPage).toHaveBeenCalledWith('beta::PRIVATE_ABSENT'));
    expect(state.open).not.toHaveBeenCalled();
    expectJoined('reference_target_missing');
  });

  it('waits for an actual Registry result rather than completing at request queueing', async () => {
    state.native.mockResolvedValue(
      nativeTarget({ kind: 'lims_entity', entityId: 'PRIVATE_REGISTRY_ENTITY' })
    );
    state.lims.mockResolvedValue({
      status: 'unsupported',
      message: 'native record',
      target: { kind: 'record_detail', entityId: 'PRIVATE_REGISTRY_ENTITY' },
    });
    dispatchOpenNativeEntityReference({
      entityId: 'beta::PRIVATE_NATIVE',
      label: 'PRIVATE_LABEL',
      owningRoot: '/PRIVATE_BETA',
    });
    await waitFor(() =>
      expect(getRegistryPresentationForTest()?.entityId).toBe('PRIVATE_REGISTRY_ENTITY')
    );
    expect(actions()).toHaveLength(1);
    const request = getRegistryPresentationForTest();
    if (!request) throw new Error('expected a queued Registry request');
    observeRegistryPresentation(request, { kind: 'record', entityId: 'PRIVATE_REGISTRY_ENTITY' });
    observeRegistryPresentation(request, { kind: 'missing' });
    expectJoined('reference_registry_presented');
  });

  it('validates a whole-entity target before requesting its exact Registry presentation', async () => {
    state.canonicalEntity.mockResolvedValue([
      { id: 'PRIVATE_CANONICAL', name: 'PRIVATE_ENTITY', archivedAt: null, tombstone: false },
    ]);
    state.lims.mockResolvedValue({ status: 'unsupported', message: 'record detail' });
    emit({ entityType: 'registry-entity', entityId: 'PRIVATE_CANONICAL' });
    await waitFor(() =>
      expect(getRegistryPresentationForTest()?.entityId).toBe('PRIVATE_CANONICAL')
    );
    expect(state.canonicalEntity).toHaveBeenCalledWith({
      id: 'PRIVATE_CANONICAL',
      includeArchived: true,
      limit: 1,
    });
    expect(state.lims).toHaveBeenCalledWith({
      entityId: 'PRIVATE_CANONICAL',
      strategy: { kind: 'focused' },
    });
    const request = getRegistryPresentationForTest();
    if (!request) throw new Error('expected an exact canonical Registry request');
    observeRegistryPresentation(request, { kind: 'record', entityId: 'PRIVATE_CANONICAL' });
    expectJoined('reference_registry_presented');
  });

  it.each([
    { message: 'PRIVATE_PROVIDER_ERROR', expected: userMessage('reference.recordNotFound') },
    { message: userMessage('file.notFound'), expected: userMessage('reference.recordNotFound') },
  ])(
    'normalizes Registry failure messages at the reference boundary ($message)',
    async ({ message, expected }) => {
      state.canonicalEntity.mockResolvedValue([
        { id: 'PRIVATE_CANONICAL', name: 'PRIVATE_ENTITY', archivedAt: null, tombstone: false },
      ]);
      state.lims.mockResolvedValue({ status: 'not_found', message });
      emit({ entityType: 'registry-entity', entityId: 'PRIVATE_CANONICAL' });
      await waitFor(() => expect(state.toast).toHaveBeenCalledOnce());
      expect(state.toast).toHaveBeenCalledWith(expected, { definition: 'document-open-refused' });
      expect(JSON.stringify(state.toast.mock.calls)).not.toContain('PRIVATE_PROVIDER_ERROR');
      expect(getRegistryPresentationForTest()).toBeNull();
      expectJoined('reference_target_missing');
    }
  );

  it.each([
    { entities: [] },
    { entities: [{ id: 'PRIVATE_CANONICAL', archivedAt: '2026-10-27', tombstone: false }] },
    { entities: [{ id: 'PRIVATE_CANONICAL', archivedAt: null, tombstone: true }] },
  ])('refuses unavailable whole-entity targets without a fallback search', async ({ entities }) => {
    state.canonicalEntity.mockResolvedValue(entities);
    emit({ entityType: 'registry-entity', entityId: 'PRIVATE_CANONICAL' });
    await waitFor(() => expect(state.toast).toHaveBeenCalled());
    expect(state.lims).not.toHaveBeenCalled();
    expect(getRegistryPresentationForTest()).toBeNull();
    expectJoined('reference_target_missing');
  });

  it('presents a canonical standalone oligo as the exact Registry record', async () => {
    state.canonicalOligo.mockResolvedValue({ id: 'PRIVATE_CANONICAL', name: 'PRIVATE_OLIGO' });
    emit({ entityType: 'registry-oligo', entityId: 'PRIVATE_CANONICAL' });
    await waitFor(() =>
      expect(getRegistryPresentationForTest()?.entityId).toBe('PRIVATE_CANONICAL')
    );
    const request = getRegistryPresentationForTest();
    if (!request) throw new Error('expected an exact canonical Registry request');
    observeRegistryPresentation(request, { kind: 'record', entityId: 'PRIVATE_CANONICAL' });
    expectJoined('reference_registry_presented');
    expect(state.primer).not.toHaveBeenCalled();
  });

  it('refuses an unavailable canonical oligo without falling back to a Registry search', async () => {
    state.canonicalOligo.mockRejectedValue(new Error('The canonical oligo is unavailable'));
    emit({ entityType: 'registry-oligo', entityId: 'PRIVATE_MISSING' });
    await waitFor(() => expect(state.toast).toHaveBeenCalled());
    expect(getRegistryPresentationForTest()).toBeNull();
    expectJoined('reference_target_missing');
  });

  it('keeps the intentional legacy primer Registry search distinct from a resolved record', async () => {
    emit({ entityType: 'primer', entityId: 'PRIVATE_PRIMER', label: 'PRIVATE_LABEL' });
    await waitFor(() => expect(getRegistryPresentationForTest()?.entityId).toBeNull());
    const request = getRegistryPresentationForTest();
    if (!request) throw new Error('expected a queued Registry search');
    observeRegistryPresentation(request, { kind: 'search' });
    expectJoined('reference_registry_search');
    expect(actions()[1].properties).toMatchObject({
      workflow_status: 'needs_action',
      usable_result: false,
    });
  });

  it.each(['missing', 'mismatch'] as const)(
    'keeps a Registry %s result outside successful presentation',
    async (kind) => {
      state.primer.mockResolvedValue('PRIVATE_REGISTRY_ENTITY');
      emit({ entityType: 'primer', entityId: 'PRIVATE_PRIMER', label: 'PRIVATE_LABEL' });
      await waitFor(() => expect(getRegistryPresentationForTest()).not.toBeNull());
      const request = getRegistryPresentationForTest();
      if (!request) throw new Error('expected a Registry request');
      observeRegistryPresentation(request, { kind });
      expectJoined(kind === 'missing' ? 'reference_target_missing' : 'reference_target_mismatch');
    }
  );

  it('preserves one identity from provider resolution into the native destination', async () => {
    state.provider.mockResolvedValue({
      resolution: { status: 'resolved', entityId: 'beta::PRIVATE_NATIVE' },
      target: null,
    });
    state.pages = { 'beta::PRIVATE_NOTE': {} };
    state.native.mockResolvedValue(
      nativeTarget({ kind: 'workspace_page', pageId: 'beta::PRIVATE_NOTE' })
    );
    await expect(
      openImportedProviderReference({
        stableObjectId: 'seq_PRIVATE',
        objectClass: 'sequence',
        href: 'https://benchling.com/s/seq_PRIVATE/edit',
        label: 'PRIVATE_LABEL',
        owningRoot: '/PRIVATE_BETA',
      })
    ).resolves.toBe('native');
    await waitFor(() => expect(state.open).toHaveBeenCalledOnce());
    expectJoined('reference_page_presented');
  });

  it('does not open an unsafe provider fallback or call it a native success', async () => {
    state.provider.mockRejectedValue(new Error('PRIVATE_PROVIDER_FAILURE'));
    const fallback = vi.fn();
    await expect(
      openImportedProviderReference({
        stableObjectId: 'seq_PRIVATE',
        objectClass: 'sequence',
        href: 'https://invalid.example/PRIVATE_URL',
        label: 'PRIVATE_LABEL',
        owningRoot: '/PRIVATE_BETA',
        openFallbackUrl: fallback,
      })
    ).resolves.toBe('none');
    expect(fallback).not.toHaveBeenCalled();
    expectJoined('reference_provider_unavailable');
  });

  it('retains the original external-request exception without exporting its message', async () => {
    state.provider.mockRejectedValue(new Error('PRIVATE_LOOKUP_FAILURE'));
    const error = new Error('PRIVATE_EXTERNAL_FAILURE');
    await expect(
      openImportedProviderReference({
        stableObjectId: 'seq_PRIVATE',
        objectClass: 'sequence',
        href: 'https://benchling.com/s/seq_PRIVATE/edit',
        label: 'PRIVATE_LABEL',
        owningRoot: '/PRIVATE_BETA',
        openFallbackUrl: () => {
          throw error;
        },
      })
    ).rejects.toBe(error);
    expectJoined('reference_open_failed');
  });

  it.each(['generation', 'episode', 'origin', 'account', 'opt-out'] as const)(
    'drops a late result after %s retirement while preserving the reference action',
    async (kind) => {
      let finish!: (value: { absolutePath: string }) => void;
      state.byUuid.mockReturnValueOnce(
        new Promise<{ absolutePath: string }>((resolve) => {
          finish = resolve;
        })
      );
      emit({
        entityType: 'sequence',
        entityId: 'PRIVATE_ID',
        objectUuid: 'PRIVATE_UUID',
        owningRoot: '/PRIVATE_BETA',
      });
      await waitFor(() => expect(state.byUuid).toHaveBeenCalledOnce());
      if (kind === 'generation') state.generation += 1;
      else if (kind === 'episode') beginTelemetryEpisode();
      else if (kind === 'origin') state.originId = '550e8400-e29b-41d4-a716-446655440007';
      else if (kind === 'account') state.accountId = '550e8400-e29b-41d4-a716-446655440008';
      else state.ready = false;
      finish({ absolutePath: '/PRIVATE_BETA/PRIVATE_SEQUENCE.gb' });
      await waitFor(() => expect(state.open).toHaveBeenCalledOnce());
      expect(actions()).toHaveLength(1);
    }
  );

  it('does not backfill a gesture initiated before optional capture became available', async () => {
    state.ready = false;
    let finish!: (value: { absolutePath: string }) => void;
    state.byUuid.mockReturnValueOnce(
      new Promise<{ absolutePath: string }>((resolve) => {
        finish = resolve;
      })
    );
    emit({
      entityType: 'sequence',
      entityId: 'PRIVATE_ID',
      objectUuid: 'PRIVATE_UUID',
      owningRoot: '/PRIVATE_BETA',
    });
    state.ready = true;
    finish({ absolutePath: '/PRIVATE_BETA/PRIVATE_SEQUENCE.gb' });
    await waitFor(() => expect(state.open).toHaveBeenCalledOnce());
    expect(state.events).toEqual([]);
  });

  it('keeps a throwing optional observer outside reference behavior', async () => {
    state.captureThrows = true;
    state.pages = { 'beta::PRIVATE_NOTE': {} };
    emit({ entityType: 'page', entityId: 'PRIVATE_NOTE', owningRoot: '/PRIVATE_BETA' });
    await waitFor(() =>
      expect(useCanvasStore.getState().panels.main.tabs[0]?.entityId).toBe('beta::PRIVATE_NOTE')
    );
    expect(state.events).toEqual([]);
  });

  it('cancels an owned intent on receiver removal without a late unintended presentation', async () => {
    let finish!: (value: { absolutePath: string }) => void;
    state.byUuid.mockReturnValueOnce(
      new Promise<{ absolutePath: string }>((resolve) => {
        finish = resolve;
      })
    );
    emit({
      entityType: 'sequence',
      entityId: 'PRIVATE_ID',
      objectUuid: 'PRIVATE_UUID',
      owningRoot: '/PRIVATE_BETA',
    });
    remove?.();
    remove = undefined;
    finish({ absolutePath: '/PRIVATE_BETA/PRIVATE_SEQUENCE.gb' });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.open).not.toHaveBeenCalled();
    expectJoined('reference_cancelled');
  });

  it('refuses physical containment failure after durable resolution', async () => {
    state.byUuid.mockResolvedValue({ absolutePath: '/PRIVATE_BETA/PRIVATE_ESCAPE.gb' });
    state.validate.mockResolvedValue(false);
    emit({
      entityType: 'sequence',
      entityId: 'PRIVATE_ID',
      objectUuid: 'PRIVATE_UUID',
      owningRoot: '/PRIVATE_BETA',
    });
    await waitFor(() => expect(state.toast).toHaveBeenCalledOnce());
    expect(state.open).not.toHaveBeenCalled();
    expectJoined('reference_refused');
  });

  it('refuses a traversing path before attempting file presentation', () => {
    emit({ entityType: 'sequence', path: '../PRIVATE_ESCAPE.gb', owningRoot: '/PRIVATE_BETA' });
    expect(state.open).not.toHaveBeenCalled();
    expect(state.validate).not.toHaveBeenCalled();
    expectJoined('reference_refused');
  });

  it('retains ambiguity refusal for duplicate portable files without an owner', async () => {
    emit({ entityType: 'sequence', entityId: 'sequences/PRIVATE_FILE.gb' });
    await waitFor(() => expect(state.toast).toHaveBeenCalledOnce());
    expect(state.open).not.toHaveBeenCalled();
    expectJoined('reference_ambiguous');
  });

  it('uses a unique portable match in the second root without inventing an owner', async () => {
    state.exists.mockImplementation(async (path: string) => path.includes('PRIVATE_BETA'));
    emit({ entityType: 'sequence', entityId: 'sequences/PRIVATE_FILE.gb' });
    await waitFor(() => expect(state.open).toHaveBeenCalledOnce());
    expectJoined('reference_file_presented');
    expect(useCanvasStore.getState().panels.main.tabs[0]?.sequenceDocument).toEqual({
      kind: 'catalog-sequence',
      entityId: 'PRIVATE_SEQUENCE_BETA',
    });
  });

  it('keeps new gestures independent even when a dispatcher reuses the same detail object', async () => {
    state.pages = { 'beta::PRIVATE_NOTE': {} };
    const detail = { entityType: 'page', entityId: 'PRIVATE_NOTE', owningRoot: '/PRIVATE_BETA' };
    emit(detail);
    await waitFor(() => expect(actions()).toHaveLength(2));
    emit(detail);
    await waitFor(() => expect(actions()).toHaveLength(4));
    const starts = actions().filter(({ properties }) => properties.action_phase === 'start');
    expect(starts[0].properties.action_id).not.toBe(starts[1].properties.action_id);
    expect(actions()[3].properties.outcome_kind).toBe('reference_page_focused');
  });

  it('accepts one receiver authority when the same event reaches two installed listeners', async () => {
    const second = installEntityReferenceHandler({ folders: roots, handleViewChange: state.view });
    try {
      state.pages = { 'beta::PRIVATE_NOTE': {} };
      emit({ entityType: 'page', entityId: 'PRIVATE_NOTE', owningRoot: '/PRIVATE_BETA' });
      await waitFor(() => expect(actions()).toHaveLength(2));
      expect(state.open).toHaveBeenCalledOnce();
      expectJoined('reference_page_presented');
    } finally {
      second();
    }
  });

  it('retains opaque joins through both actual pure sanitizers', async () => {
    state.pages = { 'beta::PRIVATE_NOTE': {} };
    emit({
      entityType: 'page',
      entityId: 'PRIVATE_NOTE',
      label: 'PRIVATE_BODY_TITLE',
      owningRoot: '/PRIVATE_BETA',
    });
    await waitFor(() => expect(actions()).toHaveLength(2));
    expectJoined('reference_page_presented');
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
      expect(wire?.properties).toMatchObject(properties);
    }
  });

  it.each(['loading', 'missing', 'error'] as const)(
    'keeps a %s presentation distinct from usable content',
    async (content) => {
      const normal = state.open.getMockImplementation();
      if (!normal) throw new Error('expected the normal test document port');
      state.open.mockImplementationOnce(async (request) => {
        const result = await normal(request);
        return result.status === 'presented' ? { ...result, content } : result;
      });
      state.byUuid.mockResolvedValue({ absolutePath: '/PRIVATE_BETA/PRIVATE_SEQUENCE.gb' });
      emit({
        entityType: 'sequence',
        entityId: 'PRIVATE_ID',
        objectUuid: 'PRIVATE_UUID',
        owningRoot: '/PRIVATE_BETA',
      });
      await waitFor(() => expect(actions()).toHaveLength(2));
      expectJoined(
        content === 'loading'
          ? 'reference_file_presented'
          : content === 'missing'
            ? 'reference_target_missing'
            : 'reference_open_failed'
      );
      if (content === 'loading')
        expect(actions()[1].properties).toMatchObject({
          workflow_status: 'needs_action',
          usable_result: false,
          value_delivered: false,
        });
      else expect(actions()[1].properties.success).toBe(false);
    }
  );

  it.each([null, [], { entityType: 'page', entityId: 17 }])(
    'bounds malformed incoming detail without presenting it: %j',
    (detail) => {
      window.dispatchEvent(new CustomEvent('waypoint:open-entity', { detail }));
      expect(state.open).not.toHaveBeenCalled();
      expectJoined('reference_unsupported');
      expect(state.toast).toHaveBeenCalledOnce();
    }
  );

  it('keeps a failed sequence-row lookup actionable and its private error off the wire', async () => {
    state.sequence.mockRejectedValueOnce(new Error('PRIVATE_DATABASE_FAILURE'));
    emit({ entityType: 'sequence', entityId: 'seq_17', label: 'PRIVATE_LABEL' });
    await waitFor(() => expect(actions()).toHaveLength(2));
    expect(state.open).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledOnce();
    expectJoined('reference_open_failed');
  });

  it('accepts a supported protein record from its actual LIMS opener destination', async () => {
    state.native.mockResolvedValue(
      nativeTarget({ kind: 'lims_entity', entityId: 'PRIVATE_PROTEIN_ENTITY' })
    );
    state.lims.mockImplementationOnce(async () => {
      const result = presentDocument(
        { type: 'protein', entityId: 'PRIVATE_PROTEIN_ENTITY', label: 'PRIVATE_LABEL' },
        undefined,
        'ready'
      );
      if (result.status !== 'presented') throw new Error('expected a real canvas presentation');
      return {
        status: 'opened_protein',
        tabId: result.tabId,
        target: { kind: 'protein_sequence', entityId: 'PRIVATE_PROTEIN_ENTITY' },
      };
    });
    dispatchOpenNativeEntityReference({
      entityId: 'beta::PRIVATE_NATIVE',
      label: 'PRIVATE_LABEL',
      owningRoot: '/PRIVATE_BETA',
    });
    await waitFor(() => expect(actions()).toHaveLength(2));
    expect(useCanvasStore.getState().panels.main.tabs[0]?.entityId).toBe('PRIVATE_PROTEIN_ENTITY');
    expectJoined('reference_document_presented');
  });

  it('keeps a late file destination inside the existing abort boundary', async () => {
    let finish!: () => void;
    state.byUuid.mockResolvedValue({ absolutePath: '/PRIVATE_BETA/PRIVATE_SEQUENCE.gb' });
    state.open.mockImplementationOnce(async (request) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      expect(request.signal?.aborted).toBe(true);
      return { status: 'cancelled', reason: 'cancelled' };
    });
    emit({
      entityType: 'sequence',
      entityId: 'PRIVATE_ID',
      objectUuid: 'PRIVATE_UUID',
      owningRoot: '/PRIVATE_BETA',
    });
    await waitFor(() => expect(state.open).toHaveBeenCalledOnce());
    remove?.();
    remove = undefined;
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
    expectJoined('reference_cancelled');
  });

  it('joins one real notebook chip gesture to its intended document through the installed receiver', async () => {
    state.pages = { 'alpha::PRIVATE_NOTE': {}, 'beta::PRIVATE_NOTE': {} };
    const { container } = render(<ReferenceChipHarness />);
    const chip = await waitFor(() => {
      const candidate = container.querySelector('[data-testid="mention-chip"]');
      if (!(candidate instanceof HTMLElement)) throw new Error('expected the real notebook chip');
      return candidate;
    });
    fireEvent.click(chip);
    await waitFor(() => expect(actions()).toHaveLength(2));
    expect(state.open).toHaveBeenCalledOnce();
    expect(useCanvasStore.getState().panels.main.tabs[0]?.entityId).toBe('beta::PRIVATE_NOTE');
    expectJoined('reference_page_presented');
  });
});

describe('entity type routing table', () => {
  it('refuses an unknown entity type with an id as unsupported, without opening anything', async () => {
    emit({
      entityType: 'PRIVATE_UNKNOWN_KIND',
      entityId: 'PRIVATE_ID',
      owningRoot: '/PRIVATE_BETA',
    });
    await waitFor(() => expect(state.toast).toHaveBeenCalledOnce());
    expect(state.toast).toHaveBeenCalledWith(
      'This reference does not have a supported destination.',
      { definition: 'document-open-refused' }
    );
    expect(state.open).not.toHaveBeenCalled();
    expect(state.selected).not.toHaveBeenCalled();
    expectJoined('reference_unsupported');
  });

  it('still resolves an unknown entity type through its durable identity and opens it as a sequence', async () => {
    state.byUuid.mockResolvedValue({ absolutePath: '/PRIVATE_BETA/PRIVATE_FILE.gb' });
    emit({
      entityType: 'PRIVATE_UNKNOWN_KIND',
      entityId: 'PRIVATE_ID',
      objectUuid: 'PRIVATE_UUID',
      owningRoot: '/PRIVATE_BETA',
    });
    await waitFor(() => expect(state.open).toHaveBeenCalledOnce());
    expect(state.open).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'file', path: '/PRIVATE_BETA/PRIVATE_FILE.gb', tabType: 'sequence' },
      })
    );
    expect(state.selected).not.toHaveBeenCalled();
  });

  it('runs the primer route only with an id, so an id-less primer reaches the no-target refusal', async () => {
    emit({ entityType: 'primer', owningRoot: '/PRIVATE_BETA' });
    await waitFor(() => expect(state.toast).toHaveBeenCalledOnce());
    expect(state.primer).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(
      'The reference has no available target. Check its project and try again.',
      { definition: 'document-open-refused' }
    );
  });

  it('opens a design found by durable identity through the file-type opener', async () => {
    state.byUuid.mockResolvedValue({ absolutePath: '/PRIVATE_BETA/PRIVATE_DESIGN.dnafdesign' });
    emit({
      entityType: 'design',
      entityId: 'PRIVATE_ID',
      objectUuid: 'PRIVATE_UUID',
      owningRoot: '/PRIVATE_BETA',
    });
    await waitFor(() => expect(state.selected).toHaveBeenCalledOnce());
    expect(state.selected.mock.calls[0][0]).toBe('/PRIVATE_BETA/PRIVATE_DESIGN.dnafdesign');
  });

  it('never matches a page by content hash', async () => {
    state.pages = { 'beta::PRIVATE_NOTE': {} };
    emit({
      entityType: 'page',
      entityId: 'PRIVATE_NOTE',
      contentHash: 'PRIVATE_HASH',
      owningRoot: '/PRIVATE_BETA',
    });
    await waitFor(() => expect(state.open).toHaveBeenCalledOnce());
    expect(state.byHash).not.toHaveBeenCalled();
    expectJoined('reference_page_presented');
  });
});
