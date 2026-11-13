import {
  validatePrepackedAnnotationInteractionVisualCouplingV2,
  type PrepackedAnnotationFeatureLookupIndexV2,
} from '../overview/prepacked-annotation-interaction-index-v2';
import {
  prepackedSceneCoversRequestedLayers,
  validatePrepackedAnnotationRuntimePolicy,
  validatePrepackedAnnotationSceneMetadata,
  type PrepackedAnnotationSceneLoadInput,
  type PrepackedAnnotationSceneMetadata,
  type PrepackedAnnotationSceneStatus,
} from '../overview/prepacked-annotation-scene';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import { buildPartitionedTranscriptScene } from '../overview/partitioned-transcript-scene';
import {
  PartitionedInstancedTranscriptLayer,
  type PartitionedInstancedTranscriptLayerOptions,
  type PartitionedTranscriptGpuPreparationRenderer,
} from '../overview/partitioned-instanced-transcript-layer';
import {
  isTrustedPartitionedTranscriptRendererAdmissionV4,
  type TrustedPartitionedTranscriptRendererAdmissionBindingV4,
} from '../overview/partitioned-transcript-scene-binary-v4';
import {
  isTrustedPartitionedTranscriptSceneDetailInteractionAdmissionV1,
  isTrustedPartitionedTranscriptSceneDetailPacketAdmissionV1,
  type TrustedPartitionedTranscriptSceneDetailInteractionBindingV1,
  type TrustedPartitionedTranscriptSceneDetailPacketAdmissionBindingV1,
} from '../overview/partitioned-transcript-scene-detail-packet-v1';
import {
  prepackedAnnotationSceneBankCompatible,
  prepackedAnnotationSceneMetadataEqual,
  trustedV4OuterProvenanceMatches,
} from './annotation-prepacked-metadata';
import {
  firstPrepackedMaterializeRejectReason,
  inspectPrepackedMaterializeAdmission,
  isValidPrepackedPolicyContract,
  secondPrepackedMaterializeRejectReason,
  type PrepackedMaterializeAdmissionFlags,
} from './indexed-prepacked-admission';
import {
  prepackedLayerConstructionRoute,
  shouldRejectIncompatibleActiveOwner,
} from './indexed-prepacked-layer-route';
import {
  findReusablePrepackedSamePacketResident,
  isIdempotentPrepackedSceneLoad,
} from './indexed-prepacked-reuse';
import {
  inspectPrepackedViewportDetailPacket,
  type PrepackedViewportDetailCompiledInteractionView,
} from './indexed-prepacked-viewport-detail';

export type PrepackedMaterializeLayerBuild = {
  layer: PartitionedInstancedTranscriptLayer;
  trustedV4Admission: boolean;
};

export type PrepackedMaterializeCompiledOwner = {
  readonly provenance: {
    readonly prepackedOwnerKey: string;
    readonly prepackedArtifactKey: string;
  };
} | null;

export type PrepackedMaterializeCompiledInteraction =
  PrepackedViewportDetailCompiledInteractionView & {
    readonly featureLookup: PrepackedAnnotationFeatureLookupIndexV2;
  };

export type PrepackedMaterializeResident = {
  ownerKey: string;
  lastUsed: number;
  policyGeneration: number;
  viewportDetailPresentationAdmitted: boolean;
  visiblePartitionCount: number;
  visibleInstanceCount: number;
  metadata: PrepackedAnnotationSceneMetadata;
  input: PrepackedAnnotationSceneLoadInput;
  sourceInput: PrepackedAnnotationSceneLoadInput;
  layer: PartitionedInstancedTranscriptLayer;
  policyTrackLaneMaxima: ReturnType<
    PartitionedInstancedTranscriptLayer['getAnnotationPolicyTrackLaneMaxima']
  >;
};

export type PrepackedMaterializeHost<
  TResident extends PrepackedMaterializeResident = PrepackedMaterializeResident,
> = {
  readonly requestedLayerTypes: readonly string[];
  readonly scaledBarHeightPx: number;
  readonly currentGenomeIdentity: string;
  readonly genomeLength: number;
  readonly isWebgl: boolean;
  readonly policyGeneration: number;
  readonly runtimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  readonly gpuRenderer: PartitionedTranscriptGpuPreparationRenderer | null;
  readonly hasActiveOwner: boolean;
  readonly hasActiveLayer: boolean;
  readonly lastCompleteOwnerKeys: readonly string[];
  readonly activeLayer: PartitionedInstancedTranscriptLayer | null;
  readonly activeOwnerKey: string | null;
  readonly activeOwnerMetadata: Pick<PrepackedAnnotationSceneMetadata, 'trackType'> | null;
  readonly residents: Iterable<TResident>;
  readonly replacementCandidates: Iterable<TResident>;
  getResident(ownerKey: string): TResident | undefined;
  getReplacementCandidate(ownerKey: string): TResident | undefined;
  compiledInteractionForOwner(ownerKey: string): PrepackedMaterializeCompiledInteraction | null;
  compiledOwnerForTrack(trackType: string): PrepackedMaterializeCompiledOwner;
  setStatus(status: PrepackedAnnotationSceneStatus): void;
  disposeScene(status: PrepackedAnnotationSceneStatus): void;
  destroyResident(
    ownerKey: string,
    status: PrepackedAnnotationSceneStatus,
    recordOwnerChange?: boolean
  ): void;
  noteInteractionCouplingValidation(primitiveCount: number): void;
  noteTrustedV4Admission(): void;
  bumpResidentClock(): number;
  bumpResidentGeneration(): void;
  bumpOwnerGeneration(): void;
  clearIdentityCaches(): void;
  invalidateLastCompleteIfContains(ownerKey: string): void;
  retargetActiveOwnerFromResident(resident: TResident): void;
  retractStaleActiveOwner(): void;
  setRuntimePolicyIfEmpty(policy: AnnotationPolicyGpuRuntimeV1): void;
  setGpuPrepareFailedStatus(): void;
  putReplacementCandidate(resident: TResident): void;
  putResident(resident: TResident): void;
  disposeLayer(layer: PartitionedInstancedTranscriptLayer, wasLastComplete: boolean): void;
  installLayer(layer: PartitionedInstancedTranscriptLayer): void;
  primeInactiveResident(resident: TResident): void;
  evictResidentsToLimit(): void;
  reconcileLaneEnvelope(): void;
};

export function constructPrepackedMaterializeLayer(input: {
  load: PrepackedAnnotationSceneLoadInput;
  partitioned: NonNullable<PrepackedAnnotationSceneLoadInput['gpuReadyScene']>;
  trustedV4Admission: boolean;
  trustedV4Binding: TrustedPartitionedTranscriptRendererAdmissionBindingV4 | null;
  trustedDetailPacketAdmission: boolean;
  trustedDetailPacketBinding: TrustedPartitionedTranscriptSceneDetailPacketAdmissionBindingV1 | null;
}): PrepackedMaterializeLayerBuild {
  const layerOptions: PartitionedInstancedTranscriptLayerOptions = {
    rendererKind: 'webgl',
    trackType: input.load.metadata.trackType,
    artifactGeneration: input.load.viewportDetail
      ? `${input.load.ownerKey}:${input.load.viewportDetail.packetPayloadSha256}`
      : input.load.ownerKey,
    ...(input.load.policyGpuInstanceData
      ? {
          policyGpuInstanceData: input.load.policyGpuInstanceData,
        }
      : {}),
    ...(input.load.submissionBank ? { submissionBank: input.load.submissionBank } : {}),
    ...(input.load.submissionFineIndices
      ? { submissionFineIndices: input.load.submissionFineIndices }
      : {}),
  };
  const constructionRoute = prepackedLayerConstructionRoute({
    trustedV4Admission: input.trustedV4Admission,
    trustedDetailPacketAdmission: input.trustedDetailPacketAdmission,
  });
  const trustedBank =
    constructionRoute === 'v4'
      ? input.trustedV4Binding?.submissionBank
      : constructionRoute === 'detail-packet'
        ? input.trustedDetailPacketBinding?.submissionBank
        : undefined;
  if (input.load.colorRoles && trustedBank && input.load.submissionBank === trustedBank) {
    layerOptions.colorRoles = input.load.colorRoles;
  }
  const layer =
    constructionRoute === 'v4'
      ? PartitionedInstancedTranscriptLayer.fromValidatedV4(
          input.trustedV4Binding!,
          layerOptions,
          input.load.trustedRendererAdmissionV4!
        )
      : constructionRoute === 'detail-packet'
        ? PartitionedInstancedTranscriptLayer.fromValidatedDetailPacket(
            input.trustedDetailPacketBinding!,
            layerOptions,
            input.load.trustedViewportDetailPacketAdmissionV1!
          )
        : new PartitionedInstancedTranscriptLayer(input.partitioned, layerOptions);
  return { layer, trustedV4Admission: input.trustedV4Admission };
}

export function preparePrepackedMaterializeLayerGpu(input: {
  layer: PartitionedInstancedTranscriptLayer;
  runtimePolicy: PrepackedAnnotationSceneLoadInput['runtimePolicy'];
  deferGpuPreparation: boolean;
  renderer: PartitionedTranscriptGpuPreparationRenderer | null;
}): void {
  if (input.runtimePolicy) input.layer.updateAnnotationPolicy(input.runtimePolicy);
  if (!input.deferGpuPreparation && input.renderer) {
    input.layer.prepareGpuResources(input.renderer);
  }
}

type AdmittedPrepackedPartition = {
  partitioned:
    | ReturnType<typeof buildPartitionedTranscriptScene>
    | NonNullable<PrepackedAnnotationSceneLoadInput['gpuReadyScene']>;
  trustedV4Admission: boolean;
  trustedV4Binding: TrustedPartitionedTranscriptRendererAdmissionBindingV4 | null;
  trustedDetailPacketAdmission: boolean;
  trustedDetailPacketBinding: TrustedPartitionedTranscriptSceneDetailPacketAdmissionBindingV1 | null;
};

function admitPrepackedPartitionedScene(args: {
  input: PrepackedAnnotationSceneLoadInput;
  viewportDetail: PrepackedAnnotationSceneLoadInput['viewportDetail'];
  compiledInteraction: PrepackedMaterializeCompiledInteraction | null;
  noteInteractionCouplingValidation: (primitiveCount: number) => void;
}): AdmittedPrepackedPartition {
  const partitioned =
    args.input.gpuReadyScene ??
    buildPartitionedTranscriptScene(
      args.input.scene.primitives,
      args.input.metadata.partitionSpanBp
    );
  if (args.input.trustedRendererAdmissionV4 !== undefined) {
    if (
      args.input.scene.primitives.length !== 0 ||
      args.input.trustedRendererAdmissionProvenanceV4 === undefined ||
      !trustedV4OuterProvenanceMatches(args.input)
    ) {
      throw new Error('prepacked annotation trusted-v4 provenance mismatch');
    }
    const candidateBinding: TrustedPartitionedTranscriptRendererAdmissionBindingV4 = {
      provenance: args.input.trustedRendererAdmissionProvenanceV4,
      loadIdentity: args.input.trustedRendererAdmissionLoadIdentityV4!,
      scene: partitioned,
      families: args.input.scene.families,
      featureFamilyIndices: args.input.scene.featureFamilyIndices,
      interactionIndex: args.input.interactionIndex,
      policyProjection: args.input.policyProjection!,
      submissionBank: args.input.submissionBank!,
      submissionFineIndices: args.input.submissionFineIndices!,
    };
    const trustedV4Admission = isTrustedPartitionedTranscriptRendererAdmissionV4(
      args.input.trustedRendererAdmissionV4,
      candidateBinding
    );
    if (!trustedV4Admission) {
      throw new Error('prepacked annotation trusted-v4 admission capability mismatch');
    }
    return {
      partitioned,
      trustedV4Admission: true,
      trustedV4Binding: candidateBinding,
      trustedDetailPacketAdmission: false,
      trustedDetailPacketBinding: null,
    };
  }
  if (args.viewportDetail && args.compiledInteraction) {
    if (!args.input.submissionBank || !args.input.submissionFineIndices) {
      throw new Error('prepacked annotation viewport detail direct banks are missing');
    }
    const trustedDetailPacketBinding: TrustedPartitionedTranscriptSceneDetailPacketAdmissionBindingV1 =
      {
        scene: partitioned,
        submissionBank: args.input.submissionBank,
        submissionFineIndices: args.input.submissionFineIndices,
        featureFamilyIndices: args.input.scene.featureFamilyIndices,
      };
    const trustedDetailPacketAdmission = isTrustedPartitionedTranscriptSceneDetailPacketAdmissionV1(
      args.input.trustedViewportDetailPacketAdmissionV1,
      trustedDetailPacketBinding
    );
    if (!trustedDetailPacketAdmission) {
      throw new Error('prepacked annotation trusted-detail capability mismatch');
    }
    const candidateInteractionBinding: TrustedPartitionedTranscriptSceneDetailInteractionBindingV1 =
      {
        sourceScene: args.viewportDetail.sourceScene,
        scene: partitioned,
        parentFeatureLookup: args.compiledInteraction.featureLookup,
        interactionIndex: args.input.interactionIndex,
      };
    if (
      !isTrustedPartitionedTranscriptSceneDetailInteractionAdmissionV1(
        args.input.trustedViewportDetailInteractionAdmissionV1,
        candidateInteractionBinding
      )
    ) {
      throw new Error('prepacked annotation trusted-detail interaction mismatch');
    }
    return {
      partitioned,
      trustedV4Admission: false,
      trustedV4Binding: null,
      trustedDetailPacketAdmission: true,
      trustedDetailPacketBinding,
    };
  }
  args.noteInteractionCouplingValidation(args.input.interactionIndex.primitiveCount);
  validatePrepackedAnnotationInteractionVisualCouplingV2(
    args.input.interactionIndex,
    partitioned,
    args.input.metadata.genomeLengthBp
  );
  return {
    partitioned,
    trustedV4Admission: false,
    trustedV4Binding: null,
    trustedDetailPacketAdmission: false,
    trustedDetailPacketBinding: null,
  };
}

function shouldRetractStalePrepackedActiveOwner(args: {
  compiledOwnerKey: string | undefined;
  compiledArtifactKey: string | undefined;
  entryOwnerKey: string;
  entryArtifactKey: string;
  activeOwnerKey: string | null;
  activeTrackType: string | undefined;
  entryTrackType: string;
}): boolean {
  return (
    args.compiledOwnerKey === args.entryOwnerKey &&
    args.compiledArtifactKey === args.entryArtifactKey &&
    args.activeOwnerKey !== null &&
    args.activeOwnerKey !== args.entryOwnerKey &&
    args.activeTrackType === args.entryTrackType
  );
}

function handlePrepackedGpuPrepareFailure<TResident extends PrepackedMaterializeResident>(args: {
  error: unknown;
  viewportDetail: PrepackedAnnotationSceneLoadInput['viewportDetail'];
  ownerKey: string;
  layer: PartitionedInstancedTranscriptLayer | null;
  replacedActiveOwner: boolean;
  host: PrepackedMaterializeHost<TResident>;
}): false {
  if (args.viewportDetail && typeof console !== 'undefined') {
    console.error('[annotation-viewport-detail] GPU preparation rejected', {
      error:
        args.error instanceof Error
          ? `${args.error.name}: ${args.error.message}`
          : String(args.error),
      stack: args.error instanceof Error ? (args.error.stack ?? null) : null,
      ownerKey: args.ownerKey,
    });
  }
  args.layer?.destroy();
  if (!args.replacedActiveOwner) args.host.setGpuPrepareFailedStatus();
  return false;
}

function handlePrepackedVisualCouplingFailure<
  TResident extends PrepackedMaterializeResident,
>(args: {
  error: unknown;
  viewportDetail: PrepackedAnnotationSceneLoadInput['viewportDetail'];
  input: PrepackedAnnotationSceneLoadInput;
  host: PrepackedMaterializeHost<TResident>;
  preserveActiveOwner: boolean;
  resident: TResident | undefined;
}): false {
  if (args.viewportDetail && typeof console !== 'undefined') {
    console.error(
      '[annotation-viewport-detail] visual coupling rejected ' +
        JSON.stringify({
          error:
            args.error instanceof Error
              ? `${args.error.name}: ${args.error.message}`
              : String(args.error),
          ownerKey: args.input.ownerKey,
          interactionPrimitiveCount: args.input.interactionIndex.primitiveCount,
          detailInstanceCount: args.input.gpuReadyScene?.featureIndices.length ?? null,
        })
    );
  }
  if (args.host.getResident(args.input.ownerKey)) {
    if (args.preserveActiveOwner && args.resident) {
      return false;
    }
    args.host.destroyResident(args.input.ownerKey, 'variant-mismatch');
  } else if (!args.host.hasActiveLayer) {
    args.host.disposeScene('variant-mismatch');
  }
  return false;
}

function collectPrepackedMaterializeAdmissionFlags<
  TResident extends PrepackedMaterializeResident,
>(args: {
  host: PrepackedMaterializeHost<TResident>;
  input: PrepackedAnnotationSceneLoadInput;
  residentLayerTypes: readonly string[];
  viewportDetailValid: boolean;
}): PrepackedMaterializeAdmissionFlags {
  const { host, input, residentLayerTypes, viewportDetailValid } = args;
  const hasPolicyProjection = input.policyProjection !== undefined;
  const hasPolicyGpuData = input.policyGpuInstanceData !== undefined;
  const hasRuntimePolicy = input.runtimePolicy !== undefined;
  const hasSubmissionBank = input.submissionBank !== undefined;
  const hasSubmissionFineIndices = input.submissionFineIndices !== undefined;
  const hasTrustedV4Capability = input.trustedRendererAdmissionV4 !== undefined;
  const hasTrustedV4Provenance = input.trustedRendererAdmissionProvenanceV4 !== undefined;
  const hasTrustedV4LoadIdentity = input.trustedRendererAdmissionLoadIdentityV4 !== undefined;
  return {
    requestedLayersCovered:
      prepackedSceneCoversRequestedLayers(
        residentLayerTypes,
        input.scene,
        input.gpuReadyScene?.featureIndices.length ?? 0
      ) ||
      Boolean(args.input.viewportDetail?.empty && input.gpuReadyScene?.featureIndices.length === 0),
    ownerKeyValid: typeof input.ownerKey === 'string' && input.ownerKey.trim().length > 0,
    metadataValid: validatePrepackedAnnotationSceneMetadata(input.metadata),
    trackMatches: input.metadata.trackType === residentLayerTypes[0],
    barHeightMatches: input.metadata.annotationBarHeightPx === host.scaledBarHeightPx,
    interactionIndexPresent: input.interactionIndex != null,
    viewportDetailValid,
    trustedAdmissionCoherent:
      hasTrustedV4Capability === hasTrustedV4Provenance &&
      hasTrustedV4Capability === hasTrustedV4LoadIdentity,
    hasValidPolicyContract: isValidPrepackedPolicyContract({
      hasPolicyProjection,
      hasPolicyGpuData,
      hasRuntimePolicy,
      hasSubmissionBank,
      hasSubmissionFineIndices,
    }),
    runtimePolicyValid:
      !hasRuntimePolicy || validatePrepackedAnnotationRuntimePolicy(input.runtimePolicy),
    policyFeatureCountMatches:
      !hasPolicyProjection ||
      input.policyProjection!.featureCount === input.interactionIndex?.featureCount,
    partitionSpanMatches:
      input.gpuReadyScene == null ||
      input.gpuReadyScene.partitionSpanBp === input.metadata.partitionSpanBp,
  };
}

function destroyCollidingPrepackedResident<TResident extends PrepackedMaterializeResident>(
  host: PrepackedMaterializeHost<TResident>,
  input: PrepackedAnnotationSceneLoadInput,
  resident: TResident | null | undefined,
  preserveActiveOwner: boolean
): boolean {
  if (!resident || prepackedAnnotationSceneMetadataEqual(resident.metadata, input.metadata)) {
    return false;
  }
  if (preserveActiveOwner && resident.layer === host.activeLayer) return true;
  host.destroyResident(input.ownerKey, 'variant-mismatch');
  return true;
}

function retainResidentWithoutViewportPacket<TResident extends PrepackedMaterializeResident>(
  host: PrepackedMaterializeHost<TResident>,
  resident: TResident | null | undefined,
  inputViewportPacket: string | null
): boolean {
  if (!resident || inputViewportPacket !== null) return false;
  resident.lastUsed = host.bumpResidentClock();
  return true;
}

function touchIdempotentPrepackedResident<TResident extends PrepackedMaterializeResident>(
  host: PrepackedMaterializeHost<TResident>,
  existing: TResident | null | undefined,
  input: PrepackedAnnotationSceneLoadInput,
  viewportDetail: PrepackedAnnotationSceneLoadInput['viewportDetail']
): boolean {
  if (
    !existing ||
    !isIdempotentPrepackedSceneLoad({
      existing,
      nextInput: input,
      nextViewportDetail: viewportDetail,
    })
  ) {
    return false;
  }
  existing.lastUsed = host.bumpResidentClock();
  return true;
}

function retargetReusableSamePacketResident<TResident extends PrepackedMaterializeResident>(
  host: PrepackedMaterializeHost<TResident>,
  input: PrepackedAnnotationSceneLoadInput,
  inputViewportPacket: string | null,
  candidates: Array<TResident | null | undefined>,
  excludedCandidate: TResident | null
): boolean {
  const reusableSamePacket = findReusablePrepackedSamePacketResident<TResident>({
    packetPayloadSha256: inputViewportPacket,
    candidates,
    excludedCandidate,
  });
  if (!reusableSamePacket) return false;
  reusableSamePacket.input = {
    ...input,
    gpuReadyScene: reusableSamePacket.input.gpuReadyScene,
    metadata: { ...input.metadata },
  };
  reusableSamePacket.sourceInput = input;
  reusableSamePacket.viewportDetailPresentationAdmitted = false;
  reusableSamePacket.lastUsed = host.bumpResidentClock();
  reusableSamePacket.visiblePartitionCount = 0;
  reusableSamePacket.visibleInstanceCount = 0;
  reusableSamePacket.layer.hide();
  host.invalidateLastCompleteIfContains(input.ownerKey);
  if (host.activeLayer === reusableSamePacket.layer) {
    host.retargetActiveOwnerFromResident(reusableSamePacket);
  }
  host.bumpResidentGeneration();
  host.clearIdentityCaches();
  return true;
}

export function materializePrepackedAnnotationScene<TResident extends PrepackedMaterializeResident>(
  host: PrepackedMaterializeHost<TResident>,
  input: PrepackedAnnotationSceneLoadInput,
  preserveActiveOwner: boolean,
  deferGpuPreparation: boolean
): boolean {
  const reject = (status: PrepackedAnnotationSceneStatus, dispose = false): false => {
    if (input.viewportDetail && typeof console !== 'undefined') {
      console.error('[annotation-viewport-detail] candidate rejected', {
        status,
        preserveActiveOwner,
        hasActiveOwner: host.hasActiveOwner,
        requestedLayerTypes: host.requestedLayerTypes,
        candidateTrackType: input.metadata.trackType,
        candidateThemeMode: input.metadata.themeMode,
      });
    }
    if (preserveActiveOwner && host.hasActiveOwner) return false;
    if (dispose) host.disposeScene(status);
    else host.setStatus(status);
    return false;
  };
  const requestedLayerTypes = host.requestedLayerTypes;
  const residentLayerTypes = [input.metadata.trackType];
  const firstReject = firstPrepackedMaterializeRejectReason({
    themeMode: input.metadata.themeMode,
    trackType: input.metadata.trackType,
    requestedLayerTypes,
    familyKinds: input.scene.families.map(({ kind }) => kind),
  });
  if (firstReject) return reject(firstReject);
  const viewportDetail = input.viewportDetail;
  const compiledInteraction = viewportDetail
    ? host.compiledInteractionForOwner(input.ownerKey)
    : null;
  const viewportDetailInspection = inspectPrepackedViewportDetailPacket({
    viewportDetail,
    ownerKey: input.ownerKey,
    genomeLengthBp: input.metadata.genomeLengthBp,
    policyProjection: input.policyProjection,
    trustedViewportDetailPacketAdmissionV1: input.trustedViewportDetailPacketAdmissionV1,
    trustedViewportDetailInteractionAdmissionV1: input.trustedViewportDetailInteractionAdmissionV1,
    compiledInteraction,
  });
  const materializeAdmission = inspectPrepackedMaterializeAdmission(
    collectPrepackedMaterializeAdmissionFlags({
      host,
      input,
      residentLayerTypes,
      viewportDetailValid: viewportDetailInspection.valid,
    })
  );
  if (!materializeAdmission.valid) {
    if (viewportDetail && typeof console !== 'undefined') {
      console.error('[annotation-viewport-detail] rejected authenticated replacement', {
        ...materializeAdmission.flags,
        viewportDetailChecks: viewportDetailInspection.checks,
        policyFeatureCount: input.policyProjection?.featureCount ?? null,
        interactionFeatureCount: input.interactionIndex?.featureCount ?? null,
        metadataPartitionSpanBp: input.metadata.partitionSpanBp,
        detailPartitionSpanBp: input.gpuReadyScene?.partitionSpanBp ?? null,
      });
    }
    return reject('variant-mismatch', true);
  }
  const secondReject = secondPrepackedMaterializeRejectReason({
    currentGenomeIdentity: host.currentGenomeIdentity,
    metadataGenomeIdentity: input.metadata.genomeIdentity,
    genomeLength: host.genomeLength,
    metadataGenomeLength: input.metadata.genomeLengthBp,
    isWebgl: host.isWebgl,
  });
  if (secondReject) return reject(secondReject, true);

  const resident = host.getResident(input.ownerKey);
  const replacementCandidate = host.getReplacementCandidate(input.ownerKey);
  if (destroyCollidingPrepackedResident(host, input, resident, preserveActiveOwner)) {
    return false;
  }
  const inputViewportPacket = viewportDetail?.packetPayloadSha256 ?? null;
  if (touchIdempotentPrepackedResident(host, resident, input, viewportDetail)) {
    return true;
  }
  if (touchIdempotentPrepackedResident(host, replacementCandidate, input, viewportDetail)) {
    return true;
  }

  if (
    retargetReusableSamePacketResident(
      host,
      input,
      inputViewportPacket,
      [replacementCandidate, resident],
      resident &&
        (host.activeLayer === resident.layer ||
          host.lastCompleteOwnerKeys.includes(resident.ownerKey))
        ? resident
        : null
    )
  ) {
    return true;
  }

  let partitioned:
    | ReturnType<typeof buildPartitionedTranscriptScene>
    | NonNullable<PrepackedAnnotationSceneLoadInput['gpuReadyScene']>;
  let trustedV4Admission = false;
  let trustedV4Binding: TrustedPartitionedTranscriptRendererAdmissionBindingV4 | null = null;
  let trustedDetailPacketAdmission = false;
  let trustedDetailPacketBinding: TrustedPartitionedTranscriptSceneDetailPacketAdmissionBindingV1 | null =
    null;
  const effectiveRuntimePolicy = host.runtimePolicy ?? input.runtimePolicy;
  try {
    const admitted = admitPrepackedPartitionedScene({
      input,
      viewportDetail,
      compiledInteraction,
      noteInteractionCouplingValidation: (primitiveCount) =>
        host.noteInteractionCouplingValidation(primitiveCount),
    });
    partitioned = admitted.partitioned;
    trustedV4Admission = admitted.trustedV4Admission;
    trustedV4Binding = admitted.trustedV4Binding;
    trustedDetailPacketAdmission = admitted.trustedDetailPacketAdmission;
    trustedDetailPacketBinding = admitted.trustedDetailPacketBinding;
  } catch (error) {
    return handlePrepackedVisualCouplingFailure({
      error,
      viewportDetail,
      input,
      host,
      preserveActiveOwner,
      resident,
    });
  }

  if (retainResidentWithoutViewportPacket(host, resident, inputViewportPacket)) {
    return true;
  }

  const replacedActiveOwner = host.hasActiveLayer;
  let layer: PartitionedInstancedTranscriptLayer | null = null;
  try {
    const constructed = constructPrepackedMaterializeLayer({
      load: input,
      partitioned,
      trustedV4Admission,
      trustedV4Binding,
      trustedDetailPacketAdmission,
      trustedDetailPacketBinding,
    });
    layer = constructed.layer;
    if (constructed.trustedV4Admission) host.noteTrustedV4Admission();
    preparePrepackedMaterializeLayerGpu({
      layer,
      runtimePolicy: effectiveRuntimePolicy,
      deferGpuPreparation,
      renderer: host.gpuRenderer,
    });
  } catch (error) {
    return handlePrepackedGpuPrepareFailure({
      error,
      viewportDetail,
      ownerKey: input.ownerKey,
      layer,
      replacedActiveOwner,
      host,
    });
  }
  const storedInput: PrepackedAnnotationSceneLoadInput = {
    ...input,
    gpuReadyScene: partitioned,
    metadata: { ...input.metadata },
    ...(effectiveRuntimePolicy
      ? {
          runtimePolicy: { ...effectiveRuntimePolicy },
        }
      : {}),
  };
  const entry = {
    ownerKey: input.ownerKey,
    input: storedInput,
    sourceInput: input,
    metadata: storedInput.metadata,
    layer,
    policyTrackLaneMaxima: layer.getAnnotationPolicyTrackLaneMaxima(),
    policyGeneration: host.policyGeneration,
    viewportDetailPresentationAdmitted: input.viewportDetail === undefined,
    lastUsed: host.bumpResidentClock(),
    visiblePartitionCount: 0,
    visibleInstanceCount: 0,
  } as TResident;
  const replacedResident = resident ?? null;
  const replacedResidentWasActive = Boolean(
    replacedResident &&
    host.activeLayer === replacedResident.layer &&
    host.activeOwnerKey === replacedResident.ownerKey
  );
  const replacedResidentWasLastComplete = Boolean(
    replacedResident && host.lastCompleteOwnerKeys.includes(replacedResident.ownerKey)
  );
  for (const existing of [...host.residents, ...host.replacementCandidates]) {
    if (
      shouldRejectIncompatibleActiveOwner({
        preserveActiveOwner,
        existingIsActiveLayer: existing.layer === host.activeLayer,
        bankCompatible: prepackedAnnotationSceneBankCompatible(existing.metadata, entry.metadata),
      })
    ) {
      layer.destroy();
      return false;
    }
  }
  for (const existing of [...host.residents]) {
    if (!prepackedAnnotationSceneBankCompatible(existing.metadata, entry.metadata)) {
      host.destroyResident(existing.ownerKey, 'not-loaded', false);
    }
  }
  const compiledInteractionOwner = host.compiledOwnerForTrack(entry.metadata.trackType);
  if (
    shouldRetractStalePrepackedActiveOwner({
      compiledOwnerKey: compiledInteractionOwner?.provenance.prepackedOwnerKey,
      compiledArtifactKey: compiledInteractionOwner?.provenance.prepackedArtifactKey,
      entryOwnerKey: entry.ownerKey,
      entryArtifactKey: entry.metadata.artifactKey,
      activeOwnerKey: host.activeOwnerKey,
      activeTrackType: host.activeOwnerMetadata?.trackType,
      entryTrackType: entry.metadata.trackType,
    })
  ) {
    host.retractStaleActiveOwner();
  }
  if (resident && inputViewportPacket !== null) {
    const previousCandidate = host.getReplacementCandidate(entry.ownerKey);
    if (previousCandidate) {
      host.disposeLayer(previousCandidate.layer, false);
    }
    host.putReplacementCandidate(entry);
    host.bumpResidentGeneration();
    host.installLayer(layer);
    host.primeInactiveResident(entry);
    return host.getReplacementCandidate(entry.ownerKey) === entry;
  }
  host.putResident(entry);
  host.bumpResidentGeneration();
  if (effectiveRuntimePolicy) {
    host.setRuntimePolicyIfEmpty(effectiveRuntimePolicy);
  }
  host.installLayer(layer);
  host.primeInactiveResident(entry);
  if (replacedResident) {
    if (replacedResidentWasActive) {
      host.retargetActiveOwnerFromResident(entry);
    }
    host.disposeLayer(replacedResident.layer, replacedResidentWasLastComplete);
    host.clearIdentityCaches();
  }
  host.evictResidentsToLimit();
  host.reconcileLaneEnvelope();
  return host.getResident(entry.ownerKey) === entry;
}

export type PrepackedMaterializeOverlayBindings<
  TResident extends PrepackedMaterializeResident = PrepackedMaterializeResident,
> = {
  pixiRenderer: { type?: number } | null;
  currentGenomeIdentity: string;
  genomeLength: number;
  prepackedAnnotationPolicyGeneration: number;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  prepackedAnnotationSceneLayer: PartitionedInstancedTranscriptLayer | null;
  prepackedAnnotationSceneOwnerKey: string | null;
  prepackedAnnotationSceneOwnerMetadata: Pick<PrepackedAnnotationSceneMetadata, 'trackType'> | null;
  prepackedAnnotationSceneInput: PrepackedAnnotationSceneLoadInput | null;
  prepackedAnnotationSceneLastCompleteOwnerKeys: readonly string[];
  prepackedAnnotationSceneResidents: {
    readonly size: number;
    values(): Iterable<TResident>;
    get(ownerKey: string): TResident | undefined;
    set(ownerKey: string, resident: TResident): void;
  };
  prepackedAnnotationSceneReplacementCandidates: {
    values(): Iterable<TResident>;
    get(ownerKey: string): TResident | undefined;
    set(ownerKey: string, resident: TResident): void;
  };
  compiledBroadAnnotationInteractionResidents: {
    get(ownerKey: string): PrepackedMaterializeCompiledInteraction | undefined;
  };
  prepackedAnnotationSceneStatus: PrepackedAnnotationSceneStatus;
  prepackedAnnotationInteractionCouplingValidationCount: number;
  prepackedAnnotationInteractionCouplingPrimitiveScanCardinality: number;
  prepackedAnnotationTrustedV4AdmissionCount: number;
  prepackedAnnotationSceneResidentClock: number;
  prepackedAnnotationSceneResidentGeneration: number;
  prepackedAnnotationSceneOwnerGeneration: number;
  prepackedCanonicalRendererIdCache: { clear(): void };
  prepackedResidentPolicyFeatureIndexCache: { clear(): void };
  prepackedAnnotationSceneLayerCreates: number;
  prepackedAnnotationSceneGpuPreparations: number;
  container: {
    children: { readonly length: number };
    addChildAt(child: unknown, index: number): void;
  };
  annotationLayerTypesForPresentation(): readonly string[];
  scaledBarHeight(): number;
  compiledBroadSurfaceOwnerForTrack(trackType: string): PrepackedMaterializeCompiledOwner;
  disposePrepackedAnnotationScene(status: PrepackedAnnotationSceneStatus): void;
  destroyPrepackedAnnotationSceneResident(
    ownerKey: string,
    status: PrepackedAnnotationSceneStatus,
    recordOwnerChange: boolean
  ): void;
  disposePrepackedAnnotationSceneLayer(
    layer: PartitionedInstancedTranscriptLayer,
    wasLastComplete: boolean
  ): void;
  primeInactivePrepackedAnnotationSceneResident(resident: TResident): void;
  evictPrepackedAnnotationSceneResidentsToLimit(): void;
  reconcileAnnotationLaneEnvelopeAuthority(): void;
};

const WEBGL_RENDERER_TYPE = 1;

export function createPrepackedMaterializeHost<TResident extends PrepackedMaterializeResident>(
  overlay: PrepackedMaterializeOverlayBindings<TResident>
): PrepackedMaterializeHost<TResident> {
  return {
    get requestedLayerTypes() {
      return overlay.annotationLayerTypesForPresentation();
    },
    get scaledBarHeightPx() {
      return overlay.scaledBarHeight();
    },
    get currentGenomeIdentity() {
      return overlay.currentGenomeIdentity;
    },
    get genomeLength() {
      return overlay.genomeLength;
    },
    get isWebgl() {
      return overlay.pixiRenderer?.type === WEBGL_RENDERER_TYPE;
    },
    get policyGeneration() {
      return overlay.prepackedAnnotationPolicyGeneration;
    },
    get runtimePolicy() {
      return overlay.prepackedAnnotationRuntimePolicy;
    },
    get gpuRenderer() {
      return overlay.pixiRenderer as PartitionedTranscriptGpuPreparationRenderer;
    },
    get hasActiveOwner() {
      return (
        overlay.prepackedAnnotationSceneLayer !== null ||
        overlay.prepackedAnnotationSceneResidents.size > 0
      );
    },
    get hasActiveLayer() {
      return overlay.prepackedAnnotationSceneLayer !== null;
    },
    get lastCompleteOwnerKeys() {
      return overlay.prepackedAnnotationSceneLastCompleteOwnerKeys;
    },
    get activeLayer() {
      return overlay.prepackedAnnotationSceneLayer;
    },
    get activeOwnerKey() {
      return overlay.prepackedAnnotationSceneOwnerKey;
    },
    get activeOwnerMetadata() {
      return overlay.prepackedAnnotationSceneOwnerMetadata;
    },
    get residents() {
      return overlay.prepackedAnnotationSceneResidents.values();
    },
    get replacementCandidates() {
      return overlay.prepackedAnnotationSceneReplacementCandidates.values();
    },
    getResident(ownerKey) {
      return overlay.prepackedAnnotationSceneResidents.get(ownerKey);
    },
    getReplacementCandidate(ownerKey) {
      return overlay.prepackedAnnotationSceneReplacementCandidates.get(ownerKey);
    },
    compiledInteractionForOwner(ownerKey) {
      return overlay.compiledBroadAnnotationInteractionResidents.get(ownerKey) ?? null;
    },
    compiledOwnerForTrack(trackType) {
      return overlay.compiledBroadSurfaceOwnerForTrack(trackType);
    },
    setStatus(status) {
      overlay.prepackedAnnotationSceneStatus = status;
    },
    disposeScene(status) {
      overlay.disposePrepackedAnnotationScene(status);
    },
    destroyResident(ownerKey, status, recordOwnerChange) {
      overlay.destroyPrepackedAnnotationSceneResident(ownerKey, status, recordOwnerChange ?? true);
    },
    noteInteractionCouplingValidation(primitiveCount) {
      overlay.prepackedAnnotationInteractionCouplingValidationCount += 1;
      overlay.prepackedAnnotationInteractionCouplingPrimitiveScanCardinality += primitiveCount;
    },
    noteTrustedV4Admission() {
      overlay.prepackedAnnotationTrustedV4AdmissionCount += 1;
    },
    bumpResidentClock() {
      return ++overlay.prepackedAnnotationSceneResidentClock;
    },
    bumpResidentGeneration() {
      overlay.prepackedAnnotationSceneResidentGeneration += 1;
    },
    bumpOwnerGeneration() {
      overlay.prepackedAnnotationSceneOwnerGeneration += 1;
    },
    clearIdentityCaches() {
      overlay.prepackedCanonicalRendererIdCache.clear();
      overlay.prepackedResidentPolicyFeatureIndexCache.clear();
    },
    invalidateLastCompleteIfContains(ownerKey) {
      if (overlay.prepackedAnnotationSceneLastCompleteOwnerKeys.includes(ownerKey)) {
        overlay.prepackedAnnotationSceneLastCompleteOwnerKeys = Object.freeze([]);
      }
    },
    retargetActiveOwnerFromResident(resident) {
      overlay.prepackedAnnotationSceneInput = resident.input;
      overlay.prepackedAnnotationSceneOwnerMetadata = resident.metadata;
      overlay.prepackedAnnotationSceneOwnerGeneration += 1;
      if (overlay.prepackedAnnotationSceneLayer === resident.layer) return;
      overlay.prepackedAnnotationSceneLayer = resident.layer;
    },
    retractStaleActiveOwner() {
      overlay.prepackedAnnotationSceneLayer = null;
      overlay.prepackedAnnotationSceneInput = null;
      overlay.prepackedAnnotationSceneOwnerKey = null;
      overlay.prepackedAnnotationSceneOwnerMetadata = null;
      overlay.prepackedAnnotationSceneOwnerGeneration += 1;
    },
    setRuntimePolicyIfEmpty(policy) {
      if (!overlay.prepackedAnnotationRuntimePolicy) {
        overlay.prepackedAnnotationRuntimePolicy = { ...policy };
      }
    },
    setGpuPrepareFailedStatus() {
      overlay.prepackedAnnotationSceneStatus = 'gpu-prepare-failed';
    },
    putReplacementCandidate(resident) {
      overlay.prepackedAnnotationSceneReplacementCandidates.set(resident.ownerKey, resident);
    },
    putResident(resident) {
      overlay.prepackedAnnotationSceneResidents.set(resident.ownerKey, resident);
    },
    disposeLayer(layer, wasLastComplete) {
      overlay.disposePrepackedAnnotationSceneLayer(layer, wasLastComplete);
    },
    installLayer(layer) {
      overlay.prepackedAnnotationSceneLayerCreates += 1;
      if (layer.isGpuPrepared) overlay.prepackedAnnotationSceneGpuPreparations += 1;
      overlay.container.addChildAt(layer.container, Math.min(2, overlay.container.children.length));
    },
    primeInactiveResident(resident) {
      overlay.primeInactivePrepackedAnnotationSceneResident(resident);
    },
    evictResidentsToLimit() {
      overlay.evictPrepackedAnnotationSceneResidentsToLimit();
    },
    reconcileLaneEnvelope() {
      overlay.reconcileAnnotationLaneEnvelopeAuthority();
    },
  };
}
