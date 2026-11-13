import { createHash } from 'node:crypto';
import { link, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCompiledBroadSurfaceManifestV2,
  type CompiledBroadSurfaceManifestV2,
} from '@waypoint/genome-renderer/pure';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COMPILED_BROAD_RASTER_ARTIFACT_V1,
  COMPILED_BROAD_RASTER_MANIFEST_FILE_V1,
  COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1,
  COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_V1,
  COMPILED_BROAD_RASTER_PIXEL_FORMAT_ROLE_WEIGHTS_V1,
  COMPILED_BROAD_RASTER_PIXEL_FORMAT_V1,
  CompiledBroadRasterArtifactError,
  MAX_COMPILED_BROAD_RASTER_CELLS_PER_READ_V1,
  exactUint8ArrayView,
  openCompiledBroadRasterArtifactV1,
  publishCompiledBroadRasterArtifactV1,
  type CompiledBroadRasterCellAddressV1,
  type CompiledBroadRasterPublisherFsV1,
  type CompiledBroadRasterSourceCellV1,
} from './compiled-broad-raster-artifact';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'annotationb-broad-raster-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function surfaceManifest(): Promise<CompiledBroadSurfaceManifestV2> {
  return buildCompiledBroadSurfaceManifestV2({
    artifactKey: 'grch38:mRNA:light:v1',
    trackId: 'mRNA',
    genomeLengthBp: 1_000,
    broadCorridorFinestSpanBp: 1_000,
    broadTilePhysicalWidthPx: 512,
    broadTileXGuardPhysicalPx: 1,
    prefetchRing: 1,
    maxQualifiedRasterMagnificationX: 1.75,
    rasterDevicePixelRatio: 1,
    laneSlabRowCount: 8,
    laneRowCssHeightPx: 16,
    laneRowTextureStridePx: 16,
    laneRowTransparentTailGutterPx: 2,
    laneRowCounts: { canonical: 8, expanded: 16 },
  });
}

function roster(manifest: CompiledBroadSurfaceManifestV2): CompiledBroadRasterCellAddressV1[] {
  const result: CompiledBroadRasterCellAddressV1[] = [];
  for (const isoformMode of ['canonical', 'expanded'] as const) {
    for (const level of manifest.levels) {
      for (let tileX = 0; tileX < level.tileCount; tileX += 1) {
        for (const slab of manifest.laneSlabs[isoformMode]) {
          result.push({
            isoformMode,
            level: level.level,
            tileX,
            laneSlabIndex: slab.slabIndex,
          });
        }
      }
    }
  }
  return result;
}

function rgbaFor(manifest: CompiledBroadSurfaceManifestV2, ordinal: number): Uint8Array {
  const widthPx = manifest.broadTilePhysicalWidthPx + manifest.broadTileXGuardPhysicalPx * 2;
  const heightPx = manifest.laneSlabRowCount * manifest.laneRowTextureStridePx;
  const result = new Uint8Array(widthPx * heightPx * 4);
  result.set([ordinal + 1, ordinal + 2, ordinal + 3, 255], 0);
  return result;
}

async function* sourceCells(
  manifest: CompiledBroadSurfaceManifestV2
): AsyncGenerator<CompiledBroadRasterSourceCellV1> {
  for (const [ordinal, address] of roster(manifest).entries()) {
    yield {
      ...address,
      occupancy: COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1,
      premultipliedRgba: rgbaFor(manifest, ordinal),
    };
  }
}

function publisherFs(
  override: Partial<CompiledBroadRasterPublisherFsV1> = {}
): CompiledBroadRasterPublisherFsV1 {
  return {
    mkdir: async (path) => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path, { recursive: true });
    },
    readFile,
    writeExclusive: async (path, bytes) => {
      await writeFile(path, bytes, { flag: 'wx' });
    },
    link,
    unlink,
    ...override,
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, canonicalize(record[key])])
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function rewriteManifest(
  mutate: (manifest: Record<string, unknown>) => void,
  recomputeFingerprint = false
): Promise<void> {
  const path = join(root, COMPILED_BROAD_RASTER_MANIFEST_FILE_V1);
  const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  mutate(manifest);
  if (recomputeFingerprint) {
    const { catalogFingerprint: _catalogFingerprint, ...fields } = manifest;
    manifest.catalogFingerprint = sha256(canonicalJson(fields));
  }
  await writeFile(path, `${JSON.stringify(manifest)}\n`, 'utf8');
}

describe('compiled broad raster artifact store', () => {
  it('streams a complete immutable bank and reads only the bounded requested Brotli cells', async () => {
    const surface = await surfaceManifest();
    const published = await publishCompiledBroadRasterArtifactV1({
      artifactDirectory: root,
      surfaceManifest: surface,
      cells: sourceCells(surface),
    });

    expect(published).toMatchObject({
      contract: COMPILED_BROAD_RASTER_ARTIFACT_V1,
      pixelFormat: COMPILED_BROAD_RASTER_PIXEL_FORMAT_V1,
      storedWidthPx: 514,
      storedHeightPx: 128,
      bytesPerPixel: 4,
    });
    expect(published.cells).toHaveLength(3);
    expect(published.cells.every((cell) => cell.fileName?.endsWith('.rgba.br'))).toBe(true);
    expect(published.cells.every((cell) => cell.decodedByteLength === 514 * 128 * 4)).toBe(true);
    expect(published.cells.every((cell) => cell.decodedSha256 !== cell.encodedSha256)).toBe(true);

    const reads: string[] = [];
    const reader = await openCompiledBroadRasterArtifactV1(
      {
        artifactDirectory: root,
        expectedSurfaceManifestFingerprint: surface.manifestFingerprint,
      },
      {
        readFile: async (path) => {
          reads.push(path);
          return readFile(path);
        },
      }
    );
    reads.length = 0;
    const addresses = [roster(surface)[2], roster(surface)[0]];
    const payloads = await reader.readCells(addresses);

    expect(reads).toHaveLength(2);
    expect(reads.every((path) => path.endsWith('.rgba.br'))).toBe(true);
    expect(payloads.map(({ record }) => record.cellId)).toEqual([
      published.cells[2].cellId,
      published.cells[0].cellId,
    ]);
    expect(payloads[0].premultipliedRgba).toEqual(rgbaFor(surface, 2));
    expect(payloads[1].premultipliedRgba).toEqual(rgbaFor(surface, 0));
  });

  it('keeps an exact shared-backing Uint8Array alive without a second pixel allocation', async () => {
    const allocation = Buffer.allocUnsafeSlow(32);
    allocation.fill(0);
    const decoded = allocation.subarray(7, 23);
    const pixels = exactUint8ArrayView(decoded);

    expect(pixels).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(pixels)).toBe(false);
    expect(pixels.buffer).toBe(decoded.buffer);
    expect(pixels.byteOffset).toBe(decoded.byteOffset);
    expect(pixels.byteLength).toBe(decoded.byteLength);
    decoded[0] = 41;
    pixels[1] = 73;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pixels[0]).toBe(41);
    expect(decoded[1]).toBe(73);
  });

  it('records transparent occupancy without hashing, compressing, storing, reading, or returning pixels', async () => {
    const surface = await surfaceManifest();
    const addresses = roster(surface);
    const sources: CompiledBroadRasterSourceCellV1[] = addresses.map((address, ordinal) =>
      ordinal === 1
        ? {
            ...address,
            occupancy: COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_V1,
          }
        : {
            ...address,
            occupancy: COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1,
            premultipliedRgba: rgbaFor(surface, ordinal),
          }
    );
    const published = await publishCompiledBroadRasterArtifactV1({
      artifactDirectory: root,
      surfaceManifest: surface,
      cells: sources,
    });

    expect(published.cells[1]).toMatchObject({
      occupancy: COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_V1,
      decodedByteLength: 0,
      decodedSha256: null,
      encodedByteLength: 0,
      encodedSha256: null,
      fileName: null,
    });
    expect(
      (await readdir(join(root, 'cells'))).filter((name) => name.endsWith('.rgba.br'))
    ).toHaveLength(2);

    const payloadReads: string[] = [];
    const reader = await openCompiledBroadRasterArtifactV1(
      {
        artifactDirectory: root,
        expectedSurfaceManifestFingerprint: surface.manifestFingerprint,
      },
      {
        readFile: async (path) => {
          if (path.endsWith('.rgba.br')) payloadReads.push(path);
          return readFile(path);
        },
      }
    );
    payloadReads.length = 0;
    const [payload] = await reader.readCells([addresses[1]]);
    expect(payload.record.occupancy).toBe(COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_V1);
    expect(payload.premultipliedRgba).toBeNull();
    expect(payloadReads).toEqual([]);
  });

  it('commits the manifest with the final create-if-absent link after every payload is addressable', async () => {
    const surface = await surfaceManifest();
    const renameDestinations: string[] = [];
    const fs = publisherFs({
      link: async (fromPath, toPath) => {
        if (toPath.endsWith(COMPILED_BROAD_RASTER_MANIFEST_FILE_V1)) {
          for (const record of renameDestinations.filter((path) => path.endsWith('.rgba.br'))) {
            await expect(stat(record)).resolves.toBeTruthy();
          }
        }
        await link(fromPath, toPath);
        renameDestinations.push(toPath);
      },
    });

    await publishCompiledBroadRasterArtifactV1(
      { artifactDirectory: root, surfaceManifest: surface, cells: sourceCells(surface) },
      fs
    );

    expect(renameDestinations.at(-1)).toBe(join(root, COMPILED_BROAD_RASTER_MANIFEST_FILE_V1));
    expect(renameDestinations.slice(0, -1).every((path) => path.endsWith('.rgba.br'))).toBe(true);
  });

  it('leaves no reachable or temporary manifest when its atomic commit fails', async () => {
    const surface = await surfaceManifest();
    const fs = publisherFs({
      link: async (fromPath, toPath) => {
        if (toPath.endsWith(COMPILED_BROAD_RASTER_MANIFEST_FILE_V1)) {
          const error = Object.assign(new Error('injected commit failure'), { code: 'EIO' });
          throw error;
        }
        await link(fromPath, toPath);
      },
    });

    await expect(
      publishCompiledBroadRasterArtifactV1(
        { artifactDirectory: root, surfaceManifest: surface, cells: sourceCells(surface) },
        fs
      )
    ).rejects.toMatchObject({ code: 'io-failure' });
    await expect(
      readFile(join(root, COMPILED_BROAD_RASTER_MANIFEST_FILE_V1))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(root)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('never replaces an incumbent immutable catalog when a different publisher races later', async () => {
    const surface = await surfaceManifest();
    const incumbent = await publishCompiledBroadRasterArtifactV1({
      artifactDirectory: root,
      surfaceManifest: surface,
      cells: sourceCells(surface),
    });
    const different = [...(await collect(sourceCells(surface)))];
    decodedPixels(different[0]).set([17, 18, 19, 255], 0);

    await expect(
      publishCompiledBroadRasterArtifactV1({
        artifactDirectory: root,
        surfaceManifest: surface,
        cells: different,
      })
    ).rejects.toMatchObject({ code: 'publication-conflict' });

    const opened = await openCompiledBroadRasterArtifactV1({
      artifactDirectory: root,
      expectedSurfaceManifestFingerprint: surface.manifestFingerprint,
    });
    expect(opened.manifest.catalogFingerprint).toBe(incumbent.catalogFingerprint);
  });

  it('rejects incomplete, overcomplete, and noncanonical publication streams', async () => {
    const surface = await surfaceManifest();
    const cells = [...(await collect(sourceCells(surface)))];

    await expect(
      publishCompiledBroadRasterArtifactV1({
        artifactDirectory: join(root, 'short'),
        surfaceManifest: surface,
        cells: cells.slice(0, -1),
      })
    ).rejects.toThrow('ended after 2 of 3');
    await expect(
      publishCompiledBroadRasterArtifactV1({
        artifactDirectory: join(root, 'long'),
        surfaceManifest: surface,
        cells: [...cells, cells[0]],
      })
    ).rejects.toThrow('more than 3');
    await expect(
      publishCompiledBroadRasterArtifactV1({
        artifactDirectory: join(root, 'reordered'),
        surfaceManifest: surface,
        cells: [cells[1], cells[0], cells[2]],
      })
    ).rejects.toThrow('not canonical address');
  });

  it('rejects non-premultiplied pixels and nontransparent fixed-slab padding', async () => {
    const surface = await surfaceManifest();
    const cells = [...(await collect(sourceCells(surface)))];
    decodedPixels(cells[0]).set([255, 0, 0, 1], 0);
    await expect(
      publishCompiledBroadRasterArtifactV1({
        artifactDirectory: join(root, 'non-premultiplied'),
        surfaceManifest: surface,
        cells,
      })
    ).rejects.toThrow('not premultiplied RGBA');

    const paddedSurface = await buildCompiledBroadSurfaceManifestV2({
      ...manifestBuildInput(),
      laneRowCounts: { canonical: 1, expanded: 1 },
    });
    const paddedCells = [...(await collect(sourceCells(paddedSurface)))];
    const widthPx = 514;
    const firstPaddedPixel = widthPx * paddedSurface.laneRowTextureStridePx * 4;
    decodedPixels(paddedCells[0]).set([0, 0, 0, 1], firstPaddedPixel);
    await expect(
      publishCompiledBroadRasterArtifactV1({
        artifactDirectory: join(root, 'nontransparent-padding'),
        surfaceManifest: paddedSurface,
        cells: paddedCells,
      })
    ).rejects.toThrow('nontransparent gutter or padded rows');
  });

  it('publishes and reopens role-weight cells with their role table', async () => {
    const surface = await surfaceManifest();
    const cells = [...(await collect(sourceCells(surface)))];
    decodedPixels(cells[0]).set([200, 40, 0, 10], 0);
    const roleTable = ['transcript:intron', 'transcript:cdsThick'] as const;
    const published = await publishCompiledBroadRasterArtifactV1({
      artifactDirectory: join(root, 'role-weights'),
      surfaceManifest: surface,
      cells,
      roleTable: [...roleTable],
    });
    expect(published).toMatchObject({
      pixelFormat: COMPILED_BROAD_RASTER_PIXEL_FORMAT_ROLE_WEIGHTS_V1,
      roleTable: [...roleTable],
    });
    const reader = await openCompiledBroadRasterArtifactV1({
      artifactDirectory: join(root, 'role-weights'),
      expectedSurfaceManifestFingerprint: surface.manifestFingerprint,
    });
    expect(reader.manifest.roleTable).toEqual([...roleTable]);
    expect(reader.manifest.catalogFingerprint).toBe(published.catalogFingerprint);
    const [first] = await reader.readCells([published.cells[0]]);
    expect(Array.from(first.premultipliedRgba?.subarray(0, 4) ?? [])).toEqual([200, 40, 0, 10]);

    await expect(
      publishCompiledBroadRasterArtifactV1({
        artifactDirectory: join(root, 'bad-roles'),
        surfaceManifest: surface,
        cells: [...(await collect(sourceCells(surface)))],
        roleTable: ['transcript:intron', 'transcript:intron'],
      })
    ).rejects.toThrow('role table is invalid');

    const paddedSurface = await buildCompiledBroadSurfaceManifestV2({
      ...manifestBuildInput(),
      laneRowCounts: { canonical: 1, expanded: 1 },
    });
    const paddedCells = [...(await collect(sourceCells(paddedSurface)))];
    decodedPixels(paddedCells[0]).set([0, 7, 0, 0], 514 * paddedSurface.laneRowTextureStridePx * 4);
    await expect(
      publishCompiledBroadRasterArtifactV1({
        artifactDirectory: join(root, 'role-padding'),
        surfaceManifest: paddedSurface,
        cells: paddedCells,
        roleTable: ['transcript:intron'],
      })
    ).rejects.toThrow('nontransparent gutter or padded rows');
  });

  it('fails closed on a corrupted surface identity, dimensions, or catalog fingerprint', async () => {
    const surface = await surfaceManifest();
    await publishCompiledBroadRasterArtifactV1({
      artifactDirectory: root,
      surfaceManifest: surface,
      cells: sourceCells(surface),
    });

    await rewriteManifest((manifest) => {
      manifest.storedWidthPx = 515;
    });
    await expect(
      openCompiledBroadRasterArtifactV1({
        artifactDirectory: root,
        expectedSurfaceManifestFingerprint: surface.manifestFingerprint,
      })
    ).rejects.toThrow('dimensions');

    await publishToFreshRoot(surface);
    await rewriteManifest((manifest) => {
      manifest.catalogFingerprint = '0'.repeat(64);
    });
    await expect(
      openCompiledBroadRasterArtifactV1({
        artifactDirectory: root,
        expectedSurfaceManifestFingerprint: surface.manifestFingerprint,
      })
    ).rejects.toThrow('catalog SHA-256');

    await publishToFreshRoot(surface);
    await expect(
      openCompiledBroadRasterArtifactV1({
        artifactDirectory: root,
        expectedSurfaceManifestFingerprint: '0'.repeat(64),
      })
    ).rejects.toThrow('does not match');
  });

  it('detects encoded and decoded payload corruption before returning pixels', async () => {
    const surface = await surfaceManifest();
    const published = await publishCompiledBroadRasterArtifactV1({
      artifactDirectory: root,
      surfaceManifest: surface,
      cells: sourceCells(surface),
    });
    const first = published.cells[0];
    if (first.fileName === null)
      throw new Error('corruption fixture did not publish an occupied cell');
    const encodedPath = join(root, first.fileName);
    const corrupt = await readFile(encodedPath);
    corrupt[0] ^= 0xff;
    await writeFile(encodedPath, corrupt);
    const encodedReader = await openCompiledBroadRasterArtifactV1({
      artifactDirectory: root,
      expectedSurfaceManifestFingerprint: surface.manifestFingerprint,
    });
    await expect(encodedReader.readCells([roster(surface)[0]])).rejects.toMatchObject({
      code: 'integrity-mismatch',
    });

    await publishToFreshRoot(surface);
    await rewriteManifest((manifest) => {
      const records = manifest.cells as Array<Record<string, unknown>>;
      records[0].decodedSha256 = '0'.repeat(64);
    }, true);
    const decodedReader = await openCompiledBroadRasterArtifactV1({
      artifactDirectory: root,
      expectedSurfaceManifestFingerprint: surface.manifestFingerprint,
    });
    await expect(decodedReader.readCells([roster(surface)[0]])).rejects.toThrow(
      'decoded payload integrity mismatch'
    );
  });

  it('rejects duplicate, out-of-bank, and unbounded reads before reading payload files', async () => {
    const surface = await surfaceManifest();
    await publishCompiledBroadRasterArtifactV1({
      artifactDirectory: root,
      surfaceManifest: surface,
      cells: sourceCells(surface),
    });
    const payloadReads: string[] = [];
    const reader = await openCompiledBroadRasterArtifactV1(
      {
        artifactDirectory: root,
        expectedSurfaceManifestFingerprint: surface.manifestFingerprint,
      },
      {
        readFile: async (path) => {
          if (path.endsWith('.rgba.br')) payloadReads.push(path);
          return readFile(path);
        },
      }
    );
    const first = roster(surface)[0];

    await expect(reader.readCells([first, first])).rejects.toThrow('duplicate');
    await expect(reader.readCells([{ ...first, tileX: 1 }])).rejects.toThrow(
      'outside the surface manifest'
    );
    await expect(
      reader.readCells(
        Array.from({ length: MAX_COMPILED_BROAD_RASTER_CELLS_PER_READ_V1 + 1 }, () => first)
      )
    ).rejects.toThrow(`1-${MAX_COMPILED_BROAD_RASTER_CELLS_PER_READ_V1}`);
    expect(payloadReads).toEqual([]);
  });

  async function publishToFreshRoot(surface: CompiledBroadSurfaceManifestV2): Promise<void> {
    await rm(root, { recursive: true, force: true });
    await publishCompiledBroadRasterArtifactV1({
      artifactDirectory: root,
      surfaceManifest: surface,
      cells: sourceCells(surface),
    });
  }
});

function manifestBuildInput() {
  return {
    artifactKey: 'grch38:mRNA:light:v1',
    trackId: 'mRNA',
    genomeLengthBp: 1_000,
    broadCorridorFinestSpanBp: 1_000,
    broadTilePhysicalWidthPx: 512,
    broadTileXGuardPhysicalPx: 1,
    prefetchRing: 1,
    maxQualifiedRasterMagnificationX: 1.75,
    rasterDevicePixelRatio: 1,
    laneSlabRowCount: 8,
    laneRowCssHeightPx: 16,
    laneRowTextureStridePx: 16,
    laneRowTransparentTailGutterPx: 2,
  } as const;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of source) result.push(value);
  return result;
}

function decodedPixels(cell: CompiledBroadRasterSourceCellV1): Uint8Array {
  if (!('premultipliedRgba' in cell)) throw new Error('test fixture expected a decoded cell');
  return cell.premultipliedRgba;
}
