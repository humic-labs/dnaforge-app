import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DBEntityReference } from '../../db/entity-references';

const {
  mockBuildSelectionDescriptor,
  mockCreateEntityReference,
  mockSetPendingAskAiPicker,
  mockSetPendingDraft,
  mockSendMessage,
  mockOpenChatTab,
  mockFocusedPanelId,
  mockFolders,
} = vi.hoisted(() => ({
  mockBuildSelectionDescriptor: vi.fn(),
  mockCreateEntityReference: vi.fn(),
  mockSetPendingAskAiPicker: vi.fn(),
  mockSetPendingDraft: vi.fn(),
  mockSendMessage: vi.fn(),
  mockOpenChatTab: vi.fn(),
  mockFocusedPanelId: { current: 'panel-source' as string | null },
  mockFolders: [] as Array<{ path: string; name: string; pinned?: boolean; addedAt: number }>,
}));

vi.mock('./selection-descriptor/build', () => ({
  buildSelectionDescriptor: mockBuildSelectionDescriptor,
}));

vi.mock('../../db/entity-references', () => ({
  createEntityReference: mockCreateEntityReference,
}));

vi.mock('../../stores/workspaceStore', () => ({
  getCurrentWorkspaceScope: () => 'folders:["/ws/proj"]',
  useWorkspaceStore: {
    getState: () => ({ folders: mockFolders }),
  },
}));

vi.mock('./hooks/useChat', () => ({
  useChatStore: {
    getState: () => ({
      setPendingAskAiPicker: mockSetPendingAskAiPicker,
      setPendingDraft: mockSetPendingDraft,
      sendMessage: mockSendMessage,
    }),
  },
}));

vi.mock('../canvas/store', () => ({
  useCanvasStore: {
    getState: () => ({
      openChatTab: mockOpenChatTab,
      focusedPanelId: mockFocusedPanelId.current,
    }),
  },
}));

import { askAiAboutSelection, type AskAiSelectionInput } from './ask-ai-about-selection';

const BASE_INPUT: AskAiSelectionInput = {
  entityType: 'sequence_region',
  displayLabel: 'pUC19.gb 123–456',
  locator: 'sequence-document-puc19',
  workspaceRootPath: '/ws/proj',
  deepLinkParams: { start: 123, end: 456 },
};

const STRUCTURE_INPUT: AskAiSelectionInput = {
  entityType: 'structure',
  displayLabel: '1FS0 chain G residues 57, 102, 195',
  locator: 'structure:1FS0',
  deepLinkParams: {
    highlightGroups: [
      {
        id: 'ask-ai-selection',
        label: 'Selected residues',
        selections: [
          {
            chain: 'G',
            authAsymId: 'G',
            ranges: [
              [57, 57],
              [102, 102],
              [195, 195],
            ],
          },
        ],
      },
    ],
  },
  structure: {
    residues: [
      { chain: 'G', authAsymId: 'G', position: 57, labelCompId: 'GLY' },
      { chain: 'G', authAsymId: 'G', position: 102, labelCompId: 'GLY' },
      { chain: 'G', authAsymId: 'G', position: 195, labelCompId: 'TYR' },
    ],
    visibleRepresentations: [
      {
        layerId: 'polymer-cartoon',
        representation: 'cartoon',
        target: 'all-polymer',
        colorMode: 'chain',
      },
    ],
    linkedCodingDna: {
      documentId: 'sequence-document-trypsin',
      regions: [
        {
          codingDnaMapped: true,
          start: 169,
          end: 171,
          strand: '+',
          residues: [{ chain: 'G', residueNumber: 57, proteinResidue: 57 }],
        },
      ],
    },
  },
};

function makeDescriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    kind: 'sequence_region',
    label: 'pUC19.gb 123–456',
    locator: { documentId: 'sequence-document-puc19' },
    coordinateSystem: '1-indexed-inclusive',
    sourceVersion: 0,
    measured: { start: 123, end: 456, length: 334, wraps: false },
    fileText: {},
    bases: 'not_included',
    fetch: { tools: ['selection_translate'] },
    ...overrides,
  };
}

function makeRef(overrides: Partial<DBEntityReference> = {}): DBEntityReference {
  return {
    id: 'ref-1',
    entity_type: 'sequence_region',
    display_label: 'pUC19.gb 123–456',
    locator: 'sequence-document-puc19',
    deep_link_params: JSON.stringify({ start: 123, end: 456 }),
    data: null,
    source: 'user',
    status: 'created',
    workspace_scope: 'folders:["/ws/proj"]',
    workspace_root_path: '/ws/proj',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe('askAiAboutSelection (M2 adapter + P4 picker hand-off)', () => {
  beforeEach(() => {
    mockBuildSelectionDescriptor.mockReset();
    mockCreateEntityReference.mockReset();
    mockSetPendingAskAiPicker.mockReset();
    mockSetPendingDraft.mockReset();
    mockSendMessage.mockReset();
    mockOpenChatTab.mockReset();
    mockFocusedPanelId.current = 'panel-source';
    mockOpenChatTab.mockReturnValue({ tabId: 'tab-1', conversationId: 'conv-1', isNew: false });
    mockFolders.length = 0;
    mockFolders.push({ path: '/ws/proj', name: 'workspace', pinned: false, addedAt: 1 });
    mockBuildSelectionDescriptor.mockReturnValue(makeDescriptor());
    mockCreateEntityReference.mockResolvedValue(makeRef());
  });

  it('builds a sequence_region descriptor from the same 1-indexed coords', async () => {
    await askAiAboutSelection(BASE_INPUT);

    expect(mockBuildSelectionDescriptor).toHaveBeenCalledTimes(1);
    expect(mockBuildSelectionDescriptor).toHaveBeenCalledWith({
      kind: 'sequence_region',
      documentId: 'sequence-document-puc19',
      activeOverlays: undefined,
      regions: undefined,
      range: { start: 123, end: 456 },
    });
  });

  it('builds a native structure descriptor and coordinate-carrying structure reference', async () => {
    const descriptor = makeDescriptor({
      kind: 'structure',
      coordinateSystem: 'auth_seq_id-1-indexed-inclusive',
      measured: {
        structureRef: 'structure:1FS0',
        residueCount: 3,
        regionCount: 3,
        disjoint: true,
        residueOmittedCount: 0,
        residueIdentityKnownCount: 3,
        residueIdentityUnknownCount: 0,
        residueIdentityOmittedCount: 0,
        residues: [
          { chain: 'G', authSeqId: 57, labelCompId: 'GLY', identityStatus: 'known' },
          { chain: 'G', authSeqId: 102, labelCompId: 'GLY', identityStatus: 'known' },
          { chain: 'G', authSeqId: 195, labelCompId: 'TYR', identityStatus: 'known' },
        ],
      },
      bases: 'never',
    });
    mockBuildSelectionDescriptor.mockReturnValue(descriptor);

    await askAiAboutSelection(STRUCTURE_INPUT);

    expect(mockBuildSelectionDescriptor).toHaveBeenCalledWith({
      kind: 'structure',
      path: 'structure:1FS0',
      label: '1FS0 chain G residues 57, 102, 195',
      ...STRUCTURE_INPUT.structure,
    });
    expect(mockCreateEntityReference).toHaveBeenCalledWith({
      entityType: 'structure',
      displayLabel: '1FS0 chain G residues 57, 102, 195',
      locator: 'entity://structure/structure:1FS0',
      deepLinkParams: {
        highlightGroups: [
          expect.objectContaining({
            id: 'ask-ai-selection',
            renderMode: 'selection',
          }),
        ],
      },
      data: descriptor,
      source: 'user',
      workspaceScope: 'folders:["/ws/proj"]',
      workspaceRootPath: null,
    });
    expect(mockSetPendingAskAiPicker).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('refuses to persist an identity-incomplete structure reference', async () => {
    mockBuildSelectionDescriptor.mockReturnValue(
      makeDescriptor({
        kind: 'structure',
        measured: {
          structureRef: 'structure:1FS0',
          residueCount: 1,
          regionCount: 1,
          disjoint: false,
          residueIdentityKnownCount: 0,
          residueIdentityUnknownCount: 1,
          residues: [
            {
              chain: 'G',
              authSeqId: 57,
              labelCompId: null,
              identityStatus: 'unknown',
            },
          ],
        },
      })
    );

    await expect(askAiAboutSelection(STRUCTURE_INPUT)).rejects.toThrow(
      'before every selected residue identity is resolved'
    );
    expect(mockCreateEntityReference).not.toHaveBeenCalled();
  });

  it('creates a source:user reference carrying the descriptor as data (not null)', async () => {
    const descriptor = makeDescriptor();
    mockBuildSelectionDescriptor.mockReturnValue(descriptor);

    await askAiAboutSelection(BASE_INPUT);

    expect(mockCreateEntityReference).toHaveBeenCalledTimes(1);
    expect(mockCreateEntityReference).toHaveBeenCalledWith({
      entityType: 'sequence_region',
      displayLabel: 'pUC19.gb 123–456',
      locator: 'sequence-document-puc19',
      deepLinkParams: { start: 123, end: 456 },
      data: descriptor,
      source: 'user',
      workspaceScope: 'folders:["/ws/proj"]',
      workspaceRootPath: '/ws/proj',
    });

    const dataArg = mockCreateEntityReference.mock.calls[0][0].data;
    expect(dataArg).not.toBeNull();
    expect(dataArg.kind).toBe('sequence_region');
    expect(dataArg.measured.start).toBe(123);
    expect(dataArg.measured.end).toBe(456);
  });

  it('preserves a wrapping selection flag into both the builder range and deepLinkParams', async () => {
    await askAiAboutSelection({
      ...BASE_INPUT,
      deepLinkParams: { start: 2600, end: 40, wraps: true },
    });

    expect(mockBuildSelectionDescriptor).toHaveBeenCalledWith({
      kind: 'sequence_region',
      documentId: 'sequence-document-puc19',
      activeOverlays: undefined,
      regions: undefined,
      range: { start: 2600, end: 40, wraps: true },
    });
    expect(mockCreateEntityReference).toHaveBeenCalledWith(
      expect.objectContaining({
        deepLinkParams: { start: 2600, end: 40, wraps: true },
        source: 'user',
      })
    );
  });

  it('falls back to data:null when the descriptor builder throws (never blocks the ask)', async () => {
    mockBuildSelectionDescriptor.mockImplementation(() => {
      throw new Error('descriptor build boom');
    });

    const result = await askAiAboutSelection(BASE_INPUT);

    expect(mockCreateEntityReference).toHaveBeenCalledWith(
      expect.objectContaining({ data: null, source: 'user' })
    );
    expect(mockSetPendingAskAiPicker).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
  });

  it('falls back to data:null when the builder returns a non-descriptor marker', async () => {
    mockBuildSelectionDescriptor.mockReturnValue({
      kind: 'unavailable',
      reason: 'No resident parsed sequence — open the file in a tab first.',
    });

    await askAiAboutSelection(BASE_INPUT);

    expect(mockCreateEntityReference).toHaveBeenCalledWith(expect.objectContaining({ data: null }));
  });

  it('stages the invocation for the picker (does NOT open a chat tab or seed a draft directly)', async () => {
    const ref = makeRef({ id: 'ref-42' });
    mockCreateEntityReference.mockResolvedValue(ref);

    await askAiAboutSelection(BASE_INPUT);

    expect(mockSetPendingAskAiPicker).toHaveBeenCalledTimes(1);
    expect(mockSetPendingAskAiPicker).toHaveBeenCalledWith({
      reference: ref,
      chatWorkspacePath: '/ws/proj',
      seedText: undefined,
      anchor: undefined,
      sourcePanelId: 'panel-source',
    });
    expect(mockSetPendingDraft).not.toHaveBeenCalled();
  });

  it('resolves the chat bucket from the first non-pinned folder (ignoring pinned dev mounts)', async () => {
    mockFolders.length = 0;
    mockFolders.push({ path: '/pinned/dev', name: 'dev', pinned: true, addedAt: 1 });
    mockFolders.push({ path: '/ws/real', name: 'real', pinned: false, addedAt: 2 });

    await askAiAboutSelection(BASE_INPUT);

    expect(mockSetPendingAskAiPicker).toHaveBeenCalledWith(
      expect.objectContaining({ chatWorkspacePath: '/ws/real' })
    );
  });

  it('resolves a null chat bucket (No-workspace) when there is no non-pinned folder', async () => {
    mockFolders.length = 0;

    await askAiAboutSelection(BASE_INPUT);

    expect(mockSetPendingAskAiPicker).toHaveBeenCalledWith(
      expect.objectContaining({ chatWorkspacePath: null })
    );
  });

  it('threads the anchor (right-click origin) through to the picker when provided', async () => {
    const ref = makeRef();
    mockCreateEntityReference.mockResolvedValue(ref);

    await askAiAboutSelection({ ...BASE_INPUT, anchor: { x: 320, y: 240 } });

    expect(mockSetPendingAskAiPicker).toHaveBeenCalledWith(
      expect.objectContaining({ reference: ref, anchor: { x: 320, y: 240 } })
    );
  });

  it('omits the anchor for anchor-less callers (centered-modal fallback)', async () => {
    await askAiAboutSelection(BASE_INPUT);

    const arg = mockSetPendingAskAiPicker.mock.calls[0][0];
    expect(arg.anchor).toBeUndefined();
  });

  it('captures the invoking canvas pane for the later inline-to-pane handoff', async () => {
    mockFocusedPanelId.current = 'panel-structure';

    await askAiAboutSelection(BASE_INPUT);

    expect(mockSetPendingAskAiPicker).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePanelId: 'panel-structure' })
    );
  });

  it('pins the invoking pane before asynchronous reference persistence can change focus', async () => {
    mockFocusedPanelId.current = 'panel-source';
    mockCreateEntityReference.mockImplementation(async () => {
      mockFocusedPanelId.current = 'panel-other';
      return makeRef();
    });

    await askAiAboutSelection(BASE_INPUT);

    expect(mockSetPendingAskAiPicker).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePanelId: 'panel-source' })
    );
  });

  it('passes seedText through to the picker when provided', async () => {
    const ref = makeRef();
    mockCreateEntityReference.mockResolvedValue(ref);

    await askAiAboutSelection({ ...BASE_INPUT, seedText: 'What is this region?' });

    expect(mockSetPendingAskAiPicker).toHaveBeenCalledWith(
      expect.objectContaining({ reference: ref, seedText: 'What is this region?' })
    );
  });

  it('returns the created reference', async () => {
    const ref = makeRef({ id: 'ref-returned' });
    mockCreateEntityReference.mockResolvedValue(ref);

    const result = await askAiAboutSelection(BASE_INPUT);

    expect(result).toBe(ref);
  });

  it('never auto-sends the message (seed-not-send)', async () => {
    await askAiAboutSelection({ ...BASE_INPUT, seedText: 'Explain this.' });

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("route:'seed-focused-chat' opens a chat tab and seeds it directly (NO picker)", async () => {
    const ref = makeRef({ id: 'ref-slash' });
    mockCreateEntityReference.mockResolvedValue(ref);

    await askAiAboutSelection(
      { ...BASE_INPUT, seedText: 'What is this region?' },
      { route: 'seed-focused-chat' }
    );

    expect(mockCreateEntityReference).toHaveBeenCalledTimes(1);
    expect(mockSetPendingAskAiPicker).not.toHaveBeenCalled();
    expect(mockOpenChatTab).toHaveBeenCalledTimes(1);
    expect(mockSetPendingDraft).toHaveBeenCalledExactlyOnceWith({
      conversationId: 'conv-1',
      references: [ref],
      text: 'What is this region?',
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("route:'seed-focused-chat' still builds the SAME descriptor as the picker route", async () => {
    await askAiAboutSelection(BASE_INPUT, { route: 'seed-focused-chat' });

    expect(mockBuildSelectionDescriptor).toHaveBeenCalledWith({
      kind: 'sequence_region',
      documentId: 'sequence-document-puc19',
      activeOverlays: undefined,
      regions: undefined,
      range: { start: 123, end: 456 },
    });
  });
});
