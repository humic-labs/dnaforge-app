import {
  admitCompiledBroadSurfaceManifestV2,
  compiledBroadSurfaceCellIdV2,
  isAnnotationColorRoleKeyV1,
  type AnnotationColorRoleKeyV1,
  type BroadSurfaceIsoformModeV2,
  type CompiledBroadSurfaceManifestV2,
} from '@waypoint/genome-renderer/pure';

export const COMPILED_BROAD_RASTER_ARTIFACT_V1 = 'compiled-broad-raster-artifact.v1' as const;
export const COMPILED_BROAD_RASTER_PIXEL_FORMAT_V1 = 'rgba8-premultiplied-srgb.v1' as const;
export const COMPILED_BROAD_RASTER_PIXEL_FORMAT_ROLE_WEIGHTS_V1 = 'rgba8-role-weights.v1' as const;
export type CompiledBroadRasterPixelFormatV1 =
  | typeof COMPILED_BROAD_RASTER_PIXEL_FORMAT_V1
  | typeof COMPILED_BROAD_RASTER_PIXEL_FORMAT_ROLE_WEIGHTS_V1;
export const COMPILED_BROAD_RASTER_MAX_ROLE_WEIGHT_ROLES_V1 = 4;
export const COMPILED_BROAD_RASTER_COMPRESSION_V1 = 'brotli.v1' as const;
export const COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1 = 'rgba8' as const;
export const COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_V1 = 'transparent' as const;
export const COMPILED_BROAD_RASTER_MANIFEST_FILE_V1 =
  'compiled-broad-raster-artifact.v1.json' as const;

export const MAX_COMPILED_BROAD_RASTER_CELLS_PER_READ_V1 = 256 as const;
export const MAX_COMPILED_BROAD_RASTER_DECODED_BYTES_PER_READ_V1 = 128 * 1024 * 1024;

export const COMPILED_BROAD_RASTER_BYTES_PER_RGBA_PIXEL_V1 = 4 as const;
export const COMPILED_BROAD_RASTER_CELL_DIRECTORY_V1 = 'cells';
export const COMPILED_BROAD_RASTER_CELL_FILE_SUFFIX_V1 = '.rgba.br';
export const COMPILED_BROAD_RASTER_MAX_MANIFEST_BYTES_V1 = 64 * 1024 * 1024;
export const COMPILED_BROAD_RASTER_MAX_BROTLI_OVERHEAD_BYTES_PER_CELL_V1 = 64 * 1024;
const BYTES_PER_RGBA_PIXEL = COMPILED_BROAD_RASTER_BYTES_PER_RGBA_PIXEL_V1;
const CELL_DIRECTORY = COMPILED_BROAD_RASTER_CELL_DIRECTORY_V1;
const CELL_FILE_SUFFIX = COMPILED_BROAD_RASTER_CELL_FILE_SUFFIX_V1;
const MAX_MANIFEST_BYTES = COMPILED_BROAD_RASTER_MAX_MANIFEST_BYTES_V1;
const MAX_BROTLI_OVERHEAD_BYTES_PER_CELL =
  COMPILED_BROAD_RASTER_MAX_BROTLI_OVERHEAD_BYTES_PER_CELL_V1;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MANIFEST_KEYS = Object.freeze([
  'contract',
  'catalogFingerprint',
  'surfaceManifest',
  'pixelFormat',
  'compression',
  'storedWidthPx',
  'storedHeightPx',
  'bytesPerPixel',
  'cells',
] as const);
const ROLE_WEIGHT_MANIFEST_KEYS = Object.freeze([...MANIFEST_KEYS, 'roleTable'] as const);
const CELL_KEYS = Object.freeze([
  'cellId',
  'trackId',
  'isoformMode',
  'level',
  'tileX',
  'laneSlabId',
  'laneSlabIndex',
  'occupancy',
  'widthPx',
  'heightPx',
  'decodedByteLength',
  'decodedSha256',
  'encodedByteLength',
  'encodedSha256',
  'fileName',
] as const);

export interface CompiledBroadRasterCellAddressV1 {
  readonly isoformMode: BroadSurfaceIsoformModeV2;
  readonly level: number;
  readonly tileX: number;
  readonly laneSlabIndex: number;
}

export interface CompiledBroadRasterCellRecordV1 extends CompiledBroadRasterCellAddressV1 {
  readonly cellId: string;
  readonly trackId: string;
  readonly laneSlabId: string;
  readonly occupancy:
    | typeof COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1
    | typeof COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_V1;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly decodedByteLength: number;
  readonly decodedSha256: string | null;
  readonly encodedByteLength: number;
  readonly encodedSha256: string | null;
  readonly fileName: string | null;
}

export interface CompiledBroadRasterArtifactManifestV1 {
  readonly contract: typeof COMPILED_BROAD_RASTER_ARTIFACT_V1;
  readonly catalogFingerprint: string;
  readonly surfaceManifest: CompiledBroadSurfaceManifestV2;
  readonly pixelFormat: CompiledBroadRasterPixelFormatV1;
  readonly roleTable?: readonly AnnotationColorRoleKeyV1[];
  readonly compression: typeof COMPILED_BROAD_RASTER_COMPRESSION_V1;
  readonly storedWidthPx: number;
  readonly storedHeightPx: number;
  readonly bytesPerPixel: typeof BYTES_PER_RGBA_PIXEL;
  readonly cells: readonly CompiledBroadRasterCellRecordV1[];
}

export interface CompiledBroadRasterCellPayloadV1 {
  readonly record: CompiledBroadRasterCellRecordV1;
  readonly premultipliedRgba: Uint8Array | null;
}

export interface CompiledBroadRasterArtifactReaderV1 {
  readonly manifest: CompiledBroadRasterArtifactManifestV1;
  readCells(
    addresses: readonly CompiledBroadRasterCellAddressV1[]
  ): Promise<readonly CompiledBroadRasterCellPayloadV1[]>;
}

export type CompiledBroadRasterArtifactErrorCodeV1 =
  | 'invalid-request'
  | 'artifact-not-found'
  | 'invalid-manifest'
  | 'integrity-mismatch'
  | 'publication-conflict'
  | 'io-failure';

export class CompiledBroadRasterArtifactError extends Error {
  readonly code: CompiledBroadRasterArtifactErrorCodeV1;

  constructor(code: CompiledBroadRasterArtifactErrorCodeV1, message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        value: cause,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    this.name = 'CompiledBroadRasterArtifactError';
    this.code = code;
  }
}

export type CompiledBroadRasterSha256HexV1 = (bytes: Uint8Array) => string | Promise<string>;

export interface CompiledBroadRasterReaderRuntimeV1 {
  readonly readFile: (path: string, maxBytes: number) => Promise<Uint8Array>;
  readonly sha256Hex: CompiledBroadRasterSha256HexV1;
  readonly brotliDecompress: (bytes: Uint8Array, maxOutputLength: number) => Promise<Uint8Array>;
  readonly isMissingFile?: (error: unknown) => boolean;
  readonly isBoundedReadFailure?: (error: unknown) => boolean;
  readonly joinPath?: (...parts: string[]) => string;
}

export async function openCompiledBroadRasterArtifactV1(
  input: {
    readonly artifactDirectory: string;
    readonly expectedSurfaceManifestFingerprint: string;
  },
  runtime: CompiledBroadRasterReaderRuntimeV1
): Promise<CompiledBroadRasterArtifactReaderV1> {
  const artifactDirectory = compiledBroadRasterNonemptyPathV1(input.artifactDirectory);
  const expectedFingerprint = compiledBroadRasterExactSha256V1(
    input.expectedSurfaceManifestFingerprint,
    'expected surface manifest fingerprint',
    'invalid-request'
  );
  const isMissing = runtime.isMissingFile ?? compiledBroadRasterIsMissingFileV1;
  const isBounded = runtime.isBoundedReadFailure ?? compiledBroadRasterIsBoundedReadFailureV1;
  const joinPath = runtime.joinPath ?? joinPosixPath;
  const manifestPath = joinPath(artifactDirectory, COMPILED_BROAD_RASTER_MANIFEST_FILE_V1);
  let manifestBytes: Uint8Array;
  try {
    manifestBytes = await runtime.readFile(manifestPath, MAX_MANIFEST_BYTES);
  } catch (error) {
    throw new CompiledBroadRasterArtifactError(
      isMissing(error)
        ? 'artifact-not-found'
        : isBounded(error)
          ? 'invalid-manifest'
          : 'io-failure',
      'broad raster artifact manifest is unavailable',
      error
    );
  }
  const manifest = await admitCompiledBroadRasterArtifactManifestV1(
    manifestBytes,
    expectedFingerprint,
    runtime.sha256Hex
  );
  const recordsByCellId = new Map(manifest.cells.map((record) => [record.cellId, record]));

  return Object.freeze({
    manifest,
    readCells: async (
      addresses: readonly CompiledBroadRasterCellAddressV1[]
    ): Promise<readonly CompiledBroadRasterCellPayloadV1[]> => {
      if (
        !Array.isArray(addresses) ||
        addresses.length === 0 ||
        addresses.length > MAX_COMPILED_BROAD_RASTER_CELLS_PER_READ_V1
      ) {
        throw new CompiledBroadRasterArtifactError(
          'invalid-request',
          `broad raster reads require 1-${MAX_COMPILED_BROAD_RASTER_CELLS_PER_READ_V1} cells`
        );
      }
      const requestedRecords: CompiledBroadRasterCellRecordV1[] = [];
      const seen = new Set<string>();
      let decodedByteLength = 0;
      let encodedByteLength = 0;
      for (const candidate of addresses) {
        const address = compiledBroadRasterValidateAddressV1(
          manifest.surfaceManifest,
          candidate,
          'invalid-request'
        );
        const cellId = compiledBroadRasterCellIdForV1(manifest.surfaceManifest, address);
        if (seen.has(cellId)) {
          throw new CompiledBroadRasterArtifactError(
            'invalid-request',
            `duplicate broad raster read address ${cellId}`
          );
        }
        seen.add(cellId);
        const record = recordsByCellId.get(cellId);
        if (!record) {
          throw new CompiledBroadRasterArtifactError(
            'invalid-manifest',
            `broad raster manifest is missing ${cellId}`
          );
        }
        decodedByteLength += record.decodedByteLength;
        encodedByteLength += record.encodedByteLength;
        requestedRecords.push(record);
      }
      if (
        decodedByteLength > MAX_COMPILED_BROAD_RASTER_DECODED_BYTES_PER_READ_V1 ||
        encodedByteLength >
          MAX_COMPILED_BROAD_RASTER_DECODED_BYTES_PER_READ_V1 +
            addresses.length * MAX_BROTLI_OVERHEAD_BYTES_PER_CELL
      ) {
        throw new CompiledBroadRasterArtifactError(
          'invalid-request',
          'broad raster read exceeds the decoded-byte budget'
        );
      }

      return Object.freeze(
        await Promise.all(
          requestedRecords.map(async (record) => {
            if (record.occupancy === COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_V1) {
              return Object.freeze({ record, premultipliedRgba: null });
            }
            if (!record.encodedSha256 || !record.decodedSha256 || !record.fileName) {
              throw new CompiledBroadRasterArtifactError(
                'invalid-manifest',
                `occupied broad raster payload metadata is absent for ${record.cellId}`
              );
            }
            const payloadPath = joinPath(
              artifactDirectory,
              CELL_DIRECTORY,
              `${record.encodedSha256}${CELL_FILE_SUFFIX}`
            );
            let encoded: Uint8Array;
            try {
              encoded = await runtime.readFile(payloadPath, record.encodedByteLength);
            } catch (error) {
              throw new CompiledBroadRasterArtifactError(
                isMissing(error)
                  ? 'artifact-not-found'
                  : isBounded(error)
                    ? 'integrity-mismatch'
                    : 'io-failure',
                `broad raster payload is unavailable for ${record.cellId}`,
                error
              );
            }
            if (
              encoded.byteLength !== record.encodedByteLength ||
              (await runtime.sha256Hex(encoded)) !== record.encodedSha256
            ) {
              throw new CompiledBroadRasterArtifactError(
                'integrity-mismatch',
                `broad raster encoded payload integrity mismatch for ${record.cellId}`
              );
            }
            let decoded: Uint8Array;
            try {
              decoded = await runtime.brotliDecompress(encoded, record.decodedByteLength);
            } catch (error) {
              throw new CompiledBroadRasterArtifactError(
                'integrity-mismatch',
                `broad raster payload cannot be decoded for ${record.cellId}`,
                error
              );
            }
            if (
              decoded.byteLength !== record.decodedByteLength ||
              (await runtime.sha256Hex(decoded)) !== record.decodedSha256
            ) {
              throw new CompiledBroadRasterArtifactError(
                'integrity-mismatch',
                `broad raster decoded payload integrity mismatch for ${record.cellId}`
              );
            }
            return Object.freeze({
              record,
              premultipliedRgba: exactUint8ArrayView(decoded),
            });
          })
        )
      );
    },
  });
}

export async function admitCompiledBroadRasterArtifactManifestV1(
  bytes: Uint8Array,
  expectedSurfaceManifestFingerprint: string,
  sha256Hex: CompiledBroadRasterSha256HexV1
): Promise<CompiledBroadRasterArtifactManifestV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes));
  } catch (error) {
    throw new CompiledBroadRasterArtifactError(
      'invalid-manifest',
      'broad raster artifact manifest is not valid JSON',
      error
    );
  }
  const roleWeights =
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as { pixelFormat?: unknown }).pixelFormat ===
      COMPILED_BROAD_RASTER_PIXEL_FORMAT_ROLE_WEIGHTS_V1;
  const input = compiledBroadRasterExactRecordV1(
    parsed,
    roleWeights ? ROLE_WEIGHT_MANIFEST_KEYS : MANIFEST_KEYS,
    'broad raster artifact manifest'
  );
  if (
    input.contract !== COMPILED_BROAD_RASTER_ARTIFACT_V1 ||
    (!roleWeights && input.pixelFormat !== COMPILED_BROAD_RASTER_PIXEL_FORMAT_V1) ||
    (roleWeights && !compiledBroadRasterRoleTableIsValidV1(input.roleTable)) ||
    input.compression !== COMPILED_BROAD_RASTER_COMPRESSION_V1 ||
    input.bytesPerPixel !== BYTES_PER_RGBA_PIXEL
  ) {
    throw new CompiledBroadRasterArtifactError(
      'invalid-manifest',
      'broad raster artifact contract is invalid'
    );
  }
  const surfaceManifest = await compiledBroadRasterAdmitSurfaceManifestV1(
    input.surfaceManifest,
    'invalid-manifest'
  );
  if (surfaceManifest.manifestFingerprint !== expectedSurfaceManifestFingerprint) {
    throw new CompiledBroadRasterArtifactError(
      'invalid-manifest',
      'broad raster surface manifest fingerprint does not match the requested artifact'
    );
  }
  const dimensions = compiledBroadRasterExactCellDimensionsV1(surfaceManifest);
  if (input.storedWidthPx !== dimensions.widthPx || input.storedHeightPx !== dimensions.heightPx) {
    throw new CompiledBroadRasterArtifactError(
      'invalid-manifest',
      'broad raster artifact dimensions do not match the surface contract'
    );
  }
  const expectedAddresses = compiledBroadRasterCompleteAddressRosterV1(surfaceManifest);
  if (!Array.isArray(input.cells) || input.cells.length !== expectedAddresses.length) {
    throw new CompiledBroadRasterArtifactError(
      'invalid-manifest',
      'broad raster artifact cell roster is incomplete'
    );
  }
  const records = input.cells.map((value, index) =>
    admitCellRecord(value, expectedAddresses[index], surfaceManifest, dimensions)
  );
  const catalogFingerprint = compiledBroadRasterExactSha256V1(
    input.catalogFingerprint,
    'catalog fingerprint',
    'invalid-manifest'
  );
  const fields = Object.freeze({
    contract: COMPILED_BROAD_RASTER_ARTIFACT_V1,
    surfaceManifest,
    pixelFormat: roleWeights
      ? COMPILED_BROAD_RASTER_PIXEL_FORMAT_ROLE_WEIGHTS_V1
      : COMPILED_BROAD_RASTER_PIXEL_FORMAT_V1,
    ...(roleWeights
      ? { roleTable: Object.freeze([...(input.roleTable as AnnotationColorRoleKeyV1[])]) }
      : {}),
    compression: COMPILED_BROAD_RASTER_COMPRESSION_V1,
    storedWidthPx: dimensions.widthPx,
    storedHeightPx: dimensions.heightPx,
    bytesPerPixel: BYTES_PER_RGBA_PIXEL,
    cells: Object.freeze(records),
  });
  const computedFingerprint = await sha256Hex(
    new TextEncoder().encode(compiledBroadRasterCanonicalJsonV1(fields))
  );
  if (catalogFingerprint !== computedFingerprint) {
    throw new CompiledBroadRasterArtifactError(
      'invalid-manifest',
      'broad raster catalog SHA-256 mismatch'
    );
  }
  return compiledBroadRasterFreezeManifestV1({ ...fields, catalogFingerprint });
}

function admitCellRecord(
  value: unknown,
  expectedAddress: CompiledBroadRasterCellAddressV1,
  surfaceManifest: CompiledBroadSurfaceManifestV2,
  dimensions: { widthPx: number; heightPx: number; decodedByteLength: number }
): CompiledBroadRasterCellRecordV1 {
  const input = compiledBroadRasterExactRecordV1(value, CELL_KEYS, 'broad raster cell record');
  const address = compiledBroadRasterValidateAddressV1(surfaceManifest, input, 'invalid-manifest');
  const expectedCellId = compiledBroadRasterCellIdForV1(surfaceManifest, expectedAddress);
  const actualCellId = compiledBroadRasterCellIdForV1(surfaceManifest, address);
  const slab =
    surfaceManifest.laneSlabs[expectedAddress.isoformMode][expectedAddress.laneSlabIndex];
  const commonValid =
    actualCellId === expectedCellId &&
    input.cellId === expectedCellId &&
    input.trackId === surfaceManifest.trackId &&
    input.laneSlabId === slab.slabId &&
    input.widthPx === dimensions.widthPx &&
    input.heightPx === dimensions.heightPx;
  if (input.occupancy === COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_V1) {
    if (
      !commonValid ||
      input.decodedByteLength !== 0 ||
      input.decodedSha256 !== null ||
      input.encodedByteLength !== 0 ||
      input.encodedSha256 !== null ||
      input.fileName !== null
    ) {
      throw new CompiledBroadRasterArtifactError(
        'invalid-manifest',
        `transparent broad raster cell record is invalid for ${expectedCellId}`
      );
    }
    return Object.freeze({
      cellId: expectedCellId,
      trackId: surfaceManifest.trackId,
      ...expectedAddress,
      laneSlabId: slab.slabId,
      occupancy: COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_V1,
      widthPx: dimensions.widthPx,
      heightPx: dimensions.heightPx,
      decodedByteLength: 0,
      decodedSha256: null,
      encodedByteLength: 0,
      encodedSha256: null,
      fileName: null,
    });
  }
  if (input.occupancy !== COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1) {
    throw new CompiledBroadRasterArtifactError(
      'invalid-manifest',
      `broad raster cell occupancy is invalid for ${expectedCellId}`
    );
  }
  const encodedSha256 = compiledBroadRasterExactSha256V1(
    input.encodedSha256,
    'encoded SHA-256',
    'invalid-manifest'
  );
  const decodedSha256 = compiledBroadRasterExactSha256V1(
    input.decodedSha256,
    'decoded SHA-256',
    'invalid-manifest'
  );
  const expectedFileName = `${CELL_DIRECTORY}/${encodedSha256}${CELL_FILE_SUFFIX}`;
  if (
    !commonValid ||
    input.decodedByteLength !== dimensions.decodedByteLength ||
    !Number.isSafeInteger(input.encodedByteLength) ||
    (input.encodedByteLength as number) <= 0 ||
    (input.encodedByteLength as number) >
      dimensions.decodedByteLength + MAX_BROTLI_OVERHEAD_BYTES_PER_CELL ||
    input.fileName !== expectedFileName
  ) {
    throw new CompiledBroadRasterArtifactError(
      'invalid-manifest',
      `broad raster cell record is invalid for ${expectedCellId}`
    );
  }
  return Object.freeze({
    cellId: expectedCellId,
    trackId: surfaceManifest.trackId,
    ...expectedAddress,
    laneSlabId: slab.slabId,
    occupancy: COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1,
    widthPx: dimensions.widthPx,
    heightPx: dimensions.heightPx,
    decodedByteLength: dimensions.decodedByteLength,
    decodedSha256,
    encodedByteLength: input.encodedByteLength as number,
    encodedSha256,
    fileName: expectedFileName,
  });
}

export function compiledBroadRasterCompleteAddressRosterV1(
  manifest: CompiledBroadSurfaceManifestV2
): readonly CompiledBroadRasterCellAddressV1[] {
  const addresses: CompiledBroadRasterCellAddressV1[] = [];
  for (const isoformMode of ['canonical', 'expanded'] as const) {
    for (const level of manifest.levels) {
      for (let tileX = 0; tileX < level.tileCount; tileX += 1) {
        for (const slab of manifest.laneSlabs[isoformMode]) {
          addresses.push(
            Object.freeze({
              isoformMode,
              level: level.level,
              tileX,
              laneSlabIndex: slab.slabIndex,
            })
          );
        }
      }
    }
  }
  return Object.freeze(addresses);
}

export function compiledBroadRasterValidateAddressV1(
  manifest: CompiledBroadSurfaceManifestV2,
  value: unknown,
  code: 'invalid-request' | 'invalid-manifest'
): CompiledBroadRasterCellAddressV1 {
  if (typeof value !== 'object' || value === null) {
    throw new CompiledBroadRasterArtifactError(code, 'broad raster cell address is invalid');
  }
  const input = value as Record<string, unknown>;
  const isoformMode = input.isoformMode;
  if (isoformMode !== 'canonical' && isoformMode !== 'expanded') {
    throw new CompiledBroadRasterArtifactError(code, 'broad raster isoform mode is invalid');
  }
  const level = nonnegativeSafeInteger(input.level, 'level', code);
  const tileX = nonnegativeSafeInteger(input.tileX, 'tileX', code);
  const laneSlabIndex = nonnegativeSafeInteger(input.laneSlabIndex, 'lane slab index', code);
  try {
    compiledBroadSurfaceCellIdV2({ manifest, isoformMode, level, tileX, laneSlabIndex });
  } catch (error) {
    throw new CompiledBroadRasterArtifactError(
      code,
      'broad raster cell address is outside the surface manifest',
      error
    );
  }
  return Object.freeze({ isoformMode, level, tileX, laneSlabIndex });
}

export function compiledBroadRasterCellIdForV1(
  manifest: CompiledBroadSurfaceManifestV2,
  address: CompiledBroadRasterCellAddressV1
): string {
  return compiledBroadSurfaceCellIdV2({ manifest, ...address });
}

export function compiledBroadRasterExactCellDimensionsV1(
  manifest: CompiledBroadSurfaceManifestV2
): {
  widthPx: number;
  heightPx: number;
  decodedByteLength: number;
} {
  const widthPx = manifest.broadTilePhysicalWidthPx + manifest.broadTileXGuardPhysicalPx * 2;
  const heightPx = manifest.laneSlabRowCount * manifest.laneRowTextureStridePx;
  const decodedByteLength = widthPx * heightPx * BYTES_PER_RGBA_PIXEL;
  if (![widthPx, heightPx, decodedByteLength].every(Number.isSafeInteger)) {
    throw new CompiledBroadRasterArtifactError(
      'invalid-manifest',
      'broad raster dimensions exceed the safe integer range'
    );
  }
  return Object.freeze({ widthPx, heightPx, decodedByteLength });
}

export function compiledBroadRasterRoleTableIsValidV1(
  value: unknown
): value is AnnotationColorRoleKeyV1[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= COMPILED_BROAD_RASTER_MAX_ROLE_WEIGHT_ROLES_V1 &&
    value.every(isAnnotationColorRoleKeyV1) &&
    new Set(value).size === value.length
  );
}

export function compiledBroadRasterFreezeManifestV1(
  value: CompiledBroadRasterArtifactManifestV1
): CompiledBroadRasterArtifactManifestV1 {
  return Object.freeze({
    ...value,
    cells: Object.freeze(value.cells),
  });
}

export async function compiledBroadRasterAdmitSurfaceManifestV1(
  value: unknown,
  code: 'invalid-request' | 'invalid-manifest'
): Promise<CompiledBroadSurfaceManifestV2> {
  try {
    return await admitCompiledBroadSurfaceManifestV2(JSON.parse(JSON.stringify(value)));
  } catch (error) {
    throw new CompiledBroadRasterArtifactError(
      code,
      'compiled broad surface manifest identity is invalid',
      error
    );
  }
}

function compiledBroadRasterExactRecordV1(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CompiledBroadRasterArtifactError('invalid-manifest', `${label} is invalid`);
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new CompiledBroadRasterArtifactError('invalid-manifest', `${label} fields are invalid`);
  }
  return value as Record<string, unknown>;
}

function nonnegativeSafeInteger(
  value: unknown,
  label: string,
  code: 'invalid-request' | 'invalid-manifest'
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CompiledBroadRasterArtifactError(code, `${label} is invalid`);
  }
  return value as number;
}

export function compiledBroadRasterExactSha256V1(
  value: unknown,
  label: string,
  code: 'invalid-request' | 'invalid-manifest'
): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new CompiledBroadRasterArtifactError(code, `${label} is invalid`);
  }
  return value;
}

export function compiledBroadRasterNonemptyPathV1(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CompiledBroadRasterArtifactError(
      'invalid-request',
      'broad raster artifact directory is invalid'
    );
  }
  return value;
}

export function exactUint8ArrayView(value: Uint8Array): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export function compiledBroadRasterCanonicalJsonV1(value: unknown): string {
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

export function compiledBroadRasterIsMissingFileV1(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export function compiledBroadRasterIsBoundedReadFailureV1(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EFBIG'
  );
}

function joinPosixPath(...parts: readonly string[]): string {
  return parts
    .map((part, index) =>
      index === 0 ? part.replace(/\/+$/u, '') : part.replace(/^\/+|\/+$/gu, '')
    )
    .filter((part, index) => index === 0 || part.length > 0)
    .join('/');
}
