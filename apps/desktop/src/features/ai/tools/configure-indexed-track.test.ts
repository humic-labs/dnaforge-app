import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { configureIndexedTrackOutputSchema } from './genome-output-schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../../canvas/public/store';
import { useLaneContractStore } from '../../sequence/public/lane-contract-store';
import { execTool as executeTool, mockUUID, resetCanvasStore } from './test-helpers';
import {
  configureIndexedTrackSchema,
  createConfigureIndexedTrackTool,
  type ConfigureIndexedTrackResult,
} from './configure-indexed-track';

mockUUID();

beforeEach(() => {
  resetCanvasStore();
  useLaneContractStore.getState().clear();
});

function openIndexedTab(): string {
  return useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: 'assembly:test',
    sequenceDocument: { kind: 'indexed-sequence', documentId: 'assembly:test' },
    label: 'Test assembly',
    indexedGenome: {
      sourcePath: 'refs/chrI.fa',
      sourceExt: '.fa',
      chrom: 'chrI',
      manifest: { chrom: 'chrI', fastaPath: 'chrI.fa', faiPath: 'chrI.fa.fai', length: 100 },
    },
  });
}

describe('configure_indexed_track', () => {
  it('requires a strict nonempty settings patch', () => {
    expect(
      configureIndexedTrackSchema.safeParse({
        trackId: 'signal',
        settings: { color: '#e11d48', heightPx: 120 },
      }).success
    ).toBe(true);
    expect(configureIndexedTrackSchema.safeParse({ trackId: 'signal', settings: {} }).success).toBe(
      false
    );
    expect(
      configureIndexedTrackSchema.safeParse({
        trackId: 'signal',
        settings: { color: 'red' },
      }).success
    ).toBe(false);
  });

  it('changes and reads back quantitative settings through the lane command boundary', async () => {
    const tabId = openIndexedTab();
    useLaneContractStore.getState().addLane(tabId, 'test', {
      trackType: 'quantitative',
      trackId: 'signal',
      label: 'Signal',
      color: 0x2563eb,
      trackPx: 96,
      records: [],
      kind: 'annotation',
      quantitativeSourceSummary: {
        contract: 'dnaforge.quantitative-source-summary.v1',
        algorithm: 'equal-genomic-bin-means-r7-quantiles-v1',
        targetSampleCount: 65_536,
        sampleCount: 100,
        lowerQuantile: 0.005,
        upperQuantile: 0.995,
        robustMin: 0,
        robustMax: 20,
        fullMin: 0,
        fullMax: 1_000,
        missingData: 'excluded',
      },
    });

    const result = await execTool<ConfigureIndexedTrackResult>(createConfigureIndexedTrackTool(), {
      trackId: 'signal',
      settings: {
        label: 'RNA-seq',
        color: '#e11d48',
        heightPx: 144,
        quantitative: {
          mode: 'full-global',
          transform: 'log1p',
          smoothingSigmaBins: 1.2,
          showRange: false,
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      tabId,
      track: {
        label: 'RNA-seq',
        color: '#e11d48',
        heightPx: 144,
        quantitative: {
          showRange: false,
          smoothingSigmaBins: 1.2,
          scale: { mode: 'full-global', transform: 'log1p' },
        },
      },
    });
  });

  it('rejects signed log scaling without partially changing visibility', async () => {
    const tabId = openIndexedTab();
    useLaneContractStore.getState().addLane(tabId, 'test', {
      trackType: 'quantitative',
      trackId: 'signed',
      label: 'Signed signal',
      color: 0x2563eb,
      trackPx: 96,
      records: [],
      kind: 'annotation',
      quantitativeSourceSummary: {
        contract: 'dnaforge.quantitative-source-summary.v1',
        algorithm: 'equal-genomic-bin-means-r7-quantiles-v1',
        targetSampleCount: 65_536,
        sampleCount: 100,
        lowerQuantile: 0.005,
        upperQuantile: 0.995,
        robustMin: -5,
        robustMax: 20,
        fullMin: -100,
        fullMax: 1_000,
        missingData: 'excluded',
      },
    });

    const result = await execTool<ConfigureIndexedTrackResult>(createConfigureIndexedTrackTool(), {
      trackId: 'signed',
      settings: { visible: false, quantitative: { transform: 'log1p' } },
    });

    expect(result).toMatchObject({ ok: false, code: 'INVALID_SETTINGS', stateChanged: false });
    expect(useLaneContractStore.getState().lanesForOwner(tabId)[0].visible).toBe(true);
  });

  it('rejects BAM/CRAM-only row settings for a quantitative track', async () => {
    const tabId = openIndexedTab();
    useLaneContractStore.getState().addLane(tabId, 'test', {
      trackType: 'quantitative',
      trackId: 'signal',
      label: 'Signal',
      color: 0x2563eb,
      trackPx: 96,
      laneHeightPx: 8,
      maxLanes: 32,
      records: [],
      kind: 'annotation',
    });

    const result = await execTool<ConfigureIndexedTrackResult>(createConfigureIndexedTrackTool(), {
      trackId: 'signal',
      settings: { rowHeightPx: 5, maxRows: 60 },
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'INVALID_SETTINGS',
      error: expect.stringContaining('BAM/CRAM'),
    });
    expect(useLaneContractStore.getState().lanesForOwner(tabId)[0].dataset).toMatchObject({
      laneHeightPx: 8,
      maxLanes: 32,
    });
  });
  it('retains the confirmed presentation effect when a later visibility update fails', async () => {
    const tabId = openIndexedTab();
    const store = useLaneContractStore.getState();
    store.addLane(tabId, 'test', {
      trackType: 'quantitative',
      trackId: 'signal',
      label: 'Original',
      color: 0x2563eb,
      trackPx: 96,
      records: [],
      kind: 'annotation',
    });
    const visibility = vi
      .spyOn(useLaneContractStore.getState(), 'setLaneVisible')
      .mockImplementation(() => {
        throw new Error('Visibility projection failed');
      });
    try {
      const result = await execTool<ConfigureIndexedTrackResult>(
        createConfigureIndexedTrackTool(),
        { trackId: 'signal', settings: { label: 'Updated', visible: false } }
      );
      expect(result).toMatchObject({
        ok: false,
        code: 'INVALID_SETTINGS',
        stateChanged: 'unknown',
        partialEffects: ['track-presentation:signal'],
      });
      expect(useLaneContractStore.getState().lanesForOwner(tabId)[0].dataset.label).toBe('Updated');
    } finally {
      visibility.mockRestore();
    }
  });
});

async function execTool<T>(...args: Parameters<typeof executeTool>): Promise<T> {
  const result = await executeTool<T>(...args);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === true)
    assertMcpOutput(configureIndexedTrackOutputSchema, result);
  return result;
}
