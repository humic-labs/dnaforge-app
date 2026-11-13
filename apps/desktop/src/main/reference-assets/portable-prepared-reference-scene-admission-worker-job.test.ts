import type { validatePartitionedTranscriptSceneBinaryV4 } from '@waypoint/genome-renderer/pure';
import { describe, expect, it, vi } from 'vitest';

import {
  portablePreparedReferenceSceneAdmissionWorkerContractV1,
  runPortablePreparedReferenceSceneAdmissionWorkerJobV1,
} from './portable-prepared-reference-scene-admission-worker-job';

const PAYLOAD_PATH = '/authorized/interaction-scene.bin';
const PAYLOAD_SHA256 = 'a'.repeat(64);
const PAYLOAD = new Uint8Array([1, 2, 3, 4]);
const MANIFEST_FIELDS = {
  byteLength: PAYLOAD.byteLength,
  integrity: { payloadSha256: PAYLOAD_SHA256 },
};
const MANIFEST = MANIFEST_FIELDS as never;
const LOCAL_DATASET = {
  datasetId: 'installed-dataset',
  datasetVersion: 'v1',
  sourceSha256: 'd'.repeat(64),
};
const LOCAL_CONTRACT_SHA256 = 'e'.repeat(64);
const LOCAL_MANIFEST = {
  ...MANIFEST_FIELDS,
  datasetContract: LOCAL_DATASET,
  integrity: { payloadSha256: PAYLOAD_SHA256, contractSha256: LOCAL_CONTRACT_SHA256 },
} as never;
const RANGE_CATALOG = {
  schema: 'partitioned-transcript-scene-range-catalog.v1',
  sourceScene: {
    schema: 'partitioned-transcript-scene-binary.v4',
    byteLength: PAYLOAD.byteLength,
    payloadSha256: PAYLOAD_SHA256,
    contractSha256: LOCAL_CONTRACT_SHA256,
  },
} as never;
const VALIDATION_WORK: Awaited<ReturnType<typeof validatePartitionedTranscriptSceneBinaryV4>> = {
  interactionIndexValidationCount: 1,
  interactionFeatureScanCardinality: 0,
  couplingPrimitiveScanCardinality: 0,
  directFineIndexValidationCount: 2,
  directFineIndexRecordScanCardinality: 0,
};

describe('portable prepared-reference scene admission worker job', () => {
  it('returns the exact exhaustively validated payload for zero-copy transfer to main', async () => {
    const validateScene = vi.fn(async () => VALIDATION_WORK);
    const result = await runPortablePreparedReferenceSceneAdmissionWorkerJobV1(
      {
        contract: portablePreparedReferenceSceneAdmissionWorkerContractV1(),
        payloadPath: PAYLOAD_PATH,
        authorizedPayloadRealPath: PAYLOAD_PATH,
        manifest: MANIFEST,
        expectedPayloadSha256: PAYLOAD_SHA256,
      },
      {
        resolveRealPath: vi.fn(async () => PAYLOAD_PATH) as never,
        readPayload: vi.fn(async () => PAYLOAD),
        validateScene,
      }
    );

    expect(result).toEqual({
      contract: 'portable-prepared-reference-scene-admission-worker.v1',
      byteCount: PAYLOAD.byteLength,
      payloadSha256: PAYLOAD_SHA256,
      validatedPayload: PAYLOAD,
    });
    expect(validateScene).toHaveBeenCalledWith(MANIFEST, PAYLOAD, expect.any(Function));
  });

  it('projects only compact broad interaction bytes after authenticating the parent scene', async () => {
    const compactPayload = new Uint8Array([9, 8]);
    const compactSha256 = 'b'.repeat(64);
    const compactManifest = {
      schema: 'compiled-broad-annotation-interaction-binary.v1',
      byteLength: compactPayload.byteLength,
      integrity: { algorithm: 'sha256', payloadSha256: compactSha256 },
      sourceScene: {
        schema: 'partitioned-transcript-scene-binary.v4',
        byteLength: PAYLOAD.byteLength,
        payloadSha256: PAYLOAD_SHA256,
        contractSha256: 'c'.repeat(64),
      },
    };
    const validateScene = vi.fn(async () => undefined);
    const buildRangeCatalog = vi.fn(async () => RANGE_CATALOG);
    const projectCompiledBroadInteraction = vi.fn(async () => ({
      manifest: compactManifest,
      payload: compactPayload,
    }));

    const result = await runPortablePreparedReferenceSceneAdmissionWorkerJobV1(
      {
        contract: portablePreparedReferenceSceneAdmissionWorkerContractV1(),
        projection: 'compiled-broad-interaction',
        payloadPath: PAYLOAD_PATH,
        authorizedPayloadRealPath: PAYLOAD_PATH,
        manifest: MANIFEST,
        expectedPayloadSha256: PAYLOAD_SHA256,
        projectionDatasetContract: LOCAL_DATASET,
        expectedProjectionContractSha256: LOCAL_CONTRACT_SHA256,
      } as never,
      {
        resolveRealPath: vi.fn(async () => PAYLOAD_PATH) as never,
        readPayload: vi.fn(async () => PAYLOAD),
        validateScene,
        buildRangeCatalog,
        projectCompiledBroadInteraction,
        resealScene: vi.fn(async () => LOCAL_MANIFEST),
      } as never
    );

    expect(validateScene).toHaveBeenCalledWith(MANIFEST, PAYLOAD, expect.any(Function));
    expect(buildRangeCatalog).toHaveBeenCalledWith(LOCAL_MANIFEST, PAYLOAD, expect.any(Function));
    expect(projectCompiledBroadInteraction).toHaveBeenCalledWith(LOCAL_MANIFEST, PAYLOAD);
    expect(result).toEqual({
      contract: 'portable-prepared-reference-scene-admission-worker.v1',
      projection: 'compiled-broad-interaction',
      sourceByteCount: PAYLOAD.byteLength,
      sourcePayloadSha256: PAYLOAD_SHA256,
      byteCount: compactPayload.byteLength,
      payloadSha256: compactSha256,
      manifest: compactManifest,
      rangeCatalog: RANGE_CATALOG,
      validatedPayload: compactPayload,
    });
  });

  it('projects only an installed-parent range catalog for a legacy portable scene', async () => {
    const validateScene = vi.fn(async () => undefined);
    const buildRangeCatalog = vi.fn(async () => RANGE_CATALOG);

    const result = await runPortablePreparedReferenceSceneAdmissionWorkerJobV1(
      {
        contract: portablePreparedReferenceSceneAdmissionWorkerContractV1(),
        projection: 'range-catalog',
        payloadPath: PAYLOAD_PATH,
        authorizedPayloadRealPath: PAYLOAD_PATH,
        manifest: MANIFEST,
        expectedPayloadSha256: PAYLOAD_SHA256,
        projectionDatasetContract: LOCAL_DATASET,
        expectedProjectionContractSha256: LOCAL_CONTRACT_SHA256,
      } as never,
      {
        resolveRealPath: vi.fn(async () => PAYLOAD_PATH) as never,
        readPayload: vi.fn(async () => PAYLOAD),
        validateScene,
        buildRangeCatalog,
        resealScene: vi.fn(async () => LOCAL_MANIFEST),
      } as never
    );

    expect(validateScene).toHaveBeenCalledWith(MANIFEST, PAYLOAD, expect.any(Function));
    expect(buildRangeCatalog).toHaveBeenCalledWith(LOCAL_MANIFEST, PAYLOAD, expect.any(Function));
    expect(result).toEqual({
      contract: 'portable-prepared-reference-scene-admission-worker.v1',
      projection: 'range-catalog',
      sourceByteCount: PAYLOAD.byteLength,
      sourcePayloadSha256: PAYLOAD_SHA256,
      sourceContractSha256: LOCAL_CONTRACT_SHA256,
      rangeCatalog: RANGE_CATALOG,
    });
    expect(result).not.toHaveProperty('validatedPayload');
  });

  it('admits a persisted compact artifact without opening or validating its parent scene', async () => {
    const compactManifest = {
      byteLength: PAYLOAD.byteLength,
      integrity: { payloadSha256: PAYLOAD_SHA256 },
      sourceScene: {
        payloadSha256: 'b'.repeat(64),
        contractSha256: 'c'.repeat(64),
      },
    } as never;
    const validateCompiledBroadInteraction = vi.fn(async () => undefined);
    const validateScene = vi.fn();

    const result = await runPortablePreparedReferenceSceneAdmissionWorkerJobV1(
      {
        contract: portablePreparedReferenceSceneAdmissionWorkerContractV1(),
        projection: 'admit-persisted-compiled-broad-interaction',
        payloadPath: PAYLOAD_PATH,
        authorizedPayloadRealPath: PAYLOAD_PATH,
        manifest: compactManifest,
        expectedPayloadSha256: PAYLOAD_SHA256,
      },
      {
        resolveRealPath: vi.fn(async () => PAYLOAD_PATH) as never,
        readPayload: vi.fn(async () => PAYLOAD),
        validateScene,
        validateCompiledBroadInteraction,
      }
    );

    expect(validateCompiledBroadInteraction).toHaveBeenCalledWith(
      compactManifest,
      expect.any(Uint8Array),
      expect.any(Function)
    );
    expect(validateScene).not.toHaveBeenCalled();
    expect(result).toEqual({
      contract: 'portable-prepared-reference-scene-admission-worker.v1',
      projection: 'persisted-compiled-broad-interaction',
      byteCount: PAYLOAD.byteLength,
      payloadSha256: PAYLOAD_SHA256,
      manifest: compactManifest,
      validatedPayload: PAYLOAD,
    });
  });

  it('rechecks the main-authorized real path before reading any scene bytes', async () => {
    const readPayload = vi.fn();
    await expect(
      runPortablePreparedReferenceSceneAdmissionWorkerJobV1(
        {
          contract: portablePreparedReferenceSceneAdmissionWorkerContractV1(),
          payloadPath: PAYLOAD_PATH,
          authorizedPayloadRealPath: PAYLOAD_PATH,
          manifest: MANIFEST,
          expectedPayloadSha256: PAYLOAD_SHA256,
        },
        {
          resolveRealPath: vi.fn(async () => '/replaced/interaction-scene.bin') as never,
          readPayload,
        }
      )
    ).rejects.toThrow('changed payload path');
    expect(readPayload).not.toHaveBeenCalled();
  });

  it('rejects truncated scene bytes before invoking semantic validation', async () => {
    const validateScene = vi.fn();
    await expect(
      runPortablePreparedReferenceSceneAdmissionWorkerJobV1(
        {
          contract: portablePreparedReferenceSceneAdmissionWorkerContractV1(),
          payloadPath: PAYLOAD_PATH,
          authorizedPayloadRealPath: PAYLOAD_PATH,
          manifest: MANIFEST,
          expectedPayloadSha256: PAYLOAD_SHA256,
        },
        {
          resolveRealPath: vi.fn(async () => PAYLOAD_PATH) as never,
          readPayload: vi.fn(async () => PAYLOAD.subarray(0, 2)),
          validateScene,
        }
      )
    ).rejects.toThrow('truncated payload');
    expect(validateScene).not.toHaveBeenCalled();
  });
});
