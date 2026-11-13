import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { setIndexedCurrentViewOutputSchema } from './genome-output-schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../../canvas/store';
import type { IndexedLiveViewport } from '../../sequence/indexed-live-viewport';
import { execTool as executeTool, mockUUID, resetCanvasStore } from './test-helpers';
import {
  createSetIndexedCurrentViewTool,
  setIndexedCurrentViewSchema,
} from './set-indexed-current-view';

mockUUID();

beforeEach(() => {
  resetCanvasStore();
});

describe('set_indexed_current_view schema', () => {
  it('rejects unknown keys and a missing chrom', () => {
    const input = { chrom: 'chrI', start0: 0, end0: 100 };
    expect(setIndexedCurrentViewSchema.safeParse(input).success).toBe(true);
    expect(setIndexedCurrentViewSchema.safeParse({ ...input, unexpected: true }).success).toBe(
      false
    );
    expect(setIndexedCurrentViewSchema.safeParse({ start0: 0, end0: 100 }).success).toBe(false);
  });
});

describe('set_indexed_current_view tool', () => {
  const createToolWithLiveAck = () =>
    createSetIndexedCurrentViewTool({
      waitForLiveViewport: async (input): Promise<IndexedLiveViewport> => ({
        tabId: input.tabId,
        chrom: input.chrom,
        start0: input.start0,
        end0: input.end0,
        commandId: input.commandId,
      }),
    });

  it('stamps a 0-based locus including start0 0 and readback', async () => {
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
        scope: { kind: 'all' },
      },
    });
    const result = await execTool<{ chrom?: string; start0?: number; end0?: number }>(
      createToolWithLiveAck(),
      { chrom: 'chrI', start0: 0, end0: 500 }
    );
    expect(result).toMatchObject({ chrom: 'chrI', start0: 0, end0: 500 });
    const tab = useCanvasStore.getState().panels.main.tabs.find((item) => item.id === tabId);
    expect(tab?.indexedGenome?.scope).toEqual({
      kind: 'locus',
      chrom: 'chrI',
      start: 0,
      end: 500,
    });
    expect(tab?.viewState?.indexedViewport).toEqual({ start0: 0, end0: 500 });
    expect(tab?.viewState?.indexedViewportCommand).toBeNull();
  });

  it('resolves an assembly alias and rejects unknown or out-of-range coordinates', async () => {
    useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: 'assembly:test',
      sequenceDocument: { kind: 'indexed-sequence', documentId: 'assembly:test' },
      label: 'Test assembly',
      indexedGenome: {
        sourcePath: 'refs/chrI.fa',
        sourceExt: '.fa',
        chrom: 'chrI',
        assembly: {
          assemblyId: 'test',
          displayName: 'Test assembly',
          chromosomes: [
            {
              chrom: 'chrI',
              displayName: 'chrI',
              length: 100,
              aliases: { ensembl: 'I' },
              manifest: { chrom: 'chrI', fastaPath: 'chrI.fa', faiPath: 'chrI.fa.fai' },
            },
            {
              chrom: 'chrII',
              displayName: 'chrII',
              length: 200,
              aliases: { ensembl: 'II' },
              manifest: { chrom: 'chrII', fastaPath: 'chrII.fa', faiPath: 'chrII.fa.fai' },
            },
          ],
        },
      },
    });
    const alias = await execTool<{ chrom?: string }>(createToolWithLiveAck(), {
      chrom: 'I',
      start0: 0,
      end0: 50,
    });
    expect(alias).toMatchObject({ ok: true, chrom: 'chrI' });
    const crossChromosome = await execTool<{ chrom?: string }>(createToolWithLiveAck(), {
      chrom: 'II',
      start0: 10,
      end0: 20,
    });
    expect(crossChromosome).toMatchObject({ ok: true, chrom: 'chrII' });
    const assemblyTab = useCanvasStore.getState().panels.main.tabs[0];
    expect(assemblyTab?.indexedGenome?.chrom).toBe('chrI');
    expect(assemblyTab?.indexedGenome?.sourcePath).toBe('refs/chrI.fa');
    expect(assemblyTab?.indexedGenome?.scope).toEqual({
      kind: 'locus',
      chrom: 'chrII',
      start: 10,
      end: 20,
    });
    const unknown = await execTool<{ ok?: boolean; error?: string }>(createToolWithLiveAck(), {
      chrom: 'chrIII',
      start0: 0,
      end0: 50,
    });
    expect(unknown).toMatchObject({ ok: false, code: 'CHROM_NOT_FOUND' });
    const outOfRange = await execTool<{ ok?: boolean; error?: string }>(createToolWithLiveAck(), {
      chrom: 'chrI',
      start0: 90,
      end0: 110,
    });
    expect(outOfRange).toMatchObject({ ok: false, code: 'OUT_OF_RANGE' });
  });

  it('rejects a reversed interval and a missing indexed tab', async () => {
    const reversed = await execTool<{ ok?: boolean; error?: string }>(createToolWithLiveAck(), {
      chrom: 'chrI',
      start0: 20,
      end0: 10,
    });
    expect(reversed).toMatchObject({ ok: false, code: 'MALFORMED_INTERVAL' });
    resetCanvasStore();
    useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: 'sequence-puc19',
      sequenceDocument: { kind: 'catalog-sequence', entityId: 'sequence-puc19' },
      label: 'pUC19',
    });
    const missing = await execTool<{ ok?: boolean; error?: string }>(createToolWithLiveAck(), {
      chrom: 'chrI',
      start0: 0,
      end0: 10,
    });
    expect(missing).toMatchObject({ ok: false, code: 'NO_INDEXED_VIEW' });
  });

  it('does not mutate the tab when the request is already cancelled', async () => {
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
    const before = useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === tabId);
    const controller = new AbortController();
    controller.abort();
    const result = await execTool<{ ok?: boolean; error?: string }>(
      createToolWithLiveAck(),
      { chrom: 'chrI', start0: 0, end0: 100 },
      {
        toolCallId: 'cancelled-set',
        messages: [],
        abortSignal: controller.signal,
        grantedCapabilities: undefined,
      }
    );
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED' });
    expect(useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === tabId)).toEqual(
      before
    );
  });

  it('rolls back unacknowledged and in-flight-cancelled navigation without clobbering a newer command', async () => {
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
      viewState: { indexedViewport: { start0: 10, end0: 20 } },
    });
    const before = useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === tabId);
    const unacknowledged = createSetIndexedCurrentViewTool({
      waitForLiveViewport: async () => null,
    });

    const failed = await execTool<{ ok?: boolean; error?: string }>(unacknowledged, {
      chrom: 'chrI',
      start0: 30,
      end0: 40,
    });
    expect(failed).toMatchObject({ ok: false, code: 'VIEW_NOT_APPLIED' });
    expect(useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === tabId)).toEqual(
      before
    );

    const controller = new AbortController();
    const cancelled = createSetIndexedCurrentViewTool({
      waitForLiveViewport: async () => {
        controller.abort();
        return null;
      },
    });
    const cancelledResult = await execTool<{ ok?: boolean; error?: string }>(
      cancelled,
      { chrom: 'chrI', start0: 40, end0: 50 },
      {
        toolCallId: 'in-flight-cancelled-set',
        messages: [],
        abortSignal: controller.signal,
        grantedCapabilities: undefined,
      }
    );
    expect(cancelledResult).toMatchObject({ ok: false, code: 'CANCELLED' });
    expect(useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === tabId)).toEqual(
      before
    );

    const newerCommand = { id: Number.MAX_SAFE_INTEGER, chrom: 'chrI', start0: 70, end0: 80 };
    const raced = createSetIndexedCurrentViewTool({
      waitForLiveViewport: async () => {
        useCanvasStore.getState().updateTab('main', tabId, {
          viewState: {
            indexedViewport: { start0: 70, end0: 80 },
            indexedViewportCommand: newerCommand,
          },
        });
        return null;
      },
    });
    await execTool(raced, { chrom: 'chrI', start0: 50, end0: 60 });
    expect(
      useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === tabId)?.viewState
        ?.indexedViewportCommand
    ).toEqual(newerCommand);
  });

  it('rolls back only its navigation fields and preserves concurrent tab updates', async () => {
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
        bamTracks: [],
      },
      viewState: { indexedViewport: { start0: 10, end0: 20 } },
    });
    const tool = createSetIndexedCurrentViewTool({
      waitForLiveViewport: async () => {
        const current = useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === tabId)!;
        useCanvasStore.getState().updateTab('main', tabId, {
          indexedGenome: {
            ...current.indexedGenome!,
            bamTracks: [
              {
                sourcePath: '/ws/sample.bam',
                sourceIdentity: 'sample-bam',
                indexPath: '/ws/sample.bam.bai',
                indexIdentity: 'sample-bai',
                trackId: 'sample',
                label: 'Sample',
              },
            ],
          },
          viewState: {
            ...(current.viewState ?? {}),
            highlightRange: { start: 4, end: 8 },
          },
        });
        return null;
      },
    });

    await expect(
      execTool<{ ok?: boolean; error?: string }>(tool, {
        chrom: 'chrI',
        start0: 30,
        end0: 40,
      })
    ).resolves.toMatchObject({ ok: false, code: 'VIEW_NOT_APPLIED' });

    const after = useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === tabId);
    expect(after?.indexedGenome?.scope).toEqual({ kind: 'chromosome', chrom: 'chrI' });
    expect(after?.indexedGenome?.bamTracks).toHaveLength(1);
    expect(after?.viewState?.indexedViewport).toEqual({ start0: 10, end0: 20 });
    expect(after?.viewState?.highlightRange).toEqual({ start: 4, end: 8 });
  });
});

async function execTool<T>(...args: Parameters<typeof executeTool>): Promise<T> {
  const result = await executeTool<T>(...args);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === true)
    assertMcpOutput(setIndexedCurrentViewOutputSchema, result);
  return result;
}
