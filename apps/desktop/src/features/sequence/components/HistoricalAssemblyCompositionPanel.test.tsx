import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SequencePackageHistoryView } from '../hooks/useSequencePackageHistory';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  inspect: vi.fn(),
  preview: vi.fn(),
}));

vi.mock('../../assembly/public/historical-component-workflow', () => ({
  listHistoricalAssemblyComponents: mocks.list,
  inspectHistoricalAssemblyStageTarget: mocks.inspect,
  previewHistoricalAssemblyComponentStage: mocks.preview,
}));
vi.mock('../../assembly/public/accepted-reopen', () => ({
  parseAcceptedAssemblyPayload: (value: unknown) => value,
  acceptedAssemblyVersionFromSidecar: (value: { acceptedAssemblyVersionId: string }) => ({
    id: value.acceptedAssemblyVersionId,
  }),
}));

import { HistoricalAssemblyCompositionPanel } from './HistoricalAssemblyCompositionPanel';

const source = {
  kind: 'region' as const,
  acceptedAssemblyVersionId: 'accepted-older',
  canonicalDraftChecksum: 'sha256:recipe',
  componentId: '["region","left"]',
  componentDigest: 'sha256:part',
  regionId: 'left',
};
const targetSlot = { kind: 'region' as const, regionId: 'left' };
const index = {
  packageRoot: '/workspace/construct-1',
  document: {
    id: 'construct-1',
    assembly: { accepted: { acceptedAssemblyVersionId: 'accepted-current' } },
    versionHistory: { revisions: [] },
  },
} as unknown as NonNullable<SequencePackageHistoryView['index']>;

describe('History assembly composition controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({ components: [source], unavailable: [] });
    mocks.inspect.mockResolvedValue({
      constructId: 'construct-1',
      baseAcceptedAssemblyVersionId: 'accepted-current',
      exists: true,
      designId: 'draft-existing',
      designVersion: 3,
      draftDigest: 'sha256:draft',
      draftPath: '/workspace/construct-1/contents/copy.wpdesign.json',
      targets: [targetSlot],
    });
    mocks.preview.mockResolvedValue({ status: 'ready' });
  });

  async function chooseOne(): Promise<void> {
    await screen.findByTestId('assembly-stage-target');
    fireEvent.click(screen.getByRole('button', { name: 'Add historical piece' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Target slot 1' }), {
      target: { value: JSON.stringify(targetSlot) },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Saved source 1' }), {
      target: {
        value: JSON.stringify([
          source.acceptedAssemblyVersionId,
          source.componentId,
          source.componentDigest,
        ]),
      },
    });
  }

  it('previews read-only, then stages the exact source and target into the inspected copy', async () => {
    const stage = vi.fn().mockResolvedValue(undefined);
    render(
      <HistoricalAssemblyCompositionPanel index={index} controller={{ isDirty: false, stage }} />
    );
    await chooseOne();
    expect(stage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview composition' }));
    await screen.findByTestId('assembly-composition-ready');
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        baseAcceptedAssemblyVersionId: 'accepted-current',
        expectedDesignVersion: 3,
        expectedDraftDigest: 'sha256:draft',
        selections: [{ source, target: targetSlot }],
      })
    );
    expect(stage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stage in Assembly' }));
    await waitFor(() =>
      expect(stage).toHaveBeenCalledWith(
        expect.objectContaining({
          selections: [{ source, target: targetSlot }],
        })
      )
    );
  });

  it('allows read-only preview but blocks Stage while sequence edits are dirty', async () => {
    const stage = vi.fn();
    render(
      <HistoricalAssemblyCompositionPanel index={index} controller={{ isDirty: true, stage }} />
    );
    await chooseOne();
    fireEvent.click(screen.getByRole('button', { name: 'Preview composition' }));
    await screen.findByTestId('assembly-composition-ready');
    expect(screen.getByRole('button', { name: 'Stage in Assembly' })).toBeDisabled();
    expect(stage).not.toHaveBeenCalled();
  });

  it('shows preview blockers and never offers Stage for an incompatible selection', async () => {
    mocks.preview.mockResolvedValue({ status: 'blocked', reason: 'Target gap changed.' });
    const stage = vi.fn();
    render(
      <HistoricalAssemblyCompositionPanel index={index} controller={{ isDirty: false, stage }} />
    );
    await chooseOne();
    fireEvent.click(screen.getByRole('button', { name: 'Preview composition' }));
    expect(await screen.findByTestId('assembly-composition-blocked')).toHaveTextContent(
      'Target gap changed.'
    );
    expect(screen.queryByRole('button', { name: 'Stage in Assembly' })).toBeNull();
    expect(stage).not.toHaveBeenCalled();
  });

  it('lets the user choose another saved assembly as the exact working-copy base', async () => {
    const olderIndex = {
      ...index,
      document: {
        ...index.document,
        versionHistory: {
          revisions: [
            {
              state: {
                acceptedAssembly: { acceptedAssemblyVersionId: 'accepted-older' },
              },
            },
          ],
        },
      },
    } as NonNullable<SequencePackageHistoryView['index']>;
    mocks.inspect.mockImplementation(
      async (request: { baseAcceptedAssemblyVersionId: string }) => ({
        constructId: 'construct-1',
        baseAcceptedAssemblyVersionId: request.baseAcceptedAssemblyVersionId,
        exists: false,
        designId: null,
        designVersion: 0,
        draftDigest: null,
        draftPath: null,
        targets: [targetSlot],
      })
    );
    render(
      <HistoricalAssemblyCompositionPanel
        index={olderIndex}
        controller={{ isDirty: false, stage: vi.fn() }}
      />
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Assembly working-copy base' }), {
      target: { value: 'accepted-older' },
    });
    await waitFor(() =>
      expect(mocks.inspect).toHaveBeenCalledWith({
        constructId: 'construct-1',
        baseAcceptedAssemblyVersionId: 'accepted-older',
      })
    );
    await chooseOne();
    fireEvent.click(screen.getByRole('button', { name: 'Preview composition' }));
    await screen.findByTestId('assembly-composition-ready');
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        baseAcceptedAssemblyVersionId: 'accepted-older',
        expectedDesignVersion: 0,
        expectedDraftDigest: null,
      })
    );
  });

  it('does not reinstate an older ready preview after the selected piece changes', async () => {
    let finishPreview!: (value: { status: 'ready' }) => void;
    mocks.preview.mockReturnValue(
      new Promise((resolve) => {
        finishPreview = resolve;
      })
    );
    const stage = vi.fn();
    render(
      <HistoricalAssemblyCompositionPanel index={index} controller={{ isDirty: false, stage }} />
    );
    await chooseOne();
    fireEvent.click(screen.getByRole('button', { name: 'Preview composition' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Saved source 1' }), {
      target: { value: '' },
    });
    finishPreview({ status: 'ready' });
    await waitFor(() => expect(screen.queryByTestId('assembly-composition-ready')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Stage in Assembly' })).toBeNull();
    expect(stage).not.toHaveBeenCalled();
  });
});
