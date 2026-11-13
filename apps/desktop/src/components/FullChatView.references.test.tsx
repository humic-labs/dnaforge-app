import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FullChatView,
  createEntityReference,
  getFullChatViewReferenceRootCacheDiagnostics,
  getFullChatViewHarness,
  getEntityReferencesByIds,
  getMessageReferences,
  holdNextFullChatViewReferenceTargetResolutionForTest,
  navigateToReference,
  resetFullChatViewHarness,
  useCanvasStore,
  useWorkspaceStore,
  useToastStore,
} from './FullChatView.test-harness';

const {
  mockChatState,
  mockOpenSequenceFile,
  mockOpenStructureFile,
  mockResolveInlineReferenceTarget,
  mockSetEntityReferenceWorkspaceRootPathIfMissing,
} = getFullChatViewHarness();

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('FullChatView — reference navigation ownership', () => {
  beforeEach(() => {
    resetFullChatViewHarness();
    vi.mocked(navigateToReference).mockClear();
    useToastStore.setState({ toasts: [] });
  });

  it('passes the exact full-tab conversation as the reference navigation source', () => {
    const reference = {
      id: 'ref-structure',
      entity_type: 'structure',
      display_label: '3OAA residues',
      locator: 'entity://structure/PDB:3OAA',
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      created_at: 1,
      updated_at: 1,
    };
    mockChatState.currentConversationId = 'visible-conv';
    mockChatState.messages = [
      {
        id: 'tool-ref',
        role: 'tool',
        toolName: 'create_reference',
        content: JSON.stringify({ referenceData: reference }),
        createdAt: 1,
      },
    ];

    render(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);
    fireEvent.click(screen.getByTestId('mock-reference-ref-structure'));

    expect(navigateToReference).toHaveBeenCalledWith(reference, {
      sourceChatConversationId: 'visible-conv',
    });
  });

  it('declines to navigate an alignment reference and shows an info toast', () => {
    const reference = {
      id: 'ref-alignment',
      entity_type: 'alignment',
      display_label: 'MSA: GFP, GFP-variant',
      locator: 'entity://alignment/some-random-uuid',
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      created_at: 1,
      updated_at: 1,
    };
    mockChatState.currentConversationId = 'visible-conv';
    mockChatState.messages = [
      {
        id: 'tool-ref-alignment',
        role: 'tool',
        toolName: 'create_reference',
        content: JSON.stringify({ referenceData: reference }),
        createdAt: 1,
      },
    ];

    render(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);
    fireEvent.click(screen.getByTestId('mock-reference-ref-alignment'));

    expect(navigateToReference).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ type: 'info' });
  });

  it('opens a file-backed alignment reference in the text viewer path', () => {
    const reference = {
      id: 'ref-file-alignment',
      entity_type: 'alignment',
      display_label: 'pUC19-vs-variant.aln',
      locator: 'git://workspace/alignments/pUC19-vs-variant.aln',
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      created_at: 1,
      updated_at: 1,
    };
    mockChatState.currentConversationId = 'visible-conv';
    mockChatState.messages = [
      {
        id: 'tool-ref-file-alignment',
        role: 'tool',
        toolName: 'create_reference',
        content: JSON.stringify({ referenceData: reference }),
        createdAt: 1,
      },
    ];

    render(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);
    fireEvent.click(screen.getByTestId('mock-reference-ref-file-alignment'));

    expect(navigateToReference).toHaveBeenCalledWith(reference, {
      sourceChatConversationId: 'visible-conv',
    });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('does not invent a canvas source panel for scoped inline chat', () => {
    const reference = {
      id: 'ref-scoped',
      entity_type: 'structure',
      display_label: 'Scoped residues',
      locator: 'entity://structure/PDB:3OAA',
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      created_at: 1,
      updated_at: 1,
    };
    (mockChatState._convStates as Map<string, unknown>).set('scoped-B', {
      messages: [
        {
          id: 'tool-scoped-ref',
          role: 'tool',
          toolName: 'create_reference',
          content: JSON.stringify({ referenceData: reference }),
          createdAt: 1,
        },
      ],
      turns: {},
      activeTurnId: null,
      streamingBlocks: [],
      isLoading: false,
      isStreaming: false,
      error: null,
    });

    render(<FullChatView workspacePath="/workspace" conversationId="scoped-B" scoped />);
    fireEvent.click(screen.getByTestId('mock-reference-ref-scoped'));

    expect(navigateToReference).toHaveBeenCalledWith(reference, {
      sourceChatConversationId: null,
    });
  });

  it('opens one exact saved origin when a same-named replacement is mounted', async () => {
    const reference = {
      id: '8887a64e-1234-4678-9abc-def012345678',
      entity_type: 'sequence',
      display_label: 'pUC19.gb',
      locator: 'git://Samples/pUC19.gb',
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      workspace_scope: 'folders:["/original/Samples"]',
      workspace_root_path: '/original/Samples',
      created_at: 1,
      updated_at: 1,
    };
    mockChatState.currentConversationId = 'saved-origin-conv';
    mockChatState.conversations = [
      {
        id: 'saved-origin-conv',
        title: 'Saved origin',
        workspacePath: '/original/Samples',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    mockChatState.messages = [
      {
        id: 'assistant-saved-origin',
        role: 'assistant',
        content: `Open [pUC19](dnaforge-chat://reference/${reference.id}).`,
        createdAt: 1,
      },
    ];
    vi.mocked(getMessageReferences).mockResolvedValue([reference.id]);
    vi.mocked(getEntityReferencesByIds).mockResolvedValue([reference]);
    useWorkspaceStore.setState({
      folders: [{ name: 'Samples', path: '/replacement/Samples', addedAt: 2 }],
    });

    let releaseResolution: (() => void) | undefined;
    const resolution = new Promise<{
      ok: true;
      path: string;
      canonicalPath: string;
      canonicalRootPath: string;
      targetType: 'file';
    }>((resolve) => {
      releaseResolution = () =>
        resolve({
          ok: true,
          path: '/original/Samples/pUC19.gb',
          canonicalPath: '/original/Samples/pUC19.gb',
          canonicalRootPath: '/original/Samples',
          targetType: 'file',
        });
    });
    mockResolveInlineReferenceTarget.mockReturnValue(resolution);

    render(<FullChatView workspacePath="/replacement/Samples" />);
    const chip = await screen.findByTestId(`mock-reference-${reference.id}`);
    fireEvent.click(chip);
    fireEvent.click(chip);

    await waitFor(() => expect(mockResolveInlineReferenceTarget).toHaveBeenCalledTimes(1));
    expect(mockResolveInlineReferenceTarget).toHaveBeenCalledWith({
      roots: [{ name: 'Samples', path: '/original/Samples' }],
      root: 'Samples',
      segments: ['pUC19.gb'],
      targetKind: 'sequence',
    });

    releaseResolution?.();
    await waitFor(() => expect(mockOpenSequenceFile).toHaveBeenCalledTimes(1));
    expect(mockOpenSequenceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/original/Samples/pUC19.gb',
        label: 'pUC19.gb',
        strategy: { kind: 'smart' },
        signal: expect.any(AbortSignal),
      })
    );
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('durably adopts one recovered legacy origin and does not recover it again', async () => {
    const reference = {
      id: '7887a64e-1234-4678-9abc-def012345678',
      entity_type: 'sequence',
      display_label: 'pUC19.gb',
      locator: 'git://My Workspace/pUC19.gb',
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      workspace_scope: 'folders:["/managed/17278/repo"]',
      workspace_root_path: null,
      created_at: 1,
      updated_at: 1,
    };
    mockChatState.currentConversationId = 'legacy-origin-conv';
    mockChatState.conversations = [
      {
        id: 'legacy-origin-conv',
        title: 'Legacy origin',
        workspacePath: '/managed/17278/repo',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    mockChatState.messages = [
      {
        id: 'assistant-legacy-origin',
        role: 'assistant',
        content: `Open [pUC19](dnaforge-chat://reference/${reference.id}).`,
        createdAt: 1,
      },
    ];
    vi.mocked(getMessageReferences).mockResolvedValue([reference.id]);
    vi.mocked(getEntityReferencesByIds).mockResolvedValue([reference]);
    mockSetEntityReferenceWorkspaceRootPathIfMissing.mockResolvedValue('/managed/17278/repo');
    mockResolveInlineReferenceTarget.mockResolvedValue({
      ok: true,
      path: '/managed/17278/repo/pUC19.gb',
      rootPath: '/managed/17278/repo',
      canonicalPath: '/managed/17278/repo/pUC19.gb',
      canonicalRootPath: '/managed/17278/repo',
      relativePath: 'pUC19.gb',
      targetType: 'file',
    });

    render(<FullChatView workspacePath="/replacement/repo" />);
    const chip = await screen.findByTestId(`mock-reference-${reference.id}`);
    fireEvent.click(chip);
    await waitFor(() => expect(mockOpenSequenceFile).toHaveBeenCalledTimes(1));
    fireEvent.click(chip);
    await waitFor(() => expect(mockOpenSequenceFile).toHaveBeenCalledTimes(2));

    expect(getFullChatViewReferenceRootCacheDiagnostics()).toMatchObject({
      completedEntityOpens: 2,
      owners: [
        expect.objectContaining({
          completedEntityOpenOperationIds: [expect.any(String)],
          abortedEntityOpenOperationIds: [],
        }),
      ],
    });

    expect(mockSetEntityReferenceWorkspaceRootPathIfMissing).toHaveBeenCalledTimes(1);
    expect(mockSetEntityReferenceWorkspaceRootPathIfMissing).toHaveBeenCalledWith(
      reference.id,
      '/managed/17278/repo'
    );
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('aborts a dispatched target resolution and releases its owner on unmount', async () => {
    const reference = {
      id: '7987a64e-1234-4678-9abc-def012345678',
      entity_type: 'sequence',
      display_label: 'held.gb',
      locator: 'git://Held Workspace/held.gb',
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      workspace_scope: 'folders:["/managed/held/repo"]',
      workspace_root_path: null,
      created_at: 1,
      updated_at: 1,
    };
    mockChatState.currentConversationId = 'held-origin-conv';
    mockChatState.conversations = [
      {
        id: 'held-origin-conv',
        title: 'Held origin',
        workspacePath: '/managed/held/repo',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    mockChatState.messages = [
      {
        id: 'assistant-held-origin',
        role: 'assistant',
        content: `Open [held](dnaforge-chat://reference/${reference.id}).`,
        createdAt: 1,
      },
    ];
    vi.mocked(getMessageReferences).mockResolvedValue([reference.id]);
    vi.mocked(getEntityReferencesByIds).mockResolvedValue([reference]);
    mockSetEntityReferenceWorkspaceRootPathIfMissing.mockResolvedValue('/managed/held/repo');
    mockResolveInlineReferenceTarget.mockResolvedValue({
      ok: true,
      path: '/managed/held/repo/held.gb',
      rootPath: '/managed/held/repo',
      canonicalPath: '/managed/held/repo/held.gb',
      canonicalRootPath: '/managed/held/repo',
      relativePath: 'held.gb',
      targetType: 'file',
    });

    const view = render(<FullChatView workspacePath="/replacement/repo" />);
    const chip = await screen.findByTestId(`mock-reference-${reference.id}`);
    holdNextFullChatViewReferenceTargetResolutionForTest();
    fireEvent.click(chip);
    await waitFor(() =>
      expect(getFullChatViewReferenceRootCacheDiagnostics()).toMatchObject({
        activeOwners: 1,
        activeActivations: 1,
        targetResolutionsStarted: 1,
        activeTargetResolutions: 1,
        originPersistencesStarted: 1,
        completedOriginPersistences: 1,
      })
    );

    view.unmount();
    await waitFor(() =>
      expect(getFullChatViewReferenceRootCacheDiagnostics()).toMatchObject({
        activeOwners: 0,
        activeActivations: 0,
        lastReleasedOwner: {
          mounted: false,
          activeActivations: 0,
          completedActivations: 1,
          failedActivations: 1,
          targetResolutionsStarted: 1,
          activeTargetResolutions: 0,
          abortedTargetResolutions: 1,
          completedOriginPersistences: 1,
        },
      })
    );
    expect(mockResolveInlineReferenceTarget).toHaveBeenCalledTimes(1);
    expect(mockOpenSequenceFile).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it.each(['sequence', 'structure'] as const)(
    'releases the chat owner while a raw %s opener is still pending',
    async (entityType) => {
      const referenceId =
        entityType === 'sequence'
          ? '8a87a64e-1234-4678-9abc-def012345678'
          : '8b87a64e-1234-4678-9abc-def012345678';
      const extension = entityType === 'sequence' ? 'gb' : 'pdb';
      const filePath = `/managed/held/repo/held.${extension}`;
      const reference = {
        id: referenceId,
        entity_type: entityType,
        display_label: `held.${extension}`,
        locator: `git://Held Workspace/held.${extension}`,
        deep_link_params: null,
        data: null,
        source: 'ai',
        status: 'created',
        workspace_scope: 'folders:["/managed/held/repo"]',
        workspace_root_path: '/managed/held/repo',
        created_at: 1,
        updated_at: 1,
      };
      mockChatState.currentConversationId = `held-${entityType}-conv`;
      mockChatState.conversations = [
        {
          id: `held-${entityType}-conv`,
          title: `Held ${entityType}`,
          workspacePath: '/managed/held/repo',
          createdAt: 1,
          updatedAt: 1,
        },
      ];
      mockChatState.messages = [
        {
          id: `assistant-held-${entityType}`,
          role: 'assistant',
          content: `Open [held](dnaforge-chat://reference/${reference.id}).`,
          createdAt: 1,
        },
      ];
      vi.mocked(getMessageReferences).mockResolvedValue([reference.id]);
      vi.mocked(getEntityReferencesByIds).mockResolvedValue([reference]);
      mockResolveInlineReferenceTarget.mockResolvedValue({
        ok: true,
        path: filePath,
        rootPath: '/managed/held/repo',
        canonicalPath: filePath,
        canonicalRootPath: '/managed/held/repo',
        relativePath: `held.${extension}`,
        targetType: 'file',
      });
      const chatTabId = useCanvasStore.getState().openTab('main', {
        type: 'chat',
        entityId: `held-${entityType}-conv`,
        label: `Held ${entityType}`,
      });
      expect(chatTabId).not.toBeNull();
      const pendingOpen = deferred<void>();
      const lateOpenSettled = deferred<void>();
      const opener = entityType === 'sequence' ? mockOpenSequenceFile : mockOpenStructureFile;
      opener.mockImplementation(
        async ({ label, signal }: { label: string; signal?: AbortSignal }) => {
          try {
            await pendingOpen.promise;
            if (signal?.aborted) return null;
            return entityType === 'sequence'
              ? useCanvasStore
                  .getState()
                  .openWithSmartPlacement('sequence', filePath, label, undefined, {
                    sequenceDocument: { kind: 'catalog-sequence', entityId: filePath },
                  })
              : useCanvasStore.getState().openWithSmartPlacement('structure', filePath, label);
          } finally {
            lateOpenSettled.resolve(undefined);
          }
        }
      );

      const view = render(<FullChatView workspacePath="/managed/held/repo" />);
      fireEvent.click(await screen.findByTestId(`mock-reference-${reference.id}`));
      await waitFor(() =>
        expect(getFullChatViewReferenceRootCacheDiagnostics()).toMatchObject({
          activeOwners: 1,
          activeActivations: 1,
          entityOpensStarted: 1,
          activeEntityOpens: 1,
        })
      );
      expect(Object.keys(useCanvasStore.getState().panels)).toEqual(['main']);

      useCanvasStore.getState().closeTab('main', chatTabId as string);
      view.unmount();
      await waitFor(() =>
        expect(getFullChatViewReferenceRootCacheDiagnostics()).toMatchObject({
          activeOwners: 0,
          activeActivations: 0,
          lastReleasedOwner: {
            mounted: false,
            activeActivations: 0,
            completedActivations: 1,
            failedActivations: 1,
            entityOpensStarted: 1,
            activeEntityOpens: 0,
            abortedEntityOpens: 1,
            completedEntityOpenOperationIds: [],
            abortedEntityOpenOperationIds: [expect.any(String)],
          },
        })
      );
      expect(opener).toHaveBeenCalledTimes(1);
      expect((opener.mock.calls[0]?.[0] as { signal?: AbortSignal }).signal?.aborted).toBe(true);
      if (entityType === 'structure') {
        expect(opener.mock.calls[0]?.[0]).toEqual(
          expect.objectContaining({
            operationId: expect.stringMatching(
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            ),
          })
        );
      }
      expect(useToastStore.getState().toasts).toHaveLength(0);

      await act(async () => {
        pendingOpen.resolve(undefined);
        await lateOpenSettled.promise;
      });
      expect(
        Object.values(useCanvasStore.getState().panels).flatMap((panel) => panel.tabs)
      ).toEqual([]);
      expect(Object.keys(useCanvasStore.getState().panels)).toEqual(['main']);
    }
  );

  it('fails closed when a recovered legacy origin cannot be made durable', async () => {
    const reference = {
      id: '6887a64e-1234-4678-9abc-def012345678',
      entity_type: 'sequence',
      display_label: 'pUC19.gb',
      locator: 'git://My Workspace/pUC19.gb',
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      workspace_scope: 'folders:["/managed/17278/repo"]',
      workspace_root_path: null,
      created_at: 1,
      updated_at: 1,
    };
    mockChatState.currentConversationId = 'legacy-cas-conv';
    mockChatState.conversations = [
      {
        id: 'legacy-cas-conv',
        title: 'Legacy CAS',
        workspacePath: '/managed/17278/repo',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    mockChatState.messages = [
      {
        id: 'assistant-legacy-cas',
        role: 'assistant',
        content: `Open [pUC19](dnaforge-chat://reference/${reference.id}).`,
        createdAt: 1,
      },
    ];
    vi.mocked(getMessageReferences).mockResolvedValue([reference.id]);
    vi.mocked(getEntityReferencesByIds).mockResolvedValue([reference]);
    mockSetEntityReferenceWorkspaceRootPathIfMissing.mockResolvedValue(null);

    render(<FullChatView workspacePath="/replacement/repo" />);
    fireEvent.click(await screen.findByTestId(`mock-reference-${reference.id}`));

    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
        'DNAForge couldn’t restore the saved location for “pUC19”.'
      )
    );
    expect(mockResolveInlineReferenceTarget).not.toHaveBeenCalled();
    expect(mockOpenSequenceFile).not.toHaveBeenCalled();
  });

  it('binds a dropped file to the mounted root that actually contains it', async () => {
    useWorkspaceStore.setState({
      folders: [
        { name: 'Primary', path: '/workspace/primary', addedAt: 1 },
        { name: 'Samples', path: '/workspace/secondary', addedAt: 2 },
      ],
    });
    vi.mocked(createEntityReference).mockResolvedValue({
      id: 'dropped-reference',
      entity_type: 'sequence',
      display_label: 'pUC19.gb',
      locator: 'git://Samples/constructs/pUC19.gb',
      deep_link_params: null,
      data: null,
      source: 'user',
      status: 'created',
      workspace_scope: 'folders:["/workspace/primary","/workspace/secondary"]',
      workspace_root_path: '/workspace/secondary',
      created_at: 1,
      updated_at: 1,
    });

    render(<FullChatView workspacePath="/workspace/primary" />);
    const dropZone = document.querySelector('[data-chat-drop-zone]');
    expect(dropZone).not.toBeNull();
    act(() => {
      dropZone?.dispatchEvent(
        new CustomEvent('waypoint-file-drop', {
          detail: {
            path: '/workspace/secondary/constructs/pUC19.gb',
            name: 'pUC19.gb',
          },
        })
      );
    });

    await waitFor(() => expect(createEntityReference).toHaveBeenCalledTimes(1));
    expect(createEntityReference).toHaveBeenCalledWith(
      expect.objectContaining({
        locator: 'git://Samples/constructs/pUC19.gb',
        workspaceRootPath: '/workspace/secondary',
      })
    );
  });

  it('explains why a dropped file outside every mounted project was not attached', async () => {
    useWorkspaceStore.setState({
      folders: [{ name: 'Primary', path: '/workspace/primary', addedAt: 1 }],
    });

    render(<FullChatView workspacePath="/workspace/primary" />);
    const dropZone = document.querySelector('[data-chat-drop-zone]');
    expect(dropZone).not.toBeNull();
    act(() => {
      dropZone?.dispatchEvent(
        new CustomEvent('waypoint-file-drop', {
          detail: {
            path: '/outside/pUC19.gb',
            name: 'pUC19.gb',
          },
        })
      );
    });

    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
        message: '“pUC19.gb” isn’t inside an open project, so DNAForge didn’t attach it.',
        type: 'error',
      })
    );
    expect(createEntityReference).not.toHaveBeenCalled();
  });
});

describe('FullChatView — reference chip durability across conversation switches ', () => {
  const REF_ID = '5887a64e-1234-5678-9abc-def012345678';

  const reference = {
    id: REF_ID,
    entity_type: 'sequence_region',
    display_label: 'pUC19.gb 100-500',
    locator: 'git://workspace/plasmids/pUC19.gb',
    deep_link_params: null,
    data: null,
    source: 'ai',
    status: 'created',
    created_at: 0,
    updated_at: 0,
  };

  beforeEach(() => {
    resetFullChatViewHarness();
    vi.mocked(getEntityReferencesByIds).mockReset().mockResolvedValue([reference]);
    vi.mocked(getMessageReferences).mockReset().mockResolvedValue([REF_ID]);
  });

  it('re-resolves reference chips after the active conversation moves away and back', async () => {
    mockChatState.currentConversationId = 'conv-A';
    mockChatState.messages = [
      { id: 'msg-1', role: 'user', content: 'What is this region?', createdAt: 1 },
    ];

    const { rerender } = render(<FullChatView workspacePath="/workspace" />);

    await waitFor(() => {
      expect(screen.getByTestId(`ref-chip-${REF_ID}`)).toBeInTheDocument();
    });
    const callsAfterFirstPaint = vi.mocked(getEntityReferencesByIds).mock.calls.length;

    mockChatState.currentConversationId = 'conv-B';
    rerender(<FullChatView workspacePath="/workspace" />);
    mockChatState.currentConversationId = 'conv-A';
    rerender(<FullChatView workspacePath="/workspace" />);

    await waitFor(() => {
      expect(vi.mocked(getEntityReferencesByIds).mock.calls.length).toBeGreaterThan(
        callsAfterFirstPaint
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId(`ref-chip-${REF_ID}`)).toBeInTheDocument();
    });
  });

  it('replays an inline entity chip only from the exact Markdown UUID plus message join', async () => {
    mockChatState.currentConversationId = 'conv-A';
    mockChatState.messages = [
      {
        id: 'assistant-inline-1',
        role: 'assistant',
        content: `Open [pUC19](dnaforge-chat://reference/${REF_ID}) now.`,
        createdAt: 1,
      },
    ];
    vi.mocked(navigateToReference).mockClear();

    render(<FullChatView workspacePath="/workspace" />);

    const chip = await screen.findByTestId(`mock-reference-${REF_ID}`);
    expect(screen.queryByTestId(`ref-chip-${REF_ID}`)).not.toBeInTheDocument();
    fireEvent.click(chip);

    expect(navigateToReference).toHaveBeenCalledWith(reference, {
      sourceChatConversationId: 'conv-A',
    });
  });

  it('does not permanently cache a failed reference query as "no references"', async () => {
    mockChatState.currentConversationId = 'conv-A';
    mockChatState.messages = [
      { id: 'msg-1', role: 'user', content: 'What is this region?', createdAt: 1 },
    ];
    vi.mocked(getMessageReferences)
      .mockRejectedValueOnce(new Error('IPC unavailable'))
      .mockResolvedValue([REF_ID]);

    render(<FullChatView workspacePath="/workspace" />);

    await waitFor(
      () => {
        expect(screen.getByTestId(`ref-chip-${REF_ID}`)).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
  });

  it('surfaces a degraded chip after entity-reference loading exhausts its retries', async () => {
    mockChatState.currentConversationId = 'conv-A';
    mockChatState.messages = [
      { id: 'msg-1', role: 'user', content: 'What is this region?', createdAt: 1 },
    ];
    vi.mocked(getEntityReferencesByIds).mockRejectedValue(new Error('entity query unavailable'));

    render(<FullChatView workspacePath="/workspace" />);

    await waitFor(
      () => {
        expect(screen.getByTestId(`ref-chip-unavailable-${REF_ID}`)).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
    expect(vi.mocked(getEntityReferencesByIds)).toHaveBeenCalledTimes(3);
  });

  it('surfaces a degraded message after message-reference loading exhausts its retries', async () => {
    mockChatState.currentConversationId = 'conv-A';
    mockChatState.messages = [
      { id: 'msg-1', role: 'user', content: 'What is this region?', createdAt: 1 },
    ];
    vi.mocked(getMessageReferences).mockRejectedValue(new Error('join query unavailable'));

    render(<FullChatView workspacePath="/workspace" />);

    await waitFor(
      () => {
        expect(screen.getByTestId('message-references-unavailable')).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
    expect(vi.mocked(getMessageReferences)).toHaveBeenCalledTimes(3);
  });

  it('renders a generic tool card when create_reference has no referenceData', () => {
    mockChatState.currentConversationId = 'conv-A';
    mockChatState.messages = [
      {
        id: 'tool-missing-reference-data',
        role: 'tool',
        toolName: 'create_reference',
        content: JSON.stringify({ output: { referenceId: REF_ID } }),
        createdAt: 1,
      },
    ];

    render(<FullChatView workspacePath="/workspace" />);

    expect(screen.getByText('create_reference')).toBeInTheDocument();
  });
});

describe('FullChatView — persisted workspace target hydration ', () => {
  beforeEach(() => {
    resetFullChatViewHarness();
    mockChatState.currentConversationId = 'workspace-replay';
    mockChatState.messages = [
      {
        id: 'assistant-workspace-path',
        role: 'assistant',
        content: 'Open [pUC19](dnaforge-chat://workspace/Samples/pUC19).',
        createdAt: 1,
      },
    ];
    useWorkspaceStore.setState({
      folders: [{ name: 'Samples', path: '/mounted/samples', addedAt: 1 }],
    });
  });

  it('resolves once for fresh but semantically equal replay containers', async () => {
    const rendered = render(<FullChatView workspacePath="/workspace" />);

    await waitFor(() => expect(mockResolveInlineReferenceTarget).toHaveBeenCalledTimes(1));

    act(() => {
      useWorkspaceStore.setState({
        folders: [{ name: 'Samples', path: '/mounted/samples', addedAt: 2 }],
      });
    });
    mockChatState.messages = mockChatState.messages.map((message) => ({ ...message }));
    rendered.rerender(<FullChatView workspacePath="/workspace" />);

    await waitFor(() => expect(mockResolveInlineReferenceTarget).toHaveBeenCalledTimes(1));
  });

  it('resolves again when the mounted root changes meaningfully', async () => {
    render(<FullChatView workspacePath="/workspace" />);
    await waitFor(() => expect(mockResolveInlineReferenceTarget).toHaveBeenCalledTimes(1));

    act(() => {
      useWorkspaceStore.setState({
        folders: [{ name: 'Samples', path: '/rebound/samples', addedAt: 2 }],
      });
    });

    await waitFor(() => expect(mockResolveInlineReferenceTarget).toHaveBeenCalledTimes(2));
  });
});
