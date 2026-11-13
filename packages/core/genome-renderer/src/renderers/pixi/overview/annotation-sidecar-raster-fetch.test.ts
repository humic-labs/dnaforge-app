import { describe, expect, it, vi } from 'vitest';
import type { TileTransport, TileTransportRequest } from '../../../engine/sources/tile-transport';
import { createAnnotationSidecarRasterFetcher } from './annotation-sidecar-raster-fetch';
import type { AnnotationSidecarRasterChromosome } from './annotation-sidecar-raster-presenter';

function fakeTransport(
  handler: (req: TileTransportRequest) => { ok: boolean; status: number; body: unknown }
): TileTransport {
  return vi.fn(async (req: TileTransportRequest) => handler(req));
}

const CHR11: AnnotationSidecarRasterChromosome = {
  chrom: 'chr11',
  globalStart: 1_000_000_000,
  length: 135_086_622,
};
const GFF_PATHS = new Map([['chr11', '/fixtures/ncbi-gff3/chr11.gff3.gz']]);

describe('createAnnotationSidecarRasterFetcher (multi-chromosome)', () => {
  it("POSTs an annotation-kind request with the resolved gffPath and this chromosome's globalStart as chromGlobalStart", async () => {
    const transport = fakeTransport(() => ({
      ok: true,
      status: 200,
      body: {
        fine: false,
        format: 'raster',
        exonRasters: [[0.5]],
        cdsRasters: [[0.25]],
        markCount: 3,
      },
    }));
    const fetchCoarseTile = createAnnotationSidecarRasterFetcher({
      transport,
      resolveGffPath: (chrom) => GFF_PATHS.get(chrom) ?? null,
    });
    await fetchCoarseTile({ chrom: CHR11, level: 18, tileIndex: 3, visibleTypes: ['mRNA'] });
    expect(transport).toHaveBeenCalledWith(
      {
        kind: 'annotation',
        level: 18,
        tileIndex: 3,
        body: {
          gffPath: '/fixtures/ncbi-gff3/chr11.gff3.gz',
          chrom: 'chr11',
          chromGlobalStart: CHR11.globalStart,
          visibleTypes: ['mRNA'],
        },
      },
      expect.anything()
    );
  });

  it('resolves with a single-lane tile on a 200 raster response with one lane', async () => {
    const transport = fakeTransport(() => ({
      ok: true,
      status: 200,
      body: {
        fine: false,
        format: 'raster',
        exonRasters: [[1, 2, 3]],
        cdsRasters: [[4, 5, 6]],
        markCount: 9,
      },
    }));
    const fetchCoarseTile = createAnnotationSidecarRasterFetcher({
      transport,
      resolveGffPath: () => GFF_PATHS.get('chr11') ?? null,
    });
    const tile = await fetchCoarseTile({
      chrom: CHR11,
      level: 18,
      tileIndex: 3,
      visibleTypes: ['mRNA'],
    });
    expect(tile.lanes).toEqual([{ exonRaster: [1, 2, 3], cdsRaster: [4, 5, 6] }]);
  });

  it('carries availableTypes through when the response includes it', async () => {
    const transport = fakeTransport(() => ({
      ok: true,
      status: 200,
      body: {
        fine: false,
        format: 'raster',
        exonRasters: [[1, 2, 3]],
        cdsRasters: [[4, 5, 6]],
        markCount: 9,
        availableTypes: ['gene', 'lncRNA', 'mRNA'],
      },
    }));
    const fetchCoarseTile = createAnnotationSidecarRasterFetcher({
      transport,
      resolveGffPath: () => GFF_PATHS.get('chr11') ?? null,
    });
    const tile = await fetchCoarseTile({
      chrom: CHR11,
      level: 18,
      tileIndex: 3,
      visibleTypes: ['mRNA'],
    });
    expect(tile.availableTypes).toEqual(['gene', 'lncRNA', 'mRNA']);
  });

  it('omits availableTypes when the response does not include it (older sidecar, still valid)', async () => {
    const transport = fakeTransport(() => ({
      ok: true,
      status: 200,
      body: { fine: false, format: 'raster', exonRasters: [[1]], cdsRasters: [[1]], markCount: 1 },
    }));
    const fetchCoarseTile = createAnnotationSidecarRasterFetcher({
      transport,
      resolveGffPath: () => GFF_PATHS.get('chr11') ?? null,
    });
    const tile = await fetchCoarseTile({
      chrom: CHR11,
      level: 18,
      tileIndex: 3,
      visibleTypes: ['mRNA'],
    });
    expect(tile.availableTypes).toBeUndefined();
  });

  it('resolves with N lanes on a multi-lane raster response and threads laneLimit into the request body', async () => {
    const transport = fakeTransport(() => ({
      ok: true,
      status: 200,
      body: {
        fine: false,
        format: 'raster',
        exonRasters: [
          [1, 0],
          [0, 1],
        ],
        cdsRasters: [
          [0.1, 0],
          [0, 0.2],
        ],
        markCount: 9,
      },
    }));
    const fetchCoarseTile = createAnnotationSidecarRasterFetcher({
      transport,
      resolveGffPath: () => GFF_PATHS.get('chr11') ?? null,
    });
    const tile = await fetchCoarseTile({
      chrom: CHR11,
      level: 18,
      tileIndex: 3,
      visibleTypes: ['mRNA'],
      laneLimit: 2,
    });
    expect(tile.lanes).toEqual([
      { exonRaster: [1, 0], cdsRaster: [0.1, 0] },
      { exonRaster: [0, 1], cdsRaster: [0, 0.2] },
    ]);
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ laneLimit: 2 }) }),
      expect.anything()
    );
  });

  it('rejects when exonRasters/cdsRasters have mismatched lane counts', async () => {
    const transport = fakeTransport(() => ({
      ok: true,
      status: 200,
      body: {
        fine: false,
        format: 'raster',
        exonRasters: [[1], [2]],
        cdsRasters: [[1]],
        markCount: 2,
      },
    }));
    const fetchCoarseTile = createAnnotationSidecarRasterFetcher({
      transport,
      resolveGffPath: () => GFF_PATHS.get('chr11') ?? null,
    });
    await expect(
      fetchCoarseTile({ chrom: CHR11, level: 18, tileIndex: 3, visibleTypes: ['mRNA'] })
    ).rejects.toThrow();
  });

  it('rejects without calling the transport when the chromosome has no known gffPath', async () => {
    const transport = fakeTransport(() => ({ ok: true, status: 200, body: {} }));
    const fetchCoarseTile = createAnnotationSidecarRasterFetcher({
      transport,
      resolveGffPath: () => null,
    });
    await expect(
      fetchCoarseTile({ chrom: CHR11, level: 18, tileIndex: 3, visibleTypes: ['mRNA'] })
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects on a non-2xx response instead of resolving a bogus tile', async () => {
    const transport = fakeTransport(() => ({
      ok: false,
      status: 404,
      body: { detail: 'not found' },
    }));
    const fetchCoarseTile = createAnnotationSidecarRasterFetcher({
      transport,
      resolveGffPath: () => GFF_PATHS.get('chr11') ?? null,
    });
    await expect(
      fetchCoarseTile({ chrom: CHR11, level: 18, tileIndex: 3, visibleTypes: ['mRNA'] })
    ).rejects.toThrow();
  });

  it('rejects if the sidecar returns a fine (vector) tile instead of a raster one', async () => {
    const transport = fakeTransport(() => ({
      ok: true,
      status: 200,
      body: { fine: true, format: 'vector', transcripts: [], droppedCount: 0 },
    }));
    const fetchCoarseTile = createAnnotationSidecarRasterFetcher({
      transport,
      resolveGffPath: () => GFF_PATHS.get('chr11') ?? null,
    });
    await expect(
      fetchCoarseTile({ chrom: CHR11, level: 18, tileIndex: 3, visibleTypes: ['mRNA'] })
    ).rejects.toThrow();
  });

  it('rejects if the response body is missing the expected raster fields', async () => {
    const transport = fakeTransport(() => ({
      ok: true,
      status: 200,
      body: { fine: false, format: 'raster' },
    }));
    const fetchCoarseTile = createAnnotationSidecarRasterFetcher({
      transport,
      resolveGffPath: () => GFF_PATHS.get('chr11') ?? null,
    });
    await expect(
      fetchCoarseTile({ chrom: CHR11, level: 18, tileIndex: 3, visibleTypes: ['mRNA'] })
    ).rejects.toThrow();
  });
});
