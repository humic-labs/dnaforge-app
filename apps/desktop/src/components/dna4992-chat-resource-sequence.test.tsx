import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FullChatView,
  getFullChatViewHarness,
  platform,
  resetFullChatViewHarness,
  useCanvasStore,
  useWorkspaceStore,
} from './FullChatView.test-harness';
import { installEntityReferenceHandler } from '../features/page/entity-ref/install-entity-reference-handler';
import { presentDocument } from '../features/canvas/public/present-document';
import { CanvasLayout } from '../features/canvas/components/CanvasLayout';
import { ExplorerWorkspaceSurface } from '../features/canvas/ExplorerWorkspaceSurface';
import { CommandScopeProvider } from '../commands/CommandScopeProvider';
import { presentationOwner } from '../presentation/ownership';
import type { Tab } from '../features/canvas/types';
import { finishGenomeViewFileOpen } from '../features/sequence/public/genome-view-open-request';
import * as navigation from '../services/notebook-resource-navigation';
import {
  projectResourceReferenceFromHref,
  projectResourceReferenceHref,
  type ProjectResourceReference,
  type ResolvedProjectResourceReference,
} from '../shared/project-resource-reference';
import * as chatComponents from './chat';
import { getFullChatViewReferenceRootCacheDiagnostics } from './FullChatView.test-harness';
import { validateTrackViewDocument } from '../shared/track-view';
import { trackViewFixture } from '../shared/track-view-fixture';

const nativeSession = vi.hoisted(() => ({ open: vi.fn(), bind: vi.fn(), close: vi.fn() }));
vi.mock('../utils/environment', async (original) => ({
  ...(await original<typeof import('../utils/environment')>()),
  isBrowserOnly: () => false,
  isHostedBrowserRuntime: () => false,
}));
vi.mock('../features/workspace-session/public/electron-session', () => ({
  openElectronWorkspaceSessionFile: nativeSession.open,
  bindElectronWorkspaceSessionTab: nativeSession.bind,
  closeElectronWorkspaceSessionFile: nativeSession.close,
}));
const { mockChatState } = getFullChatViewHarness();
const realFormatting = await vi.importActual<typeof import('./chat/MessageFormatting')>(
  './chat/MessageFormatting'
);
let formatting: ReturnType<typeof vi.spyOn<typeof chatComponents, 'FormattedMessage'>>;
const root = '/projects/original-owner';
const projectId = 'ws7';
const conversationId = 'resource-source-conversation';
const document = validateTrackViewDocument(trackViewFixture());
const saved = {
  document,
  path: `${root}/Measured.dnaforge-track-view.json`,
  workspaceRoot: root,
  revision: 'a'.repeat(64),
};
const resources = {
  view: { kind: 'entity', projectId, entityId: document.id },
  file: {
    kind: 'path',
    projectId,
    path: 'analyses/evo2-klf17/selection.json',
    resourceKind: 'file',
  },
  directory: { kind: 'path', projectId, path: 'analyses/evo2-klf17', resourceKind: 'directory' },
} satisfies Record<string, ProjectResourceReference>;
const labels = {
  view: 'Measured saved view',
  file: 'Original selection file',
  directory: 'Original analyses',
};
const paths = {
  view: saved.path,
  file: `${root}/analyses/evo2-klf17/selection.json`,
  directory: `${root}/analyses/evo2-klf17`,
};
const owner = { id: 7, path: root, repo_uuid: null, archived_at: null, trashed_at: null };
let sourceChatId: string;
let removeHandler: (() => void) | undefined;
let open: ReturnType<typeof vi.spyOn<typeof navigation, 'openProjectResourceReference'>>;
const resolve = vi.fn();
const validate = vi.fn();
const viewChange = vi.fn();
const select = vi.fn();

function resolveResource(
  input: string | ProjectResourceReference
): ResolvedProjectResourceReference {
  const reference = typeof input === 'string' ? projectResourceReferenceFromHref(input) : input;
  const key = (Object.keys(resources) as Array<keyof typeof resources>).find(
    (key) => JSON.stringify(resources[key]) === JSON.stringify(reference)
  );
  if (!key) throw new Error('The native query received a different resource or owner.');
  return {
    reference: resources[key],
    workspaceRoot: root,
    path: paths[key],
    entityType: key === 'directory' ? 'directory' : 'file',
    label: labels[key],
  };
}

vi.mock('../features/canvas/components/PanelContent', () => ({
  PanelContent: ({ tab, isActive, panelId }: { tab: Tab; isActive: boolean; panelId: string }) => {
    const focused = useCanvasStore((state) => state.focusedPanelId === panelId);
    return tab.type === 'chat' ? (
      <div data-testid="visible-source-assistant">
        <FullChatView
          workspacePath={root}
          conversationId={tab.entityId}
          isOpen={isActive && focused}
          isVisible={isActive}
        />
      </div>
    ) : (
      <div data-testid={`document-leaf-${tab.entityId}`}>{tab.label}</div>
    );
  },
}));
vi.mock('../features/page/public/embeds/structure3d/molstar/cache', () => ({
  getPaneRendererHostCacheKey: (key: string) => key,
  acquireCachedViewerLease: vi.fn(),
  releaseCachedViewerLease: vi.fn(),
}));
vi.mock('../features/memory-pressure/public', async (original) => ({
  ...(await original<typeof import('../features/memory-pressure/public')>()),
  useMemoryPressureMonitoring: vi.fn(),
}));

function Scene() {
  return (
    <CommandScopeProvider>
      <ExplorerWorkspaceSurface
        takeoverActive={false}
        emptyFilesHomeActive={false}
        explorerInset={0}
      >
        <CanvasLayout />
      </ExplorerWorkspaceSurface>
    </CommandScopeProvider>
  );
}

function createTarget(kind: 'view' | 'file', panelId = 'main') {
  const result = presentDocument(
    kind === 'view'
      ? {
          type: 'sequence',
          entityId: document.id,
          label: labels.view,
          sequenceDocument: { kind: 'indexed-sequence', documentId: document.id },
          trackView: saved,
          indexedGenome: { sourcePath: '/owner/reference.fa', sourceExt: 'fa', chrom: 'chr1' },
          loadStatus: 'loaded',
        }
      : { type: 'text', entityId: paths.file, label: labels.file, loadStatus: 'loaded' },
    { kind: 'panel', panelId }
  );
  if (result.status !== 'presented') throw new Error('The original target was not presented.');
  return result.tabId;
}

function activateChat() {
  useCanvasStore.getState().setActiveTab('main', sourceChatId);
  useCanvasStore.getState().focusPanel('main');
}

async function clickResource(kind: keyof typeof resources) {
  const chip = await screen.findByRole('link', {
    name: `${labels[kind]}, ${kind === 'view' ? 'Track View' : kind === 'directory' ? 'Folder' : 'File'}`,
  });
  await waitFor(() => {
    expect(chip).not.toHaveAttribute('aria-disabled', 'true');
    expect(chip).not.toHaveAttribute('aria-busy', 'true');
  });
  const before = open.mock.calls.length;
  console.info(
    ' sequential chip before click',
    JSON.stringify({
      kind,
      busy: chip.getAttribute('aria-busy'),
      disabled: chip.getAttribute('aria-disabled'),
      activations: getFullChatViewReferenceRootCacheDiagnostics(),
    })
  );
  await act(async () => {
    chip.focus();
    fireEvent.pointerDown(chip);
    fireEvent.mouseDown(chip);
    fireEvent.mouseUp(chip);
    fireEvent.click(chip);
    expect(open).toHaveBeenCalledTimes(before + 1);
    const [outcome] = await Promise.allSettled([open.mock.results[before].value]);
    expect(outcome.status).toBe('fulfilled');
  });
  console.info(
    ' sequential chip after click',
    JSON.stringify({
      kind,
      activations: getFullChatViewReferenceRootCacheDiagnostics(),
      panels: Object.values(useCanvasStore.getState().panels).map((panel) => ({
        id: panel.id,
        activeTabId: panel.activeTabId,
        tabs: panel.tabs.map((tab) => ({ id: tab.id, entityId: tab.entityId })),
      })),
    })
  );
}

function expectChatBesideExactTarget(kind: 'view' | 'file', expectedTabId?: string) {
  const state = useCanvasStore.getState();
  const targetId = kind === 'view' ? document.id : paths.file;
  const targets = Object.values(state.panels).flatMap((panel) =>
    panel.tabs.filter((tab) => tab.entityId === targetId).map((tab) => ({ panel, tab }))
  );
  expect(targets).toHaveLength(1);
  const [{ panel, tab }] = targets;
  if (expectedTabId) expect(tab.id).toBe(expectedTabId);
  expect(panel.id).not.toBe('main');
  expect(panel.activeTabId).toBe(tab.id);
  expect(state.panels.main.activeTabId).toBe(sourceChatId);
  expect(state.focusedPanelId).toBe('main');
  expect(presentationOwner.allows(`tab-${sourceChatId}`, 'presentation')).toBe(true);
  const host = globalThis.document.getElementById(`tab-content-${sourceChatId}`);
  expect(host).not.toBeNull();
  expect(host).not.toHaveAttribute('inert');
  expect(host).toHaveAttribute('aria-hidden', 'false');
  expect(screen.getByTestId('visible-source-assistant')).toBeVisible();
  expect(screen.getByRole('link', { name: `${labels.file}, File` })).toBeVisible();
  expect(screen.getByRole('link', { name: `${labels.directory}, Folder` })).toBeVisible();
  expect(resolve).toHaveBeenCalledWith(resources[kind]);
}

beforeEach(() => {
  resetFullChatViewHarness();
  nativeSession.open.mockReset().mockResolvedValue('/native/admitted-view');
  nativeSession.bind.mockReset();
  nativeSession.close.mockReset();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  formatting = vi
    .spyOn(chatComponents, 'FormattedMessage')
    .mockImplementation((props) => <realFormatting.FormattedMessage {...props} />);
  resolve.mockReset().mockImplementation(async (reference) => resolveResource(reference));
  validate
    .mockReset()
    .mockImplementation(
      async (input) => input.workspaceRoot === root && Object.values(paths).includes(input.path)
    );
  viewChange.mockReset();
  select.mockReset().mockImplementation(async (query: string, parameters: unknown[] = []) => {
    if (query.includes('workspace_sync_restore_locks')) return [];
    if (query.includes('FROM workspaces')) {
      if (query.includes('path = ?') && parameters[0] !== root) return [];
      return [owner];
    }
    if (query.includes('FROM catalog_entities') && parameters[0] === document.id)
      return [
        { id: document.id, workspace_id: 7, type: 'file', name: labels.view, status: 'active' },
      ];
    if (query.includes('FROM catalog_entity_files') && parameters[0] === document.id)
      return [
        {
          id: 'exact-view-binding',
          entity_id: document.id,
          workspace_id: 7,
          path: saved.path,
          relative_path: 'Measured.dnaforge-track-view.json',
          file_kind: 'track-view',
          status: 'current',
          updated_at: 1,
        },
      ];
    throw new Error(`Unexpected native catalog query: ${query}`);
  });
  const current = platform();
  vi.mocked(platform).mockReturnValue({
    ...current,
    db: { ...current.db, select },
    fs: {
      ...current.fs,
      resolveProjectResourceReference: resolve,
      validateWorkspacePath: validate,
      stat: async (path: string) => ({
        canonicalPath: path,
        isDirectory: false,
        isFile: true,
        size: 10,
        mtime: 0,
        ctime: 0,
        mtimeNs: '0',
        ctimeNs: '0',
      }),
    },
  });
  useWorkspaceStore.setState({
    folders: [{ path: root, name: 'Original owner', addedAt: 1 }],
    selectedPath: null,
  });
  mockChatState.currentConversationId = conversationId;
  mockChatState.messages = [
    {
      id: 'assistant-resources',
      role: 'assistant',
      createdAt: 1,
      content: `The source assistant stays visible. ${Object.entries(resources)
        .map(
          ([key, reference]) =>
            `[${labels[key as keyof typeof labels]}](${projectResourceReferenceHref(reference)})`
        )
        .join(' ')}`,
    },
  ];
  mockChatState._convStates.set(conversationId, {
    messages: mockChatState.messages,
    turns: mockChatState.turns,
    activeTurnId: mockChatState.activeTurnId,
    streamingBlocks: mockChatState.streamingBlocks,
    isLoading: mockChatState.isLoading,
    isStreaming: mockChatState.isStreaming,
    error: mockChatState.error,
    queuedMessages: mockChatState.queuedMessages,
  });
  sourceChatId = useCanvasStore
    .getState()
    .openTab('main', { type: 'chat', entityId: conversationId, label: 'Source assistant' })!;
  open = vi.spyOn(navigation, 'openProjectResourceReference');
  removeHandler = installEntityReferenceHandler({
    folders: [{ path: root, name: 'Original owner' }],
    handleViewChange: viewChange,
  });
});

afterEach(() => {
  cleanup();
  removeHandler?.();
  removeHandler = undefined;
  finishGenomeViewFileOpen(null);
  open.mockRestore();
  formatting.mockRestore();
  vi.unstubAllGlobals();
});

describe(' real pooled chat and Markdown sequential resource activation', () => {
  it('opens a saved view then an existing JSON file from the same live assistant', async () => {
    const existingView = createTarget('view');
    const existingFile = createTarget('file');
    activateChat();
    render(<Scene />);
    await clickResource('view');
    expectChatBesideExactTarget('view', existingView);
    expect(useCanvasStore.getState().panels.main.tabs.some((tab) => tab.id === existingFile)).toBe(
      true
    );
    await clickResource('file');
    expectChatBesideExactTarget('file', existingFile);
    expect(open).toHaveBeenCalledTimes(2);
    await clickResource('directory');
    expect(useWorkspaceStore.getState().selectedPath).toBe(paths.directory);
    expect(useCanvasStore.getState().panels.main.activeTabId).toBe(sourceChatId);
    expect(screen.getByTestId('visible-source-assistant')).toBeVisible();
  });
  it('keeps pinned history geometry stable while native view admission temporarily focuses the other panel', async () => {
    createTarget('view');
    const existingFile = createTarget('file');
    activateChat();
    const admission = Promise.withResolvers<string>();
    nativeSession.open.mockReturnValueOnce(admission.promise);
    render(<Scene />);
    fireEvent.click(screen.getByTestId('ai-history-button'));
    const chat = screen.getByTestId('full-chat-view');
    expect(chat).toHaveAttribute('data-history-pinned', 'true');
    const viewChip = await screen.findByRole('link', { name: `${labels.view}, Track View` });
    await waitFor(() => expect(viewChip).not.toHaveAttribute('aria-busy', 'true'));
    fireEvent.pointerDown(viewChip);
    fireEvent.mouseDown(viewChip);
    fireEvent.mouseUp(viewChip);
    fireEvent.click(viewChip);
    expect(open).toHaveBeenCalledOnce();
    const viewOpening = open.mock.results[0].value;
    try {
      await waitFor(() => expect(nativeSession.open).toHaveBeenCalledWith(saved.path));
      const state = useCanvasStore.getState();
      expect(state.panels.main.activeTabId).toBe(sourceChatId);
      expect(state.focusedPanelId).not.toBe('main');
      expect(presentationOwner.allows(`tab-${sourceChatId}`, 'presentation')).toBe(true);
      console.info(
        ' pending native admission layout',
        JSON.stringify({
          pinned: chat.getAttribute('data-history-pinned'),
          focusedPanelId: state.focusedPanelId,
          chatStillActive: state.panels.main.activeTabId === sourceChatId,
          viewAdmissionPending: true,
        })
      );
      expect(chat).toHaveAttribute('data-history-pinned', 'true');
      expect(screen.getByTestId('ai-history-panel')).toBeVisible();
      const fileChip = screen.getByRole('link', { name: `${labels.file}, File` });
      expect(fileChip).not.toHaveAttribute('aria-busy', 'true');
      await act(async () => {
        fireEvent.pointerDown(fileChip);
        expect(useCanvasStore.getState().focusedPanelId).toBe('main');
        expect(chat).toHaveAttribute('data-history-pinned', 'true');
        fireEvent.mouseDown(fileChip);
        fireEvent.mouseUp(fileChip);
        fireEvent.click(fileChip);
        expect(open).toHaveBeenCalledTimes(2);
        const [outcome] = await Promise.allSettled([open.mock.results[1].value]);
        expect(outcome.status).toBe('fulfilled');
      });
      expectChatBesideExactTarget('file', existingFile);
    } finally {
      await act(async () => {
        admission.resolve('/native/admitted-view');
        await Promise.allSettled([viewOpening]);
      });
    }
    expectChatBesideExactTarget('file', existingFile);
  });
});
