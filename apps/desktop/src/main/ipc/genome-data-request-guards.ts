import {
  PREPACKED_ANNOTATION_SEARCH_MAX_QUERY_CODE_UNITS_V1,
  PREPACKED_PROTEIN_SEARCH_MAX_QUERY_RESIDUES_V1,
  PREPACKED_PROTEIN_SEARCH_MAX_RESULTS_V1,
  PREPACKED_PROTEIN_SEARCH_MIN_QUERY_RESIDUES_V1,
} from '@waypoint/genome-data';
import {
  COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2,
  PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
} from '@waypoint/genome-renderer/pure';

import type {
  AssemblyAnnotationSceneReadRequest,
  AssemblyAnnotationSearchCancelRequestV1,
  AssemblyAnnotationSearchQueryRequestV1,
  AssemblyProteinSearchCancelRequestV1,
  AssemblyProteinSearchQueryRequestV1,
  AssemblySequenceSearchRequestV1,
  AssemblySequenceSearchSourceV1,
  GenomeFeatureDetailsRequest,
  GenomeSearchOptions,
  GenomeSearchRequestIdentityV1,
  IndexedGenomeManifest,
} from '../../shared/indexed-genome';
import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  ASSEMBLY_SEQUENCE_SEARCH_SOURCE_V1,
  GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP,
  assemblyAnnotationSceneArtifactKey,
  assemblyAnnotationSceneScopeMatchesChromosomes,
} from '../../shared/indexed-genome';

const ANNOTATION_SEARCH_OPAQUE_ID_MAX_CODE_UNITS = 128;
const ASSEMBLY_ANNOTATION_SEARCH_MAX_CHROMOSOMES = 1_024;
const ASSEMBLY_ANNOTATION_SEARCH_MAX_CONTRACT_CODE_UNITS = 1_024;
const ASSEMBLY_ANNOTATION_SEARCH_MAX_PATH_CODE_UNITS = 32_768;
const ASSEMBLY_ANNOTATION_SEARCH_MAX_CHROM_CODE_UNITS = 512;
const ASSEMBLY_ANNOTATION_SEARCH_MAX_SOURCE_STRING_CODE_UNITS = 1_048_576;
const GENOME_SEQUENCE_SEARCH_MAX_MOTIF_CODE_UNITS = 16_384;
const GENOME_SEQUENCE_SEARCH_MAX_RESULTS = 500;
const ASSEMBLY_SEQUENCE_SEARCH_MAX_CHROMOSOMES = 1_024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isBoundedOpaqueSearchId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= ANNOTATION_SEARCH_OPAQUE_ID_MAX_CODE_UNITS
  );
}

export function isBoundedAssemblyAnnotationSearchQueryRequest(
  input: unknown
): input is AssemblyAnnotationSearchQueryRequestV1 {
  if (!input || typeof input !== 'object') return false;
  const request = input as Partial<AssemblyAnnotationSearchQueryRequestV1>;
  return Boolean(
    isBoundedAssemblyAnnotationSearchSource(request.source) &&
    isBoundedOpaqueSearchId(request.clientId) &&
    isBoundedOpaqueSearchId(request.requestId) &&
    typeof request.query === 'string' &&
    request.query.length <= PREPACKED_ANNOTATION_SEARCH_MAX_QUERY_CODE_UNITS_V1 &&
    Number.isInteger(request.limit) &&
    typeof request.limit === 'number' &&
    request.limit > 0 &&
    request.limit <= 500
  );
}

export function isBoundedAssemblyProteinSearchQueryRequest(
  input: unknown
): input is AssemblyProteinSearchQueryRequestV1 {
  if (!input || typeof input !== 'object') return false;
  const request = input as Partial<AssemblyProteinSearchQueryRequestV1>;
  if (
    !isBoundedAssemblyAnnotationSearchSource(request.source) ||
    !isBoundedOpaqueSearchId(request.clientId) ||
    !isBoundedOpaqueSearchId(request.requestId) ||
    typeof request.query !== 'string' ||
    request.query.length > PREPACKED_PROTEIN_SEARCH_MAX_QUERY_RESIDUES_V1 * 4 ||
    !Number.isInteger(request.limit) ||
    typeof request.limit !== 'number' ||
    request.limit <= 0 ||
    request.limit > PREPACKED_PROTEIN_SEARCH_MAX_RESULTS_V1
  ) {
    return false;
  }
  const normalized = request.query.replace(/\s+/g, '').toUpperCase();
  return (
    normalized.length >= PREPACKED_PROTEIN_SEARCH_MIN_QUERY_RESIDUES_V1 &&
    normalized.length <= PREPACKED_PROTEIN_SEARCH_MAX_QUERY_RESIDUES_V1 &&
    /^[ACDEFGHIKLMNPQRSTVWY]+$/.test(normalized)
  );
}

function admitBoundedAssemblySearchChromosome(
  chromosome: unknown,
  admitStringSize: (value: string) => boolean
): { sourced: boolean } | null {
  if (
    !hasExactEnumerableKeys(chromosome, ['chrom', 'length'], ['sourcePath', 'manifest']) ||
    !isBoundedContractString(chromosome.chrom, ASSEMBLY_ANNOTATION_SEARCH_MAX_CHROM_CODE_UNITS) ||
    typeof chromosome.length !== 'number' ||
    !Number.isSafeInteger(chromosome.length) ||
    chromosome.length <= 0 ||
    (chromosome.sourcePath !== undefined &&
      chromosome.sourcePath !== null &&
      !isBoundedCanonicalPath(
        chromosome.sourcePath,
        ASSEMBLY_ANNOTATION_SEARCH_MAX_PATH_CODE_UNITS
      ))
  ) {
    return null;
  }
  const sourcePath = chromosome.sourcePath;
  const sourced = typeof sourcePath === 'string';
  if (sourced) {
    if (
      !isBoundedCompleteAssemblySearchManifest(
        chromosome.manifest,
        chromosome.chrom,
        chromosome.length,
        sourcePath
      )
    ) {
      return null;
    }
    if (
      !admitStringSize(chromosome.chrom) ||
      !admitStringSize(sourcePath) ||
      !admitStringSize(chromosome.manifest.fastaPath) ||
      !admitStringSize(chromosome.manifest.faiPath) ||
      !admitStringSize(chromosome.manifest.gffPath) ||
      !admitStringSize(chromosome.manifest.tbiPath)
    ) {
      return null;
    }
    return { sourced: true };
  }
  if (chromosome.manifest !== undefined && chromosome.manifest !== null) return null;
  if (!admitStringSize(chromosome.chrom)) return null;
  return { sourced: false };
}

function isBoundedAssemblyAnnotationSearchDataset(
  dataset: unknown,
  admitStringSize: (value: string) => boolean
): dataset is {
  datasetId: string;
  datasetVersion: string;
  sourceSha256: string;
} {
  return (
    hasExactEnumerableKeys(dataset, ['datasetId', 'datasetVersion', 'sourceSha256']) &&
    isBoundedContractString(dataset.datasetId) &&
    isBoundedContractString(dataset.datasetVersion) &&
    typeof dataset.sourceSha256 === 'string' &&
    SHA256_HEX.test(dataset.sourceSha256) &&
    admitStringSize(dataset.datasetId) &&
    admitStringSize(dataset.datasetVersion) &&
    admitStringSize(dataset.sourceSha256)
  );
}

function isBoundedAssemblyAnnotationSearchArtifact(
  artifact: unknown,
  admitStringSize: (value: string) => boolean
): boolean {
  if (
    !hasExactEnumerableKeys(artifact, [
      'artifactKey',
      'themeMode',
      'trackType',
      'partitionSpanBp',
      'annotationBarHeightPx',
      'laneAlgorithmToken',
      'mapperContractToken',
      'geometryContractToken',
      'interactionContractToken',
    ]) ||
    !isBoundedContractString(artifact.artifactKey) ||
    (artifact.themeMode !== 'light' && artifact.themeMode !== 'dark') ||
    !isBoundedContractString(artifact.trackType) ||
    artifact.partitionSpanBp !== PREPACKED_ANNOTATION_PARTITION_SPAN_BP ||
    artifact.annotationBarHeightPx !== PREPACKED_ANNOTATION_BAR_HEIGHT_PX ||
    artifact.laneAlgorithmToken !== PREPACKED_ANNOTATION_LANE_TOKEN ||
    artifact.mapperContractToken !== PREPACKED_ANNOTATION_MAPPER_TOKEN ||
    artifact.geometryContractToken !== PREPACKED_ANNOTATION_GEOMETRY_TOKEN ||
    artifact.interactionContractToken !== PREPACKED_ANNOTATION_INTERACTION_TOKEN
  ) {
    return false;
  }
  return (
    [
      artifact.artifactKey,
      artifact.trackType,
      artifact.laneAlgorithmToken,
      artifact.mapperContractToken,
      artifact.geometryContractToken,
      artifact.interactionContractToken,
    ].every(admitStringSize) &&
    artifact.artifactKey ===
      assemblyAnnotationSceneArtifactKey({
        themeMode: artifact.themeMode,
        trackType: artifact.trackType,
        partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
        annotationBarHeightPx: PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
        laneAlgorithmToken: artifact.laneAlgorithmToken,
        mapperContractToken: artifact.mapperContractToken,
        geometryContractToken: artifact.geometryContractToken,
        interactionContractToken: artifact.interactionContractToken,
      })
  );
}

export function isBoundedAssemblyAnnotationSearchSource(
  source: unknown
): source is AssemblyAnnotationSceneReadRequest {
  if (
    !hasExactEnumerableKeys(
      source,
      [
        'ipcContractVersion',
        'assemblyId',
        'chromosomes',
        'workspaceRoot',
        'scope',
        'datasetContract',
        'artifact',
        'requestedPolicy',
      ],
      ['datasetVersion']
    )
  ) {
    return false;
  }
  const request = source;
  let remainingStringCodeUnits = ASSEMBLY_ANNOTATION_SEARCH_MAX_SOURCE_STRING_CODE_UNITS;
  const admitStringSize = (value: string): boolean => {
    remainingStringCodeUnits -= value.length;
    return remainingStringCodeUnits >= 0;
  };
  if (
    request.ipcContractVersion !== ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT ||
    !isBoundedContractString(request.assemblyId) ||
    !isBoundedCanonicalPath(
      request.workspaceRoot,
      ASSEMBLY_ANNOTATION_SEARCH_MAX_PATH_CODE_UNITS
    ) ||
    !isDenseArrayWithNoExtraEnumerableKeys(
      request.chromosomes,
      ASSEMBLY_ANNOTATION_SEARCH_MAX_CHROMOSOMES
    ) ||
    request.chromosomes.length === 0 ||
    !admitStringSize(request.assemblyId) ||
    !admitStringSize(request.workspaceRoot) ||
    (request.datasetVersion !== undefined &&
      (!isBoundedContractString(request.datasetVersion) ||
        !admitStringSize(request.datasetVersion)))
  ) {
    return false;
  }

  let sourcedChromosomeCount = 0;
  for (const chromosome of request.chromosomes) {
    const admitted = admitBoundedAssemblySearchChromosome(chromosome, admitStringSize);
    if (!admitted) return false;
    if (admitted.sourced) sourcedChromosomeCount += 1;
  }

  if (
    !hasExactEnumerableKeys(request.scope, ['kind', 'placements']) ||
    request.scope.kind !== 'complete-assembly' ||
    !isDenseArrayWithNoExtraEnumerableKeys(
      request.scope.placements,
      ASSEMBLY_ANNOTATION_SEARCH_MAX_CHROMOSOMES
    )
  ) {
    return false;
  }
  for (const placement of request.scope.placements) {
    if (
      !hasExactEnumerableKeys(placement, ['chrom', 'length', 'annotationCoverage']) ||
      !isBoundedContractString(placement.chrom, ASSEMBLY_ANNOTATION_SEARCH_MAX_CHROM_CODE_UNITS) ||
      typeof placement.length !== 'number' ||
      !Number.isSafeInteger(placement.length) ||
      placement.length <= 0 ||
      (placement.annotationCoverage !== 'sourced' && placement.annotationCoverage !== 'unsourced')
    ) {
      return false;
    }
    if (!admitStringSize(placement.chrom)) return false;
  }
  if (
    sourcedChromosomeCount === 0 ||
    !assemblyAnnotationSceneScopeMatchesChromosomes(request.scope, request.chromosomes)
  ) {
    return false;
  }

  const datasetContract = request.datasetContract;
  if (!isBoundedAssemblyAnnotationSearchDataset(datasetContract, admitStringSize)) {
    return false;
  }
  if (
    request.datasetVersion !== undefined &&
    request.datasetVersion !== datasetContract.datasetVersion
  ) {
    return false;
  }

  if (!isBoundedAssemblyAnnotationSearchArtifact(request.artifact, admitStringSize)) {
    return false;
  }

  const policy = request.requestedPolicy;
  return Boolean(
    hasExactEnumerableKeys(policy, ['isoformMode', 'laneLimit']) &&
    (policy.isoformMode === 'canonical' || policy.isoformMode === 'expanded') &&
    (policy.laneLimit === null ||
      (typeof policy.laneLimit === 'number' &&
        Number.isSafeInteger(policy.laneLimit) &&
        policy.laneLimit > 0 &&
        policy.laneLimit <= COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2))
  );
}

function isBoundedCompleteAssemblySearchManifest(
  input: unknown,
  chrom: string,
  length: number,
  sourcePath: string
): input is IndexedGenomeManifest & { gffPath: string; tbiPath: string } {
  if (
    !hasExactEnumerableKeys(
      input,
      ['chrom', 'fastaPath', 'faiPath'],
      ['gffPath', 'tbiPath', 'length', 'circular']
    )
  ) {
    return false;
  }
  return (
    input.chrom === chrom &&
    input.gffPath === sourcePath &&
    isBoundedCanonicalPath(input.fastaPath, ASSEMBLY_ANNOTATION_SEARCH_MAX_PATH_CODE_UNITS) &&
    isBoundedCanonicalPath(input.faiPath, ASSEMBLY_ANNOTATION_SEARCH_MAX_PATH_CODE_UNITS) &&
    isBoundedCanonicalPath(input.gffPath, ASSEMBLY_ANNOTATION_SEARCH_MAX_PATH_CODE_UNITS) &&
    isBoundedCanonicalPath(input.tbiPath, ASSEMBLY_ANNOTATION_SEARCH_MAX_PATH_CODE_UNITS) &&
    (input.length === undefined || input.length === length) &&
    (input.circular === undefined || typeof input.circular === 'boolean')
  );
}

function isBoundedNonEmptyString(value: unknown, maxCodeUnits: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxCodeUnits &&
    value.trim().length > 0
  );
}

function isBoundedCanonicalPath(value: unknown, maxCodeUnits: number): value is string {
  return isBoundedNonEmptyString(value, maxCodeUnits) && value === value.trim();
}

function isBoundedWorkspaceRootPaths(value: unknown): value is string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 64 &&
      value.every((root) =>
        isBoundedCanonicalPath(root, ASSEMBLY_ANNOTATION_SEARCH_MAX_PATH_CODE_UNITS)
      ))
  );
}

function isBoundedContractString(
  value: unknown,
  maxCodeUnits = ASSEMBLY_ANNOTATION_SEARCH_MAX_CONTRACT_CODE_UNITS
): value is string {
  return (
    isBoundedNonEmptyString(value, maxCodeUnits) &&
    value === value.trim() &&
    !value.includes('\r') &&
    !value.includes('\n')
  );
}

function hasExactEnumerableKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key) || !allowed.has(key)) return false;
  }
  return required.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}

function isDenseArrayWithNoExtraEnumerableKeys(
  value: unknown,
  maxLength: number
): value is unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) return false;
  let index = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || key !== String(index)) return false;
    index += 1;
  }
  return index === value.length;
}

export function isBoundedAssemblyAnnotationSearchCancelRequest(
  input: unknown
): input is AssemblyAnnotationSearchCancelRequestV1 {
  return isBoundedGenomeSearchRequestIdentity(input);
}

export function isBoundedAssemblyProteinSearchCancelRequest(
  input: unknown
): input is AssemblyProteinSearchCancelRequestV1 {
  return isBoundedGenomeSearchRequestIdentity(input);
}

export function isBoundedGenomeSearchRequestIdentity(
  input: unknown
): input is GenomeSearchRequestIdentityV1 {
  if (!input || typeof input !== 'object') return false;
  const request = input as Partial<GenomeSearchRequestIdentityV1>;
  return isBoundedOpaqueSearchId(request.clientId) && isBoundedOpaqueSearchId(request.requestId);
}

export function isBoundedGenomeSequenceSearchRequest(input: {
  manifest: unknown;
  chrom: unknown;
  motif: unknown;
  opts: unknown;
  control: unknown;
}): input is {
  manifest: IndexedGenomeManifest;
  chrom: string;
  motif: string;
  opts: GenomeSearchOptions;
  control: GenomeSearchRequestIdentityV1;
} {
  if (!input.manifest || typeof input.manifest !== 'object') return false;
  const manifest = input.manifest as Partial<IndexedGenomeManifest>;
  if (
    typeof input.chrom !== 'string' ||
    input.chrom.length === 0 ||
    input.chrom.length > 512 ||
    input.chrom !== manifest.chrom ||
    typeof input.motif !== 'string' ||
    input.motif.length === 0 ||
    input.motif.length > GENOME_SEQUENCE_SEARCH_MAX_MOTIF_CODE_UNITS ||
    !isBoundedGenomeSearchRequestIdentity(input.control) ||
    !input.opts ||
    typeof input.opts !== 'object'
  ) {
    return false;
  }
  const opts = input.opts as GenomeSearchOptions & { signal?: unknown };
  return (
    opts.signal === undefined &&
    isOptionalFiniteCoordinate(opts.start) &&
    isOptionalFiniteCoordinate(opts.end) &&
    (opts.start === undefined || opts.end === undefined || opts.end >= opts.start) &&
    (opts.chunkSize === undefined ||
      (Number.isInteger(opts.chunkSize) &&
        opts.chunkSize > 0 &&
        opts.chunkSize <= 16 * 1024 * 1024)) &&
    Number.isInteger(opts.maxResults) &&
    typeof opts.maxResults === 'number' &&
    opts.maxResults > 0 &&
    opts.maxResults <= GENOME_SEQUENCE_SEARCH_MAX_RESULTS &&
    (opts.reverseComplement === undefined || typeof opts.reverseComplement === 'boolean') &&
    (opts.caseSensitive === undefined || typeof opts.caseSensitive === 'boolean') &&
    (opts.validateIupacDna === undefined || typeof opts.validateIupacDna === 'boolean')
  );
}

export function isBoundedAssemblySequenceSearchRequest(
  input: unknown
): input is AssemblySequenceSearchRequestV1 {
  if (
    !hasExactEnumerableKeys(
      input,
      ['source', 'clientId', 'requestId', 'motif', 'limit', 'reverseComplement'],
      ['caseSensitive']
    )
  ) {
    return false;
  }
  const request = input;
  return (
    isBoundedAssemblySequenceSearchSource(request.source) &&
    isBoundedOpaqueSearchId(request.clientId) &&
    isBoundedOpaqueSearchId(request.requestId) &&
    typeof request.motif === 'string' &&
    request.motif.length > 0 &&
    request.motif.length <= GENOME_SEQUENCE_SEARCH_MAX_MOTIF_CODE_UNITS &&
    typeof request.limit === 'number' &&
    Number.isInteger(request.limit) &&
    request.limit > 0 &&
    request.limit <= GENOME_SEQUENCE_SEARCH_MAX_RESULTS &&
    typeof request.reverseComplement === 'boolean' &&
    (request.caseSensitive === undefined || typeof request.caseSensitive === 'boolean')
  );
}

function isBoundedAssemblySequenceSearchSource(
  input: unknown
): input is AssemblySequenceSearchSourceV1 {
  if (!hasExactEnumerableKeys(input, ['contract', 'assemblyId', 'chromosomes'])) return false;
  const source = input;
  if (
    source.contract !== ASSEMBLY_SEQUENCE_SEARCH_SOURCE_V1 ||
    !isBoundedContractString(source.assemblyId) ||
    !isDenseArrayWithNoExtraEnumerableKeys(
      source.chromosomes,
      ASSEMBLY_SEQUENCE_SEARCH_MAX_CHROMOSOMES
    ) ||
    source.chromosomes.length === 0
  ) {
    return false;
  }

  let totalLength = 0;
  let remainingStringCodeUnits =
    ASSEMBLY_ANNOTATION_SEARCH_MAX_SOURCE_STRING_CODE_UNITS - source.assemblyId.length;
  const seenChromosomes = new Set<string>();
  for (const chromosome of source.chromosomes) {
    if (
      !hasExactEnumerableKeys(chromosome, ['chrom', 'length', 'manifest']) ||
      !isBoundedContractString(chromosome.chrom, ASSEMBLY_ANNOTATION_SEARCH_MAX_CHROM_CODE_UNITS) ||
      seenChromosomes.has(chromosome.chrom) ||
      typeof chromosome.length !== 'number' ||
      !Number.isSafeInteger(chromosome.length) ||
      chromosome.length <= 0 ||
      !isBoundedAssemblySequenceSearchManifest(
        chromosome.manifest,
        chromosome.chrom,
        chromosome.length
      )
    ) {
      return false;
    }
    seenChromosomes.add(chromosome.chrom);
    totalLength += chromosome.length;
    remainingStringCodeUnits -=
      chromosome.chrom.length +
      chromosome.manifest.fastaPath.length +
      chromosome.manifest.faiPath.length +
      (chromosome.manifest.gffPath?.length ?? 0) +
      (chromosome.manifest.tbiPath?.length ?? 0);
    if (!Number.isSafeInteger(totalLength) || remainingStringCodeUnits < 0) return false;
  }
  return true;
}

function isBoundedAssemblySequenceSearchManifest(
  input: unknown,
  chrom: string,
  length: number
): input is IndexedGenomeManifest {
  if (
    !hasExactEnumerableKeys(
      input,
      ['chrom', 'fastaPath', 'faiPath'],
      ['gffPath', 'tbiPath', 'length', 'circular']
    )
  ) {
    return false;
  }
  const manifest = input;
  return (
    manifest.chrom === chrom &&
    isBoundedCanonicalPath(manifest.fastaPath, ASSEMBLY_ANNOTATION_SEARCH_MAX_PATH_CODE_UNITS) &&
    isBoundedCanonicalPath(manifest.faiPath, ASSEMBLY_ANNOTATION_SEARCH_MAX_PATH_CODE_UNITS) &&
    (manifest.gffPath === undefined ||
      manifest.gffPath === null ||
      isBoundedCanonicalPath(manifest.gffPath, ASSEMBLY_ANNOTATION_SEARCH_MAX_PATH_CODE_UNITS)) &&
    (manifest.tbiPath === undefined ||
      manifest.tbiPath === null ||
      isBoundedCanonicalPath(manifest.tbiPath, ASSEMBLY_ANNOTATION_SEARCH_MAX_PATH_CODE_UNITS)) &&
    (manifest.length === undefined || manifest.length === length) &&
    (manifest.circular === undefined || typeof manifest.circular === 'boolean')
  );
}

function isOptionalFiniteCoordinate(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
}

export function assertLegacyGetFeaturesRequestAllowed(input: {
  manifest: IndexedGenomeManifest;
  chrom: string;
  start: number;
  end: number;
  zoomLevel: number;
}): void {
  const { manifest, chrom, start, end, zoomLevel } = input;
  if (typeof chrom !== 'string' || chrom.trim().length === 0) {
    throw new Error('[genome] Legacy getFeatures chrom is required.');
  }
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !Number.isFinite(zoomLevel) ||
    start < 0 ||
    end < start
  ) {
    throw new Error(`[genome] Invalid legacy getFeatures range: ${start}-${end}.`);
  }
  if (chrom !== manifest.chrom) {
    throw new Error(
      `[genome] Legacy getFeatures chrom mismatch: request=${chrom} manifest=${manifest.chrom}.`
    );
  }

  const span = end - start;
  const length = manifest.length;
  const coversKnownChromosome =
    typeof length === 'number' &&
    Number.isFinite(length) &&
    length > 0 &&
    start <= 0 &&
    end >= length;
  if (span > GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP || coversKnownChromosome) {
    throw new Error(
      `[genome] Legacy getFeatures is limited to ${GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP} bp. Use genome:getAnnotationTile for indexed annotation rendering.`
    );
  }
}

export function assertLegacyGetFeatureDetailsRequestAllowed(input: {
  manifest: IndexedGenomeManifest;
  request: GenomeFeatureDetailsRequest;
}): void {
  const { manifest, request } = input;
  const declaredLength = manifest.length;
  const validationLength =
    typeof declaredLength === 'number' && Number.isSafeInteger(declaredLength) && declaredLength > 0
      ? declaredLength
      : 1;
  if (!isBoundedLegacyFeatureDetailsManifest(manifest, manifest.chrom, validationLength)) {
    throw new Error('[genome] Invalid legacy feature-details manifest.');
  }
  if (
    !hasExactEnumerableKeys(request, ['chrom', 'start', 'end'], ['featureId', 'maxWindowBp']) ||
    typeof request.chrom !== 'string' ||
    request.chrom.trim().length === 0 ||
    request.chrom !== manifest.chrom ||
    !Number.isSafeInteger(request.start) ||
    !Number.isSafeInteger(request.end) ||
    request.start < 0 ||
    request.end < request.start ||
    (request.featureId !== undefined &&
      (typeof request.featureId !== 'string' || request.featureId.length === 0))
  ) {
    throw new Error('[genome] Invalid legacy feature-details request.');
  }
  const maxWindowBp = request.maxWindowBp ?? 500_000;
  if (
    !Number.isSafeInteger(maxWindowBp) ||
    maxWindowBp <= 0 ||
    maxWindowBp > GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP ||
    request.end - request.start > GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP ||
    (typeof declaredLength === 'number' && request.end > declaredLength)
  ) {
    throw new Error(
      `[genome] Legacy feature details are limited to ${GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP} bp.`
    );
  }
}

function isBoundedLegacyFeatureDetailsManifest(
  input: unknown,
  chrom: string,
  length: number
): input is IndexedGenomeManifest {
  if (
    !hasExactEnumerableKeys(
      input,
      ['chrom', 'fastaPath', 'faiPath'],
      ['gffPath', 'tbiPath', 'length', 'circular', 'workspaceRootPaths']
    )
  ) {
    return false;
  }
  const manifest = input;
  return (
    manifest.chrom === chrom &&
    isBoundedCanonicalPath(manifest.fastaPath, ASSEMBLY_ANNOTATION_SEARCH_MAX_PATH_CODE_UNITS) &&
    isBoundedCanonicalPath(manifest.faiPath, ASSEMBLY_ANNOTATION_SEARCH_MAX_PATH_CODE_UNITS) &&
    (manifest.gffPath === undefined ||
      manifest.gffPath === null ||
      isBoundedCanonicalPath(manifest.gffPath, ASSEMBLY_ANNOTATION_SEARCH_MAX_PATH_CODE_UNITS)) &&
    (manifest.tbiPath === undefined ||
      manifest.tbiPath === null ||
      isBoundedCanonicalPath(manifest.tbiPath, ASSEMBLY_ANNOTATION_SEARCH_MAX_PATH_CODE_UNITS)) &&
    isBoundedWorkspaceRootPaths(manifest.workspaceRootPaths) &&
    (manifest.length === undefined || manifest.length === length) &&
    (manifest.circular === undefined || typeof manifest.circular === 'boolean')
  );
}
