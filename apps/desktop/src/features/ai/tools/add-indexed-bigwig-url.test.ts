import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { addIndexedBigWigUrlOutputSchema } from './genome-output-schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../../canvas/store';
import { useLaneContractStore } from '../../sequence/lane-contract-store';
import { execTool as executeTool, mockUUID, resetCanvasStore } from './test-helpers';
import {
  addIndexedBigWigUrlSchema,
  createAddIndexedBigWigUrlTool,
  type AddIndexedBigWigUrlResult,
} from './add-indexed-bigwig-url';

mockUUID();

const URL = 'https://results.example.org/run/signal.bigWig';

beforeEach(() => {
  resetCanvasStore();
  useLaneContractStore.getState().clear();
});

describe('add_indexed_bigwig_url schema', () => {
  it('rejects unknown keys, credentials, and non-http schemes', () => {
    expect(addIndexedBigWigUrlSchema.safeParse({ url: URL }).success).toBe(true);
    expect(addIndexedBigWigUrlSchema.safeParse({ url: URL, unexpected: true }).success).toBe(false);
    expect(
      addIndexedBigWigUrlSchema.safeParse({ url: 'https://user:secret@example.org/x.bw' }).success
    ).toBe(false);
    expect(addIndexedBigWigUrlSchema.safeParse({ url: 'file:///tmp/x.bw' }).success).toBe(false);
    expect(addIndexedBigWigUrlSchema.safeParse({}).success).toBe(false);
  });
});

describe('add_indexed_bigwig_url tool', () => {
  it('returns NO_INDEXED_VIEW when no indexed tab is open', async () => {
    const result = await execTool<AddIndexedBigWigUrlResult>(createAddIndexedBigWigUrlTool(), {
      url: URL,
    });
    expect(result).toMatchObject({ ok: false, code: 'NO_INDEXED_VIEW' });
  });

  it('attaches a URL to the open assembly tab and reports a later duplicate', async () => {
    const attach = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'added',
        trackId: 'data:signal.bigWig-abc',
        label: 'Pol II pSer5 WT',
      })
      .mockResolvedValueOnce({
        status: 'duplicate',
        trackId: 'data:signal.bigWig-abc',
        label: 'Pol II pSer5 WT',
      });
    const tabId = useCanvasStore.getState().openTab('main', {
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
          ],
        },
      },
    });
    const tool = createAddIndexedBigWigUrlTool({ attach });
    const added = await execTool<AddIndexedBigWigUrlResult>(tool, {
      url: URL,
      label: 'Pol II pSer5 WT',
    });
    expect(added).toEqual({
      ok: true,
      tabId,
      assemblyId: 'test',
      trackId: 'data:signal.bigWig-abc',
      label: 'Pol II pSer5 WT',
      url: URL,
      status: 'added',
      laneCount: 0,
    });
    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({
        laneOwnerId: tabId,
        assemblyId: 'test',
        assemblyReferences: [{ name: 'chrI', length: 100, aliases: ['I'] }],
        request: expect.objectContaining({
          source: { kind: 'http', url: URL },
          label: 'Pol II pSer5 WT',
          ingress: { kind: 'automation' },
        }),
      })
    );

    const duplicate = await execTool<AddIndexedBigWigUrlResult>(tool, {
      url: URL,
      label: 'Pol II pSer5 WT',
    });
    expect(duplicate).toMatchObject({ ok: true, status: 'duplicate', tabId });
  });

  it('maps admission throws to ADMISSION_FAILED without swallowing cancel', async () => {
    useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: 'assembly:chrI',
      sequenceDocument: { kind: 'indexed-sequence', documentId: 'assembly:chrI' },
      label: 'chrI',
      indexedGenome: {
        sourcePath: 'refs/chrI.fa',
        sourceExt: '.fa',
        chrom: 'chrI',
        manifest: { chrom: 'chrI', fastaPath: 'chrI.fa', faiPath: 'chrI.fa.fai', length: 500 },
      },
    });
    const tool = createAddIndexedBigWigUrlTool({
      attach: async () => {
        throw new Error('BigWig reference mismatch for chr1');
      },
    });
    const result = await execTool<AddIndexedBigWigUrlResult>(tool, { url: URL });
    expect(result).toMatchObject({
      ok: false,
      code: 'ADMISSION_FAILED',
      message: 'BigWig reference mismatch for chr1',
    });
  });

  it('reports the committed attach when cancellation arrives after the lane commit point', async () => {
    useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: 'assembly:chrI',
      sequenceDocument: { kind: 'indexed-sequence', documentId: 'assembly:chrI' },
      label: 'chrI',
      indexedGenome: {
        sourcePath: 'refs/chrI.fa',
        sourceExt: '.fa',
        chrom: 'chrI',
        manifest: { chrom: 'chrI', fastaPath: 'chrI.fa', faiPath: 'chrI.fa.fai', length: 500 },
      },
    });
    const controller = new AbortController();
    const attach = vi.fn(async () => {
      controller.abort();
      return {
        status: 'added' as const,
        trackId: 'data:signal.bigWig-abc',
        label: 'signal.bigWig',
      };
    });
    const result = await execTool<AddIndexedBigWigUrlResult>(
      createAddIndexedBigWigUrlTool({ attach }),
      { url: URL },
      { abortSignal: controller.signal }
    );

    expect(result).toMatchObject({
      ok: true,
      status: 'added',
      trackId: 'data:signal.bigWig-abc',
    });
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it('returns NO_ASSEMBLY_REFERENCES when the open tab has no chromosome lengths', async () => {
    useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: 'assembly:chrI',
      sequenceDocument: { kind: 'indexed-sequence', documentId: 'assembly:chrI' },
      label: 'chrI',
      indexedGenome: {
        sourcePath: 'refs/chrI.fa',
        sourceExt: '.fa',
        chrom: 'chrI',
      },
    });
    const result = await execTool<AddIndexedBigWigUrlResult>(createAddIndexedBigWigUrlTool(), {
      url: URL,
    });
    expect(result).toMatchObject({ ok: false, code: 'NO_ASSEMBLY_REFERENCES' });
  });
});

async function execTool<T>(...args: Parameters<typeof executeTool>): Promise<T> {
  const result = await executeTool<T>(...args);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === true)
    assertMcpOutput(addIndexedBigWigUrlOutputSchema, result);
  return result;
}
