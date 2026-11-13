import type {
  PartitionedTranscriptSceneBinaryManifestV4,
  PartitionedTranscriptSceneBinarySha256V4,
} from './partitioned-transcript-scene-binary-v4';

export const PARTITIONED_TRANSCRIPT_SCENE_RANGE_CATALOG_V1 =
  'partitioned-transcript-scene-range-catalog.v1' as const;

export interface AuthenticatedTranscriptSceneRangeV1 {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface PartitionedTranscriptSceneModePartitionRangeV1 {
  readonly key: string;
  readonly partitionIndex: number;
  readonly startBp: number;
  readonly endBpExclusive: number;
  readonly minStartBp: number;
  readonly maxEndBp: number;
  readonly instanceCount: number;
  readonly sourceInstanceCount: number;
  readonly hiddenByIsoformMembershipInstanceCount: number;
  readonly lanePrefixCount: number;
  readonly glyphs: AuthenticatedTranscriptSceneRangeV1;
  readonly featureIndices: AuthenticatedTranscriptSceneRangeV1;
  readonly lanePrefixes: AuthenticatedTranscriptSceneRangeV1;
}

export interface PartitionedTranscriptSceneModeRangeCatalogV1 {
  readonly mode: 'expanded' | 'canonical';
  readonly maxTrackLane: number;
  readonly partitions: readonly PartitionedTranscriptSceneModePartitionRangeV1[];
}

export interface PartitionedTranscriptSceneRangeCatalogV1 {
  readonly schema: typeof PARTITIONED_TRANSCRIPT_SCENE_RANGE_CATALOG_V1;
  readonly sourceScene: Readonly<{
    schema: PartitionedTranscriptSceneBinaryManifestV4['schema'];
    byteLength: number;
    payloadSha256: string;
    contractSha256: string;
  }>;
  readonly partitionSpanBp: number;
  readonly maxPrimitiveSpanBp: number;
  readonly featureFamilyIndices: AuthenticatedTranscriptSceneRangeV1;
  readonly expanded: PartitionedTranscriptSceneModeRangeCatalogV1;
  readonly canonical: PartitionedTranscriptSceneModeRangeCatalogV1;
}

type Mode = 'expanded' | 'canonical';

const SHA256 = /^[0-9a-f]{64}$/;

export async function buildPartitionedTranscriptSceneRangeCatalogV1(
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  payload: Uint8Array,
  payloadSha256: PartitionedTranscriptSceneBinarySha256V4
): Promise<PartitionedTranscriptSceneRangeCatalogV1> {
  if (!(payload instanceof Uint8Array) || payload.byteLength !== manifest.byteLength) {
    throw new Error('partitioned transcript range catalog payload length is invalid');
  }
  const featureFamilyRange = rangeForRecords(
    manifest.sections.featureFamilyIndices.byteOffset,
    manifest.sections.featureFamilyIndices.recordBytes,
    0,
    manifest.sections.featureFamilyIndices.count
  );
  const catalog: PartitionedTranscriptSceneRangeCatalogV1 = Object.freeze({
    schema: PARTITIONED_TRANSCRIPT_SCENE_RANGE_CATALOG_V1,
    sourceScene: Object.freeze({
      schema: manifest.schema,
      byteLength: manifest.byteLength,
      payloadSha256: manifest.integrity.payloadSha256,
      contractSha256: manifest.integrity.contractSha256,
    }),
    partitionSpanBp: manifest.partitionSpanBp,
    maxPrimitiveSpanBp: manifest.maxPrimitiveSpanBp,
    featureFamilyIndices: Object.freeze({
      ...featureFamilyRange,
      sha256: await hashRange(payload, featureFamilyRange, payloadSha256),
    }),
    expanded: await buildModeCatalog(manifest, payload, payloadSha256, 'expanded'),
    canonical: await buildModeCatalog(manifest, payload, payloadSha256, 'canonical'),
  });
  assertPartitionedTranscriptSceneRangeCatalogV1(catalog, manifest);
  return catalog;
}

export function assertPartitionedTranscriptSceneRangeCatalogV1(
  catalog: PartitionedTranscriptSceneRangeCatalogV1,
  manifest: PartitionedTranscriptSceneBinaryManifestV4
): void {
  if (
    catalog?.schema !== PARTITIONED_TRANSCRIPT_SCENE_RANGE_CATALOG_V1 ||
    catalog.sourceScene?.schema !== manifest.schema ||
    catalog.sourceScene.byteLength !== manifest.byteLength ||
    catalog.sourceScene.payloadSha256 !== manifest.integrity.payloadSha256 ||
    catalog.sourceScene.contractSha256 !== manifest.integrity.contractSha256 ||
    catalog.partitionSpanBp !== manifest.partitionSpanBp ||
    catalog.maxPrimitiveSpanBp !== manifest.maxPrimitiveSpanBp ||
    !sameAuthenticatedRange(
      catalog.featureFamilyIndices,
      rangeForRecords(
        manifest.sections.featureFamilyIndices.byteOffset,
        manifest.sections.featureFamilyIndices.recordBytes,
        0,
        manifest.sections.featureFamilyIndices.count
      )
    )
  ) {
    throw new Error('partitioned transcript range catalog source identity is invalid');
  }
  assertModeCatalog(catalog.expanded, manifest, 'expanded');
  assertModeCatalog(catalog.canonical, manifest, 'canonical');
}

export function resealPartitionedTranscriptSceneRangeCatalogV1(
  catalog: PartitionedTranscriptSceneRangeCatalogV1,
  publishedManifest: PartitionedTranscriptSceneBinaryManifestV4,
  installedManifest: PartitionedTranscriptSceneBinaryManifestV4
): PartitionedTranscriptSceneRangeCatalogV1 {
  assertPartitionedTranscriptSceneRangeCatalogV1(catalog, publishedManifest);
  const resealed: PartitionedTranscriptSceneRangeCatalogV1 = Object.freeze({
    ...catalog,
    sourceScene: Object.freeze({
      ...catalog.sourceScene,
      contractSha256: installedManifest.integrity.contractSha256,
    }),
  });
  assertPartitionedTranscriptSceneRangeCatalogV1(resealed, installedManifest);
  return resealed;
}

async function buildModeCatalog(
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  payload: Uint8Array,
  payloadSha256: PartitionedTranscriptSceneBinarySha256V4,
  mode: Mode
): Promise<PartitionedTranscriptSceneModeRangeCatalogV1> {
  const contract = manifest.directContract[mode];
  const glyphSection = manifest.sections[`${mode}Glyphs`];
  const featureSection = manifest.sections[`${mode}FeatureIndices`];
  const laneSection = manifest.sections[`${mode}LanePrefixes`];
  const partitions: PartitionedTranscriptSceneModePartitionRangeV1[] = [];
  for (const partition of contract.partitions) {
    const glyphs = rangeForRecords(
      glyphSection.byteOffset,
      glyphSection.recordBytes,
      partition.firstInstance,
      partition.instanceCount
    );
    const featureIndices = rangeForRecords(
      featureSection.byteOffset,
      featureSection.recordBytes,
      partition.firstInstance,
      partition.instanceCount
    );
    const lanePrefixes = rangeForRecords(
      laneSection.byteOffset,
      laneSection.recordBytes,
      partition.lanePrefixOffset,
      partition.lanePrefixCount
    );
    const [glyphSha256, featureSha256, laneSha256] = await Promise.all([
      hashRange(payload, glyphs, payloadSha256),
      hashRange(payload, featureIndices, payloadSha256),
      hashRange(payload, lanePrefixes, payloadSha256),
    ]);
    partitions.push(
      Object.freeze({
        key: partition.key,
        partitionIndex: partition.partitionIndex,
        startBp: partition.startBp,
        endBpExclusive: partition.endBpExclusive,
        minStartBp: partition.minStartBp,
        maxEndBp: partition.maxEndBp,
        instanceCount: partition.instanceCount,
        sourceInstanceCount: partition.sourceInstanceCount,
        hiddenByIsoformMembershipInstanceCount: partition.hiddenByIsoformMembershipInstanceCount,
        lanePrefixCount: partition.lanePrefixCount,
        glyphs: Object.freeze({ ...glyphs, sha256: glyphSha256 }),
        featureIndices: Object.freeze({ ...featureIndices, sha256: featureSha256 }),
        lanePrefixes: Object.freeze({ ...lanePrefixes, sha256: laneSha256 }),
      })
    );
  }
  return Object.freeze({
    mode,
    maxTrackLane: contract.maxTrackLane,
    partitions: Object.freeze(partitions),
  });
}

function assertModeCatalog(
  catalog: PartitionedTranscriptSceneModeRangeCatalogV1,
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  mode: Mode
): void {
  const contract = manifest.directContract[mode];
  if (
    catalog?.mode !== mode ||
    catalog.maxTrackLane !== contract.maxTrackLane ||
    catalog.partitions.length !== contract.partitions.length
  ) {
    throw new Error(`partitioned transcript ${mode} range catalog shape is invalid`);
  }
  const glyphSection = manifest.sections[`${mode}Glyphs`];
  const featureSection = manifest.sections[`${mode}FeatureIndices`];
  const laneSection = manifest.sections[`${mode}LanePrefixes`];
  for (let index = 0; index < contract.partitions.length; index++) {
    const expected = contract.partitions[index];
    const actual = catalog.partitions[index];
    if (
      !actual ||
      actual.key !== expected.key ||
      actual.partitionIndex !== expected.partitionIndex ||
      actual.startBp !== expected.startBp ||
      actual.endBpExclusive !== expected.endBpExclusive ||
      actual.minStartBp !== expected.minStartBp ||
      actual.maxEndBp !== expected.maxEndBp ||
      actual.instanceCount !== expected.instanceCount ||
      actual.sourceInstanceCount !== expected.sourceInstanceCount ||
      actual.hiddenByIsoformMembershipInstanceCount !==
        expected.hiddenByIsoformMembershipInstanceCount ||
      actual.lanePrefixCount !== expected.lanePrefixCount ||
      !sameAuthenticatedRange(
        actual.glyphs,
        rangeForRecords(
          glyphSection.byteOffset,
          glyphSection.recordBytes,
          expected.firstInstance,
          expected.instanceCount
        )
      ) ||
      !sameAuthenticatedRange(
        actual.featureIndices,
        rangeForRecords(
          featureSection.byteOffset,
          featureSection.recordBytes,
          expected.firstInstance,
          expected.instanceCount
        )
      ) ||
      !sameAuthenticatedRange(
        actual.lanePrefixes,
        rangeForRecords(
          laneSection.byteOffset,
          laneSection.recordBytes,
          expected.lanePrefixOffset,
          expected.lanePrefixCount
        )
      )
    ) {
      throw new Error(`partitioned transcript ${mode} range catalog partition is invalid`);
    }
  }
}

function rangeForRecords(
  sectionByteOffset: number,
  recordBytes: number,
  firstRecord: number,
  recordCount: number
): Omit<AuthenticatedTranscriptSceneRangeV1, 'sha256'> {
  return {
    byteOffset: sectionByteOffset + firstRecord * recordBytes,
    byteLength: recordCount * recordBytes,
  };
}

async function hashRange(
  payload: Uint8Array,
  range: Omit<AuthenticatedTranscriptSceneRangeV1, 'sha256'>,
  payloadSha256: PartitionedTranscriptSceneBinarySha256V4
): Promise<string> {
  const end = range.byteOffset + range.byteLength;
  if (
    !Number.isSafeInteger(range.byteOffset) ||
    !Number.isSafeInteger(range.byteLength) ||
    range.byteOffset < 0 ||
    range.byteLength < 0 ||
    end > payload.byteLength
  ) {
    throw new Error(
      `partitioned transcript catalog range is outside the payload: ${range.byteOffset}+${range.byteLength}/${payload.byteLength}`
    );
  }
  const sha256 = await payloadSha256(payload.subarray(range.byteOffset, end));
  if (!SHA256.test(sha256)) {
    throw new Error('partitioned transcript catalog range hash is invalid');
  }
  return sha256;
}

function sameAuthenticatedRange(
  actual: AuthenticatedTranscriptSceneRangeV1,
  expected: Omit<AuthenticatedTranscriptSceneRangeV1, 'sha256'>
): boolean {
  return (
    actual.byteOffset === expected.byteOffset &&
    actual.byteLength === expected.byteLength &&
    SHA256.test(actual.sha256)
  );
}
