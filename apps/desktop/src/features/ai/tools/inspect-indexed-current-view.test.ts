import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { inspectIndexedCurrentViewOutputSchema } from './genome-output-schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../../canvas/public/store';
import { execTool as executeTool, mockUUID, resetCanvasStore } from './test-helpers';
import {
  registerIndexedLiveViewportReader,
  resetIndexedLiveViewportForTests,
} from '../../sequence/public/indexed-live-viewport';
import { useLaneContractStore } from '../../sequence/public/lane-contract-store';
import {
  createInspectIndexedCurrentViewTool,
  inspectIndexedCurrentViewSchema,
} from './inspect-indexed-current-view';

mockUUID();

beforeEach(() => {
  resetCanvasStore();
  resetIndexedLiveViewportForTests();
  useLaneContractStore.getState().clear();
});

describe('inspect_indexed_current_view schema', () => {
  it('rejects unknown keys', () => {
    expect(inspectIndexedCurrentViewSchema.safeParse({}).success).toBe(true);
    expect(inspectIndexedCurrentViewSchema.safeParse({ unexpected: true }).success).toBe(false);
  });
});

describe('inspect_indexed_current_view tool', () => {
  it('keeps live start0 0 as real and omits a missing assembly id', async () => {
    const store = useCanvasStore.getState();
    const tabId = store.openTab('main', {
      type: 'sequence',
      entityId: 'assembly:chrI',
      sequenceDocument: { kind: 'indexed-sequence', documentId: 'assembly:chrI' },
      label: 'chrI',
      indexedGenome: {
        sourcePath: 'refs/chrI.fa',
        sourceExt: '.fa',
        chrom: 'chrI',
        scope: { kind: 'chromosome', chrom: 'chrI' },
      },
    });
    registerIndexedLiveViewportReader(tabId, () => ({
      chrom: 'chrI',
      start0: 0,
      end0: 250,
      commandId: null,
    }));
    useLaneContractStore.getState().addLane(tabId, 'chrI', {
      trackType: 'quantitative',
      trackId: 'signal',
      label: 'Signal',
      color: 0x2563eb,
      trackPx: 96,
      records: [],
      kind: 'annotation',
    });
    const result = await execTool<{
      start0?: number;
      assemblyId?: string;
      chrom?: string;
      tracks?: Array<{ trackId: string; color: string }>;
    }>(createInspectIndexedCurrentViewTool(), {});
    expect(result.chrom).toBe('chrI');
    expect(result.start0).toBe(0);
    expect(result).not.toHaveProperty('assemblyId');
    expect(result.tracks).toEqual([
      expect.objectContaining({ trackId: 'signal', color: '#2563eb' }),
    ]);
  });

  it('returns NO_INDEXED_VIEW when only a plasmid tab is open', async () => {
    const store = useCanvasStore.getState();
    store.openTab('main', {
      type: 'sequence',
      entityId: 'sequence-puc19',
      sequenceDocument: { kind: 'catalog-sequence', entityId: 'sequence-puc19' },
      label: 'pUC19',
    });
    const result = await execTool<{ ok?: boolean; error?: string }>(
      createInspectIndexedCurrentViewTool(),
      {}
    );
    expect(result).toMatchObject({ ok: false, code: 'NO_INDEXED_VIEW' });
  });

  it('omits stale persisted coordinates when a mounted assembly camera spans chromosomes', async () => {
    const tabId = useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: 'assembly:test',
      sequenceDocument: { kind: 'indexed-sequence', documentId: 'assembly:test' },
      label: 'Test assembly',
      indexedGenome: {
        sourcePath: 'refs/chrI.fa',
        sourceExt: '.fa',
        chrom: 'chrI',
        scope: { kind: 'locus', chrom: 'chrII', start: 25, end: 50 },
      },
      viewState: { indexedViewport: { start0: 25, end0: 50 } },
    });
    registerIndexedLiveViewportReader(tabId, () => null);

    const result = await execTool<{ chrom?: string; start0?: number; end0?: number }>(
      createInspectIndexedCurrentViewTool(),
      {}
    );
    expect(result.chrom).toBe('chrII');
    expect(result).not.toHaveProperty('start0');
    expect(result).not.toHaveProperty('end0');
  });

  it('returns CANCELLED when the tool abort signal is already fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await execTool<{ ok: boolean; error?: string }>(
      createInspectIndexedCurrentViewTool(),
      {},
      {
        toolCallId: 'test',
        messages: [],
        abortSignal: controller.signal,
        grantedCapabilities: undefined,
      }
    );
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED' });
  });
});

async function execTool<T>(...args: Parameters<typeof executeTool>): Promise<T> {
  const result = await executeTool<T>(...args);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === true)
    assertMcpOutput(inspectIndexedCurrentViewOutputSchema, result);
  return result;
}
