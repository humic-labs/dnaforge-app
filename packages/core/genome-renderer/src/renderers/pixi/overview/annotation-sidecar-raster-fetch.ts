import type { TileTransport } from '../../../engine/sources/tile-transport';
import type {
  AnnotationSidecarRasterTile,
  AnnotationSidecarRasterTileFetchRequest,
} from './annotation-sidecar-raster-presenter';

export interface AnnotationSidecarRasterFetcherOptions {
  readonly transport: TileTransport;
  readonly resolveGffPath: (chrom: string) => string | null;
  readonly bank?: 'canonical' | 'expanded';
}

interface AnnotationTileRouteBody {
  readonly fine?: boolean;
  readonly format?: string;
  readonly exonRasters?: unknown;
  readonly cdsRasters?: unknown;
  readonly availableTypes?: unknown;
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'number');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isNumberArrayArray(value: unknown): value is number[][] {
  return Array.isArray(value) && value.every((v) => isNumberArray(v));
}

export function createAnnotationSidecarRasterFetcher(
  options: AnnotationSidecarRasterFetcherOptions
): (request: AnnotationSidecarRasterTileFetchRequest) => Promise<AnnotationSidecarRasterTile> {
  const { transport, resolveGffPath, bank } = options;
  return async (request) => {
    const gffPath = resolveGffPath(request.chrom.chrom);
    if (!gffPath) {
      throw new Error(
        `annotation raster tile fetch: no known GFF3 path for chrom ${request.chrom.chrom}`
      );
    }
    const controller = new AbortController();
    const response = await transport(
      {
        kind: 'annotation',
        level: request.level,
        tileIndex: request.tileIndex,
        body: {
          gffPath,
          chrom: request.chrom.chrom,
          chromGlobalStart: request.chrom.globalStart,
          ...(bank ? { bank } : {}),
          visibleTypes: [...request.visibleTypes],
          ...(request.laneLimit !== undefined ? { laneLimit: request.laneLimit } : {}),
        },
      },
      controller.signal
    );
    if (!response.ok) {
      throw new Error(
        `annotation raster tile fetch failed: chrom=${request.chrom.chrom} level=${request.level} tileIndex=${request.tileIndex} status=${response.status}`
      );
    }
    const body = response.body as AnnotationTileRouteBody | null;
    if (!body || body.format !== 'raster' || body.fine !== false) {
      throw new Error(
        `annotation raster tile fetch returned a non-raster body: chrom=${request.chrom.chrom} level=${request.level} tileIndex=${request.tileIndex} format=${String(body?.format)} fine=${String(body?.fine)}`
      );
    }
    const exonRasters = body.exonRasters;
    const cdsRasters = body.cdsRasters;
    if (!isNumberArrayArray(exonRasters) || !isNumberArrayArray(cdsRasters)) {
      throw new Error(
        `annotation raster tile response missing exonRasters/cdsRasters: chrom=${request.chrom.chrom} level=${request.level} tileIndex=${request.tileIndex}`
      );
    }
    if (exonRasters.length === 0 || exonRasters.length !== cdsRasters.length) {
      throw new Error(
        `annotation raster tile response has mismatched lane counts: chrom=${request.chrom.chrom} level=${request.level} tileIndex=${request.tileIndex} exonLanes=${exonRasters.length} cdsLanes=${cdsRasters.length}`
      );
    }
    return {
      lanes: exonRasters.map((exonRaster, i) => ({
        exonRaster,
        cdsRaster: cdsRasters[i],
      })),
      ...(isStringArray(body.availableTypes) ? { availableTypes: body.availableTypes } : {}),
    };
  };
}
