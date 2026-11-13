import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  brotliCompress as nodeBrotliCompress,
  brotliCompressSync,
  brotliDecompress as nodeBrotliDecompress,
  constants as zlibConstants,
} from 'node:zlib';

import type {
  AnnotationColorRoleKeyV1,
  CompiledBroadSurfaceManifestV2,
} from '@waypoint/genome-renderer/pure';

import {
  COMPILED_BROAD_RASTER_ARTIFACT_V1,
  COMPILED_BROAD_RASTER_BYTES_PER_RGBA_PIXEL_V1 as BYTES_PER_RGBA_PIXEL,
  COMPILED_BROAD_RASTER_CELL_DIRECTORY_V1 as CELL_DIRECTORY,
  COMPILED_BROAD_RASTER_CELL_FILE_SUFFIX_V1 as CELL_FILE_SUFFIX,
  COMPILED_BROAD_RASTER_COMPRESSION_V1,
  COMPILED_BROAD_RASTER_MANIFEST_FILE_V1,
  COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1,
  COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_V1,
  COMPILED_BROAD_RASTER_PIXEL_FORMAT_ROLE_WEIGHTS_V1,
  COMPILED_BROAD_RASTER_PIXEL_FORMAT_V1,
  CompiledBroadRasterArtifactError,
  admitCompiledBroadRasterArtifactManifestV1,
  compiledBroadRasterAdmitSurfaceManifestV1 as admitSurfaceManifest,
  compiledBroadRasterCanonicalJsonV1 as canonicalJson,
  compiledBroadRasterCellIdForV1 as cellIdFor,
  compiledBroadRasterCompleteAddressRosterV1 as completeAddressRoster,
  compiledBroadRasterExactCellDimensionsV1 as exactCellDimensions,
  compiledBroadRasterFreezeManifestV1 as freezeManifest,
  compiledBroadRasterIsBoundedReadFailureV1 as isBoundedReadFailure,
  compiledBroadRasterIsMissingFileV1 as isMissingFile,
  compiledBroadRasterNonemptyPathV1 as nonemptyPath,
  compiledBroadRasterRoleTableIsValidV1 as roleTableIsValid,
  compiledBroadRasterValidateAddressV1 as validateAddress,
  openCompiledBroadRasterArtifactV1 as openSharedCompiledBroadRasterArtifactV1,
  type CompiledBroadRasterArtifactManifestV1,
  type CompiledBroadRasterArtifactReaderV1,
  type CompiledBroadRasterCellAddressV1,
  type CompiledBroadRasterCellRecordV1,
  type CompiledBroadRasterPixelFormatV1,
} from '../../shared/compiled-broad-raster-artifact-reader';

export {
  COMPILED_BROAD_RASTER_ARTIFACT_V1,
  COMPILED_BROAD_RASTER_COMPRESSION_V1,
  COMPILED_BROAD_RASTER_MANIFEST_FILE_V1,
  COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1,
  COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_V1,
  COMPILED_BROAD_RASTER_PIXEL_FORMAT_ROLE_WEIGHTS_V1,
  COMPILED_BROAD_RASTER_PIXEL_FORMAT_V1,
  CompiledBroadRasterArtifactError,
  MAX_COMPILED_BROAD_RASTER_CELLS_PER_READ_V1,
  MAX_COMPILED_BROAD_RASTER_DECODED_BYTES_PER_READ_V1,
  exactUint8ArrayView,
} from '../../shared/compiled-broad-raster-artifact-reader';
export type {
  CompiledBroadRasterArtifactErrorCodeV1,
  CompiledBroadRasterArtifactManifestV1,
  CompiledBroadRasterArtifactReaderV1,
  CompiledBroadRasterCellAddressV1,
  CompiledBroadRasterCellPayloadV1,
  CompiledBroadRasterCellRecordV1,
  CompiledBroadRasterPixelFormatV1,
} from '../../shared/compiled-broad-raster-artifact-reader';

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export type CompiledBroadRasterSourceCellV1 = CompiledBroadRasterCellAddressV1 &
  (
    | {
        readonly occupancy: typeof COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_V1;
      }
    | {
        readonly occupancy: typeof COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1;
        readonly premultipliedRgba: Uint8Array;
      }
    | {
        readonly occupancy: typeof COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1;
        readonly encoded: CompiledBroadRasterEncodedCellV1;
      }
  );

export interface CompiledBroadRasterEncodedCellV1 {
  readonly decodedByteLength: number;
  readonly decodedSha256: string;
  readonly encodedBytes: Uint8Array;
  readonly encodedSha256: string;
}

const BROTLI_OPTIONS = Object.freeze({
  params: {
    [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_GENERIC,
    [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
  },
});

export async function createCompiledBroadRasterCellEncoderV1(
  surfaceManifest: CompiledBroadSurfaceManifestV2,
  options: { readonly pixelFormat?: CompiledBroadRasterPixelFormatV1 } = {}
): Promise<
  (
    address: CompiledBroadRasterCellAddressV1,
    premultipliedRgba: Uint8Array
  ) => CompiledBroadRasterEncodedCellV1
> {
  const manifest = await admitSurfaceManifest(surfaceManifest, 'invalid-request');
  const pixelFormat = options.pixelFormat ?? COMPILED_BROAD_RASTER_PIXEL_FORMAT_V1;
  return (address, premultipliedRgba) =>
    encodeAdmittedCell(
      manifest,
      validateAddress(manifest, address, 'invalid-request'),
      premultipliedRgba,
      pixelFormat
    );
}

async function encodedSourceCell(
  source: CompiledBroadRasterSourceCellV1,
  surfaceManifest: CompiledBroadSurfaceManifestV2,
  address: CompiledBroadRasterCellAddressV1,
  cellId: string,
  pixelFormat: CompiledBroadRasterPixelFormatV1
): Promise<CompiledBroadRasterEncodedCellV1> {
  if (source.occupancy === COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1 && 'encoded' in source) {
    const encoded = source.encoded;
    if (
      encoded?.decodedByteLength !== exactCellDimensions(surfaceManifest).decodedByteLength ||
      !HASH_PATTERN.test(encoded.decodedSha256) ||
      !(encoded.encodedBytes instanceof Uint8Array) ||
      sha256Hex(encoded.encodedBytes) !== encoded.encodedSha256
    ) {
      throw new CompiledBroadRasterArtifactError(
        'invalid-request',
        `broad raster pre-encoded cell ${cellId} is invalid`
      );
    }
    return encoded;
  }
  if (
    source.occupancy !== COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1 ||
    !(source.premultipliedRgba instanceof Uint8Array)
  ) {
    throw new CompiledBroadRasterArtifactError(
      'invalid-request',
      `broad raster source cell ${cellId} is not a Uint8Array`
    );
  }
  if (
    source.premultipliedRgba.byteLength !== exactCellDimensions(surfaceManifest).decodedByteLength
  ) {
    throw new CompiledBroadRasterArtifactError(
      'invalid-request',
      `broad raster source cell ${cellId} has incorrect RGBA dimensions`
    );
  }
  assertPremultipliedAndPadded(
    surfaceManifest,
    address,
    source.premultipliedRgba,
    cellId,
    pixelFormat
  );
  const decodedBytes = exactBytes(source.premultipliedRgba);
  const encodedBytes = await brotliCompress(decodedBytes);
  return {
    decodedByteLength: decodedBytes.byteLength,
    decodedSha256: sha256Hex(decodedBytes),
    encodedBytes,
    encodedSha256: sha256Hex(encodedBytes),
  };
}

function encodeAdmittedCell(
  surfaceManifest: CompiledBroadSurfaceManifestV2,
  address: CompiledBroadRasterCellAddressV1,
  premultipliedRgba: Uint8Array,
  pixelFormat: CompiledBroadRasterPixelFormatV1
): CompiledBroadRasterEncodedCellV1 {
  const cellId = cellIdFor(surfaceManifest, address);
  if (premultipliedRgba.byteLength !== exactCellDimensions(surfaceManifest).decodedByteLength) {
    throw new CompiledBroadRasterArtifactError(
      'invalid-request',
      `broad raster source cell ${cellId} has incorrect RGBA dimensions`
    );
  }
  assertPremultipliedAndPadded(surfaceManifest, address, premultipliedRgba, cellId, pixelFormat);
  const decodedBytes = exactBytes(premultipliedRgba);
  const encodedBytes = brotliCompressSync(decodedBytes, BROTLI_OPTIONS);
  return {
    decodedByteLength: decodedBytes.byteLength,
    decodedSha256: sha256Hex(decodedBytes),
    encodedBytes,
    encodedSha256: sha256Hex(encodedBytes),
  };
}

export interface CompiledBroadRasterPublisherFsV1 {
  readonly mkdir: (path: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly writeExclusive: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly link: (existingPath: string, newPath: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
}

export interface CompiledBroadRasterReaderFsV1 {
  readonly readFile: (path: string, maxBytes: number) => Promise<Buffer>;
}

const DEFAULT_PUBLISHER_FS: CompiledBroadRasterPublisherFsV1 = Object.freeze({
  mkdir: async (path: string) => {
    await mkdir(path, { recursive: true });
  },
  readFile,
  writeExclusive: async (path: string, bytes: Uint8Array) => {
    await writeFile(path, bytes, { flag: 'wx' });
  },
  link,
  unlink,
});

const DEFAULT_READER_FS: CompiledBroadRasterReaderFsV1 = Object.freeze({
  readFile: readFileBounded,
});

export async function publishCompiledBroadRasterArtifactV1(
  input: {
    readonly artifactDirectory: string;
    readonly surfaceManifest: CompiledBroadSurfaceManifestV2;
    readonly cells:
      | AsyncIterable<CompiledBroadRasterSourceCellV1>
      | Iterable<CompiledBroadRasterSourceCellV1>;
    readonly roleTable?: readonly AnnotationColorRoleKeyV1[];
  },
  fs: CompiledBroadRasterPublisherFsV1 = DEFAULT_PUBLISHER_FS
): Promise<CompiledBroadRasterArtifactManifestV1> {
  const artifactDirectory = nonemptyPath(input.artifactDirectory);
  if (input.roleTable !== undefined && !roleTableIsValid(input.roleTable)) {
    throw new CompiledBroadRasterArtifactError(
      'invalid-request',
      'broad raster role table is invalid'
    );
  }
  const pixelFormat = input.roleTable
    ? COMPILED_BROAD_RASTER_PIXEL_FORMAT_ROLE_WEIGHTS_V1
    : COMPILED_BROAD_RASTER_PIXEL_FORMAT_V1;
  const surfaceManifest = await admitSurfaceManifest(input.surfaceManifest, 'invalid-request');
  const dimensions = exactCellDimensions(surfaceManifest);
  const expectedAddresses = completeAddressRoster(surfaceManifest);
  if (!isCellIterable(input.cells)) {
    throw new CompiledBroadRasterArtifactError(
      'invalid-request',
      'broad raster publication cells are not iterable'
    );
  }

  const cellDirectory = join(artifactDirectory, CELL_DIRECTORY);
  await fs.mkdir(cellDirectory);
  const temporaryPaths = new Set<string>();
  const records: CompiledBroadRasterCellRecordV1[] = [];
  try {
    let sourceIndex = 0;
    for await (const source of input.cells) {
      const address = expectedAddresses[sourceIndex];
      if (!address) {
        throw new CompiledBroadRasterArtifactError(
          'invalid-request',
          `broad raster publication contains more than ${expectedAddresses.length} cells`
        );
      }
      const cellId = cellIdFor(surfaceManifest, address);
      const sourceAddress = validateAddress(surfaceManifest, source, 'invalid-request');
      if (cellIdFor(surfaceManifest, sourceAddress) !== cellId) {
        throw new CompiledBroadRasterArtifactError(
          'invalid-request',
          `broad raster publication cell ${sourceIndex} is not canonical address ${cellId}`
        );
      }
      const slab = surfaceManifest.laneSlabs[address.isoformMode][address.laneSlabIndex];
      if (source.occupancy === COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_V1) {
        records.push(
          Object.freeze({
            cellId,
            trackId: surfaceManifest.trackId,
            ...address,
            laneSlabId: slab.slabId,
            occupancy: COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_V1,
            widthPx: dimensions.widthPx,
            heightPx: dimensions.heightPx,
            decodedByteLength: 0,
            decodedSha256: null,
            encodedByteLength: 0,
            encodedSha256: null,
            fileName: null,
          })
        );
        sourceIndex += 1;
        continue;
      }
      const { decodedByteLength, decodedSha256, encodedBytes, encodedSha256 } =
        await encodedSourceCell(source, surfaceManifest, address, cellId, pixelFormat);
      const fileName = `${CELL_DIRECTORY}/${encodedSha256}${CELL_FILE_SUFFIX}`;
      const finalPath = join(
        artifactDirectory,
        CELL_DIRECTORY,
        `${encodedSha256}${CELL_FILE_SUFFIX}`
      );
      await ensureContentAddressedFile({
        finalPath,
        bytes: exactBytes(encodedBytes),
        expectedSha256: encodedSha256,
        fs,
        temporaryPaths,
      });
      records.push(
        Object.freeze({
          cellId,
          trackId: surfaceManifest.trackId,
          ...address,
          laneSlabId: slab.slabId,
          occupancy: COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1,
          widthPx: dimensions.widthPx,
          heightPx: dimensions.heightPx,
          decodedByteLength,
          decodedSha256,
          encodedByteLength: encodedBytes.byteLength,
          encodedSha256,
          fileName,
        })
      );
      sourceIndex += 1;
    }
    if (sourceIndex !== expectedAddresses.length) {
      throw new CompiledBroadRasterArtifactError(
        'invalid-request',
        `broad raster publication ended after ${sourceIndex} of ${expectedAddresses.length} cells`
      );
    }

    const fields = Object.freeze({
      contract: COMPILED_BROAD_RASTER_ARTIFACT_V1,
      surfaceManifest,
      pixelFormat,
      ...(input.roleTable ? { roleTable: Object.freeze([...input.roleTable]) } : {}),
      compression: COMPILED_BROAD_RASTER_COMPRESSION_V1,
      storedWidthPx: dimensions.widthPx,
      storedHeightPx: dimensions.heightPx,
      bytesPerPixel: BYTES_PER_RGBA_PIXEL,
      cells: Object.freeze(records),
    });
    const catalogFingerprint = sha256Hex(Buffer.from(canonicalJson(fields), 'utf8'));
    const manifest = freezeManifest({ ...fields, catalogFingerprint });
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
    const manifestPath = join(artifactDirectory, COMPILED_BROAD_RASTER_MANIFEST_FILE_V1);
    const manifestTempPath = temporaryPath(manifestPath);
    temporaryPaths.add(manifestTempPath);
    await fs.writeExclusive(manifestTempPath, manifestBytes);

    try {
      await fs.link(manifestTempPath, manifestPath);
      await fs.unlink(manifestTempPath);
      temporaryPaths.delete(manifestTempPath);
      return manifest;
    } catch (error) {
      const incumbent = await readAndValidateManifestIfPresent(
        manifestPath,
        surfaceManifest.manifestFingerprint,
        fs
      );
      if (incumbent?.catalogFingerprint === manifest.catalogFingerprint) {
        return incumbent;
      }
      if (incumbent) {
        throw new CompiledBroadRasterArtifactError(
          'publication-conflict',
          'a different immutable broad raster catalog already owns this directory',
          error
        );
      }
      throw new CompiledBroadRasterArtifactError(
        'io-failure',
        'failed to atomically commit the broad raster manifest',
        error
      );
    }
  } finally {
    await Promise.all([...temporaryPaths].map((path) => ignoreMissingUnlink(path, fs)));
  }
}

export async function openCompiledBroadRasterArtifactV1(
  input: {
    readonly artifactDirectory: string;
    readonly expectedSurfaceManifestFingerprint: string;
  },
  fs: CompiledBroadRasterReaderFsV1 = DEFAULT_READER_FS
): Promise<CompiledBroadRasterArtifactReaderV1> {
  return openSharedCompiledBroadRasterArtifactV1(input, {
    readFile: (path, maxBytes) => fs.readFile(path, maxBytes),
    sha256Hex,
    brotliDecompress: (bytes, maxOutputLength) =>
      brotliDecompress(exactBytes(bytes), maxOutputLength),
    isMissingFile,
    isBoundedReadFailure,
    joinPath: join,
  });
}

function assertPremultipliedAndPadded(
  manifest: CompiledBroadSurfaceManifestV2,
  address: CompiledBroadRasterCellAddressV1,
  bytes: Uint8Array,
  cellId: string,
  pixelFormat: CompiledBroadRasterPixelFormatV1
): void {
  const roleWeights = pixelFormat === COMPILED_BROAD_RASTER_PIXEL_FORMAT_ROLE_WEIGHTS_V1;
  const { widthPx } = exactCellDimensions(manifest);
  const stridePx = manifest.laneRowTextureStridePx;
  const contentHeightPx = stridePx - manifest.laneRowTransparentTailGutterPx;
  const slab = manifest.laneSlabs[address.isoformMode][address.laneSlabIndex];
  const sourceHeightPx = slab.sourceLaneRowCount * stridePx;
  const words =
    bytes.byteOffset % Uint32Array.BYTES_PER_ELEMENT === 0
      ? new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2)
      : new Uint32Array(bytes.slice().buffer);
  const rowCount = words.length / widthPx;
  for (let row = 0; row < rowCount; row++) {
    const mustBeTransparent = row >= sourceHeightPx || row % stridePx >= contentHeightPx;
    const rowEnd = (row + 1) * widthPx;
    for (let pixel = row * widthPx; pixel < rowEnd; pixel++) {
      if (words[pixel] === 0) continue;
      const offset = pixel * BYTES_PER_RGBA_PIXEL;
      if (roleWeights) {
        if (mustBeTransparent) {
          throw new CompiledBroadRasterArtifactError(
            'invalid-request',
            `broad raster source cell ${cellId} has nontransparent gutter or padded rows`
          );
        }
        continue;
      }
      const alpha = bytes[offset + 3];
      if (bytes[offset] > alpha || bytes[offset + 1] > alpha || bytes[offset + 2] > alpha) {
        throw new CompiledBroadRasterArtifactError(
          'invalid-request',
          `broad raster source cell ${cellId} is not premultiplied RGBA`
        );
      }
      if (mustBeTransparent && alpha !== 0) {
        throw new CompiledBroadRasterArtifactError(
          'invalid-request',
          `broad raster source cell ${cellId} has nontransparent gutter or padded rows`
        );
      }
    }
  }
}

async function ensureContentAddressedFile(input: {
  finalPath: string;
  bytes: Buffer;
  expectedSha256: string;
  fs: CompiledBroadRasterPublisherFsV1;
  temporaryPaths: Set<string>;
}): Promise<void> {
  try {
    const incumbent = await input.fs.readFile(input.finalPath);
    if (
      incumbent.byteLength !== input.bytes.byteLength ||
      sha256Hex(incumbent) !== input.expectedSha256
    ) {
      throw new CompiledBroadRasterArtifactError(
        'integrity-mismatch',
        'a content-addressed broad raster payload is corrupt'
      );
    }
    return;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const tempPath = temporaryPath(input.finalPath);
  input.temporaryPaths.add(tempPath);
  await input.fs.writeExclusive(tempPath, input.bytes);
  try {
    await input.fs.link(tempPath, input.finalPath);
    await input.fs.unlink(tempPath);
    input.temporaryPaths.delete(tempPath);
  } catch (error) {
    try {
      const incumbent = await input.fs.readFile(input.finalPath);
      if (
        incumbent.byteLength === input.bytes.byteLength &&
        sha256Hex(incumbent) === input.expectedSha256
      ) {
        return;
      }
    } catch {}
    throw new CompiledBroadRasterArtifactError(
      'io-failure',
      'failed to publish a content-addressed broad raster payload',
      error
    );
  }
}

async function readAndValidateManifestIfPresent(
  path: string,
  expectedSurfaceManifestFingerprint: string,
  fs: Pick<CompiledBroadRasterPublisherFsV1, 'readFile'>
): Promise<CompiledBroadRasterArtifactManifestV1 | null> {
  try {
    return await admitCompiledBroadRasterArtifactManifestV1(
      await fs.readFile(path),
      expectedSurfaceManifestFingerprint,
      sha256Hex
    );
  } catch (error) {
    if (isMissingFile(error)) return null;
    if (error instanceof CompiledBroadRasterArtifactError && error.code === 'artifact-not-found') {
      return null;
    }
    throw error;
  }
}

function isCellIterable(
  value: unknown
): value is
  | AsyncIterable<CompiledBroadRasterSourceCellV1>
  | Iterable<CompiledBroadRasterSourceCellV1> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    [Symbol.asyncIterator]?: unknown;
    [Symbol.iterator]?: unknown;
  };
  return (
    typeof candidate[Symbol.asyncIterator] === 'function' ||
    typeof candidate[Symbol.iterator] === 'function'
  );
}

function exactBytes(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function temporaryPath(finalPath: string): string {
  return `${finalPath}.${process.pid}.${randomUUID()}.tmp`;
}

async function ignoreMissingUnlink(
  path: string,
  fs: Pick<CompiledBroadRasterPublisherFsV1, 'unlink'>
): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

async function readFileBounded(path: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new CompiledBroadRasterArtifactError(
      'invalid-request',
      'bounded broad raster read size is invalid'
    );
  }
  const handle = await open(path, 'r');
  try {
    const file = await handle.stat();
    if (!Number.isSafeInteger(file.size) || file.size > maxBytes) {
      throw Object.assign(new Error('bounded broad raster file exceeds its byte budget'), {
        code: 'EFBIG',
      });
    }
    const bytes = Buffer.allocUnsafe(file.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > file.size) {
      throw Object.assign(new Error('bounded broad raster file changed during its read'), {
        code: 'EFBIG',
      });
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function brotliCompress(bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeBrotliCompress(bytes, BROTLI_OPTIONS, (error, result) =>
      error ? reject(error) : resolve(result)
    );
  });
}

function brotliDecompress(bytes: Buffer, maxOutputLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeBrotliDecompress(bytes, { maxOutputLength }, (error, result) =>
      error ? reject(error) : resolve(result)
    );
  });
}
