import {
  assertSourceAnnotationAliasesV1,
  type SourceAnnotationAliasesV1,
} from '../../../annotation-data-appearance';
import {
  ANNOTATION_POLICY_DIRECT_FINE_INDEX_V1,
  buildAnnotationPolicyDirectFineIndexV1,
  type AnnotationPolicyDirectFineIndexV1,
} from './annotation-policy-direct-fine-index-v1';
import {
  ANNOTATION_POLICY_DIRECT_SUBMISSION_BANK_V1,
  type AnnotationPolicyDirectSubmissionBankV1,
  type AnnotationPolicyDirectSubmissionModeBankV1,
  type AnnotationPolicyDirectSubmissionPartitionV1,
} from './annotation-policy-direct-submission-bank-v1';
import type { GpuReadyPartitionedTranscriptScene } from './partitioned-transcript-scene';
import type { AnnotationShapeFamilyV1 } from './annotation-scene-binary-v1';
import type {
  AnnotationPolicyDirectFineIndicesV1,
  PartitionedTranscriptSceneBinaryManifestV4,
  PartitionedTranscriptSceneBinarySha256V4,
  PartitionedTranscriptSceneRoleSidecarV1,
} from './partitioned-transcript-scene-binary-v4';
import {
  assertPartitionedTranscriptSceneRangeCatalogV1,
  type AuthenticatedTranscriptSceneRangeV1,
  type PartitionedTranscriptSceneModePartitionRangeV1,
  type PartitionedTranscriptSceneRangeCatalogV1,
} from './partitioned-transcript-scene-range-catalog-v1';
import { FINE_TRANSCRIPT_VIEW_SPAN_BP } from './fine-transcript-view-planner';
import { TRANSCRIPT_GLYPH_INSTANCE_LAYOUT } from './transcript-glyph-instances';
import {
  bindPrepackedAnnotationFeatureLookupToPrimitiveCsrV2,
  bindPrepackedAnnotationFeatureLookupToPrimitiveBankV2,
  buildPrepackedAnnotationPrimitiveCsrV2,
  type PrepackedAnnotationFeatureLookupIndexV2,
  type PrepackedAnnotationInteractionIndexV2,
  type PrepackedAnnotationPrimitiveCsrV2,
} from './prepacked-annotation-interaction-index-v2';

export const PARTITIONED_TRANSCRIPT_SCENE_DETAIL_PACKET_V1 =
  'partitioned-transcript-scene-detail-packet.v1' as const;

interface DetailPacketSectionV1 {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly count: number;
  readonly recordBytes: number;
}

interface DetailPacketPartitionV1 extends Omit<
  PartitionedTranscriptSceneModePartitionRangeV1,
  'glyphs' | 'featureIndices' | 'lanePrefixes'
> {
  readonly firstInstance: number;
  readonly lanePrefixOffset: number;
}

interface DetailPacketModeV1 {
  readonly mode: 'expanded' | 'canonical';
  readonly maxTrackLane: number;
  readonly partitions: readonly DetailPacketPartitionV1[];
}

export interface PartitionedTranscriptSceneDetailPacketManifestV1 {
  readonly schema: typeof PARTITIONED_TRANSCRIPT_SCENE_DETAIL_PACKET_V1;
  readonly sourceScene: PartitionedTranscriptSceneRangeCatalogV1['sourceScene'];
  readonly assemblyLengthBp: number;
  readonly featureCount: number;
  readonly sourcePrimitiveCount: number;
  readonly sourceAnnotationAliases?: readonly SourceAnnotationAliasesV1[];
  readonly families: readonly AnnotationShapeFamilyV1[];
  readonly partitionSpanBp: number;
  readonly maxPrimitiveSpanBp: number;
  readonly requestedRange: Readonly<{ startBp: number; endBp: number }>;
  readonly selectedPartitionIndices: readonly number[];
  readonly expanded: DetailPacketModeV1;
  readonly canonical: DetailPacketModeV1;
  readonly fineIndex: Readonly<{
    schema: typeof ANNOTATION_POLICY_DIRECT_FINE_INDEX_V1;
    tileSpanBp: number;
    tileCount: number;
  }>;
  readonly sections: Readonly<{
    expandedGlyphs: DetailPacketSectionV1;
    expandedFeatureIndices: DetailPacketSectionV1;
    expandedLanePrefixes: DetailPacketSectionV1;
    canonicalGlyphs: DetailPacketSectionV1;
    canonicalFeatureIndices: DetailPacketSectionV1;
    canonicalLanePrefixes: DetailPacketSectionV1;
    featureFamilyIndices: DetailPacketSectionV1;
    expandedFineTileOffsets: DetailPacketSectionV1;
    expandedFineBankRecordIndices: DetailPacketSectionV1;
    canonicalFineTileOffsets: DetailPacketSectionV1;
    canonicalFineBankRecordIndices: DetailPacketSectionV1;
    sourceFineTilePrimitiveCounts: DetailPacketSectionV1;
    interactionFeaturePrimitiveOffsets: DetailPacketSectionV1;
    interactionFeaturePrimitiveIndices: DetailPacketSectionV1;
    interactionActiveFeatureIndices: DetailPacketSectionV1;
  }>;
  readonly byteLength: number;
  readonly integrity: Readonly<{ algorithm: 'sha256'; payloadSha256: string }>;
}

export interface PackedPartitionedTranscriptSceneDetailPacketV1 {
  readonly manifest: PartitionedTranscriptSceneDetailPacketManifestV1;
  readonly payload: Uint8Array;
}

export type PartitionedTranscriptSceneRangeReaderV1 = (
  range: AuthenticatedTranscriptSceneRangeV1
) => Promise<Uint8Array>;

export type UnpackedPartitionedTranscriptSceneDetailPacketV1 = Readonly<{
  empty: boolean;
  scene: GpuReadyPartitionedTranscriptScene;
  submissionBank: AnnotationPolicyDirectSubmissionBankV1;
  submissionFineIndices: AnnotationPolicyDirectFineIndicesV1;
  featureFamilyIndices: Uint32Array;
  interactionPrimitiveCsr: PrepackedAnnotationPrimitiveCsrV2;
  selectedPartitionIndices: readonly number[];
  rendererAdmissionCapability: TrustedPartitionedTranscriptSceneDetailPacketAdmissionV1;
}>;

export interface TrustedPartitionedTranscriptSceneDetailPacketAdmissionV1 {
  readonly __trustedPartitionedTranscriptSceneDetailPacketAdmissionV1: never;
}

export interface TrustedPartitionedTranscriptSceneDetailPacketAdmissionBindingV1 {
  readonly scene: GpuReadyPartitionedTranscriptScene;
  readonly submissionBank: AnnotationPolicyDirectSubmissionBankV1;
  readonly submissionFineIndices: AnnotationPolicyDirectFineIndicesV1;
  readonly featureFamilyIndices: Uint32Array;
}

export interface TrustedPartitionedTranscriptSceneDetailInteractionAdmissionV1 {
  readonly __trustedPartitionedTranscriptSceneDetailInteractionAdmissionV1: never;
}

export interface TrustedPartitionedTranscriptSceneDetailInteractionBindingV1 {
  readonly sourceScene: Readonly<{
    byteLength: number;
    payloadSha256: string;
    contractSha256: string;
  }>;
  readonly scene: GpuReadyPartitionedTranscriptScene;
  readonly parentFeatureLookup: PrepackedAnnotationFeatureLookupIndexV2;
  readonly interactionIndex: PrepackedAnnotationInteractionIndexV2;
}

const trustedDetailPacketAdmissionBindingsV1 = new WeakMap<
  object,
  TrustedPartitionedTranscriptSceneDetailPacketAdmissionBindingV1 &
    Readonly<{ interactionPrimitiveCsr: PrepackedAnnotationPrimitiveCsrV2 }>
>();
const trustedDetailInteractionBindingsV1 = new WeakMap<
  object,
  TrustedPartitionedTranscriptSceneDetailInteractionBindingV1
>();

interface LoadedMode {
  readonly mode: 'expanded' | 'canonical';
  readonly maxTrackLane: number;
  readonly partitions: readonly DetailPacketPartitionV1[];
  readonly glyphs: readonly Uint8Array[];
  readonly featureIndices: readonly Uint8Array[];
  readonly lanePrefixes: readonly Uint8Array[];
}

const SHA256 = /^[0-9a-f]{64}$/;
const U32_BYTES = Uint32Array.BYTES_PER_ELEMENT;

export function planPartitionedTranscriptSceneDetailPartitionsV1(
  catalog: PartitionedTranscriptSceneRangeCatalogV1,
  startBp: number,
  endBp: number
): readonly number[] {
  if (
    !Number.isSafeInteger(startBp) ||
    !Number.isSafeInteger(endBp) ||
    startBp < 0 ||
    endBp <= startBp
  ) {
    throw new Error('partitioned transcript detail viewport is invalid');
  }
  const expandedStartBp = Math.max(0, startBp - catalog.maxPrimitiveSpanBp);
  return Object.freeze(
    catalog.expanded.partitions
      .filter(
        (partition) =>
          partition.startBp < endBp &&
          partition.endBpExclusive > expandedStartBp &&
          partition.minStartBp < endBp &&
          partition.maxEndBp > startBp
      )
      .map(({ partitionIndex }) => partitionIndex)
  );
}

export function slicePartitionedTranscriptSceneDetailRolesV1(
  catalog: PartitionedTranscriptSceneRangeCatalogV1,
  selectedPartitionIndices: readonly number[],
  parent: PartitionedTranscriptSceneRoleSidecarV1
): PartitionedTranscriptSceneRoleSidecarV1 | null {
  const selected = new Set(selectedPartitionIndices);
  const slice = (mode: 'expanded' | 'canonical', roles: Uint8Array): Uint8Array | null => {
    const partitions = catalog[mode].partitions;
    const total = partitions.reduce((sum, partition) => sum + partition.instanceCount, 0);
    if (total !== roles.length) return null;
    const count = partitions.reduce(
      (sum, partition) =>
        sum + (selected.has(partition.partitionIndex) ? partition.instanceCount : 0),
      0
    );
    const out = new Uint8Array(count);
    let source = 0;
    let target = 0;
    for (const partition of partitions) {
      if (selected.has(partition.partitionIndex)) {
        out.set(roles.subarray(source, source + partition.instanceCount), target);
        target += partition.instanceCount;
      }
      source += partition.instanceCount;
    }
    return out;
  };
  const expandedRoleIndices = slice('expanded', parent.expandedRoleIndices);
  const canonicalRoleIndices = slice('canonical', parent.canonicalRoleIndices);
  if (!expandedRoleIndices || !canonicalRoleIndices) return null;
  return { roleTable: [...parent.roleTable], expandedRoleIndices, canonicalRoleIndices };
}

export async function packPartitionedTranscriptSceneDetailPacketV1(input: {
  readonly sourceManifest: PartitionedTranscriptSceneBinaryManifestV4;
  readonly rangeCatalog: PartitionedTranscriptSceneRangeCatalogV1;
  readonly startBp: number;
  readonly endBp: number;
  readonly readRange: PartitionedTranscriptSceneRangeReaderV1;
  readonly payloadSha256: PartitionedTranscriptSceneBinarySha256V4;
}): Promise<PackedPartitionedTranscriptSceneDetailPacketV1> {
  assertPartitionedTranscriptSceneRangeCatalogV1(input.rangeCatalog, input.sourceManifest);
  const selectedPartitionIndices = planPartitionedTranscriptSceneDetailPartitionsV1(
    input.rangeCatalog,
    input.startBp,
    input.endBp
  );
  const selected = new Set(selectedPartitionIndices);
  const [expanded, canonical, featureFamilyIndices] = await Promise.all([
    loadMode(input, 'expanded', selected),
    loadMode(input, 'canonical', selected),
    readAuthenticatedRange(input, input.rangeCatalog.featureFamilyIndices),
  ]);
  const expandedModeBank = materializeLoadedModeBank(expanded);
  const canonicalModeBank = materializeLoadedModeBank(canonical);
  const expandedFine = buildAnnotationPolicyDirectFineIndexV1(
    expandedModeBank,
    input.sourceManifest.assemblyContract.assemblyLengthBp
  );
  const canonicalFine = buildAnnotationPolicyDirectFineIndexV1(
    canonicalModeBank,
    input.sourceManifest.assemblyContract.assemblyLengthBp,
    expandedFine.sourceTilePrimitiveCounts
  );
  const interactionPrimitiveCsr = buildPrepackedAnnotationPrimitiveCsrV2(
    input.sourceManifest.featureCount,
    expandedModeBank.featureIndices
  );
  const chunks = [
    ...expanded.glyphs,
    ...expanded.featureIndices,
    ...expanded.lanePrefixes,
    ...canonical.glyphs,
    ...canonical.featureIndices,
    ...canonical.lanePrefixes,
    featureFamilyIndices,
    bytesOf(expandedFine.tileOffsets),
    bytesOf(expandedFine.bankRecordIndices),
    bytesOf(canonicalFine.tileOffsets),
    bytesOf(canonicalFine.bankRecordIndices),
    bytesOf(expandedFine.sourceTilePrimitiveCounts),
    bytesOf(interactionPrimitiveCsr.featurePrimitiveOffsets),
    bytesOf(interactionPrimitiveCsr.featurePrimitiveIndices),
    bytesOf(interactionPrimitiveCsr.activeFeatureIndices),
  ];
  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const payload = new Uint8Array(byteLength);
  let cursor = 0;
  const section = (mode: LoadedMode, key: 'glyphs' | 'featureIndices' | 'lanePrefixes') => {
    const byteOffset = cursor;
    const values = mode[key];
    for (const value of values) {
      payload.set(value, cursor);
      cursor += value.byteLength;
    }
    const recordBytes = key === 'glyphs' ? TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes : U32_BYTES;
    const sectionByteLength = cursor - byteOffset;
    return Object.freeze({
      byteOffset,
      byteLength: sectionByteLength,
      count: sectionByteLength / recordBytes,
      recordBytes,
    });
  };
  const uint32Section = (values: Uint32Array): DetailPacketSectionV1 => {
    const byteOffset = cursor;
    const bytes = bytesOf(values);
    payload.set(bytes, cursor);
    cursor += bytes.byteLength;
    return Object.freeze({
      byteOffset,
      byteLength: bytes.byteLength,
      count: values.length,
      recordBytes: U32_BYTES,
    });
  };
  const sections = Object.freeze({
    expandedGlyphs: section(expanded, 'glyphs'),
    expandedFeatureIndices: section(expanded, 'featureIndices'),
    expandedLanePrefixes: section(expanded, 'lanePrefixes'),
    canonicalGlyphs: section(canonical, 'glyphs'),
    canonicalFeatureIndices: section(canonical, 'featureIndices'),
    canonicalLanePrefixes: section(canonical, 'lanePrefixes'),
    featureFamilyIndices: (() => {
      const byteOffset = cursor;
      payload.set(featureFamilyIndices, cursor);
      cursor += featureFamilyIndices.byteLength;
      return Object.freeze({
        byteOffset,
        byteLength: featureFamilyIndices.byteLength,
        count: featureFamilyIndices.byteLength / U32_BYTES,
        recordBytes: U32_BYTES,
      });
    })(),
    expandedFineTileOffsets: uint32Section(expandedFine.tileOffsets),
    expandedFineBankRecordIndices: uint32Section(expandedFine.bankRecordIndices),
    canonicalFineTileOffsets: uint32Section(canonicalFine.tileOffsets),
    canonicalFineBankRecordIndices: uint32Section(canonicalFine.bankRecordIndices),
    sourceFineTilePrimitiveCounts: uint32Section(expandedFine.sourceTilePrimitiveCounts),
    interactionFeaturePrimitiveOffsets: uint32Section(
      interactionPrimitiveCsr.featurePrimitiveOffsets
    ),
    interactionFeaturePrimitiveIndices: uint32Section(
      interactionPrimitiveCsr.featurePrimitiveIndices
    ),
    interactionActiveFeatureIndices: uint32Section(interactionPrimitiveCsr.activeFeatureIndices),
  });
  if (cursor !== byteLength)
    throw new Error('partitioned transcript detail packet packing drifted');
  const payloadDigest = await input.payloadSha256(payload);
  if (!SHA256.test(payloadDigest)) {
    throw new Error('partitioned transcript detail packet hash is invalid');
  }
  const activeAliasFeatureIndices = input.sourceManifest.sourceAnnotationAliases
    ? new Set(interactionPrimitiveCsr.activeFeatureIndices)
    : null;
  const manifest: PartitionedTranscriptSceneDetailPacketManifestV1 = Object.freeze({
    schema: PARTITIONED_TRANSCRIPT_SCENE_DETAIL_PACKET_V1,
    sourceScene: input.rangeCatalog.sourceScene,
    assemblyLengthBp: input.sourceManifest.assemblyContract.assemblyLengthBp,
    featureCount: input.sourceManifest.featureCount,
    sourcePrimitiveCount: input.sourceManifest.sourcePrimitiveCount,
    ...(input.sourceManifest.sourceAnnotationAliases
      ? {
          sourceAnnotationAliases: Object.freeze(
            input.sourceManifest.sourceAnnotationAliases
              .filter((entry) => activeAliasFeatureIndices!.has(entry.featureIndex))
              .map((entry) =>
                Object.freeze({
                  featureIndex: entry.featureIndex,
                  aliases: Object.freeze([...entry.aliases]),
                })
              )
          ),
        }
      : {}),
    families: Object.freeze(structuredClone(input.sourceManifest.families)),
    partitionSpanBp: input.rangeCatalog.partitionSpanBp,
    maxPrimitiveSpanBp: input.rangeCatalog.maxPrimitiveSpanBp,
    requestedRange: Object.freeze({ startBp: input.startBp, endBp: input.endBp }),
    selectedPartitionIndices,
    expanded: freezeMode(expanded),
    canonical: freezeMode(canonical),
    fineIndex: Object.freeze({
      schema: ANNOTATION_POLICY_DIRECT_FINE_INDEX_V1,
      tileSpanBp: expandedFine.tileSpanBp,
      tileCount: expandedFine.tileCount,
    }),
    sections,
    byteLength,
    integrity: Object.freeze({ algorithm: 'sha256', payloadSha256: payloadDigest }),
  });
  return Object.freeze({ manifest, payload });
}

export function bindPartitionedTranscriptSceneDetailInteractionV1(
  manifest: PartitionedTranscriptSceneDetailPacketManifestV1,
  scene: GpuReadyPartitionedTranscriptScene,
  featureLookup: PrepackedAnnotationFeatureLookupIndexV2
): PrepackedAnnotationInteractionIndexV2 {
  if (
    featureLookup.featureCount !== manifest.featureCount ||
    featureLookup.primitiveCount !== manifest.sourcePrimitiveCount ||
    scene.featureIndices.length !== manifest.sections.expandedFeatureIndices.count
  ) {
    throw new Error('partitioned transcript detail interaction parent counts disagree');
  }
  return bindPrepackedAnnotationFeatureLookupToPrimitiveBankV2(featureLookup, scene.featureIndices);
}

export function bindTrustedPartitionedTranscriptSceneDetailInteractionV1(
  manifest: PartitionedTranscriptSceneDetailPacketManifestV1,
  scene: GpuReadyPartitionedTranscriptScene,
  featureLookup: PrepackedAnnotationFeatureLookupIndexV2,
  packetAdmissionCapability: TrustedPartitionedTranscriptSceneDetailPacketAdmissionV1
): Readonly<{
  interactionIndex: PrepackedAnnotationInteractionIndexV2;
  rendererAdmissionCapability: TrustedPartitionedTranscriptSceneDetailInteractionAdmissionV1;
}> {
  const packetBinding = trustedDetailPacketAdmissionBindingsV1.get(packetAdmissionCapability);
  if (
    !packetBinding ||
    packetBinding.scene !== scene ||
    packetBinding.interactionPrimitiveCsr.featureCount !== manifest.featureCount ||
    packetBinding.interactionPrimitiveCsr.primitiveCount !==
      manifest.sections.expandedFeatureIndices.count
  ) {
    throw new Error('partitioned transcript detail interaction packet authority is invalid');
  }
  const interactionIndex = bindPrepackedAnnotationFeatureLookupToPrimitiveCsrV2(
    featureLookup,
    packetBinding.interactionPrimitiveCsr
  );
  const binding: TrustedPartitionedTranscriptSceneDetailInteractionBindingV1 = Object.freeze({
    sourceScene: manifest.sourceScene,
    scene,
    parentFeatureLookup: featureLookup,
    interactionIndex,
  });
  const rendererAdmissionCapability = Object.freeze(
    Object.create(null)
  ) as TrustedPartitionedTranscriptSceneDetailInteractionAdmissionV1;
  trustedDetailInteractionBindingsV1.set(rendererAdmissionCapability, binding);
  return Object.freeze({ interactionIndex, rendererAdmissionCapability });
}

export function isTrustedPartitionedTranscriptSceneDetailInteractionAdmissionV1(
  capability: unknown,
  binding: TrustedPartitionedTranscriptSceneDetailInteractionBindingV1
): capability is TrustedPartitionedTranscriptSceneDetailInteractionAdmissionV1 {
  if ((typeof capability !== 'object' && typeof capability !== 'function') || capability === null) {
    return false;
  }
  const trusted = trustedDetailInteractionBindingsV1.get(capability);
  return (
    trusted?.sourceScene === binding.sourceScene &&
    trusted.scene === binding.scene &&
    trusted.parentFeatureLookup === binding.parentFeatureLookup &&
    trusted.interactionIndex === binding.interactionIndex
  );
}

export async function unpackPartitionedTranscriptSceneDetailPacketV1(
  manifest: PartitionedTranscriptSceneDetailPacketManifestV1,
  payload: Uint8Array,
  payloadSha256: PartitionedTranscriptSceneBinarySha256V4
): Promise<UnpackedPartitionedTranscriptSceneDetailPacketV1> {
  assertPacketEnvelope(manifest, payload);
  if ((await payloadSha256(payload)) !== manifest.integrity.payloadSha256) {
    throw new Error('partitioned transcript detail packet payload hash is invalid');
  }
  const expanded = unpackMode(manifest, payload, 'expanded');
  const canonical = unpackMode(manifest, payload, 'canonical');
  if (manifest.sourceAnnotationAliases)
    assertSourceAnnotationAliasesV1(manifest.sourceAnnotationAliases, manifest.featureCount);
  const scene: GpuReadyPartitionedTranscriptScene = {
    sourceAnnotationIdentity: Object.freeze({
      payloadSha256: manifest.sourceScene.payloadSha256,
      contractSha256: manifest.sourceScene.contractSha256,
    }),
    ...(manifest.sourceAnnotationAliases
      ? {
          sourceAnnotationAliases: Object.freeze(
            manifest.sourceAnnotationAliases.map((entry) =>
              Object.freeze({
                featureIndex: entry.featureIndex,
                aliases: Object.freeze([...entry.aliases]),
              })
            )
          ),
        }
      : {}),
    partitionSpanBp: manifest.partitionSpanBp,
    maxPrimitiveSpanBp: manifest.maxPrimitiveSpanBp,
    packedInstanceData: expanded.packedInstanceData,
    featureIndices: expanded.featureIndices,
    partitions: expanded.partitions.map((partition) => ({ ...partition })),
  };
  const submissionBank: AnnotationPolicyDirectSubmissionBankV1 = {
    schema: ANNOTATION_POLICY_DIRECT_SUBMISSION_BANK_V1,
    sourcePrimitiveCount: expanded.featureIndices.length,
    sourcePartitionSpanBp: manifest.partitionSpanBp,
    expanded,
    canonical,
  };
  const sourceTilePrimitiveCounts = u32View(
    payload,
    manifest.sections.sourceFineTilePrimitiveCounts
  );
  const expandedFine = unpackFineIndex(manifest, payload, 'expanded', sourceTilePrimitiveCounts);
  const canonicalFine = unpackFineIndex(manifest, payload, 'canonical', sourceTilePrimitiveCounts);
  const featureFamilyIndices = u32View(payload, manifest.sections.featureFamilyIndices);
  const interactionPrimitiveCsr: PrepackedAnnotationPrimitiveCsrV2 = Object.freeze({
    featureCount: manifest.featureCount,
    primitiveCount: expanded.featureIndices.length,
    featurePrimitiveOffsets: u32View(payload, manifest.sections.interactionFeaturePrimitiveOffsets),
    featurePrimitiveIndices: u32View(payload, manifest.sections.interactionFeaturePrimitiveIndices),
    activeFeatureIndices: u32View(payload, manifest.sections.interactionActiveFeatureIndices),
  });
  const binding = Object.freeze({
    scene,
    submissionBank,
    submissionFineIndices: Object.freeze({ expanded: expandedFine, canonical: canonicalFine }),
    featureFamilyIndices,
    interactionPrimitiveCsr,
  });
  const rendererAdmissionCapability = Object.freeze(
    Object.create(null)
  ) as TrustedPartitionedTranscriptSceneDetailPacketAdmissionV1;
  trustedDetailPacketAdmissionBindingsV1.set(rendererAdmissionCapability, binding);
  return Object.freeze({
    empty: expanded.featureIndices.length === 0,
    scene,
    submissionBank,
    submissionFineIndices: binding.submissionFineIndices,
    featureFamilyIndices,
    interactionPrimitiveCsr,
    selectedPartitionIndices: manifest.selectedPartitionIndices,
    rendererAdmissionCapability,
  });
}

export function isTrustedPartitionedTranscriptSceneDetailPacketAdmissionV1(
  capability: unknown,
  binding: TrustedPartitionedTranscriptSceneDetailPacketAdmissionBindingV1
): capability is TrustedPartitionedTranscriptSceneDetailPacketAdmissionV1 {
  if ((typeof capability !== 'object' && typeof capability !== 'function') || capability === null) {
    return false;
  }
  const trusted = trustedDetailPacketAdmissionBindingsV1.get(capability);
  return (
    trusted?.scene === binding.scene &&
    trusted.submissionBank === binding.submissionBank &&
    trusted.submissionFineIndices === binding.submissionFineIndices &&
    trusted.featureFamilyIndices === binding.featureFamilyIndices
  );
}

async function loadMode(
  input: Parameters<typeof packPartitionedTranscriptSceneDetailPacketV1>[0],
  mode: 'expanded' | 'canonical',
  selected: ReadonlySet<number>
): Promise<LoadedMode> {
  const source = input.rangeCatalog[mode];
  const sourcePartitions = source.partitions.filter(({ partitionIndex }) =>
    selected.has(partitionIndex)
  );
  const loadedPartitions = await Promise.all(
    sourcePartitions.map(async (partition) => {
      const [glyphBytes, featureBytes, laneBytes] = await Promise.all([
        readAuthenticatedRange(input, partition.glyphs),
        readAuthenticatedRange(input, partition.featureIndices),
        readAuthenticatedRange(input, partition.lanePrefixes),
      ]);
      return Object.freeze({ partition, glyphBytes, featureBytes, laneBytes });
    })
  );
  const partitions: DetailPacketPartitionV1[] = [];
  const glyphs: Uint8Array[] = [];
  const featureIndices: Uint8Array[] = [];
  const lanePrefixes: Uint8Array[] = [];
  let firstInstance = 0;
  let lanePrefixOffset = 0;
  for (const { partition, glyphBytes, featureBytes, laneBytes } of loadedPartitions) {
    partitions.push(
      Object.freeze({
        key: partition.key,
        partitionIndex: partition.partitionIndex,
        startBp: partition.startBp,
        endBpExclusive: partition.endBpExclusive,
        minStartBp: partition.minStartBp,
        maxEndBp: partition.maxEndBp,
        firstInstance,
        instanceCount: partition.instanceCount,
        sourceInstanceCount: partition.sourceInstanceCount,
        hiddenByIsoformMembershipInstanceCount: partition.hiddenByIsoformMembershipInstanceCount,
        lanePrefixOffset,
        lanePrefixCount: partition.lanePrefixCount,
      })
    );
    firstInstance += partition.instanceCount;
    lanePrefixOffset += partition.lanePrefixCount;
    glyphs.push(glyphBytes);
    featureIndices.push(featureBytes);
    lanePrefixes.push(laneBytes);
  }
  return Object.freeze({
    mode,
    maxTrackLane: source.maxTrackLane,
    partitions: Object.freeze(partitions),
    glyphs: Object.freeze(glyphs),
    featureIndices: Object.freeze(featureIndices),
    lanePrefixes: Object.freeze(lanePrefixes),
  });
}

async function readAuthenticatedRange(
  input: Parameters<typeof packPartitionedTranscriptSceneDetailPacketV1>[0],
  range: AuthenticatedTranscriptSceneRangeV1
): Promise<Uint8Array> {
  const bytes = await input.readRange(range);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== range.byteLength) {
    throw new Error('partitioned transcript detail range read was incomplete');
  }
  if ((await input.payloadSha256(bytes)) !== range.sha256) {
    throw new Error('partitioned transcript detail range hash is invalid');
  }
  return bytes;
}

function freezeMode(mode: LoadedMode): DetailPacketModeV1 {
  return Object.freeze({
    mode: mode.mode,
    maxTrackLane: mode.maxTrackLane,
    partitions: mode.partitions,
  });
}

function materializeLoadedModeBank(mode: LoadedMode): AnnotationPolicyDirectSubmissionModeBankV1 {
  const glyphBytes = concatenateBytes(mode.glyphs);
  const featureBytes = concatenateBytes(mode.featureIndices);
  const laneBytes = concatenateBytes(mode.lanePrefixes);
  const lanePrefixValues = new Uint32Array(
    laneBytes.buffer,
    laneBytes.byteOffset,
    laneBytes.byteLength / U32_BYTES
  );
  return {
    mode: mode.mode,
    packedInstanceData: new Float32Array(
      glyphBytes.buffer,
      glyphBytes.byteOffset,
      glyphBytes.byteLength / Float32Array.BYTES_PER_ELEMENT
    ),
    featureIndices: new Uint32Array(
      featureBytes.buffer,
      featureBytes.byteOffset,
      featureBytes.byteLength / U32_BYTES
    ),
    partitions: mode.partitions.map((partition) => ({
      key: partition.key,
      partitionIndex: partition.partitionIndex,
      startBp: partition.startBp,
      endBpExclusive: partition.endBpExclusive,
      firstInstance: partition.firstInstance,
      instanceCount: partition.instanceCount,
      minStartBp: partition.minStartBp,
      maxEndBp: partition.maxEndBp,
      sourceInstanceCount: partition.sourceInstanceCount,
      hiddenByIsoformMembershipInstanceCount: partition.hiddenByIsoformMembershipInstanceCount,
      lanePrefixEnds: lanePrefixValues.subarray(
        partition.lanePrefixOffset,
        partition.lanePrefixOffset + partition.lanePrefixCount
      ),
    })),
    maxTrackLane: mode.maxTrackLane,
  };
}

function unpackFineIndex(
  manifest: PartitionedTranscriptSceneDetailPacketManifestV1,
  payload: Uint8Array,
  mode: 'expanded' | 'canonical',
  sourceTilePrimitiveCounts: Uint32Array
): AnnotationPolicyDirectFineIndexV1 {
  return Object.freeze({
    schema: ANNOTATION_POLICY_DIRECT_FINE_INDEX_V1,
    tileSpanBp: FINE_TRANSCRIPT_VIEW_SPAN_BP,
    tileCount: manifest.fineIndex.tileCount,
    tileOffsets: u32View(payload, manifest.sections[`${mode}FineTileOffsets`]),
    bankRecordIndices: u32View(payload, manifest.sections[`${mode}FineBankRecordIndices`]),
    sourceTilePrimitiveCounts,
  });
}

function concatenateBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let cursor = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return bytes;
}

function bytesOf(values: Uint32Array): Uint8Array {
  return new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
}

function unpackMode(
  manifest: PartitionedTranscriptSceneDetailPacketManifestV1,
  payload: Uint8Array,
  mode: 'expanded' | 'canonical'
): AnnotationPolicyDirectSubmissionModeBankV1 {
  const contract = manifest[mode];
  const glyphs = manifest.sections[`${mode}Glyphs`];
  const features = manifest.sections[`${mode}FeatureIndices`];
  const lanes = manifest.sections[`${mode}LanePrefixes`];
  const packedInstanceData = f32View(payload, glyphs);
  const featureIndices = u32View(payload, features);
  const laneValues = u32View(payload, lanes);
  const partitions: AnnotationPolicyDirectSubmissionPartitionV1[] = contract.partitions.map(
    (partition) => ({
      key: partition.key,
      partitionIndex: partition.partitionIndex,
      startBp: partition.startBp,
      endBpExclusive: partition.endBpExclusive,
      firstInstance: partition.firstInstance,
      instanceCount: partition.instanceCount,
      minStartBp: partition.minStartBp,
      maxEndBp: partition.maxEndBp,
      sourceInstanceCount: partition.sourceInstanceCount,
      hiddenByIsoformMembershipInstanceCount: partition.hiddenByIsoformMembershipInstanceCount,
      lanePrefixEnds: laneValues.subarray(
        partition.lanePrefixOffset,
        partition.lanePrefixOffset + partition.lanePrefixCount
      ),
    })
  );
  return {
    mode,
    packedInstanceData,
    featureIndices,
    partitions,
    maxTrackLane: contract.maxTrackLane,
  };
}

function isValidPacketEnvelopeIdentity(
  manifest: PartitionedTranscriptSceneDetailPacketManifestV1,
  payload: Uint8Array
): boolean {
  return (
    manifest?.schema === PARTITIONED_TRANSCRIPT_SCENE_DETAIL_PACKET_V1 &&
    Boolean(manifest.sourceScene) &&
    SHA256.test(manifest.sourceScene.payloadSha256) &&
    SHA256.test(manifest.sourceScene.contractSha256) &&
    manifest.sourceScene.byteLength > 0 &&
    payload instanceof Uint8Array &&
    payload.byteLength === manifest.byteLength &&
    manifest.integrity?.algorithm === 'sha256' &&
    SHA256.test(manifest.integrity.payloadSha256)
  );
}

function isValidPacketEnvelopeCounts(
  manifest: PartitionedTranscriptSceneDetailPacketManifestV1
): boolean {
  return (
    Number.isSafeInteger(manifest.assemblyLengthBp) &&
    manifest.assemblyLengthBp > 0 &&
    Number.isSafeInteger(manifest.featureCount) &&
    manifest.featureCount > 0 &&
    Number.isSafeInteger(manifest.sourcePrimitiveCount) &&
    manifest.sourcePrimitiveCount > 0 &&
    Array.isArray(manifest.families) &&
    manifest.families.length > 0 &&
    !manifest.families.some((family) => family?.kind !== 'transcript') &&
    Number.isSafeInteger(manifest.partitionSpanBp) &&
    manifest.partitionSpanBp > 0 &&
    Number.isSafeInteger(manifest.maxPrimitiveSpanBp) &&
    manifest.maxPrimitiveSpanBp >= 0
  );
}

function isValidPacketEnvelopeRange(
  manifest: PartitionedTranscriptSceneDetailPacketManifestV1
): boolean {
  return (
    manifest.fineIndex?.schema === ANNOTATION_POLICY_DIRECT_FINE_INDEX_V1 &&
    manifest.fineIndex.tileSpanBp === FINE_TRANSCRIPT_VIEW_SPAN_BP &&
    Number.isSafeInteger(manifest.fineIndex.tileCount) &&
    manifest.fineIndex.tileCount > 0 &&
    Number.isSafeInteger(manifest.requestedRange?.startBp) &&
    Number.isSafeInteger(manifest.requestedRange?.endBp) &&
    manifest.requestedRange.startBp >= 0 &&
    manifest.requestedRange.endBp > manifest.requestedRange.startBp &&
    manifest.requestedRange.endBp <= manifest.assemblyLengthBp
  );
}

function isValidPacketSelectionOrder(selectedPartitionIndices: readonly number[]): boolean {
  for (let index = 0; index < selectedPartitionIndices.length; index++) {
    const partitionIndex = selectedPartitionIndices[index];
    if (
      !Number.isSafeInteger(partitionIndex) ||
      partitionIndex < 0 ||
      (index > 0 && partitionIndex <= selectedPartitionIndices[index - 1]!)
    ) {
      return false;
    }
  }
  return true;
}

function isValidPacketSectionLayout(
  manifest: PartitionedTranscriptSceneDetailPacketManifestV1,
  payload: Uint8Array
): boolean {
  let expectedOffset = 0;
  for (const section of [
    manifest.sections.expandedGlyphs,
    manifest.sections.expandedFeatureIndices,
    manifest.sections.expandedLanePrefixes,
    manifest.sections.canonicalGlyphs,
    manifest.sections.canonicalFeatureIndices,
    manifest.sections.canonicalLanePrefixes,
    manifest.sections.featureFamilyIndices,
    manifest.sections.expandedFineTileOffsets,
    manifest.sections.expandedFineBankRecordIndices,
    manifest.sections.canonicalFineTileOffsets,
    manifest.sections.canonicalFineBankRecordIndices,
    manifest.sections.sourceFineTilePrimitiveCounts,
    manifest.sections.interactionFeaturePrimitiveOffsets,
    manifest.sections.interactionFeaturePrimitiveIndices,
    manifest.sections.interactionActiveFeatureIndices,
  ]) {
    if (
      section.byteOffset !== expectedOffset ||
      section.byteLength !== section.count * section.recordBytes ||
      section.byteOffset % U32_BYTES !== 0 ||
      section.byteLength < 0
    ) {
      return false;
    }
    expectedOffset += section.byteLength;
  }
  return expectedOffset === payload.byteLength;
}

function isValidPacketFineIndexSections(
  manifest: PartitionedTranscriptSceneDetailPacketManifestV1
): boolean {
  return (
    manifest.sections.expandedFineTileOffsets.count === manifest.fineIndex.tileCount + 1 &&
    manifest.sections.canonicalFineTileOffsets.count === manifest.fineIndex.tileCount + 1 &&
    manifest.sections.sourceFineTilePrimitiveCounts.count === manifest.fineIndex.tileCount &&
    manifest.sections.expandedFineBankRecordIndices.count ===
      manifest.sections.expandedFeatureIndices.count &&
    manifest.sections.canonicalFineBankRecordIndices.count ===
      manifest.sections.canonicalFeatureIndices.count &&
    manifest.sections.interactionFeaturePrimitiveOffsets.count ===
      manifest.sections.interactionActiveFeatureIndices.count + 1 &&
    manifest.sections.interactionFeaturePrimitiveIndices.count ===
      manifest.sections.expandedFeatureIndices.count &&
    manifest.sections.interactionActiveFeatureIndices.count <= manifest.featureCount
  );
}

function assertPacketEnvelope(
  manifest: PartitionedTranscriptSceneDetailPacketManifestV1,
  payload: Uint8Array
): void {
  if (
    !isValidPacketEnvelopeIdentity(manifest, payload) ||
    !isValidPacketEnvelopeCounts(manifest) ||
    !isValidPacketEnvelopeRange(manifest)
  ) {
    throw new Error('partitioned transcript detail packet envelope is invalid');
  }
  if (!isValidPacketSelectionOrder(manifest.selectedPartitionIndices)) {
    throw new Error('partitioned transcript detail packet selection is invalid');
  }
  assertModeEnvelope(manifest, 'expanded', true);
  assertModeEnvelope(manifest, 'canonical', false);
  if (!isValidPacketSectionLayout(manifest, payload)) {
    throw new Error('partitioned transcript detail packet section layout is invalid');
  }
  if (!isValidPacketFineIndexSections(manifest)) {
    throw new Error('partitioned transcript detail packet fine index sections are invalid');
  }
}

function assertModeEnvelope(
  manifest: PartitionedTranscriptSceneDetailPacketManifestV1,
  mode: 'expanded' | 'canonical',
  exactSelection: boolean
): void {
  const contract = manifest[mode];
  const selected = new Set(manifest.selectedPartitionIndices);
  let firstInstance = 0;
  let lanePrefixOffset = 0;
  let previousPartitionIndex = -1;
  for (const partition of contract.partitions) {
    if (
      !selected.has(partition.partitionIndex) ||
      partition.partitionIndex <= previousPartitionIndex ||
      partition.firstInstance !== firstInstance ||
      partition.lanePrefixOffset !== lanePrefixOffset ||
      partition.instanceCount <= 0 ||
      partition.sourceInstanceCount < partition.instanceCount ||
      partition.hiddenByIsoformMembershipInstanceCount !==
        partition.sourceInstanceCount - partition.instanceCount ||
      partition.startBp !== partition.partitionIndex * manifest.partitionSpanBp ||
      partition.endBpExclusive <= partition.startBp ||
      partition.minStartBp < partition.startBp ||
      partition.maxEndBp <= partition.minStartBp
    ) {
      throw new Error(`partitioned transcript detail packet ${mode} partition is invalid`);
    }
    previousPartitionIndex = partition.partitionIndex;
    firstInstance += partition.instanceCount;
    lanePrefixOffset += partition.lanePrefixCount;
  }
  if (
    exactSelection &&
    (contract.partitions.length !== manifest.selectedPartitionIndices.length ||
      contract.partitions.some(
        (partition, index) => partition.partitionIndex !== manifest.selectedPartitionIndices[index]
      ))
  ) {
    throw new Error('partitioned transcript detail packet expanded selection is incomplete');
  }
  const glyphs = manifest.sections[`${mode}Glyphs`];
  const features = manifest.sections[`${mode}FeatureIndices`];
  const lanes = manifest.sections[`${mode}LanePrefixes`];
  if (
    glyphs.recordBytes !== TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes ||
    glyphs.count !== firstInstance ||
    features.recordBytes !== U32_BYTES ||
    features.count !== firstInstance ||
    lanes.recordBytes !== U32_BYTES ||
    lanes.count !== lanePrefixOffset
  ) {
    throw new Error(`partitioned transcript detail packet ${mode} sections are invalid`);
  }
  if (
    mode === 'expanded' &&
    manifest.sections.featureFamilyIndices.count !== manifest.featureCount
  ) {
    throw new Error('partitioned transcript detail packet feature families are incomplete');
  }
}

function f32View(payload: Uint8Array, section: DetailPacketSectionV1): Float32Array {
  return new Float32Array(
    payload.buffer,
    payload.byteOffset + section.byteOffset,
    section.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
}

function u32View(payload: Uint8Array, section: DetailPacketSectionV1): Uint32Array {
  return new Uint32Array(
    payload.buffer,
    payload.byteOffset + section.byteOffset,
    section.byteLength / Uint32Array.BYTES_PER_ELEMENT
  );
}
