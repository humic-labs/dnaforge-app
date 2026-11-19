import { buildCoverageGpuAtlas } from '@waypoint/genome-renderer/coverage-gpu-atlas';
import type { Assembly } from '@waypoint/genome-renderer';
import type {
  AlignedReadSourceGenerationV1,
  CoverageGpuAtlas,
  CoverageSignal,
} from '@waypoint/genome-data';
import { alignedReadSourceGenerationKey } from '@waypoint/genome-data/aligned-read-source-generation';

export const COVERAGE_CORRIDOR_FLOOR_CONTRACT = 'coverage-corridor-floor.v1';
export const COVERAGE_CORRIDOR_FLOOR_REQUEST_CONTRACT = 'coverage-corridor-floor-request.v1';
export const COVERAGE_CORRIDOR_FLOOR_ASSEMBLY_CONTRACT = 'coverage-assembly-placement.v1';
export const COVERAGE_CORRIDOR_FLOOR_STATISTIC = 'fixed-base-peak-mean-v1';
export const COVERAGE_CORRIDOR_FLOOR_LEVEL = 15;
export const COVERAGE_CORRIDOR_FLOOR_BIN_SIZE = 2 ** COVERAGE_CORRIDOR_FLOOR_LEVEL;

export interface CoverageCorridorFloorSource {
  bamPath: string;
  indexPath?: string;
  referencePath?: string;
  generation?: AlignedReadSourceGenerationV1;
}

export interface CoverageCorridorFloorSegmentRequest {
  chrom: string;
  start: number;
  end: number;
  chromGlobalStart: number;
}

export interface VerifiedCoverageCorridorFloorLayer {
  chrom: string;
  globalStart: number;
  globalEnd: number;
  binSize: number;
  bins: Float32Array;
}

export interface VerifiedCoverageCorridorFloor {
  contract: typeof COVERAGE_CORRIDOR_FLOOR_CONTRACT;
  sourceIdentity: string;
  requestFingerprint: string;
  orderedAssemblyFingerprint: string;
  statistic: typeof COVERAGE_CORRIDOR_FLOOR_STATISTIC;
  level: typeof COVERAGE_CORRIDOR_FLOOR_LEVEL;
  binSize: typeof COVERAGE_CORRIDOR_FLOOR_BIN_SIZE;
  assemblyStart: 0;
  assemblyEnd: number;
  depthPercentiles: NonNullable<CoverageSignal['depthPercentiles']>;
  layers: ReadonlyMap<string, VerifiedCoverageCorridorFloorLayer>;
}

export interface PreparedCoverageCorridorFloor {
  readonly floor: VerifiedCoverageCorridorFloor;
  readonly atlas: CoverageGpuAtlas;
}

export function buildCoverageCorridorFloorGpuAtlas(
  floor: VerifiedCoverageCorridorFloor
): CoverageGpuAtlas {
  return buildCoverageGpuAtlas({
    sourceIdentity: floor.sourceIdentity,
    assemblyFingerprint: floor.orderedAssemblyFingerprint,
    statistic: floor.statistic,
    payloadRevision: floor.requestFingerprint,
    assemblyEndBp: floor.assemblyEnd,
    baseBinSizeBp: floor.binSize,
    depthPercentiles: floor.depthPercentiles,
    layers: [...floor.layers.values()].map((layer) => ({
      chrom: layer.chrom,
      globalStartBp: layer.globalStart,
      globalEndBp: layer.globalEnd,
      binSizeBp: layer.binSize,
      bins: layer.bins,
    })),
  });
}

type ManifestSegment = {
  chrom: string;
  localStart: number;
  localEnd: number;
  globalStart: number;
  globalEnd: number;
  binSize: number;
  count: number;
  byteOffset: number;
  byteLength: number;
  sourceBaseBinSize: number;
  checksumSha256: string;
  complete: boolean;
};

type Manifest = {
  contract: string;
  requestFingerprint: string;
  sourceIdentity: string;
  orderedAssemblyFingerprint: string;
  statistic: string;
  level: number;
  binSize: number;
  complete: boolean;
  assemblyStart: number;
  assemblyEnd: number;
  segments: ManifestSegment[];
  dataChecksumSha256: string;
  byteLayout: {
    framing: string;
    dtype: string;
    endian: string;
    headerLengthPrefixBytes: number;
    headerPaddedBytes: number;
    dataOffset: number;
    dataByteLength: number;
  };
  depthScale: {
    contract: string;
    basisStatistic: string;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    max: number;
    scaleDepth: number;
  };
};

export interface LoadCoverageCorridorFloorOptions {
  baseUrl: string;
  source: CoverageCorridorFloorSource;
  assembly: Assembly;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface AuthenticatedCoverageCorridorFloorPayload {
  readonly bytes: ArrayBuffer;
  readonly contractHeader: string | null;
  readonly sourceHeader: string | null;
}

export class CoverageCorridorFloorContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoverageCorridorFloorContractError';
  }
}

export function coverageCorridorFloorSegments(
  assembly: Assembly
): CoverageCorridorFloorSegmentRequest[] {
  return assembly.chromosomes.map((placement) => ({
    chrom: placement.chromosome.id,
    start: 0,
    end: placement.chromosome.length,
    chromGlobalStart: placement.globalStartBp,
  }));
}

function segmentIdentityText(contract: string, segments: CoverageCorridorFloorSegmentRequest[]) {
  return [
    contract,
    ...segments.map((segment) =>
      [segment.chrom, segment.start, segment.end, segment.chromGlobalStart].join('\0')
    ),
  ].join('\n');
}

async function sha256Hex(bytes: BufferSource | string): Promise<string> {
  const input = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function coverageCorridorFloorAssemblyFingerprint(
  segments: CoverageCorridorFloorSegmentRequest[]
): Promise<string> {
  return sha256Hex(segmentIdentityText(COVERAGE_CORRIDOR_FLOOR_ASSEMBLY_CONTRACT, segments));
}

export async function coverageCorridorFloorRequestFingerprint(
  source: CoverageCorridorFloorSource,
  segments: CoverageCorridorFloorSegmentRequest[]
): Promise<string> {
  const prefix = [
    COVERAGE_CORRIDOR_FLOOR_REQUEST_CONTRACT,
    source.bamPath,
    source.indexPath ?? '',
    source.referencePath ?? '',
    alignedReadSourceGenerationKey(source.generation),
  ].join('\0');
  return sha256Hex(
    `${prefix}\n${segmentIdentityText(COVERAGE_CORRIDOR_FLOOR_ASSEMBLY_CONTRACT, segments)}`
  );
}

function requireContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CoverageCorridorFloorContractError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseManifest(bytes: Uint8Array): { manifest: Manifest; data: Uint8Array } {
  requireContract(
    bytes.byteLength >= 4,
    'corridor floor payload is shorter than its header prefix'
  );
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  requireContract(headerLength > 0 && headerLength % 4 === 0, 'invalid padded header length');
  const dataOffset = 4 + headerLength;
  requireContract(dataOffset <= bytes.byteLength, 'corridor floor header exceeds payload');
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(bytes.subarray(4, dataOffset)));
  } catch {
    throw new CoverageCorridorFloorContractError('corridor floor header is not valid JSON');
  }
  requireContract(isRecord(decoded), 'corridor floor header must be an object');
  return { manifest: decoded as unknown as Manifest, data: bytes.subarray(dataOffset) };
}

async function validateManifest(
  manifest: Manifest,
  data: Uint8Array,
  segments: CoverageCorridorFloorSegmentRequest[],
  requestFingerprint: string,
  assemblyFingerprint: string,
  totalLengthBp: number,
  dataOffset: number
): Promise<VerifiedCoverageCorridorFloor> {
  requireContract(manifest.contract === COVERAGE_CORRIDOR_FLOOR_CONTRACT, 'contract mismatch');
  requireContract(manifest.requestFingerprint === requestFingerprint, 'request identity mismatch');
  requireContract(/^[0-9a-f]{64}$/.test(manifest.sourceIdentity), 'source identity is missing');
  requireContract(
    manifest.orderedAssemblyFingerprint === assemblyFingerprint,
    'ordered assembly fingerprint mismatch'
  );
  requireContract(manifest.statistic === COVERAGE_CORRIDOR_FLOOR_STATISTIC, 'statistic mismatch');
  requireContract(manifest.level === COVERAGE_CORRIDOR_FLOOR_LEVEL, 'floor level mismatch');
  requireContract(manifest.binSize === COVERAGE_CORRIDOR_FLOOR_BIN_SIZE, 'bin size mismatch');
  requireContract(manifest.complete === true, 'corridor floor is incomplete');
  requireContract(
    manifest.assemblyStart === 0 && manifest.assemblyEnd === totalLengthBp,
    'assembly range mismatch'
  );
  requireContract(Array.isArray(manifest.segments), 'manifest segments are missing');
  requireContract(manifest.segments.length === segments.length, 'partial assembly segment list');
  const layout = manifest.byteLayout;
  requireContract(isRecord(layout), 'byte layout is missing');
  requireContract(
    layout.framing === 'uint32le-json-header-padded4-then-data' &&
      layout.dtype === 'float32' &&
      layout.endian === 'little' &&
      layout.headerLengthPrefixBytes === 4,
    'byte layout contract mismatch'
  );
  requireContract(layout.dataOffset === dataOffset, 'data offset mismatch');
  requireContract(layout.headerPaddedBytes === dataOffset - 4, 'header size mismatch');
  requireContract(layout.dataByteLength === data.byteLength, 'data byte length mismatch');
  requireContract(
    manifest.dataChecksumSha256 === (await sha256Hex(data)),
    'whole-floor checksum mismatch'
  );

  let expectedByteOffset = 0;
  const layers = new Map<string, VerifiedCoverageCorridorFloorLayer>();
  for (let index = 0; index < segments.length; index += 1) {
    const expected = segments[index]!;
    const actual = manifest.segments[index]!;
    const expectedCount = Math.ceil(
      (expected.end - expected.start) / COVERAGE_CORRIDOR_FLOOR_BIN_SIZE
    );
    const expectedGlobalEnd = expected.chromGlobalStart + expected.end - expected.start;
    requireContract(
      actual.chrom === expected.chrom &&
        actual.localStart === expected.start &&
        actual.localEnd === expected.end &&
        actual.globalStart === expected.chromGlobalStart &&
        actual.globalEnd === expectedGlobalEnd,
      `segment ${index} identity or range mismatch`
    );
    requireContract(actual.complete === true, `segment ${actual.chrom} is incomplete`);
    requireContract(
      actual.binSize === COVERAGE_CORRIDOR_FLOOR_BIN_SIZE &&
        actual.count === expectedCount &&
        actual.byteOffset === expectedByteOffset &&
        actual.byteLength === expectedCount * Float32Array.BYTES_PER_ELEMENT,
      `segment ${actual.chrom} layout mismatch`
    );
    requireContract(
      Number.isInteger(actual.sourceBaseBinSize) &&
        actual.sourceBaseBinSize > 0 &&
        actual.sourceBaseBinSize <= COVERAGE_CORRIDOR_FLOOR_BIN_SIZE,
      `segment ${actual.chrom} source resolution is invalid`
    );
    const raw = data.subarray(actual.byteOffset, actual.byteOffset + actual.byteLength);
    requireContract(
      actual.checksumSha256 === (await sha256Hex(raw)),
      `segment ${actual.chrom} checksum mismatch`
    );
    const view = new Float32Array(raw.buffer, raw.byteOffset, actual.count);
    const bins = Float32Array.from(view);
    for (const value of bins) {
      requireContract(
        Number.isFinite(value) && value >= 0,
        `segment ${actual.chrom} has invalid depth`
      );
    }
    layers.set(actual.chrom, {
      chrom: actual.chrom,
      globalStart: actual.globalStart,
      globalEnd: actual.globalEnd,
      binSize: actual.binSize,
      bins,
    });
    expectedByteOffset += actual.byteLength;
  }
  requireContract(expectedByteOffset === data.byteLength, 'unclaimed or missing coverage bytes');

  const depth = manifest.depthScale;
  requireContract(isRecord(depth), 'depth-scale metadata is missing');
  requireContract(
    depth.contract === 'coverage-depth-scale.v1' &&
      depth.basisStatistic === COVERAGE_CORRIDOR_FLOOR_STATISTIC,
    'depth-scale provenance mismatch'
  );
  requireContract(
    finiteNonnegative(depth.p50) &&
      finiteNonnegative(depth.p90) &&
      finiteNonnegative(depth.p95) &&
      finiteNonnegative(depth.p99) &&
      finiteNonnegative(depth.max) &&
      finiteNonnegative(depth.scaleDepth) &&
      depth.p50 <= depth.p90 &&
      depth.p90 <= depth.p95 &&
      depth.p95 <= depth.p99 &&
      depth.p99 <= depth.max &&
      depth.scaleDepth >= 1,
    'depth-scale values are invalid'
  );
  return {
    contract: COVERAGE_CORRIDOR_FLOOR_CONTRACT,
    sourceIdentity: manifest.sourceIdentity,
    requestFingerprint,
    orderedAssemblyFingerprint: assemblyFingerprint,
    statistic: COVERAGE_CORRIDOR_FLOOR_STATISTIC,
    level: COVERAGE_CORRIDOR_FLOOR_LEVEL,
    binSize: COVERAGE_CORRIDOR_FLOOR_BIN_SIZE,
    assemblyStart: 0,
    assemblyEnd: totalLengthBp,
    depthPercentiles: {
      p50: depth.p50,
      p90: depth.p90,
      p95: depth.p95,
      p99: depth.p99,
      max: depth.max,
    },
    layers,
  };
}

export async function decodeAuthenticatedCoverageCorridorFloorPayload(
  options: LoadCoverageCorridorFloorOptions,
  payload: AuthenticatedCoverageCorridorFloorPayload
): Promise<VerifiedCoverageCorridorFloor> {
  const segments = coverageCorridorFloorSegments(options.assembly);
  const requestFingerprint = await coverageCorridorFloorRequestFingerprint(
    options.source,
    segments
  );
  const assemblyFingerprint = await coverageCorridorFloorAssemblyFingerprint(segments);
  const bytes = new Uint8Array(payload.bytes);
  const { manifest, data } = parseManifest(bytes);
  requireContract(
    payload.contractHeader === manifest.contract,
    'response contract header mismatch'
  );
  requireContract(
    payload.sourceHeader === manifest.sourceIdentity,
    'response source header mismatch'
  );
  return validateManifest(
    manifest,
    data,
    segments,
    requestFingerprint,
    assemblyFingerprint,
    options.assembly.totalLengthBp,
    bytes.byteLength - data.byteLength
  );
}

export async function prepareAuthenticatedCoverageCorridorFloorPayload(
  options: LoadCoverageCorridorFloorOptions,
  payload: AuthenticatedCoverageCorridorFloorPayload
): Promise<PreparedCoverageCorridorFloor> {
  const floor = await decodeAuthenticatedCoverageCorridorFloorPayload(options, payload);
  return { floor, atlas: buildCoverageCorridorFloorGpuAtlas(floor) };
}
