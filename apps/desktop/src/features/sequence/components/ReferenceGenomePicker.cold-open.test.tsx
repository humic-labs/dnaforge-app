import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCanvasStore } from '../../canvas/store';
import { referenceAssemblyById } from '../reference-catalog';
import type {
  HostedReferenceCatalogEntryV1,
  PreparedReferenceAssemblyEntryV1,
} from '../../../shared/reference-assets-ipc';

const {
  importLocal,
  installHosted,
  listHosted,
  listLocal,
  onHostedInstallProgress,
  onPreparationProgress,
  readTextFile,
  referenceAssetCacheRoot,
  queryEntities,
} = vi.hoisted(() => ({
  importLocal: vi.fn(),
  installHosted: vi.fn(),
  listHosted: vi.fn(),
  listLocal: vi.fn(),
  onHostedInstallProgress: vi.fn(),
  onPreparationProgress: vi.fn(),
  readTextFile: vi.fn(),
  referenceAssetCacheRoot: vi.fn(),
  queryEntities: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: {
      readTextFile,
    },
    path: {
      referenceAssetCacheRoot,
    },
    referenceAssets: {
      importLocal,
      installHosted,
      listHosted,
      listLocal,
      onHostedInstallProgress,
      onPreparationProgress,
    },
    lims: { queryEntities },
  }),
}));

import { ReferenceGenomePicker } from './ReferenceGenomePicker';

const catalogAssembly = referenceAssemblyById('grch38')!;
const hostedGrch38: HostedReferenceCatalogEntryV1 = {
  id: catalogAssembly.id,
  name: catalogAssembly.name,
  organism: catalogAssembly.organism,
  assembly: catalogAssembly.assembly,
  description: catalogAssembly.description,
  cacheStatus: 'not-cached',
  lengthBp: 3_088_269_832,
  contigCount: 24,
  downloadBytes: 1_061_733_652,
  provider: 'NCBI RefSeq',
  datasetVersion: 'GRCh38.p14',
};
const grch38Shell: PreparedReferenceAssemblyEntryV1 = {
  id: catalogAssembly.id,
  name: catalogAssembly.name,
  organism: catalogAssembly.organism,
  assembly: catalogAssembly.assembly,
  description: catalogAssembly.description,
  assetCacheKey: catalogAssembly.assetCacheKey,
  members: catalogAssembly.members.map((member) => ({
    chrom: member.chrom,
    cytobandId: member.cytobandId,
    circular: member.circular,
  })),
};

function PickerHarness() {
  const [open, setOpen] = useState(true);
  return <ReferenceGenomePicker open={open} onClose={() => setOpen(false)} />;
}

describe('ReferenceGenomePicker cold hosted open', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      panels: { main: { id: 'main', tabs: [], activeTabId: null } },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
    });
    importLocal.mockReset();
    installHosted.mockReset();
    listHosted.mockReset().mockResolvedValue([hostedGrch38]);
    listLocal.mockReset().mockResolvedValue([]);
    onHostedInstallProgress.mockReset().mockReturnValue(() => {});
    onPreparationProgress.mockReset().mockReturnValue(() => {});
    readTextFile.mockReset().mockRejectedValue(new Error('cold cache'));
    referenceAssetCacheRoot.mockReset().mockResolvedValue('/reference-assets');
    queryEntities.mockReset().mockResolvedValue([]);
  });

  afterEach(() => cleanup());

  it('closes the picker and opens the 24-chromosome shell while preparation is still running', async () => {
    let finishBackgroundPreparation!: () => void;
    let backgroundPreparationFinished = false;
    const backgroundPreparation = new Promise<void>((resolve) => {
      finishBackgroundPreparation = resolve;
    }).then(() => {
      backgroundPreparationFinished = true;
    });
    installHosted.mockImplementation(async () => {
      void backgroundPreparation;
      return { status: 'view-ready' as const, entry: grch38Shell };
    });

    render(<PickerHarness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download GRCh38 (human)' }));

    await waitFor(() =>
      expect(installHosted).toHaveBeenCalledWith({
        catalogId: 'grch38',
        themeMode: 'light',
        intent: 'open-view',
      })
    );
    expect(backgroundPreparationFinished).toBe(false);
    const row = await screen.findByTestId('reference-hosted-grch38');
    fireEvent.click(within(row).getByRole('button', { name: 'Show details for GRCh38 (human)' }));
    expect(screen.getByTestId('reference-saved-views-grch38')).toBeVisible();
    fireEvent.click(within(row).getByRole('button', { name: 'Open GRCh38 (human)' }));

    await waitFor(() =>
      expect(
        useCanvasStore
          .getState()
          .panels.main.tabs.find((tab) => tab.indexedGenome?.assembly?.assemblyId === 'grch38')
      ).toBeDefined()
    );
    expect(
      useCanvasStore
        .getState()
        .panels.main.tabs.find((tab) => tab.indexedGenome?.assembly?.assemblyId === 'grch38')
        ?.indexedGenome
    ).toMatchObject({
      assembly: {
        assemblyId: 'grch38',
        chromosomes: expect.arrayContaining([
          expect.objectContaining({ chrom: 'chr1' }),
          expect.objectContaining({ chrom: 'chrY' }),
        ]),
      },
      assemblySourceReadiness: 'pending',
      assemblyAnnotationProductsReadiness: 'pending',
      assemblySearchReadiness: 'pending',
      scope: { kind: 'all' },
    });
    expect(
      useCanvasStore
        .getState()
        .panels.main.tabs.find((tab) => tab.indexedGenome?.assembly?.assemblyId === 'grch38')
        ?.indexedGenome?.assembly?.chromosomes
    ).toHaveLength(24);
    expect(installHosted).toHaveBeenCalledTimes(2);
    expect(installHosted).toHaveBeenNthCalledWith(2, {
      catalogId: 'grch38',
      themeMode: 'light',
      intent: 'open-view',
    });
    expect(
      screen.queryByRole('dialog', { name: 'Reference genome library' })
    ).not.toBeInTheDocument();
    expect(backgroundPreparationFinished).toBe(false);

    finishBackgroundPreparation();
    await backgroundPreparation;
  });
});
