import { useEffect, useRef, useState } from 'react';

import type { CompiledBroadAnnotationInteractionLoadInputV1 } from '@waypoint/genome-renderer';
import {
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  TRUSTED_MAIN_COMPILED_BROAD_ANNOTATION_INTERACTION_VALIDATION_V1,
  unpackTrustedMainValidatedCompiledBroadAnnotationInteractionBinaryV1,
} from '@waypoint/genome-renderer/pure';

import { platform } from '../../../platform';
import {
  ASSEMBLY_COMPILED_BROAD_INTERACTION_IPC_V1,
  assemblyAnnotationSceneGenomeIdentityV1,
  assemblyAnnotationSceneInteractionOwnerKeyV3,
  assemblyAnnotationSceneScopeMatchesChromosomes,
  type AssemblyCompiledBroadInteractionHitResultV1,
} from '../../../shared/indexed-genome';
import type { AssemblyPrepackedAnnotationSceneDescriptor } from '../assembly-annotation-product-descriptor';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import { readNullableAuthorityUntilPublishedV1 } from './awaitNullableAuthorityPublication';

const COMPACT_INTERACTION_PUBLICATION_DEADLINE_MS = 120_000;

export type AssemblyCompiledBroadInteractionReadiness =
  | 'not-applicable'
  | 'waiting-renderer'
  | 'loading'
  | 'loaded'
  | 'error';

export interface AssemblyCompiledBroadInteractionReceiptV1 {
  readonly status: AssemblyCompiledBroadInteractionReadiness;
  readonly ownerKey: string | null;
  readonly payloadBytes: number | null;
  readonly startedAt: number | null;
  readonly readCompletedAt: number | null;
  readonly preparedAt: number | null;
  readonly completedAt: number | null;
  readonly authorityKind: 'portable' | 'local' | null;
  readonly origin: 'durable-hit' | 'prepared-after-miss' | null;
  readonly error: unknown | null;
  readonly authority: CompiledBroadAnnotationInteractionLoadInputV1 | null;
}

const NOT_APPLICABLE_RECEIPT: AssemblyCompiledBroadInteractionReceiptV1 = Object.freeze({
  status: 'not-applicable',
  ownerKey: null,
  payloadBytes: null,
  startedAt: null,
  readCompletedAt: null,
  preparedAt: null,
  completedAt: null,
  authorityKind: null,
  origin: null,
  error: null,
  authority: null,
});

type CompactInteractionRenderer = {
  getAnnotationPolicyReadinessSnapshot?(): Readonly<{
    supported: boolean;
    genomeIdentity: string;
    genomeLengthBp: number;
  }>;
  loadCompiledBroadAnnotationInteraction(
    input: CompiledBroadAnnotationInteractionLoadInputV1
  ): CompiledBroadAnnotationInteractionLoadInputV1 | null;
};

type CompactInteractionPreparationV1 = Readonly<
  | { status: 'not-applicable'; identityKey: null }
  | { status: 'waiting-renderer'; identityKey: string }
  | { status: 'loading'; identityKey: string; startedAt: number }
  | {
      status: 'prepared';
      identityKey: string;
      startedAt: number;
      readCompletedAt: number;
      preparedAt: number;
      payloadBytes: number;
      authorityKind: 'portable' | 'local';
      origin: 'durable-hit' | 'prepared-after-miss';
      prepared: PreparedCompiledBroadInteractionV1;
    }
  | {
      status: 'error';
      identityKey: string;
      startedAt: number;
      completedAt: number;
      error: unknown;
    }
>;

const NOT_APPLICABLE_PREPARATION: CompactInteractionPreparationV1 = Object.freeze({
  status: 'not-applicable',
  identityKey: null,
});

function exactArtifactMatches(
  descriptor: AssemblyPrepackedAnnotationSceneDescriptor,
  result: AssemblyCompiledBroadInteractionHitResultV1
): boolean {
  return (Object.keys(descriptor.artifact) as Array<keyof typeof descriptor.artifact>).every(
    (key) => result.artifact[key] === descriptor.artifact[key]
  );
}

type PreparedCompiledBroadInteractionV1 = Readonly<{
  sourceOwnerKey: string;
  authorityKind: 'portable' | 'local';
  loadInput: Omit<CompiledBroadAnnotationInteractionLoadInputV1, 'ownerKey'>;
}>;

export function annotationInteractionOwnerMatchesRasterParentV3(input: {
  readonly expectedOwnerKey: string;
  readonly sourceOwnerKey: string;
}): boolean {
  return input.expectedOwnerKey === input.sourceOwnerKey;
}

function prepareCompiledBroadInteractionV1(input: {
  readonly descriptor: AssemblyPrepackedAnnotationSceneDescriptor;
  readonly result: AssemblyCompiledBroadInteractionHitResultV1;
}): PreparedCompiledBroadInteractionV1 {
  const { descriptor, result } = input;
  const request = descriptor.request;
  const assemblyLengthBp = request.chromosomes.reduce(
    (total, chromosome) => total + chromosome.length,
    0
  );
  const genomeIdentity = assemblyAnnotationSceneGenomeIdentityV1(request);
  const sourceOwnerKey = assemblyAnnotationSceneInteractionOwnerKeyV3({
    sourceFingerprint: result.fingerprint,
    scenePayloadSha256: result.sourceScene.payloadSha256,
    sceneArtifactKey: result.artifact.artifactKey,
  });
  const manifest = result.manifest;
  const scopeMatches =
    assemblyAnnotationSceneScopeMatchesChromosomes(result.scope, request.chromosomes) &&
    result.scope.kind === request.scope.kind &&
    !result.scope.placements.some((placement, index) => {
      const expected = request.scope.placements[index];
      return (
        placement.chrom !== expected?.chrom ||
        placement.length !== expected?.length ||
        placement.annotationCoverage !== expected?.annotationCoverage
      );
    });
  const mismatches = [
    result.contract === ASSEMBLY_COMPILED_BROAD_INTERACTION_IPC_V1 ? null : 'ipc-contract',
    genomeIdentity ? null : 'genome-identity',
    sourceOwnerKey ? null : 'source-owner',
    exactArtifactMatches(descriptor, result) ? null : 'artifact',
    scopeMatches ? null : 'assembly-scope',
    manifest.datasetContract.datasetId === descriptor.datasetContract.datasetId &&
    manifest.datasetContract.datasetVersion === descriptor.datasetContract.datasetVersion &&
    manifest.datasetContract.sourceSha256 === descriptor.datasetContract.sourceSha256
      ? null
      : 'dataset',
    manifest.assemblyContract.assemblyId === request.assemblyId &&
    manifest.assemblyContract.assemblyLengthBp === assemblyLengthBp
      ? null
      : 'assembly',
    manifest.sourceScene.byteLength === result.sourceScene.byteCount &&
    manifest.sourceScene.payloadSha256 === result.sourceScene.payloadSha256 &&
    manifest.sourceScene.contractSha256 === result.sourceScene.contractSha256
      ? null
      : 'source-scene',
    descriptor.artifact.laneAlgorithmToken === PREPACKED_ANNOTATION_LANE_TOKEN &&
    descriptor.artifact.mapperContractToken === PREPACKED_ANNOTATION_MAPPER_TOKEN &&
    descriptor.artifact.geometryContractToken === PREPACKED_ANNOTATION_GEOMETRY_TOKEN &&
    descriptor.artifact.interactionContractToken === PREPACKED_ANNOTATION_INTERACTION_TOKEN
      ? null
      : 'renderer-contract-tokens',
  ].filter((reason): reason is string => reason !== null);
  if (mismatches.length > 0 || !sourceOwnerKey || !genomeIdentity) {
    throw new Error(
      `The compact annotation interaction authority is invalid (${mismatches.join(', ')}).`
    );
  }
  const unpacked = unpackTrustedMainValidatedCompiledBroadAnnotationInteractionBinaryV1(
    manifest,
    result.payload,
    TRUSTED_MAIN_COMPILED_BROAD_ANNOTATION_INTERACTION_VALIDATION_V1
  );
  return Object.freeze({
    sourceOwnerKey,
    authorityKind: result.authorityKind,
    loadInput: {
      validationMarker: TRUSTED_MAIN_COMPILED_BROAD_ANNOTATION_INTERACTION_VALIDATION_V1,
      sourceFingerprint: result.fingerprint,
      interactionPayloadSha256: manifest.integrity.payloadSha256,
      sourceScene: result.sourceScene,
      metadata: {
        genomeIdentity,
        genomeLengthBp: assemblyLengthBp,
        partitionSpanBp: descriptor.artifact.partitionSpanBp,
        artifactKey: descriptor.artifact.artifactKey,
        themeMode: descriptor.artifact.themeMode,
        trackType: descriptor.artifact.trackType,
        annotationBarHeightPx: descriptor.artifact.annotationBarHeightPx,
        laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
        mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
        geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
        interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
      },
      policyProjection: unpacked.policyProjection,
      featureLookup: unpacked.featureLookup,
    },
  });
}

function bindCompiledBroadInteractionToRasterParentV3(
  prepared: PreparedCompiledBroadInteractionV1,
  expectedInteractionOwnerKey: string
): CompiledBroadAnnotationInteractionLoadInputV1 {
  if (
    !annotationInteractionOwnerMatchesRasterParentV3({
      expectedOwnerKey: expectedInteractionOwnerKey,
      sourceOwnerKey: prepared.sourceOwnerKey,
    })
  ) {
    throw new Error(
      'The compact annotation interaction does not belong to the currently presented raster owner (raster-parent-owner).'
    );
  }
  return { ...prepared.loadInput, ownerKey: expectedInteractionOwnerKey };
}

export function compiledBroadInteractionLoadInputV1(input: {
  readonly descriptor: AssemblyPrepackedAnnotationSceneDescriptor;
  readonly expectedInteractionOwnerKey: string;
  readonly result: AssemblyCompiledBroadInteractionHitResultV1;
}): CompiledBroadAnnotationInteractionLoadInputV1 {
  return bindCompiledBroadInteractionToRasterParentV3(
    prepareCompiledBroadInteractionV1({ descriptor: input.descriptor, result: input.result }),
    input.expectedInteractionOwnerKey
  );
}

export function useAssemblyCompiledBroadInteraction(input: {
  readonly enabled: boolean;
  readonly publicationReady: boolean;
  readonly descriptor: AssemblyPrepackedAnnotationSceneDescriptor | null;
  readonly expectedInteractionOwnerKey: string | null;
  readonly rendererReadyEpoch: number;
  readonly rendererGenomeCommitEpoch: number;
  readonly webglRef: {
    readonly current:
      | (Pick<IndexedGenomeTileNativeMapHandle, 'getLinearRenderer'> &
          Partial<Pick<IndexedGenomeTileNativeMapHandle, 'requestRender'>>)
      | null;
  };
}): AssemblyCompiledBroadInteractionReceiptV1 {
  const [preparation, setPreparation] = useState<CompactInteractionPreparationV1>(
    NOT_APPLICABLE_PREPARATION
  );
  const [receipt, setReceipt] =
    useState<AssemblyCompiledBroadInteractionReceiptV1>(NOT_APPLICABLE_RECEIPT);
  const publicationReadyRef = useRef(input.publicationReady);
  publicationReadyRef.current = input.publicationReady;
  const descriptor = input.descriptor;
  const liveDescriptorKey = descriptor?.sceneKey ?? descriptor?.runtimeCacheKey ?? null;
  const stableDescriptorRef = useRef({ key: liveDescriptorKey, value: descriptor });
  if (!input.enabled) {
    stableDescriptorRef.current = { key: null, value: null };
  } else if (liveDescriptorKey !== null && stableDescriptorRef.current.key !== liveDescriptorKey) {
    stableDescriptorRef.current = { key: liveDescriptorKey, value: descriptor };
  }
  const stableDescriptor = stableDescriptorRef.current.value;
  const stableDescriptorKey = stableDescriptorRef.current.key;
  const expectedInteractionOwnerKey = input.expectedInteractionOwnerKey;
  const preparationIdentityKey = input.enabled ? stableDescriptorKey : null;
  const preparationRenderer = input.webglRef.current?.getLinearRenderer?.() as
    | CompactInteractionRenderer
    | null
    | undefined;
  const retainsImmutablePreparation =
    preparation.identityKey === preparationIdentityKey &&
    (preparation.status === 'loading' ||
      preparation.status === 'prepared' ||
      preparation.status === 'error');
  const activePreparationIdentityKey =
    preparationIdentityKey && (preparationRenderer || retainsImmutablePreparation)
      ? preparationIdentityKey
      : null;

  useEffect(() => {
    if (!preparationIdentityKey || !stableDescriptor) {
      setPreparation(NOT_APPLICABLE_PREPARATION);
      return;
    }
    if (!activePreparationIdentityKey) {
      setPreparation({
        status: 'waiting-renderer',
        identityKey: preparationIdentityKey,
      });
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const startedAt = performance.now();
    setPreparation({
      status: 'loading',
      identityKey: preparationIdentityKey,
      startedAt,
    });
    void readNullableAuthorityUntilPublishedV1({
      authorityLabel: 'The compact annotation interaction',
      signal: controller.signal,
      deadlineReady: () => publicationReadyRef.current,
      deadlineMs: COMPACT_INTERACTION_PUBLICATION_DEADLINE_MS,
      read: (signal) =>
        platform().genome.readAssemblyCompiledBroadInteractionV1(stableDescriptor.request, {
          signal,
        }),
    })
      .then((result) => {
        if (cancelled) return;
        const readCompletedAt = performance.now();
        const prepared = prepareCompiledBroadInteractionV1({
          descriptor: stableDescriptor,
          result,
        });
        const preparedAt = performance.now();
        setPreparation({
          status: 'prepared',
          identityKey: preparationIdentityKey,
          startedAt,
          readCompletedAt,
          preparedAt,
          payloadBytes: result.payload.byteLength,
          authorityKind: result.authorityKind,
          origin: result.origin,
          prepared,
        });
      })
      .catch((error: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setPreparation({
          status: 'error',
          identityKey: preparationIdentityKey,
          startedAt,
          completedAt: performance.now(),
          error,
        });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activePreparationIdentityKey, preparationIdentityKey, stableDescriptor]);

  useEffect(() => {
    if (!preparationIdentityKey) {
      setReceipt(NOT_APPLICABLE_RECEIPT);
      return;
    }
    if (preparation.identityKey !== preparationIdentityKey) {
      setReceipt({
        status: 'loading',
        ownerKey: expectedInteractionOwnerKey,
        payloadBytes: null,
        startedAt: null,
        readCompletedAt: null,
        preparedAt: null,
        completedAt: null,
        authorityKind: null,
        origin: null,
        error: null,
        authority: null,
      });
      return;
    }
    if (preparation.status === 'waiting-renderer') {
      setReceipt({
        status: 'waiting-renderer',
        ownerKey: expectedInteractionOwnerKey,
        payloadBytes: null,
        startedAt: null,
        readCompletedAt: null,
        preparedAt: null,
        completedAt: null,
        authorityKind: null,
        origin: null,
        error: null,
        authority: null,
      });
      return;
    }
    if (preparation.status === 'loading') {
      setReceipt({
        status: 'loading',
        ownerKey: expectedInteractionOwnerKey,
        payloadBytes: null,
        startedAt: preparation.startedAt,
        readCompletedAt: null,
        preparedAt: null,
        completedAt: null,
        authorityKind: null,
        origin: null,
        error: null,
        authority: null,
      });
      return;
    }
    if (preparation.status === 'error') {
      setReceipt({
        status: 'error',
        ownerKey: expectedInteractionOwnerKey,
        payloadBytes: null,
        startedAt: preparation.startedAt,
        readCompletedAt: null,
        preparedAt: null,
        completedAt: preparation.completedAt,
        authorityKind: null,
        origin: null,
        error: preparation.error,
        authority: null,
      });
      return;
    }
    if (preparation.status !== 'prepared') return;
    const admissionOwnerKey = expectedInteractionOwnerKey ?? preparation.prepared.sourceOwnerKey;
    const renderer = input.webglRef.current?.getLinearRenderer?.() as
      | CompactInteractionRenderer
      | null
      | undefined;
    const committedGenome = renderer?.getAnnotationPolicyReadinessSnapshot?.();
    const preparedMetadata = preparation.prepared.loadInput.metadata;
    const rendererGenomeMatches =
      committedGenome === undefined ||
      (committedGenome.supported &&
        committedGenome.genomeIdentity === preparedMetadata.genomeIdentity &&
        committedGenome.genomeLengthBp === preparedMetadata.genomeLengthBp);
    if (!renderer || !rendererGenomeMatches) {
      try {
        const loadInput = bindCompiledBroadInteractionToRasterParentV3(
          preparation.prepared,
          admissionOwnerKey
        );
        setReceipt({
          status: 'waiting-renderer',
          ownerKey: admissionOwnerKey,
          payloadBytes: preparation.payloadBytes,
          startedAt: preparation.startedAt,
          readCompletedAt: preparation.readCompletedAt,
          preparedAt: preparation.preparedAt,
          completedAt: null,
          authorityKind: preparation.authorityKind,
          origin: preparation.origin,
          error: null,
          authority: renderer ? null : loadInput,
        });
      } catch (error) {
        setReceipt({
          status: 'error',
          ownerKey: admissionOwnerKey,
          payloadBytes: null,
          startedAt: preparation.startedAt,
          readCompletedAt: preparation.readCompletedAt,
          preparedAt: preparation.preparedAt,
          completedAt: performance.now(),
          authorityKind: preparation.authorityKind,
          origin: preparation.origin,
          error,
          authority: null,
        });
      }
      return;
    }
    try {
      const loadInput = bindCompiledBroadInteractionToRasterParentV3(
        preparation.prepared,
        admissionOwnerKey
      );
      const rendererSource = renderer.getAnnotationPolicyReadinessSnapshot?.();
      if (
        rendererSource &&
        (!rendererSource.supported ||
          rendererSource.genomeIdentity !== loadInput.metadata.genomeIdentity ||
          rendererSource.genomeLengthBp !== loadInput.metadata.genomeLengthBp)
      ) {
        setReceipt({
          status: 'waiting-renderer',
          ownerKey: admissionOwnerKey,
          payloadBytes: preparation.payloadBytes,
          startedAt: preparation.startedAt,
          readCompletedAt: preparation.readCompletedAt,
          preparedAt: preparation.preparedAt,
          completedAt: null,
          authorityKind: preparation.authorityKind,
          origin: preparation.origin,
          error: null,
          authority: null,
        });
        return;
      }
      const admittedAuthority = renderer.loadCompiledBroadAnnotationInteraction(loadInput);
      if (!admittedAuthority) {
        throw new Error('The renderer rejected the compact annotation interaction authority.');
      }
      setReceipt({
        status: 'loaded',
        ownerKey: admissionOwnerKey,
        payloadBytes: preparation.payloadBytes,
        startedAt: preparation.startedAt,
        readCompletedAt: preparation.readCompletedAt,
        preparedAt: preparation.preparedAt,
        completedAt: performance.now(),
        authorityKind: preparation.authorityKind,
        origin: preparation.origin,
        error: null,
        authority: admittedAuthority,
      });
    } catch (error) {
      setReceipt({
        status: 'error',
        ownerKey: admissionOwnerKey,
        payloadBytes: null,
        startedAt: preparation.startedAt,
        readCompletedAt: preparation.readCompletedAt,
        preparedAt: preparation.preparedAt,
        completedAt: performance.now(),
        authorityKind: preparation.authorityKind,
        origin: preparation.origin,
        error,
        authority: null,
      });
    }
  }, [
    expectedInteractionOwnerKey,
    input.rendererGenomeCommitEpoch,
    input.rendererReadyEpoch,
    input.webglRef,
    preparation,
    preparationIdentityKey,
  ]);

  return receipt;
}
