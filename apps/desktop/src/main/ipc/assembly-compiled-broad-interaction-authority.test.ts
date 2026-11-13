import { describe, expect, it, vi } from 'vitest';

import type { AssemblyAnnotationSceneReadRequest } from '../../shared/indexed-genome';
import type { PortablePreparedReferenceCompiledBroadInteractionHitV1 } from '../reference-assets/portable-prepared-reference-view-authority';
import type { PortablePreparedReferenceSceneAdmissionWorkerResultV1 } from '../reference-assets/portable-prepared-reference-scene-admission-worker-job';
import type { AssemblyAnnotationSceneCacheIndexReadResult } from './assembly-overview-texture-cache';
import { AssemblyCompiledBroadInteractionAuthorityV1 } from './assembly-compiled-broad-interaction-authority';

const PAYLOAD_SHA = 'a'.repeat(64);
const CONTRACT_SHA = 'b'.repeat(64);
const COMPACT_SHA = 'c'.repeat(64);
const RANGE_CATALOG = { schema: 'partitioned-transcript-scene-range-catalog.v1' } as never;
const request = {} as AssemblyAnnotationSceneReadRequest;

function localIndex(
  overrides: Partial<Extract<AssemblyAnnotationSceneCacheIndexReadResult, { status: 'hit' }>> = {}
): Extract<AssemblyAnnotationSceneCacheIndexReadResult, { status: 'hit' }> {
  return {
    status: 'hit',
    ipcContractVersion: 'assembly-annotation-scene-ipc.v1',
    fingerprint: 'd'.repeat(24),
    sourceBuildFingerprint: 'build-current',
    scope: { kind: 'complete-assembly', placements: [] },
    artifact: { trackType: 'mRNA' },
    byteCount: 400_000_000,
    manifest: {
      integrity: { payloadSha256: PAYLOAD_SHA, contractSha256: CONTRACT_SHA },
      datasetContract: {
        datasetId: 'dataset',
        datasetVersion: 'v1',
        sourceSha256: 'e'.repeat(64),
      },
    },
    scenePath: '/workspace/scene.bin',
    payloadSha256: PAYLOAD_SHA,
    placementFingerprint: 'ap1:test',
    ...overrides,
  } as Extract<AssemblyAnnotationSceneCacheIndexReadResult, { status: 'hit' }>;
}

function projected(): PortablePreparedReferenceSceneAdmissionWorkerResultV1 {
  return {
    contract: 'portable-prepared-reference-scene-admission-worker.v1',
    projection: 'compiled-broad-interaction',
    sourceByteCount: 400_000_000,
    sourcePayloadSha256: PAYLOAD_SHA,
    byteCount: 128,
    payloadSha256: COMPACT_SHA,
    manifest: {
      sourceScene: {
        byteLength: 400_000_000,
        payloadSha256: PAYLOAD_SHA,
        contractSha256: CONTRACT_SHA,
      },
    },
    rangeCatalog: RANGE_CATALOG,
    validatedPayload: new Uint8Array(128),
  } as PortablePreparedReferenceSceneAdmissionWorkerResultV1;
}

function persistedCompact(): PortablePreparedReferenceSceneAdmissionWorkerResultV1 {
  const value = projected();
  if (!('manifest' in value)) throw new Error('compact fixture is invalid');
  return {
    contract: 'portable-prepared-reference-scene-admission-worker.v1',
    projection: 'persisted-compiled-broad-interaction',
    byteCount: value.byteCount,
    payloadSha256: value.payloadSha256,
    manifest: value.manifest,
    validatedPayload: value.validatedPayload,
  } as PortablePreparedReferenceSceneAdmissionWorkerResultV1;
}

function authority(input: {
  portable?: PortablePreparedReferenceCompiledBroadInteractionHitV1 | null;
  indexes?: AssemblyAnnotationSceneCacheIndexReadResult[];
  project?: ReturnType<typeof vi.fn>;
}) {
  const readPortable = vi.fn(async () => input.portable ?? null);
  const indexes = [...(input.indexes ?? [localIndex(), localIndex()])];
  const readLocalSceneIndex = vi.fn(async () => indexes.shift() ?? localIndex());
  const projectLocalScene = input.project ?? vi.fn(async () => projected());
  const resolveRealPath = vi.fn(async (path: string) => `/real${path}`);
  const persistLocalProjection = vi.fn(async () => true);
  return {
    value: new AssemblyCompiledBroadInteractionAuthorityV1({
      readPortable,
      readLocalSceneIndex,
      projectLocalScene,
      resolveRealPath,
      persistLocalProjection,
    }),
    readPortable,
    readLocalSceneIndex,
    projectLocalScene,
    resolveRealPath,
    persistLocalProjection,
  };
}

describe('AssemblyCompiledBroadInteractionAuthorityV1', () => {
  it('keeps an admitted portable hit authoritative without probing local state', async () => {
    const portable = { status: 'hit' } as PortablePreparedReferenceCompiledBroadInteractionHitV1;
    const fixture = authority({ portable });

    await expect(fixture.value.read(request)).resolves.toBe(portable);
    expect(fixture.readLocalSceneIndex).not.toHaveBeenCalled();
    expect(fixture.projectLocalScene).not.toHaveBeenCalled();
  });

  it('does not fall back to a local projection for a portable-bound request', async () => {
    const fixture = authority({ portable: null });

    await expect(fixture.value.read(request, 'portable-only')).resolves.toBeNull();
    expect(fixture.readPortable).toHaveBeenCalledOnce();
    expect(fixture.readLocalSceneIndex).not.toHaveBeenCalled();
    expect(fixture.projectLocalScene).not.toHaveBeenCalled();
  });

  it('does not probe portable state for a local-bound request', async () => {
    const fixture = authority({});

    await expect(fixture.value.read(request, 'local-only')).resolves.toMatchObject({
      status: 'hit',
    });
    expect(fixture.readPortable).not.toHaveBeenCalled();
    expect(fixture.readLocalSceneIndex).toHaveBeenCalled();
  });

  it('admits a persisted local compact artifact in the worker without opening the parent scene', async () => {
    const compact = persistedCompact();
    if (!('manifest' in compact)) throw new Error('compact fixture is invalid');
    const indexed = localIndex({
      compiledBroadInteraction: {
        payloadPath: '/workspace/compact.bin',
        byteCount: compact.byteCount,
        payloadSha256: compact.payloadSha256,
        manifest: compact.manifest,
      },
    });
    const project = vi.fn(async () => compact);
    const fixture = authority({ indexes: [indexed, indexed], project });

    await expect(fixture.value.read(request)).resolves.toMatchObject({
      status: 'hit',
      authorityKind: 'local',
      origin: 'durable-hit',
      byteCount: compact.byteCount,
      payloadSha256: compact.payloadSha256,
    });
    expect(project).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadPath: '/workspace/compact.bin',
        authorizedPayloadRealPath: '/real/workspace/compact.bin',
        projection: 'admit-persisted-compiled-broad-interaction',
      })
    );
    expect(project).not.toHaveBeenCalledWith(
      expect.objectContaining({ payloadPath: '/workspace/scene.bin' })
    );
  });

  it('projects an exact local scene in the worker and rechecks its revision before publication', async () => {
    const fixture = authority({});

    await expect(fixture.value.read(request)).resolves.toMatchObject({
      status: 'hit',
      authorityKind: 'local',
      origin: 'prepared-after-miss',
      fingerprint: 'd'.repeat(24),
      sourceScene: {
        byteCount: 400_000_000,
        payloadSha256: PAYLOAD_SHA,
        contractSha256: CONTRACT_SHA,
      },
      byteCount: 128,
      payloadSha256: COMPACT_SHA,
    });
    expect(fixture.projectLocalScene).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadPath: '/workspace/scene.bin',
        authorizedPayloadRealPath: '/real/workspace/scene.bin',
        projection: 'compiled-broad-interaction',
        expectedPayloadSha256: PAYLOAD_SHA,
        expectedProjectionContractSha256: CONTRACT_SHA,
      })
    );
    expect(fixture.readLocalSceneIndex).toHaveBeenCalledTimes(2);
    expect(fixture.persistLocalProjection).toHaveBeenCalledTimes(1);
  });

  it('reuses one immutable local projection across repeated renderer reads', async () => {
    const fixture = authority({
      indexes: [localIndex(), localIndex(), localIndex(), localIndex()],
    });

    await expect(fixture.value.read(request)).resolves.toMatchObject({ status: 'hit' });
    await expect(fixture.value.read(request)).resolves.toMatchObject({ status: 'hit' });
    expect(fixture.projectLocalScene).toHaveBeenCalledTimes(1);
  });

  it('rejects a completed projection when the source revision changed in flight', async () => {
    const fixture = authority({
      indexes: [localIndex(), localIndex({ fingerprint: 'f'.repeat(24) })],
    });

    await expect(fixture.value.read(request)).resolves.toBeNull();
  });
});
