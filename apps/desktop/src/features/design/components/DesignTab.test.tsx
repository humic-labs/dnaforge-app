import { documentLifecycle } from '../../../shared/document-lifecycle';
import type { SaveDocumentTarget } from '../../../shared/save-document-events';
import { DocumentSaveCommands } from '../../../test/document-save-commands';
type SaveRequest = SaveDocumentTarget & { sourceTabId?: string };
type SaveResult = SaveRequest & { success: boolean };
const saveDocument = documentLifecycle.save.bind(documentLifecycle);
/**
 * @vitest-environment jsdom
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../../canvas/store';
import { assemblyDispatcher, useDesignStore } from '../store';
import { useDesignRecoveryStore } from '../design-recovery';
import { useRichSequenceClipboardStore } from '../../sequence-clipboard/store';
import { useAssemblyColorSchemeStore } from '../color-scheme-store';
import { productLayoutSegmentId, selectProductLayout } from '../assembly-boundaries';
import type { DesignRegion } from '../types';
import { DesignTab } from './DesignTab';
import { WorkspaceCommandProvider as CommandScopeProviderForTest } from '../../../test/document-save-commands';
import { useCommandScope } from '../../../commands/useCommandScope';
import { COMMAND_SCOPES } from '../../../commands/types';
import {
  CIDAR_MOCLO_RED_TU_DESIGN_ID,
  cidarMocloRedFluorescentTu,
  ytkMocloFactoryExpressionCassette,
} from '../../../test/scenarios/assembly-real-pipeline';

function mockNavigatorPlatform(platform: string): void {
  Object.defineProperty(navigator, 'platform', {
    value: platform,
    configurable: true,
  });
}

const workspaceViewerSpy = vi.hoisted(() => vi.fn());
const artifactMocks = vi.hoisted(() => ({
  renameDesignArtifactFile: vi.fn(),
  writeDesignArtifactSnapshot: vi.fn(),
}));
const catalogMocks = vi.hoisted(() => ({
  getCurrentCatalogFileForEntity: vi.fn(),
}));
const materializationMocks = vi.hoisted(() => ({
  ensureDesignArtifact: vi.fn(),
}));

vi.mock('../../../db/workspace-artifacts', () => ({
  artifactStemFromFileName: (fileName: string) => fileName.replace(/\.wpdesign\.json$/i, ''),
  renameDesignArtifactFile: artifactMocks.renameDesignArtifactFile,
  writeDesignArtifactSnapshot: artifactMocks.writeDesignArtifactSnapshot,
}));

vi.mock('../../../db/workspace-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db/workspace-catalog')>()),
  getCurrentCatalogFileForEntity: catalogMocks.getCurrentCatalogFileForEntity,
}));

vi.mock('../materialize-design-artifact', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../materialize-design-artifact')>()),
  ensureDesignArtifact: materializationMocks.ensureDesignArtifact,
}));

vi.mock('./DesignDrawer', () => ({
  DesignDrawer: () => <div data-testid="mock-design-drawer" />,
}));

vi.mock('../../sequence/components/WorkspaceViewer', () => ({
  WorkspaceViewer: (props: unknown) => {
    workspaceViewerSpy(props);
    return <div data-testid="mock-workspace-viewer" />;
  },
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockNavigatorPlatform('MacIntel');
  workspaceViewerSpy.mockClear();
  artifactMocks.renameDesignArtifactFile.mockResolvedValue({
    path: '/lab/Renamed Assembly.wpdesign.json',
    name: 'Renamed Assembly.wpdesign.json',
    fileKind: 'waypoint-design',
    sizeBytes: 42,
  });

  catalogMocks.getCurrentCatalogFileForEntity.mockImplementation(() => new Promise(() => {}));
  materializationMocks.ensureDesignArtifact.mockResolvedValue(
    '/lab/Untitled Assembly.wpdesign.json'
  );
  useAssemblyColorSchemeStore.setState({ assemblyColorScheme: 'tailwind' });
  useDesignStore.setState({
    designs: {},
    draftDesignIds: {},
    activeDesignId: null,
    pendingDispatchId: null,
  });
  useDesignRecoveryStore.setState({ records: {} });
  useRichSequenceClipboardStore.getState().clear();
  useCanvasStore.setState({
    panels: {
      main: {
        id: 'main',
        tabs: [],
        activeTabId: null,
      },
    },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    oversizeScanComplete: true,
  });
});

describe('published assembly Save', () => {
  afterEach(() => artifactMocks.writeDesignArtifactSnapshot.mockReset());

  function openPublishedAssembly() {
    const designId = useDesignStore.getState().createDesign('Saved Assembly');
    useCanvasStore.getState().openTab('main', {
      type: 'design',
      entityId: designId,
      label: 'Saved Assembly',
    });
    const tab = useCanvasStore
      .getState()
      .panels.main.tabs.find((item) => item.entityId === designId);
    if (!tab) throw new Error('Saved assembly tab was not created');
    return { designId, tab };
  }

  function mountPublishedAssembly(
    designId: string,
    tab: ReturnType<typeof openPublishedAssembly>['tab']
  ) {
    return render(
      <CommandScopeProviderForTest>
        <DocumentSaveCommands />
        <DesignTab designId={designId} tab={tab} panelId="main" />
      </CommandScopeProviderForTest>
    );
  }

  function ExplorerFocus() {
    const scope = useCommandScope(COMMAND_SCOPES.sidebarFileTree);
    return (
      <button data-testid="save-explorer-scope" {...scope.eventHandlers}>
        Explorer
      </button>
    );
  }

  function MountedAssemblyViewer() {
    useCommandScope(COMMAND_SCOPES.tabSequence, {
      claimOnMount: true,
    });
    return null;
  }

  it('keeps Save available after its molecular viewer mounts', async () => {
    const { designId, tab } = openPublishedAssembly();
    artifactMocks.writeDesignArtifactSnapshot.mockResolvedValue({ id: 'saved-artifact' });
    const requests: SaveRequest[] = [];
    const capture = vi
      .spyOn(documentLifecycle, 'save')
      .mockImplementation((target, sourceTabId) => {
        requests.push({ ...target, sourceTabId });
        return saveDocument(target, sourceTabId);
      });
    try {
      const view = mountPublishedAssembly(designId, tab);
      view.rerender(
        <CommandScopeProviderForTest>
          <DocumentSaveCommands />
          <DesignTab designId={designId} tab={tab} panelId="main" />
          <MountedAssemblyViewer />
        </CommandScopeProviderForTest>
      );
      fireEvent.keyDown(document, { key: 's', metaKey: true });
      await waitFor(() => expect(requests).toHaveLength(1));
      expect(requests[0]).toMatchObject({ kind: 'tab', tabId: tab.id, sourceTabId: tab.id });
      await waitFor(() =>
        expect(useDesignRecoveryStore.getState().records[designId].pending).toBe(false)
      );
    } finally {
      capture.mockRestore();
    }
  });

  it('reclaims Save after Explorer focus returns to the same mounted Assembly panel', async () => {
    const { designId, tab } = openPublishedAssembly();
    artifactMocks.writeDesignArtifactSnapshot.mockResolvedValue({ id: 'saved-artifact' });
    const requests: SaveRequest[] = [];
    const capture = vi
      .spyOn(documentLifecycle, 'save')
      .mockImplementation((target, sourceTabId) => {
        requests.push({ ...target, sourceTabId });
        return saveDocument(target, sourceTabId);
      });
    try {
      render(
        <CommandScopeProviderForTest>
          <DocumentSaveCommands />
          <ExplorerFocus />
          <DesignTab designId={designId} tab={tab} panelId="main" />
        </CommandScopeProviderForTest>
      );
      fireEvent.keyDown(document, { key: 's', metaKey: true });
      await waitFor(() => expect(requests).toHaveLength(1));
      await waitFor(() =>
        expect(useDesignRecoveryStore.getState().records[designId].pending).toBe(false)
      );
      fireEvent.mouseDown(screen.getByTestId('save-explorer-scope'));
      fireEvent.keyDown(document, { key: 's', metaKey: true });
      expect(requests).toHaveLength(1);
      fireEvent.mouseDown(screen.getByTestId('design-rename-button'));
      fireEvent.keyDown(document, { key: 's', metaKey: true });
      await waitFor(() => expect(requests).toHaveLength(2));
      expect(requests.every((request) => request.kind === 'tab' && request.tabId === tab.id)).toBe(
        true
      );
    } finally {
      capture.mockRestore();
    }
  });

  it('routes the focused published design Save shortcut to its tab', async () => {
    const designId = useDesignStore.getState().createDesign('Saved Assembly');
    useCanvasStore.getState().openTab('main', {
      type: 'design',
      entityId: designId,
      label: 'Saved Assembly',
    });
    const tab = useCanvasStore
      .getState()
      .panels.main.tabs.find((item) => item.entityId === designId);
    if (!tab) throw new Error('Saved assembly tab was not created');
    const requests: SaveRequest[] = [];
    const capture = vi
      .spyOn(documentLifecycle, 'save')
      .mockImplementation((target, sourceTabId) => {
        requests.push({ ...target, sourceTabId });
        return saveDocument(target, sourceTabId);
      });
    try {
      render(
        <CommandScopeProviderForTest>
          <DocumentSaveCommands />
          <DesignTab designId={designId} tab={tab} panelId="main" />
        </CommandScopeProviderForTest>
      );
      fireEvent.keyDown(document, { key: 's', metaKey: true });
      await waitFor(() => {
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ kind: 'tab', tabId: tab.id });
      });
    } finally {
      capture.mockRestore();
    }
  });

  it('acknowledges Save only after its existing artifact publication finishes', async () => {
    const { designId, tab } = openPublishedAssembly();
    let releaseWrite: (() => void) | undefined;
    artifactMocks.writeDesignArtifactSnapshot.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      return { id: 'saved-artifact' };
    });
    const completions: SaveResult[] = [];
    const capture = vi
      .spyOn(documentLifecycle, 'save')
      .mockImplementation(async (target, sourceTabId) => {
        const success = await saveDocument(target, sourceTabId);
        completions.push({ ...target, sourceTabId, success });
        return success;
      });
    try {
      mountPublishedAssembly(designId, tab);
      fireEvent.keyDown(document, { key: 's', metaKey: true });
      await waitFor(() =>
        expect(artifactMocks.writeDesignArtifactSnapshot).toHaveBeenCalledTimes(1)
      );
      expect(completions).toHaveLength(0);
      expect(useDesignRecoveryStore.getState().records[designId].pending).toBe(true);
      await act(async () => {
        releaseWrite?.();
      });
      await waitFor(() => expect(completions).toHaveLength(1));
      expect(completions[0]).toMatchObject({ kind: 'tab', tabId: tab.id, success: true });
      expect(useDesignRecoveryStore.getState().records[designId].pending).toBe(false);
    } finally {
      releaseWrite?.();
      capture.mockRestore();
    }
  });

  it('reports a failed publication without clearing the pending design recovery', async () => {
    const { designId, tab } = openPublishedAssembly();
    artifactMocks.writeDesignArtifactSnapshot.mockRejectedValue(new Error('disk write failed'));
    const completions: SaveResult[] = [];
    const capture = vi
      .spyOn(documentLifecycle, 'save')
      .mockImplementation(async (target, sourceTabId) => {
        const success = await saveDocument(target, sourceTabId);
        completions.push({ ...target, sourceTabId, success });
        return success;
      });
    try {
      mountPublishedAssembly(designId, tab);
      fireEvent.keyDown(document, { key: 's', metaKey: true });
      await waitFor(() => expect(completions).toHaveLength(1));
      expect(completions[0]).toMatchObject({ tabId: tab.id, success: false });
      expect(useDesignRecoveryStore.getState().records[designId].pending).toBe(true);
      expect(useDesignStore.getState().designs[designId].name).toBe('Saved Assembly');
    } finally {
      capture.mockRestore();
    }
  });

  it('does not save a background assembly after chat takes focus before rerender', async () => {
    const { designId, tab } = openPublishedAssembly();
    mountPublishedAssembly(designId, tab);
    await act(async () => {
      useCanvasStore
        .getState()
        .openTab('main', { type: 'chat', entityId: 'chat-1', label: 'Chat' });
      fireEvent.keyDown(document, { key: 's', metaKey: true });
    });
    expect(artifactMocks.writeDesignArtifactSnapshot).not.toHaveBeenCalled();
    expect(useDesignRecoveryStore.getState().records[designId]).toBeUndefined();
  });

  it('preserves modal command ownership instead of saving the assembly behind it', () => {
    const { designId, tab } = openPublishedAssembly();
    mountPublishedAssembly(designId, tab);
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.append(modal);
    try {
      fireEvent.keyDown(document, { key: 's', metaKey: true });
      expect(artifactMocks.writeDesignArtifactSnapshot).not.toHaveBeenCalled();
    } finally {
      modal.remove();
    }
  });

  it('uses Control+S for the focused assembly on Windows', async () => {
    mockNavigatorPlatform('Win32');
    const { designId, tab } = openPublishedAssembly();
    artifactMocks.writeDesignArtifactSnapshot.mockResolvedValue({ id: 'saved-artifact' });
    mountPublishedAssembly(designId, tab);
    fireEvent.keyDown(document, { key: 's', ctrlKey: true });
    await waitFor(() => expect(artifactMocks.writeDesignArtifactSnapshot).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(useDesignRecoveryStore.getState().records[designId].pending).toBe(false)
    );
  });

  it('does not resurrect a retired design when Save is requested', async () => {
    const { designId, tab } = openPublishedAssembly();
    const { captureDesignRecovery } = await import('../design-recovery');
    captureDesignRecovery(useDesignStore.getState().designs[designId]);
    useDesignRecoveryStore.setState((state) => ({
      records: {
        ...state.records,
        [designId]: {
          ...state.records[designId],
          retired: true,
          pending: false,
          status: 'retired',
        },
      },
    }));
    const completions: SaveResult[] = [];
    const capture = vi
      .spyOn(documentLifecycle, 'save')
      .mockImplementation(async (target, sourceTabId) => {
        const success = await saveDocument(target, sourceTabId);
        completions.push({ ...target, sourceTabId, success });
        return success;
      });
    try {
      mountPublishedAssembly(designId, tab);
      fireEvent.keyDown(document, { key: 's', metaKey: true });
      await waitFor(() => expect(completions).toHaveLength(1));
      expect(completions[0].success).toBe(false);
      expect(artifactMocks.writeDesignArtifactSnapshot).not.toHaveBeenCalled();
      expect(useDesignRecoveryStore.getState().records[designId].retired).toBe(true);
    } finally {
      capture.mockRestore();
    }
  });

  it('does not acknowledge a replacement design as saved when the old publication completes', async () => {
    const { designId, tab } = openPublishedAssembly();
    const replacementId = useDesignStore.getState().createDesign('Replacement');
    let releaseWrite: (() => void) | undefined;
    artifactMocks.writeDesignArtifactSnapshot.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      return { id: 'old-artifact' };
    });
    const completions: SaveResult[] = [];
    const capture = vi
      .spyOn(documentLifecycle, 'save')
      .mockImplementation(async (target, sourceTabId) => {
        const success = await saveDocument(target, sourceTabId);
        completions.push({ ...target, sourceTabId, success });
        return success;
      });
    try {
      mountPublishedAssembly(designId, tab);
      fireEvent.keyDown(document, { key: 's', metaKey: true });
      await waitFor(() =>
        expect(artifactMocks.writeDesignArtifactSnapshot).toHaveBeenCalledTimes(1)
      );
      act(() =>
        useCanvasStore
          .getState()
          .retargetTab('main', tab.id, { type: 'design', entityId: replacementId })
      );
      await act(async () => {
        releaseWrite?.();
      });
      await waitFor(() => expect(completions).toHaveLength(1));
      expect(completions[0].success).toBe(false);
      expect(useDesignStore.getState().designs[replacementId].name).toBe('Replacement');
      expect(useDesignRecoveryStore.getState().records[replacementId]).toBeUndefined();
    } finally {
      releaseWrite?.();
      capture.mockRestore();
    }
  });

  it('ignores a stale tab Save request after that tab changes its design identity', async () => {
    const { designId, tab } = openPublishedAssembly();
    const replacementId = useDesignStore.getState().createDesign('Replacement');
    mountPublishedAssembly(designId, tab);
    await act(async () => {
      useCanvasStore
        .getState()
        .retargetTab('main', tab.id, { type: 'design', entityId: replacementId });
      void documentLifecycle.save({ kind: 'tab', tabId: tab.id }, tab.id);
    });
    expect(artifactMocks.writeDesignArtifactSnapshot).not.toHaveBeenCalled();
    expect(useDesignRecoveryStore.getState().records[designId]).toBeUndefined();
    expect(useDesignRecoveryStore.getState().records[replacementId]).toBeUndefined();
  });
});

async function draftAssemblyAndWait(designId: string): Promise<void> {
  const dispatch = vi.spyOn(assemblyDispatcher, 'dispatch');
  let result: ReturnType<typeof assemblyDispatcher.dispatch> | undefined;
  try {
    useDesignStore.getState().draftAssembly(designId);
    result = dispatch.mock.results.at(-1)?.value;
  } finally {
    dispatch.mockRestore();
  }
  await result?.result;
}

describe('DesignTab draft lifecycle', () => {
  function openDraftAssembly() {
    const designId = useDesignStore.getState().createDraftDesign('Untitled Assembly', 'goldengate');
    const tabId = useCanvasStore.getState().openTab('main', {
      type: 'design',
      entityId: designId,
      label: 'Untitled Assembly',
      artifactDocument: {
        kind: 'assembly',
        persistence: 'draft',
        workspaceRoot: '/lab',
        destinationPath: '/lab',
      },
    });
    const tab = useCanvasStore.getState().panels.main.tabs.find((item) => item.id === tabId);
    if (!tab) throw new Error('Draft tab was not opened.');
    return { designId, tab };
  }

  it('marks the untitled assembly dirty after its first edit without renaming a nonexistent file', async () => {
    const { designId, tab } = openDraftAssembly();
    render(<DesignTab designId={designId} tab={tab} panelId="main" />);

    fireEvent.click(screen.getByTestId('design-rename-button'));
    const input = await screen.findByTestId('design-name-input');
    fireEvent.change(input, { target: { value: 'Edited Assembly' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(useCanvasStore.getState().panels.main.tabs[0].isDirty).toBe(true);
    });
    expect(artifactMocks.renameDesignArtifactFile).not.toHaveBeenCalled();
  });

  it('discards the transient design when its draft tab is discarded', () => {
    const { designId, tab } = openDraftAssembly();
    render(<DesignTab designId={designId} tab={tab} panelId="main" />);

    act(() => {
      void documentLifecycle.discard({ kind: 'tab', tabId: tab.id }, tab.id);
    });

    expect(useDesignStore.getState().designs[designId]).toBeUndefined();
    expect(useDesignStore.getState().draftDesignIds[designId]).toBeUndefined();
  });

  it('materializes and promotes the draft through the shared tab save request', async () => {
    const { designId, tab } = openDraftAssembly();
    const completions: Array<{ kind: string; tabId: string; success: boolean }> = [];
    const capture = vi
      .spyOn(documentLifecycle, 'save')
      .mockImplementation(async (target, sourceTabId) => {
        const success = await saveDocument(target, sourceTabId);
        if (target.kind === 'tab') completions.push({ ...target, success });
        return success;
      });
    render(<DesignTab designId={designId} tab={tab} panelId="main" />);

    await act(async () => {
      void documentLifecycle.save({ kind: 'tab', tabId: tab.id }, tab.id);
    });

    await waitFor(() => {
      expect(materializationMocks.ensureDesignArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          design: expect.objectContaining({ id: designId }),
          workspaceRoot: '/lab',
          source: 'interactive-draft',
        })
      );
      expect(useDesignStore.getState().draftDesignIds[designId]).toBeUndefined();
      expect(documentLifecycle.dirty({ kind: 'tab', tabId: tab.id }, tab.id)).toBe(false);
      expect(useCanvasStore.getState().panels.main.tabs[0]).toMatchObject({
        artifactDocument: undefined,
      });
      expect(completions).toContainEqual({
        kind: 'tab',
        tabId: tab.id,
        success: true,
      });
    });
    capture.mockRestore();
  });

  it('keeps a later assembly edit in its draft when the first write finishes', async () => {
    const { designId, tab } = openDraftAssembly();
    let finish!: (path: string) => void;
    materializationMocks.ensureDesignArtifact.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        })
    );
    render(<DesignTab designId={designId} tab={tab} panelId="main" />);
    const target = { kind: 'tab', tabId: tab.id } as const;
    let result!: Promise<boolean>;
    act(() => {
      result = documentLifecycle.save(target, tab.id);
    });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    act(() => {
      useDesignStore.getState().updateDesign(designId, { name: 'Later edit' });
      finish('/lab/first.wpdesign.json');
    });
    await act(async () => {
      expect(await result).toBe(false);
    });
    expect(useDesignStore.getState().draftDesignIds[designId]).toBe(true);
    expect(useCanvasStore.getState().panels.main.tabs[0].artifactDocument?.persistence).toBe(
      'draft'
    );
    expect(useDesignStore.getState().designs[designId].name).toBe('Later edit');
  });

  it('materializes every transient stage in the same MoClo factory run', async () => {
    const { designId, tab } = openDraftAssembly();
    const siblingId = useDesignStore
      .getState()
      .createDraftDesign('Downstream Assembly', 'goldengate');
    const factory = {
      runId: 'factory-run-1',
      kitId: 'ytk',
      kitRevision: 1,
      recipeId: 'ytk-multigene-device',
      stageInputs: [],
    };
    useDesignStore.setState((state) => ({
      designs: {
        ...state.designs,
        [designId]: {
          ...state.designs[designId],
          mocloFactory: { ...factory, stageId: 'cassette-vector' },
        },
        [siblingId]: {
          ...state.designs[siblingId],
          mocloFactory: { ...factory, stageId: 'multigene-device' },
        },
      },
    }));
    materializationMocks.ensureDesignArtifact.mockImplementation(async ({ design }) => {
      return `/lab/${design.name}.wpdesign.json`;
    });
    render(<DesignTab designId={designId} tab={tab} panelId="main" />);

    await act(async () => {
      void documentLifecycle.save({ kind: 'tab', tabId: tab.id }, tab.id);
    });

    await waitFor(() => {
      expect(materializationMocks.ensureDesignArtifact).toHaveBeenCalledTimes(2);
      expect(
        materializationMocks.ensureDesignArtifact.mock.calls.map(([input]) => input.design.id)
      ).toEqual([designId, siblingId]);
      expect(useDesignStore.getState().draftDesignIds[designId]).toBeUndefined();
      expect(useDesignStore.getState().draftDesignIds[siblingId]).toBeUndefined();
    });
  });
});

describe('DesignTab rename and artifact actions', () => {
  it('uses Windows copy/paste shortcut labels in the empty assembly onboarding hint', () => {
    mockNavigatorPlatform('Win32');
    const designId = useDesignStore.getState().createDesign('Windows Assembly');

    render(<DesignTab designId={designId} />);

    expect(screen.getByText('Ctrl+C')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+V')).toBeInTheDocument();
    expect(screen.queryByText('Cmd+C')).not.toBeInTheDocument();
    expect(screen.queryByText('Cmd+V')).not.toBeInTheDocument();
  });

  it('keeps Command copy/paste shortcut labels on macOS', () => {
    mockNavigatorPlatform('MacIntel');
    const designId = useDesignStore.getState().createDesign('Mac Assembly');

    render(<DesignTab designId={designId} />);

    expect(screen.getByText('Command+C')).toBeInTheDocument();
    expect(screen.getByText('Command+V')).toBeInTheDocument();
  });

  it('shows a rename icon that opens the same inline editor on one click', async () => {
    const designId = useDesignStore.getState().createDesign('Original Assembly');
    useCanvasStore.getState().openTab('main', {
      type: 'design',
      entityId: designId,
      label: 'Original Assembly',
    });

    render(<DesignTab designId={designId} />);

    fireEvent.click(screen.getByTestId('design-rename-button'));

    const input = await screen.findByTestId('design-name-input');
    expect(input).toHaveValue('Original Assembly');

    fireEvent.change(input, { target: { value: 'Renamed Assembly' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(useDesignStore.getState().designs[designId].name).toBe('Renamed Assembly');
    });
    const tab = useCanvasStore
      .getState()
      .panels.main.tabs.find((item) => item.entityId === designId);
    expect(tab?.label).toBe('Renamed Assembly');
  });

  it('renames the backing design artifact when the assembly viewer title is renamed', async () => {
    const designId = useDesignStore.getState().createDesign('Old Assembly');
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          tabs: [{ id: 'tab-1', type: 'design', entityId: designId, label: 'Old Assembly' }],
          activeTabId: 'tab-1',
        },
      },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
    });

    const workspaceEvents: Array<{ path?: string }> = [];
    const handleWorkspaceFilesChanged = (event: Event) => {
      workspaceEvents.push((event as CustomEvent<{ path?: string }>).detail);
    };
    window.addEventListener('waypoint:workspace-files-changed', handleWorkspaceFilesChanged);

    render(<DesignTab designId={designId} />);

    fireEvent.doubleClick(screen.getByText('Old Assembly'));
    const input = await screen.findByDisplayValue('Old Assembly');
    fireEvent.change(input, { target: { value: 'Renamed Assembly' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(artifactMocks.renameDesignArtifactFile).toHaveBeenCalledWith({
        designId,
        name: 'Renamed Assembly',
      });
      expect(useDesignStore.getState().designs[designId].name).toBe('Renamed Assembly');
      expect(useCanvasStore.getState().panels.main.tabs[0].label).toBe('Renamed Assembly');
    });

    await waitFor(() => {
      expect(workspaceEvents).toContainEqual({ path: '/lab/Renamed Assembly.wpdesign.json' });
    });

    window.removeEventListener('waypoint:workspace-files-changed', handleWorkspaceFilesChanged);
  });

  it('confirms the rename on Enter even while the artifact file rename is still in flight', async () => {
    let resolveRename: ((value: unknown) => void) | undefined;
    artifactMocks.renameDesignArtifactFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRename = resolve;
        })
    );

    const designId = useDesignStore.getState().createDesign('Old Assembly');
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          tabs: [{ id: 'tab-1', type: 'design', entityId: designId, label: 'Old Assembly' }],
          activeTabId: 'tab-1',
        },
      },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
    });

    render(<DesignTab designId={designId} />);
    fireEvent.click(screen.getByTestId('design-rename-button'));
    const input = await screen.findByTestId('design-name-input');
    fireEvent.change(input, { target: { value: 'Renamed Assembly' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(useDesignStore.getState().designs[designId].name).toBe('Renamed Assembly');
      expect(screen.queryByTestId('design-name-input')).toBeNull();
    });

    resolveRename?.(null);
  });

  it('confirms the rename on Enter even when the artifact file rename fails', async () => {
    artifactMocks.renameDesignArtifactFile.mockRejectedValue(
      new Error('EACCES: artifact write failed')
    );

    const designId = useDesignStore.getState().createDesign('Old Assembly');
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          tabs: [{ id: 'tab-1', type: 'design', entityId: designId, label: 'Old Assembly' }],
          activeTabId: 'tab-1',
        },
      },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
    });

    render(<DesignTab designId={designId} />);
    fireEvent.click(screen.getByTestId('design-rename-button'));
    const input = await screen.findByTestId('design-name-input');
    fireEvent.change(input, { target: { value: 'Renamed Assembly' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(useDesignStore.getState().designs[designId].name).toBe('Renamed Assembly');
      expect(screen.queryByTestId('design-name-input')).toBeNull();
    });
  });

  it('keeps method, draft, and graduate off the design-tab toolbar', () => {
    const designId = useDesignStore.getState().createDesign('Old Assembly');
    useDesignStore.getState().addRegion(designId, {
      sourceSequenceId: 'source-1',
      sourceSequenceName: 'Source Sequence',
      sourceStart: 0,
      sourceEnd: 6,
      sequence: 'ATGCGT',
      annotations: [],
    });

    render(<DesignTab designId={designId} />);

    expect(screen.queryByTestId('draft-assembly-button')).toBeNull();
    expect(screen.queryByTestId('graduate-design-button')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByTestId('assembly-drawer-toggle')).toBeVisible();
  });

  it('omits Deep Share from the artifact eyebrow while sharing is paused', () => {
    const designId = useDesignStore.getState().createDesign('Shareable Assembly');
    useDesignStore.getState().addRegion(designId, {
      sourceSequenceId: 'source-1',
      sourceSequenceName: 'Source Sequence',
      sourceStart: 0,
      sourceEnd: 6,
      sequence: 'ATGCGT',
      annotations: [],
    });

    render(<DesignTab designId={designId} />);

    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
    expect(screen.getByTestId('assembly-drawer-toggle')).toBeVisible();
  });
});

describe('DesignTab assembly product projection', () => {
  it('does not open a detached toolbar when a colored map part is selected', () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Assembly');
    store.addRegion(designId, createRegion('A', 'AAAA'));
    store.addRegion(designId, createRegion('B', 'CCCC'));
    store.addRegion(designId, createRegion('C', 'GGGG'));

    render(<DesignTab designId={designId} />);

    act(() => {
      latestWorkspaceViewerProps().onMapPositionClick(6);
    });

    expect(screen.queryByTestId('assembly-map-part-toolbar')).toBeNull();
    expect(useDesignStore.getState().designs[designId].regions).toHaveLength(3);
  });

  it('edits a mixed-case degenerate spacer at an exact map caret and redraws immediately', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Assembly');
    store.addRegion(designId, createRegion('A', 'AAAA'));
    store.addRegion(designId, createRegion('B', 'CCCC'));
    store.clearDraftAssembly(designId);

    render(<DesignTab designId={designId} />);

    act(() => {
      latestWorkspaceViewerProps().onMapPositionClick(4);
    });

    expect(screen.queryByTestId('assembly-map-part-toolbar')).toBeNull();
    expect(screen.queryByTestId('assembly-map-junction-toolbar')).toBeNull();
    expect(latestWorkspaceViewerProps().mapEditCursorPosition).toBe(4);
    expect(latestWorkspaceViewerProps().mapEditCursorBlinking).toBe(true);

    for (const [index, key] of [...'aRnY'].entries()) {
      act(() => pressAssemblyMapKey(key));
      expect(useDesignStore.getState().designs[designId].spacers[0].sequence).toBe(
        'aRnY'.slice(0, index + 1)
      );
      expect(latestWorkspaceViewerProps().mapEditCursorPosition).toBe(5 + index);
      expect(latestWorkspaceViewerProps().mapEditCursorBlinking).toBe(true);
    }
    expect(latestWorkspaceViewerProps().sequence.sequence).toBe('AAAAaRnYCCCC');

    act(() => latestWorkspaceViewerProps().onMapCursorNavigate(junctionMapNavigation(7, false)));
    act(() => latestWorkspaceViewerProps().onMapCursorNavigate(junctionMapNavigation(6, false)));
    expect(latestWorkspaceViewerProps().mapEditCursorPosition).toBe(6);
    act(() => pressAssemblyMapKey('k'));
    expect(useDesignStore.getState().designs[designId].spacers[0].sequence).toBe('aRknY');
    expect(latestWorkspaceViewerProps().mapEditCursorPosition).toBe(7);
    act(() => latestWorkspaceViewerProps().onMapCursorNavigate(junctionMapNavigation(8, false)));
    act(() => pressAssemblyMapKey('Backspace'));
    expect(useDesignStore.getState().designs[designId].spacers[0].sequence).toBe('aRkY');
    expect(latestWorkspaceViewerProps().mapEditCursorPosition).toBe(7);

    act(() => pressAssemblyMapKey('X'));
    expect(useDesignStore.getState().designs[designId].spacers[0].sequence).toBe('aRkY');
    expect(latestWorkspaceViewerProps().mapEditCursorPosition).toBe(7);

    act(() => latestWorkspaceViewerProps().onMapPositionClick(5));
    act(() => pressAssemblyMapKey('d'));
    expect(useDesignStore.getState().designs[designId].spacers[0].sequence).toBe('adRkY');
    expect(latestWorkspaceViewerProps().mapEditCursorPosition).toBe(6);
    act(() => pressAssemblyMapKey('Escape'));
    expect(latestWorkspaceViewerProps().mapEditCursorPosition).toBeUndefined();
    expect(latestWorkspaceViewerProps().mapEditCursorBlinking).toBe(false);
    act(() => pressAssemblyMapKey('G'));
    expect(screen.queryByTestId('assembly-map-junction-toolbar')).toBeNull();
    expect(useDesignStore.getState().designs[designId].spacers[0].sequence).toBe('adRkY');
  });

  it('leaves spacer edit mode when map navigation crosses a junction or starts a range', () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Assembly');
    store.addRegion(designId, createRegion('A', 'AAAA'));
    store.addRegion(designId, createRegion('B', 'CCCC'));
    store.clearDraftAssembly(designId);
    store.setJunctionSpacer(designId, 0, 'GG');

    render(<DesignTab designId={designId} />);

    act(() => latestWorkspaceViewerProps().onMapPositionClick(5));
    expect(latestWorkspaceViewerProps().mapEditCursorPosition).toBe(5);
    expect(latestWorkspaceViewerProps().mapEditCursorBlinking).toBe(true);

    act(() => latestWorkspaceViewerProps().onMapCursorNavigate(junctionMapNavigation(6, false)));
    expect(latestWorkspaceViewerProps().mapEditCursorPosition).toBe(6);
    expect(latestWorkspaceViewerProps().mapEditCursorBlinking).toBe(true);

    act(() => latestWorkspaceViewerProps().onMapCursorNavigate(junctionMapNavigation(7, false)));
    expect(latestWorkspaceViewerProps().mapEditCursorPosition).toBeUndefined();
    expect(latestWorkspaceViewerProps().mapEditCursorBlinking).toBe(false);

    act(() => latestWorkspaceViewerProps().onMapPositionClick(5));
    act(() => latestWorkspaceViewerProps().onMapCursorNavigate(junctionMapNavigation(6, true)));
    expect(latestWorkspaceViewerProps().mapEditCursorPosition).toBeUndefined();
    expect(latestWorkspaceViewerProps().mapEditCursorBlinking).toBe(false);
    expect(useDesignStore.getState().designs[designId].spacers[0].sequence).toBe('GG');
  });

  it.each(['forward', 'reverse'] as const)(
    'previews the exact %s primer bases before committing a map-handle drag',
    async (direction) => {
      const store = useDesignStore.getState();
      const designId = store.createDesign('Assembly', 'circular', 'goldengate');
      store.addRegion(designId, createRegion('A', 'AACCGT'.repeat(12)));
      store.addRegion(designId, createRegion('B', 'TTGGCA'.repeat(12)));
      await draftAssemblyAndWait(designId);

      const before = useDesignStore.getState().designs[designId];
      const canonicalPrimer = before.designPrimers[0][direction];
      const requestedLength = canonicalPrimer.pbs.sequence.length + 2;

      render(<DesignTab designId={designId} />);
      const mapPrimer = latestWorkspaceViewerProps().primers.find(
        (primer: { id: string }) => primer.id === canonicalPrimer.id
      );
      expect(mapPrimer).toBeDefined();

      let previewPrimer: {
        start: number;
        end: number;
        bases: string;
      } | null = null;
      act(() => {
        previewPrimer = latestWorkspaceViewerProps().onMapPrimerPbsLengthPreview(
          mapPrimer,
          requestedLength
        );
      });

      expect(previewPrimer).not.toBeNull();
      const stillCanonical = useDesignStore.getState().designs[designId];
      expect(previewPrimer?.bases).toHaveLength(canonicalPrimer.sequence.length + 2);
      expect(previewPrimer?.bases).not.toBe(canonicalPrimer.sequence);
      expect(direction === 'forward' ? previewPrimer?.end : previewPrimer?.start).toBe(
        direction === 'forward' ? mapPrimer.end + 2 : mapPrimer.start - 2
      );
      expect(stillCanonical.version).toBe(before.version);
      expect(stillCanonical.designPrimers[0][direction].sequence).toBe(canonicalPrimer.sequence);

      act(() => {
        latestWorkspaceViewerProps().onMapPrimerPbsLengthCommit(mapPrimer, requestedLength);
      });

      const committed = useDesignStore.getState().designs[designId];
      expect(committed.designPrimers[0][direction].sequence).toBe(previewPrimer?.bases);
      expect(committed.version).toBe(before.version + 1);
    }
  );

  it('does not resurrect a detached junction box when copied DNA exists', () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Assembly');
    store.addRegion(designId, createRegion('A', 'AAAA'));
    store.addRegion(designId, createRegion('B', 'CCCC'));
    useRichSequenceClipboardStore.getState().setCopiedRegion({
      sequence: 'TTTT',
      sourceSequence: 'GGTTTTAA',
      sourceId: '/tmp/puc19-pcr.gb',
      sourceName: 'pUC19 PCR fragment',
      start: 2,
      end: 6,
      annotations: [],
      sourceType: 'pcr',
    });

    render(<DesignTab designId={designId} />);
    act(() => {
      latestWorkspaceViewerProps().onMapPositionClick(4);
    });

    expect(screen.queryByTestId('assembly-map-junction-toolbar')).toBeNull();
  });

  it('projects copied-fragment context into the map paste hint and menu target', () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Assembly');
    store.addRegion(designId, createRegion('A', 'AAAA'));
    store.addRegion(designId, createRegion('B', 'CCCC'));
    useRichSequenceClipboardStore.getState().setCopiedRegion({
      sequence: 'TTTT',
      sourceSequence: 'GGTTTTAA',
      sourceId: '/tmp/puc19-pcr.gb',
      sourceName: 'pUC19 PCR fragment',
      start: 2,
      end: 6,
      annotations: [],
      sourceType: 'pcr',
    });

    render(<DesignTab designId={designId} />);

    expect(latestWorkspaceViewerProps()).toMatchObject({
      pasteTargetLabel: 'pUC19 PCR fragment · 4 bp',
      mapPasteHint: 'Right-click to paste pUC19 PCR fragment · 4 bp at this position',
    });
  });

  it('does not expose the rejected floating reverse-complement control', () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Assembly');
    store.addRegion(
      designId,
      createRegion('A', 'AACCGT', {
        sourceStart: 2,
        sourceEnd: 8,
        sourceSequence: 'AAAACCGTGGTT',
        sourceLength: 12,
      })
    );

    render(<DesignTab designId={designId} />);
    act(() => {
      latestWorkspaceViewerProps().onMapPositionClick(2);
    });

    expect(screen.queryByTestId('assembly-map-reverse-complement')).toBeNull();
    expect(useDesignStore.getState().designs[designId].regions[0].sequence).toBe('AACCGT');
  });

  it('keeps part selection and reverse complement while withholding WebGL reorder callbacks', () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Assembly');
    store.addRegion(
      designId,
      createRegion('A', 'AACCGT', {
        sourceStart: 2,
        sourceEnd: 8,
        sourceSequence: 'AAAACCGTGGTT',
        sourceLength: 12,
      })
    );

    render(<DesignTab designId={designId} />);

    expect(latestWorkspaceViewerProps().onMapPartSelect).toEqual(expect.any(Function));
    expect(latestWorkspaceViewerProps().onMapPartReverseComplement).toEqual(expect.any(Function));
    expect(latestWorkspaceViewerProps().onMapPartReorderPreview).toBeUndefined();
    expect(latestWorkspaceViewerProps().onMapPartReorderCommit).toBeUndefined();
  });

  it('propagates product reorder with stable part colors to sequence viewer backbone props', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Assembly');
    store.addRegion(designId, createRegion('A', 'AAAA'));
    store.addRegion(designId, createRegion('B', 'CCCC'));
    store.addRegion(designId, createRegion('C', 'GGGG'));

    render(<DesignTab designId={designId} />);

    await waitFor(() => {
      expect(latestWorkspaceViewerProps().sequence.sequence).toBe('AAAACCCCGGGG');
    });
    expect(
      latestWorkspaceViewerProps().backboneSegments.map(
        (segment: { label: string; color: string }) => ({
          label: segment.label.split(' ')[0],
          color: segment.color,
        })
      )
    ).toEqual([
      { label: 'A', color: '#3b82f6' },
      { label: 'B', color: '#10b981' },
      { label: 'C', color: '#f59e0b' },
    ]);

    const segments = selectProductLayout(useDesignStore.getState().designs[designId]);
    const byLabel = new Map(
      segments.map((segment) => [
        segment.kind === 'part' ? segment.region.sourceSequenceName : 'spacer',
        productLayoutSegmentId(segment),
      ])
    );

    act(() => {
      useDesignStore
        .getState()
        .reorderProductLayoutSegments(designId, [
          byLabel.get('C')!,
          byLabel.get('A')!,
          byLabel.get('B')!,
        ]);
    });

    await waitFor(() => {
      expect(latestWorkspaceViewerProps().sequence.sequence).toBe('GGGGAAAACCCC');
    });

    const updatedDesign = useDesignStore.getState().designs[designId];
    expect(updatedDesign.regions.map((region) => region.sourceSequenceName)).toEqual([
      'C',
      'A',
      'B',
    ]);
    expect(updatedDesign.regions.map((region) => region.colorIndex)).toEqual([2, 0, 1]);
    expect(
      latestWorkspaceViewerProps().backboneSegments.map(
        (segment: { start: number; end: number; label: string; color: string }) => ({
          start: segment.start,
          end: segment.end,
          label: segment.label.split(' ')[0],
          color: segment.color,
        })
      )
    ).toEqual([
      { start: 0, end: 4, label: 'C', color: '#f59e0b' },
      { start: 4, end: 8, label: 'A', color: '#3b82f6' },
      { start: 8, end: 12, label: 'B', color: '#10b981' },
    ]);
  });

  it('passes retained homology RD scar annotations to the sequence viewer product surface', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('RD scar assembly');
    store.addRegion(
      designId,
      createRegion('RD', 'ATGCATGCCTGCA', {
        sourceType: 'rd',
        rdSourceEnzymeName: 'PstI',
        rdOverhangs: { upstream: 'NNNN', downstream: 'TGCA' },
        rdEnds: {
          downstream: {
            overhangType: '3_prime',
            overhang: 'TGCA',
            retainedScarSequence: 'CTGCA',
            retainedScarLength: 5,
          },
        },
      })
    );
    store.addRegion(designId, createRegion('PCR', 'GGGGCCCC'));

    render(<DesignTab designId={designId} />);

    await waitFor(() => {
      const sequence = latestWorkspaceViewerProps().sequence;
      const scar = sequence.annotations.find(
        (annotation: { type: string }) => annotation.type === 'restriction_scar'
      );
      expect(scar).toMatchObject({
        name: 'PstI downstream RD scar',
        start: 9,
        end: 13,
      });
      expect(sequence.sequence.slice(scar.start - 1, scar.end)).toBe('CTGCA');
    });
  });

  it.each(['before drafting', 'after clearing primers'] as const)(
    'previews physical Golden Gate scars %s without primer outlines',
    async (phase) => {
      const store = useDesignStore.getState();
      const designId = store.createDesign('Golden Gate fusion sites', 'circular', 'goldengate');
      store.addRegion(
        designId,
        createRegion('A', 'GGAGAAAATACT', {
          sourceType: 'rd',
          rdSourceEnzyme: 'BsaI',
          rdOverhangs: { upstream: 'GGAG', downstream: 'TACT' },
        })
      );
      store.addRegion(
        designId,
        createRegion('B', 'TACTCCCCGGAG', {
          sourceType: 'rd',
          rdSourceEnzyme: 'BsaI',
          rdOverhangs: { upstream: 'TACT', downstream: 'GGAG' },
        })
      );
      if (phase === 'after clearing primers') {
        await draftAssemblyAndWait(designId);
        store.clearDraftAssembly(designId);
      }

      render(<DesignTab designId={designId} />);

      await waitFor(() => {
        const sequence = latestWorkspaceViewerProps().sequence;
        expect(
          latestWorkspaceViewerProps().primers.every(
            (primer: { isScarMarkerOnly?: boolean }) => primer.isScarMarkerOnly
          )
        ).toBe(true);
        const duplicateFusionAnnotations = sequence.annotations.filter(
          (annotation: { type: string }) => annotation.type === 'enforced_overhang'
        );
        expect(duplicateFusionAnnotations).toEqual([]);
        expect(
          latestWorkspaceViewerProps().plasmid.features.filter(
            (feature: { type: string }) => feature.type === 'enforced_overhang'
          )
        ).toEqual([]);
        expect(
          latestWorkspaceViewerProps()
            .primers.filter((primer: { isScarMarkerOnly?: boolean }) => primer.isScarMarkerOnly)
            .map((primer: { id: string; start: number; end: number }) => ({
              id: primer.id,
              start: primer.start,
              end: primer.end,
            }))
        ).toEqual([
          { id: 'scar-marker-0', start: 12, end: 16 },
          { id: 'scar-marker-1', start: 0, end: 4 },
        ]);
      });
    }
  );

  it('does not keep the Golden Gate enzyme selector on the design-tab toolbar', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Golden Gate RD Assembly', 'circular', 'goldengate');
    store.addRegion(
      designId,
      createRegion('RD', 'AAAACCCCGGGGGCTA', {
        sourceType: 'rd',
        ggType: 'insert',
        rdSourceEnzyme: 'BsaI',
        rdSourceEnzymeName: 'BsaI',
        rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
      })
    );
    store.addRegion(designId, createRegion('PCR', 'TTTTACGTACGTACGTACGT'));

    render(<DesignTab designId={designId} />);

    expect(screen.queryByDisplayValue('BsaI')).toBeNull();
    expect(screen.getByTestId('assembly-drawer-toggle')).toBeVisible();
  });
});

describe('DesignTab empty-placeholder parts ', () => {
  it('keeps the assembly building UI after adding the first blank placeholder part', () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Blank-first assembly');

    store.addRegion(designId, {
      sourceSequenceId: 'placeholder',
      sourceSequenceName: 'Empty slot',
      sourceStart: 0,
      sourceEnd: 0,
      sequence: '',
      annotations: [],
      isPlaceholder: true,
      sourceType: 'pcr',
    });
    expect(useDesignStore.getState().designs[designId].regions).toHaveLength(1);

    render(<DesignTab designId={designId} />);

    expect(screen.getByTestId('mock-design-drawer')).toBeInTheDocument();
    expect(screen.queryByText('Failed to compose sequence')).not.toBeInTheDocument();

    expect(screen.queryByTestId('mock-workspace-viewer')).not.toBeInTheDocument();
  });
});

describe('DesignTab first-part paste ', () => {
  function firePaste(text: string): void {
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      configurable: true,
      value: { getData: (type: string) => (type === 'text/plain' ? text : '') },
    });
    act(() => {
      document.dispatchEvent(pasteEvent);
    });
  }

  it('Cmd+V fills the FIRST empty placeholder part in place (not rejected, not appended)', () => {
    const SEQ = 'GATTACAGATTACA';
    const store = useDesignStore.getState();
    const designId = store.createDesign('Blank-first assembly');

    store.addRegion(designId, {
      sourceSequenceId: 'placeholder',
      sourceSequenceName: 'Empty slot',
      sourceStart: 0,
      sourceEnd: 0,
      sequence: '',
      annotations: [],
      isPlaceholder: true,
      sourceType: 'pcr',
    });
    useRichSequenceClipboardStore.getState().setCopiedRegion({
      sequence: SEQ,
      sourceId: '/tmp/copied.gb',
      sourceName: 'Copied source',
      start: 0,
      end: SEQ.length,
      annotations: [],
      sourceType: 'pcr',
    });

    render(<DesignTab designId={designId} />);

    expect(screen.queryByTestId('mock-workspace-viewer')).not.toBeInTheDocument();

    firePaste(SEQ);

    const regions = useDesignStore.getState().designs[designId].regions;

    expect(regions).toHaveLength(1);
    expect(regions[0].sequence).toBe(SEQ);
    expect(regions[0].sourceSequenceName).toBe('Copied source');
    expect(regions[0].isPlaceholder).toBeFalsy();
  });

  it('still rejects Cmd+V when real parts exist and there is no placeholder or junction', () => {
    const SEQ = 'GATTACAGATTACA';
    const store = useDesignStore.getState();
    const designId = store.createDesign('Two real parts');

    store.addRegion(designId, createRegion('part-A', 'AAAACCCCGGGGTTTT'));
    store.addRegion(designId, createRegion('part-B', 'TTTTGGGGCCCCAAAA'));
    useRichSequenceClipboardStore.getState().setCopiedRegion({
      sequence: SEQ,
      sourceId: '/tmp/copied.gb',
      sourceName: 'Copied source',
      start: 0,
      end: SEQ.length,
      annotations: [],
      sourceType: 'pcr',
    });

    render(<DesignTab designId={designId} />);
    firePaste(SEQ);

    const regions = useDesignStore.getState().designs[designId].regions;
    expect(regions).toHaveLength(2);
    expect(regions.map((r) => r.sourceSequenceName)).toEqual(['part-A', 'part-B']);
  });
});

function latestWorkspaceViewerProps(): any {
  const calls = workspaceViewerSpy.mock.calls;
  return calls[calls.length - 1]?.[0];
}

function pressAssemblyMapKey(key: string): void {
  latestWorkspaceViewerProps().onMapKeyDown({
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });
}

function junctionMapNavigation(position: number, selecting: boolean) {
  return { position, selecting };
}

function createRegion(
  sourceSequenceName: string,
  sequence: string,
  overrides: Partial<DesignRegion> = {}
): Omit<DesignRegion, 'id'> {
  return {
    sourceSequenceId: `source-${sourceSequenceName}`,
    sourceSequenceName,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
    ...overrides,
  };
}

describe('active design release on close ', () => {
  function openDesignTab(designId: string, tabId: string, panelId = 'main'): void {
    useCanvasStore.setState((state) => {
      const panel = state.panels[panelId] ?? { ...state.panels.main, tabs: [] };
      return {
        panels: {
          ...state.panels,
          [panelId]: {
            ...panel,
            tabs: [
              ...panel.tabs,
              { id: tabId, type: 'design', entityId: designId, label: designId },
            ],
            activeTabId: tabId,
          },
        },
      };
    });
  }
  function closeDesignTab(designId: string, panelId = 'main'): void {
    useCanvasStore.setState((state) => ({
      panels: {
        ...state.panels,
        [panelId]: {
          ...state.panels[panelId],
          tabs: state.panels[panelId].tabs.filter((t) => t.entityId !== designId),
        },
      },
    }));
  }

  it('clears the pointer when the last assembly tab closes', () => {
    const designId = useDesignStore.getState().createDesign('Only Assembly');
    openDesignTab(designId, 'tab-1');
    const { unmount } = render(<DesignTab designId={designId} />);
    expect(useDesignStore.getState().activeDesignId).toBe(designId);

    closeDesignTab(designId);
    unmount();

    expect(useDesignStore.getState().activeDesignId).toBeNull();
  });

  it('hands the pointer to another open assembly rather than clearing it', () => {
    const staying = useDesignStore.getState().createDesign('Staying Open');
    const closing = useDesignStore.getState().createDesign('Being Closed');
    openDesignTab(staying, 'tab-1');
    openDesignTab(closing, 'tab-2');
    const { unmount } = render(<DesignTab designId={closing} />);
    expect(useDesignStore.getState().activeDesignId).toBe(closing);

    closeDesignTab(closing);
    unmount();

    expect(useDesignStore.getState().activeDesignId).toBe(staying);
  });

  it('keeps the pointer when the same design is still open in ANOTHER PANEL', () => {
    const designId = useDesignStore.getState().createDesign('Split View');
    openDesignTab(designId, 'tab-1', 'main');
    openDesignTab(designId, 'tab-2', 'split');
    const { unmount } = render(<DesignTab designId={designId} />);
    expect(useDesignStore.getState().activeDesignId).toBe(designId);

    closeDesignTab(designId, 'split');
    unmount();

    expect(useDesignStore.getState().activeDesignId).toBe(designId);
  });

  it('is not involved at all when a tab is DRAGGED to another panel', () => {
    const dragged = useDesignStore.getState().createDesign('Dragged');
    const elsewhere = useDesignStore.getState().createDesign('Elsewhere');
    openDesignTab(elsewhere, 'tab-other', 'main');
    openDesignTab(dragged, 'tab-1', 'main');
    openDesignTab(elsewhere, 'tab-seed', 'split');
    render(<DesignTab designId={dragged} />);
    expect(useDesignStore.getState().activeDesignId).toBe(dragged);

    useCanvasStore.getState().moveTab('main', 'split', 'tab-1');

    expect(useDesignStore.getState().activeDesignId).toBe(dragged);
  });

  it('hands off to the design the canvas made ACTIVE, not the first tab', () => {
    const a = useDesignStore.getState().createDesign('A hidden');
    const b = useDesignStore.getState().createDesign('B promoted');
    const c = useDesignStore.getState().createDesign('C closing');
    openDesignTab(a, 'tab-a');
    openDesignTab(b, 'tab-b');
    openDesignTab(c, 'tab-c');
    const closing = render(<DesignTab designId={c} />);
    expect(useDesignStore.getState().activeDesignId).toBe(c);

    useCanvasStore.getState().closeTab('main', 'tab-c');
    expect(useCanvasStore.getState().panels.main.activeTabId).toBe('tab-b');
    closing.unmount();

    expect(useDesignStore.getState().activeDesignId).toBe(b);
  });

  it('repairs the pointer when a whole PANEL closes', () => {
    const surviving = useDesignStore.getState().createDesign('Surviving pane');
    const doomed = useDesignStore.getState().createDesign('Doomed pane');
    openDesignTab(surviving, 'tab-keep', 'main');
    openDesignTab(doomed, 'tab-doomed', 'split');
    const doomedTab = render(<DesignTab designId={doomed} />);
    expect(useDesignStore.getState().activeDesignId).toBe(doomed);

    useCanvasStore.getState().closePanel('split');
    doomedTab.unmount();

    expect(useDesignStore.getState().activeDesignId).toBe(surviving);
  });

  it('repairs a pointer that names a design with NO open tab', () => {
    const visible = useDesignStore.getState().createDesign('Visible');
    openDesignTab(visible, 'tab-1');
    const onlyTab = render(<DesignTab designId={visible} />);
    expect(useDesignStore.getState().activeDesignId).toBe(visible);

    const orphan = useDesignStore.getState().createDesign('Orphan, no tab');
    expect(useDesignStore.getState().activeDesignId).toBe(orphan);

    closeDesignTab(visible);
    onlyTab.unmount();

    expect(useDesignStore.getState().activeDesignId).toBeNull();
  });

  it('does not touch the pointer when a NON-active assembly tab closes', () => {
    const bystander = useDesignStore.getState().createDesign('Bystander');
    const active = useDesignStore.getState().createDesign('Active One');
    const other = useDesignStore.getState().createDesign('Other One');
    openDesignTab(bystander, 'tab-0');
    openDesignTab(active, 'tab-1');
    openDesignTab(other, 'tab-2');

    const otherTab = render(<DesignTab designId={other} />);
    render(<DesignTab designId={active} />);
    expect(useDesignStore.getState().activeDesignId).toBe(active);

    closeDesignTab(other);
    otherTab.unmount();

    expect(useDesignStore.getState().activeDesignId).toBe(active);
  });

  it('does not re-serialize the whole design corpus when the pointer is unchanged', () => {
    const designId = useDesignStore.getState().createDesign('Stable Pointer');

    const other = useDesignStore.getState().createDesign('Somewhere Else');
    openDesignTab(designId, 'tab-1');
    render(<DesignTab designId={designId} />);
    expect(useDesignStore.getState().activeDesignId).toBe(designId);

    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const designWrites = () =>
      setItem.mock.calls.filter(([key]) => key === 'waypoint-designs').length;
    try {
      useDesignStore.getState().setActiveDesign(designId);
      expect(designWrites()).toBe(0);

      setItem.mockClear();
      useDesignStore.getState().setActiveDesign(other);
      expect(designWrites()).toBeGreaterThan(0);
    } finally {
      setItem.mockRestore();
    }
  });
});

describe(' — DesignTab declares itself as the assembly surface', () => {
  it('passes surface="assembly" so the map-only default applies', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Assembly');
    store.addRegion(designId, createRegion('A', 'AAAA'));

    render(<DesignTab designId={designId} />);

    await waitFor(() => {
      expect(latestWorkspaceViewerProps()).toBeTruthy();
    });
    expect(latestWorkspaceViewerProps().surface).toBe('assembly');
  });
});

describe(' — first-class MoClo assembly workspace', () => {
  it('keeps the real viewer mounted and projects every empty schema slot as a scaffold', async () => {
    const fixture = ytkMocloFactoryExpressionCassette();
    const fixtureDesign = Object.values(fixture.designs?.designs ?? {}).find(
      (candidate) => candidate.goldenGateSchema
    );
    if (!fixtureDesign?.goldenGateSchema) throw new Error('YTK fixture schema is unavailable.');

    const store = useDesignStore.getState();
    const designId = store.createDraftDesign('Untitled Assembly', 'goldengate');
    const result = store.setGoldenGateSchema(designId, fixtureDesign.goldenGateSchema, 0);
    if (result.status !== 'applied')
      throw new Error(`Could not apply YTK schema: ${result.status}`);

    render(<DesignTab designId={designId} />);

    expect(screen.queryByTestId('moclo-assembly-workspace')).not.toBeInTheDocument();
    expect(screen.queryByTestId('moclo-schema-strip')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('mock-workspace-viewer')).toBeInTheDocument();
    });
    const props = latestWorkspaceViewerProps();
    expect(props.sequence.sequence).toBe('');
    expect(props.plasmid.length).toBe(0);
    expect(props.backboneSegments).toHaveLength(fixtureDesign.goldenGateSchema.slots.length);
    expect(
      (props.backboneSegments as Array<{ scaffold?: unknown }>).every((segment) => segment.scaffold)
    ).toBe(true);
    expect(props.hideMinimap).toBeUndefined();
    expect(props.alternateMinimapContent).toBeUndefined();
    expect(screen.queryByTestId('assembly-schema-draft-map')).not.toBeInTheDocument();

    const firstScaffold = props.backboneSegments[0];
    act(() =>
      props.onMapPartSelect({
        regionId: firstScaffold.regionId,
        rangeStart: firstScaffold.start,
        rangeEnd: firstScaffold.end,
        isScaffold: true,
        scaffold: firstScaffold.scaffold,
      })
    );
    const selectedProps = latestWorkspaceViewerProps();
    expect(selectedProps.mapSelectedPartRegionId).toBe(firstScaffold.regionId);
    expect(selectedProps.drawerSlot.props.schemaPickerRequest).toBeUndefined();
  });

  it('keeps the map mounted without restoring the flagged-off schema strip', () => {
    const scenario = cidarMocloRedFluorescentTu();
    const design = scenario.designs?.designs[CIDAR_MOCLO_RED_TU_DESIGN_ID];
    if (!design) throw new Error('CIDAR fixture design is unavailable.');
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });
    const versionBefore = design.version;
    const orderBefore = design.regions.map((region) => region.id);

    render(<DesignTab designId={design.id} />);

    expect(screen.queryByTestId('moclo-assembly-workspace')).not.toBeInTheDocument();
    expect(screen.queryByTestId('moclo-schema-strip')).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-workspace-viewer')).toBeInTheDocument();
    expect(screen.queryByTestId('moclo-workspace-toggle')).not.toBeInTheDocument();
    expect(latestWorkspaceViewerProps().drawerSlot).toBeTruthy();
    expect(screen.queryByTestId('mock-design-drawer')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('assembly-drawer-toggle'));
    expect(screen.queryByTestId('moclo-assembly-workspace')).not.toBeInTheDocument();
    expect(screen.queryByTestId('moclo-schema-strip')).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-workspace-viewer')).toBeInTheDocument();
    expect(screen.getByTestId('assembly-drawer-toggle')).toHaveAttribute('aria-pressed', 'false');
    expect(latestWorkspaceViewerProps().drawerSlot).toBeUndefined();

    const currentDesign = useDesignStore.getState().designs[design.id];
    expect(currentDesign.version).toBe(versionBefore);
    expect(currentDesign.regions.map((region) => region.id)).toEqual(orderBefore);
  });
});
