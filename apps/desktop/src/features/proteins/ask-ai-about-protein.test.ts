import { beforeEach, describe, expect, it, vi } from 'vitest';

const refMock = vi.hoisted(() => ({ createEntityReference: vi.fn() }));
vi.mock('../../db/entity-references', () => refMock);

vi.mock('../../stores/workspaceStore', () => ({ getCurrentWorkspaceScope: () => 'scope-1' }));

const canvasStoreMock = vi.hoisted(() => ({ openChatTab: vi.fn() }));
vi.mock('../canvas/store', () => ({
  useCanvasStore: { getState: () => canvasStoreMock },
}));

const chatStoreMock = vi.hoisted(() => ({ setPendingDraft: vi.fn() }));
vi.mock('../ai/hooks/useChat', () => ({
  useChatStore: { getState: () => chatStoreMock },
}));

import { askAiAboutProtein } from './ask-ai-about-protein';
import type { LimsEntity } from '../../shared/lims';

const ENTITY = { id: 'aa-uuid-1', name: 'mioC' } as LimsEntity;

beforeEach(() => {
  vi.clearAllMocks();
  canvasStoreMock.openChatTab.mockReturnValue({
    tabId: 't1',
    conversationId: 'conv-1',
    isNew: true,
  });
  refMock.createEntityReference.mockResolvedValue({ id: 'ref-1' });
});

describe('askAiAboutProtein', () => {
  it('references the whole entity with no selection', async () => {
    await askAiAboutProtein(ENTITY, null);
    expect(refMock.createEntityReference).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'protein',
        displayLabel: 'mioC',
        locator: 'entity://protein/aa-uuid-1',
        deepLinkParams: null,
      })
    );
    expect(chatStoreMock.setPendingDraft).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      references: [{ id: 'ref-1' }],
      text: undefined,
    });
  });

  it('labels and seeds the selection range when one is provided', async () => {
    await askAiAboutProtein(ENTITY, { start: 10, end: 20 });
    expect(refMock.createEntityReference).toHaveBeenCalledWith(
      expect.objectContaining({
        displayLabel: 'mioC 10-20',
        deepLinkParams: { start: 10, end: 20 },
      })
    );
    expect(chatStoreMock.setPendingDraft).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'About residues 10-20 of mioC: ' })
    );
  });

  it('labels a single-residue click ("residue N"), not a zero-width "N-N" range — the common case from a plain ProteinResidueTrack click', async () => {
    await askAiAboutProtein(ENTITY, { start: 5, end: 5 });
    expect(refMock.createEntityReference).toHaveBeenCalledWith(
      expect.objectContaining({
        displayLabel: 'mioC residue 5',
        deepLinkParams: { start: 5, end: 5 },
      })
    );
    expect(chatStoreMock.setPendingDraft).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'About residues 5-5 of mioC: ' })
    );
  });

  it('opens/reuses the currently-focused chat tab, not a new one keyed to the protein', async () => {
    await askAiAboutProtein(ENTITY, null);
    expect(canvasStoreMock.openChatTab).toHaveBeenCalledWith();
  });
});
