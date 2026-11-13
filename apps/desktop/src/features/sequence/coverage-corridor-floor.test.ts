import { describe, expect, it, vi } from 'vitest';
import type { Assembly } from '@waypoint/genome-renderer';
import {
  COVERAGE_CORRIDOR_FLOOR_ASSEMBLY_CONTRACT,
  COVERAGE_CORRIDOR_FLOOR_BIN_SIZE,
  COVERAGE_CORRIDOR_FLOOR_CONTRACT,
  COVERAGE_CORRIDOR_FLOOR_LEVEL,
  COVERAGE_CORRIDOR_FLOOR_STATISTIC,
  coverageCorridorFloorAssemblyFingerprint,
  coverageCorridorFloorRequestFingerprint,
  coverageCorridorFloorSegments,
  loadCoverageCorridorFloor,
} from './coverage-corridor-floor';
import { TileEngineDriver } from './tile-engine-driver';

const source = {
  bamPath: '/data/HG002.bam',
  indexPath: '/data/HG002.bam.bai',
  referencePath: '/data/grch38.fa',
  generation: {
    contract: 'aligned-read-source-generation.v1' as const,
    alignment: {
      canonicalPath: '/data/HG002.bam',
      size: 42,
      mtimeNs: '1700000000000000000',
      ctimeNs: '1700000000000000001',
      device: '1',
      inode: '101',
    },
    index: {
      canonicalPath: '/data/HG002.bam.bai',
      size: 17,
      mtimeNs: '1700000000000000002',
      ctimeNs: '1700000000000000003',
      device: '1',
      inode: '102',
    },
    reference: {
      canonicalPath: '/data/grch38.fa',
      size: 84,
      mtimeNs: '1700000000000000004',
      ctimeNs: '1700000000000000005',
      device: '1',
      inode: '103',
    },
    referenceIndex: {
      canonicalPath: '/data/grch38.fa.fai',
      size: 29,
      mtimeNs: '1700000000000000006',
      ctimeNs: '1700000000000000007',
      device: '1',
      inode: '104',
    },
  },
};

function assembly(): Assembly {
  return {
    id: 'grch38-test',
    displayName: 'GRCh38 test',
    totalLengthBp: 98_304,
    chromosomes: [
      {
        chromosome: { id: 'chr1', displayName: 'chr1', length: 65_536 },
        globalStartBp: 0,
        globalEndBp: 65_536,
        order: 0,
      },
      {
        chromosome: { id: 'chr2', displayName: 'chr2', length: 32_768 },
        globalStartBp: 65_536,
        globalEndBp: 98_304,
        order: 1,
      },
    ],
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function responseArtifact(
  mutate?: (manifest: Record<string, any>, data: Uint8Array) => void
): Promise<Response> {
  const segments = coverageCorridorFloorSegments(assembly());
  const values = new Float32Array([1, 2, 3]);
  const data = new Uint8Array(values.buffer.slice(0));
  const first = data.subarray(0, 8);
  const second = data.subarray(8);
  const manifest: Record<string, any> = {
    contract: COVERAGE_CORRIDOR_FLOOR_CONTRACT,
    requestFingerprint: await coverageCorridorFloorRequestFingerprint(source, segments),
    sourceIdentity: 'a'.repeat(64),
    orderedAssemblyFingerprint: await coverageCorridorFloorAssemblyFingerprint(segments),
    statistic: COVERAGE_CORRIDOR_FLOOR_STATISTIC,
    level: COVERAGE_CORRIDOR_FLOOR_LEVEL,
    binSize: COVERAGE_CORRIDOR_FLOOR_BIN_SIZE,
    complete: true,
    assemblyStart: 0,
    assemblyEnd: assembly().totalLengthBp,
    segments: [
      {
        chrom: 'chr1',
        localStart: 0,
        localEnd: 65_536,
        globalStart: 0,
        globalEnd: 65_536,
        binSize: COVERAGE_CORRIDOR_FLOOR_BIN_SIZE,
        count: 2,
        byteOffset: 0,
        byteLength: 8,
        sourceBaseBinSize: 8,
        checksumSha256: await sha256(first),
        complete: true,
      },
      {
        chrom: 'chr2',
        localStart: 0,
        localEnd: 32_768,
        globalStart: 65_536,
        globalEnd: 98_304,
        binSize: COVERAGE_CORRIDOR_FLOOR_BIN_SIZE,
        count: 1,
        byteOffset: 8,
        byteLength: 4,
        sourceBaseBinSize: 4,
        checksumSha256: await sha256(second),
        complete: true,
      },
    ],
    dataChecksumSha256: await sha256(data),
    byteLayout: {
      framing: 'uint32le-json-header-padded4-then-data',
      dtype: 'float32',
      endian: 'little',
      headerLengthPrefixBytes: 4,
      headerPaddedBytes: 0,
      dataOffset: 0,
      dataByteLength: data.byteLength,
    },
    depthScale: {
      contract: 'coverage-depth-scale.v1',
      basisStatistic: COVERAGE_CORRIDOR_FLOOR_STATISTIC,
      p50: 2,
      p90: 2.8,
      p95: 2.9,
      p99: 2.98,
      max: 3,
      scaleDepth: 2.98,
    },
  };
  mutate?.(manifest, data);
  let encoded = new Uint8Array();
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const rawHeader = new TextEncoder().encode(JSON.stringify(manifest));
    const paddedLength = rawHeader.byteLength + (-rawHeader.byteLength % 4);
    manifest.byteLayout.headerPaddedBytes = paddedLength;
    manifest.byteLayout.dataOffset = 4 + paddedLength;
    const header = new TextEncoder().encode(JSON.stringify(manifest));
    const finalPadded = header.byteLength + (-header.byteLength % 4);
    if (finalPadded !== paddedLength) continue;
    encoded = new Uint8Array(4 + finalPadded + data.byteLength);
    new DataView(encoded.buffer).setUint32(0, finalPadded, true);
    encoded.set(header, 4);
    encoded.fill(32, 4 + header.byteLength, 4 + finalPadded);
    encoded.set(data, 4 + finalPadded);
    break;
  }
  if (encoded.byteLength === 0) throw new Error('test manifest did not converge');
  return new Response(encoded, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Waypoint-Coverage-Contract': String(manifest.contract),
      'X-Waypoint-Coverage-Source': String(manifest.sourceIdentity),
    },
  });
}

describe('coverage corridor floor client', () => {
  it('admits only the exact complete source-keyed ordered assembly artifact', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.cache).toBe('no-store');
      expect(JSON.parse(String(init?.body))).toEqual({
        bamPath: source.bamPath,
        indexPath: source.indexPath,
        referencePath: source.referencePath,
        sourceGeneration: source.generation,
        segments: coverageCorridorFloorSegments(assembly()),
      });
      return responseArtifact();
    }) as unknown as typeof fetch;

    const result = await loadCoverageCorridorFloor({
      baseUrl: 'http://sidecar/',
      source,
      assembly: assembly(),
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      contract: COVERAGE_CORRIDOR_FLOOR_CONTRACT,
      sourceIdentity: 'a'.repeat(64),
      statistic: COVERAGE_CORRIDOR_FLOOR_STATISTIC,
      level: 15,
      binSize: 32_768,
      assemblyStart: 0,
      assemblyEnd: 98_304,
      depthPercentiles: { p50: 2, p90: 2.8, p95: 2.9, p99: 2.98, max: 3 },
    });
    expect([...result!.layers.keys()]).toEqual(['chr1', 'chr2']);
    expect([...result!.layers.get('chr1')!.bins]).toEqual([1, 2]);
    expect([...result!.layers.get('chr2')!.bins]).toEqual([3]);
  });

  it('retries a transient ready-cache miss until background preparation publishes the floor', async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      return attempts === 1 ? new Response(null, { status: 425 }) : responseArtifact();
    }) as unknown as typeof fetch;
    const result = await loadCoverageCorridorFloor({
      baseUrl: 'http://sidecar',
      source,
      assembly: assembly(),
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result?.sourceIdentity).toBe('a'.repeat(64));
  });

  it('stops retrying immediately when the owning tile engine is disposed', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort(new DOMException('track disposed', 'AbortError'));
      return new Response(null, { status: 425 });
    }) as unknown as typeof fetch;

    await expect(
      loadCoverageCorridorFloor({
        baseUrl: 'http://sidecar',
        source,
        assembly: assembly(),
        signal: controller.signal,
        fetchImpl,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['wrong request', (manifest: any) => (manifest.requestFingerprint = '0'.repeat(64))],
    ['wrong assembly', (manifest: any) => (manifest.orderedAssemblyFingerprint = '0'.repeat(64))],
    ['missing source', (manifest: any) => (manifest.sourceIdentity = '')],
    ['stale statistic', (manifest: any) => (manifest.statistic = 'pyramid-maxpool')],
    ['partial assembly', (manifest: any) => manifest.segments.pop()],
    ['incomplete assembly', (manifest: any) => (manifest.complete = false)],
    ['incomplete segment', (manifest: any) => (manifest.segments[1].complete = false)],
    ['wrong segment range', (manifest: any) => (manifest.segments[1].globalStart += 1)],
    [
      'wrong segment checksum',
      (manifest: any) => (manifest.segments[0].checksumSha256 = '0'.repeat(64)),
    ],
    ['wrong whole checksum', (manifest: any) => (manifest.dataChecksumSha256 = '0'.repeat(64))],
    ['wrong depth provenance', (manifest: any) => (manifest.depthScale.basisStatistic = 'other')],
  ])('fails closed for %s', async (_label, mutate) => {
    await expect(
      loadCoverageCorridorFloor({
        baseUrl: 'http://sidecar',
        source,
        assembly: assembly(),
        fetchImpl: vi.fn(async () => responseArtifact(mutate)) as unknown as typeof fetch,
      })
    ).rejects.toThrow();
  });

  it('binds fingerprinting to full ordered placement rather than only total length', async () => {
    const original = coverageCorridorFloorSegments(assembly());
    const reordered = [original[1]!, original[0]!].map((segment, index) => ({
      ...segment,
      chromGlobalStart: index === 0 ? 0 : 32_768,
    }));
    expect(await coverageCorridorFloorAssemblyFingerprint(original)).not.toBe(
      await coverageCorridorFloorAssemblyFingerprint(reordered)
    );
    expect(
      new TextEncoder().encode(COVERAGE_CORRIDOR_FLOOR_ASSEMBLY_CONTRACT).byteLength
    ).toBeGreaterThan(0);
  });

  it('is requested and atomically adopted by the production driver wiring', async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      requests.push(String(url));
      return responseArtifact();
    }) as unknown as typeof fetch;
    const driver = new TileEngineDriver({
      assembly: assembly(),
      source,
      baseUrl: 'http://sidecar',
      fetchImpl,
      onFeed: () => undefined,
    });

    for (let turn = 0; turn < 20; turn += 1) {
      if ((driver as any).corridorFloorState === 'ready') break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(requests).toEqual(['http://sidecar/tiles/coverage-corridor-floor']);
    expect((driver as any).corridorFloorState).toBe('ready');
    expect((driver as any).verifiedCorridorFloor.sourceIdentity).toBe('a'.repeat(64));
    expect((driver as any).verifiedCorridorFloor.layers.size).toBe(2);
    expect((driver as any).residentBaseLayerVerified).toBe(false);
    expect((driver as any).residentBaseLayer.size).toBe(0);
    driver.dispose();
  });
});
