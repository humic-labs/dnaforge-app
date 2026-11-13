import { expectToastCall } from '../../test/toast-assertions';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_ASSOCIATION_SNOOZE_MS } from './opportunity-state';
import { useFileAssociationOpportunities } from '../../hooks/use-file-association-opportunities';
import { resolveToastDefinition } from '../../stores/toast-definitions';

const mocks = vi.hoisted(() => ({
  visibleListener: null as
    | ((event: { filePath: string; associationFamilyId?: 'genbank' | 'snapgene' }) => void)
    | null,
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  queryHandlers: vi.fn(),
  requestDefault: vi.fn(),
  addRichToast: vi.fn(),
  addToast: vi.fn(),
}));

vi.mock('../../db', () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    fileAssociations: {
      queryHandlers: mocks.queryHandlers,
      requestDefault: mocks.requestDefault,
    },
  }),
}));
vi.mock('../sequence/file-open-telemetry', () => ({
  subscribeVisibleFileOpen: (
    listener: (event: { filePath: string; associationFamilyId?: 'genbank' | 'snapgene' }) => void
  ) => {
    mocks.visibleListener = listener;
    return () => {
      mocks.visibleListener = null;
    };
  },
}));
vi.mock('../../stores/toast-store', () => ({
  useToastStore: {
    getState: () => ({ addRichToast: mocks.addRichToast, addToast: mocks.addToast }),
  },
}));

const NOW = Date.UTC(2026, 7, 26, 12);

describe('useFileAssociationOpportunities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.visibleListener = null;
    mocks.getSetting.mockResolvedValue(null);
    mocks.setSetting.mockResolvedValue(undefined);
    mocks.queryHandlers.mockResolvedValue([
      {
        familyId: 'genbank',
        state: 'other',
        handlerName: 'Preview',
        handlerPath: null,
        defaultAction: 'native',
        detail: null,
      },
      {
        familyId: 'snapgene',
        state: 'other',
        handlerName: 'SnapGene',
        handlerPath: null,
        defaultAction: 'native',
        detail: null,
      },
    ]);
    mocks.requestDefault.mockResolvedValue({
      familyId: 'genbank',
      outcome: 'requested',
      detail: null,
    });
  });

  it('shows a persistent three-action opportunity after a visible GenBank open', async () => {
    renderHook(() => useFileAssociationOpportunities({ now: () => NOW }));

    act(() => mocks.visibleListener?.({ filePath: '/workspace/pUC19.gb' }));
    await waitFor(() => expect(mocks.addRichToast).toHaveBeenCalledOnce());

    const toast = mocks.addRichToast.mock.calls[0][0];
    expect(toast.message).toContain('GenBank');
    expect(resolveToastDefinition(toast).duration).toBe(0);
    expect(toast.actions.map((action: { label: string }) => action.label)).toEqual([
      'Make DNAForge default',
      'Not now',
      "Don't ask again",
    ]);
  });

  it('treats Not now and the close control as a durable fourteen-day snooze', async () => {
    renderHook(() => useFileAssociationOpportunities({ now: () => NOW }));
    act(() => mocks.visibleListener?.({ filePath: '/workspace/pUC19.gb' }));
    await waitFor(() => expect(mocks.addRichToast).toHaveBeenCalledOnce());
    const toast = mocks.addRichToast.mock.calls[0][0];

    await act(async () => toast.actions[1].onClick());
    const saved = JSON.parse(mocks.setSetting.mock.calls.at(-1)?.[1] ?? '{}');
    expect(saved.families.genbank.snoozedUntil).toBe(NOW + FILE_ASSOCIATION_SNOOZE_MS);

    mocks.setSetting.mockClear();
    await act(async () => toast.onDismiss());
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it('never prompts automatically for SnapGene before the fidelity gate is satisfied', async () => {
    renderHook(() => useFileAssociationOpportunities({ now: () => NOW }));
    act(() => mocks.visibleListener?.({ filePath: '/workspace/sample.dna' }));

    await waitFor(() => expect(mocks.queryHandlers).toHaveBeenCalledOnce());
    expect(mocks.addRichToast).not.toHaveBeenCalled();
  });

  it('uses the original SnapGene family after conversion to a GenBank product', async () => {
    renderHook(() => useFileAssociationOpportunities({ now: () => NOW }));
    act(() =>
      mocks.visibleListener?.({
        filePath: '/quick-look/sample.gb',
        associationFamilyId: 'snapgene',
      })
    );

    await waitFor(() => expect(mocks.queryHandlers).toHaveBeenCalledOnce());
    expect(mocks.addRichToast).not.toHaveBeenCalled();
  });

  it('fails closed when durable prompt state cannot be written', async () => {
    mocks.setSetting.mockRejectedValue(new Error('settings unavailable'));
    renderHook(() => useFileAssociationOpportunities({ now: () => NOW }));

    act(() => mocks.visibleListener?.({ filePath: '/workspace/pUC19.gb' }));

    await waitFor(() => expect(mocks.setSetting).toHaveBeenCalled());
    expect(mocks.addRichToast).not.toHaveBeenCalled();
  });

  it('reports a preference write failure without rejecting the toast action', async () => {
    renderHook(() => useFileAssociationOpportunities({ now: () => NOW }));
    act(() => mocks.visibleListener?.({ filePath: '/workspace/pUC19.gb' }));
    await waitFor(() => expect(mocks.addRichToast).toHaveBeenCalledOnce());
    const toast = mocks.addRichToast.mock.calls[0][0];
    mocks.setSetting.mockRejectedValueOnce(new Error('disk unavailable'));

    await act(async () => toast.actions[1].onClick());

    expectToastCall(mocks.addToast, 'Could not save the default-app prompt preference.', 'error');
  });
});
