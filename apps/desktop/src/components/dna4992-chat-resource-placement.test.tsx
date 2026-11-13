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
import { finishGenomeViewFileOpen } from '../features/sequence/public/genome-view-open-request';
import * as navigation from '../services/notebook-resource-navigation';
import {
  projectResourceReferenceFromHref,
  projectResourceReferenceHref,
  type ProjectResourceReference,
  type ResolvedProjectResourceReference,
} from '../shared/project-resource-reference';
import { validateTrackViewDocument } from '../shared/track-view';
import { trackViewFixture } from '../shared/track-view-fixture';

const { mockChatState } = getFullChatViewHarness();
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
  file: { kind: 'path', projectId, path: 'analyses/selection.txt', resourceKind: 'file' },
  directory: { kind: 'path', projectId, path: 'analyses', resourceKind: 'directory' },
} satisfies Record<string, ProjectResourceReference>;
const labels = {
  view: 'Measured saved view',
  file: 'Original selection file',
  directory: 'Original analyses',
};
const paths = {
  view: saved.path,
  file: `${root}/analyses/selection.txt`,
  directory: `${root}/analyses`,
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

function SourceChat() {
  const active = useCanvasStore((state) =>
    Object.values(state.panels).some((panel) => panel.activeTabId === sourceChatId)
  );
  return active ? (
    <div data-testid="visible-source-assistant">
      <FullChatView workspacePath={root} conversationId={conversationId} />
    </div>
  ) : null;
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
    name: `${labels[kind]}, ${kind === 'directory' ? 'Folder' : 'File'}`,
  });
  await waitFor(() => {
    expect(chip).not.toHaveAttribute('aria-disabled', 'true');
    expect(chip).not.toHaveAttribute('aria-busy', 'true');
  });
  await act(async () => {
    fireEvent.click(chip);
    expect(open).toHaveBeenCalledOnce();
    await Promise.allSettled([open.mock.results[0].value]);
  });
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
  expect(screen.getByTestId('visible-source-assistant')).toBeVisible();
  expect(screen.getByRole('link', { name: `${labels.file}, File` })).toBeVisible();
  expect(screen.getByRole('link', { name: `${labels.directory}, Folder` })).toBeVisible();
  expect(resolve).toHaveBeenCalledWith(resources[kind]);
}

beforeEach(() => {
  resetFullChatViewHarness();
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
});

describe(' chat project resources retain the source assistant', () => {
  it.each(['view', 'file'] as const)(
    'moves an existing exact %s out of the chat panel without duplication',
    async (kind) => {
      const targetId = createTarget(kind);
      activateChat();
      render(<SourceChat />);
      await clickResource(kind);
      expectChatBesideExactTarget(kind, targetId);
    }
  );

  it.each(['view', 'file'] as const)(
    'reuses an exact %s already beside chat without changing the source focus',
    async (kind) => {
      const placement = useCanvasStore.getState().agentContentPlacement('main');
      const targetId = createTarget(kind, placement.targetPanelId);
      activateChat();
      render(<SourceChat />);
      await clickResource(kind);
      expectChatBesideExactTarget(kind, targetId);
      expect(Object.keys(useCanvasStore.getState().panels)).toHaveLength(2);
    }
  );

  it('opens a new exact file beside chat and leaves the remaining resource chips usable', async () => {
    activateChat();
    render(<SourceChat />);
    await clickResource('file');
    expectChatBesideExactTarget('file');
    expect(validate).toHaveBeenCalledWith({
      workspaceRoot: root,
      path: paths.file,
      artifactNoun: 'reference',
    });
  });

  it('reveals the exact directory while the source assistant stays active and focused', async () => {
    activateChat();
    render(<SourceChat />);
    await clickResource('directory');
    expect(useWorkspaceStore.getState().selectedPath).toBe(paths.directory);
    expect(useCanvasStore.getState().panels.main.activeTabId).toBe(sourceChatId);
    expect(useCanvasStore.getState().focusedPanelId).toBe('main');
    expect(screen.getByTestId('visible-source-assistant')).toBeVisible();
    expect(Object.keys(useCanvasStore.getState().panels)).toEqual(['main']);
    expect(viewChange).toHaveBeenCalledWith('files');
  });

  it.each(['view', 'file'] as const)(
    'retains ordinary notebook focused placement for the exact %s',
    async (kind) => {
      const targetId = createTarget(kind);
      const notebook = presentDocument({
        type: 'page',
        entityId: 'source-notebook',
        label: 'Notebook',
      });
      expect(notebook.status).toBe('presented');
      await navigation.openProjectResourceReference(resources[kind]);
      expect(useCanvasStore.getState().panels.main.activeTabId).toBe(targetId);
      expect(useCanvasStore.getState().focusedPanelId).toBe('main');
      expect(Object.keys(useCanvasStore.getState().panels)).toEqual(['main']);
    }
  );
});
