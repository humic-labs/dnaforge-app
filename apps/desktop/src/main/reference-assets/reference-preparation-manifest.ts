import './node-sha256-sync';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type {
  ReferenceAssemblyEntry,
  ReferenceAssemblyMember,
} from '../../features/sequence/reference-catalog';
import {
  REFERENCE_PREPARATION_MANIFEST_V2,
  type LoadedReferencePreparationManifestV2,
  type HostedReferencePreparationManifestAdmissionV2,
  parseReferencePreparationManifestV2,
  parseHostedReferencePreparationManifestV2,
  preparedReferenceDefinitionV2,
} from './reference-preparation-manifest-v2';
import {
  assertAliasUniqueness,
  optionalAliases,
  optionalBoolean,
  optionalPositiveInteger,
  optionalSequenceRole,
  optionalText,
  preparedAnnotationIndexPath,
  requireDigest,
  requirePositiveInteger,
  requireRecord,
  requireSafeId,
  requireText,
  resolveInputPath,
} from './reference-preparation-validation';
import {
  PREPARED_REFERENCE_DEFINITION_V1,
  REFERENCE_PREPARATION_PIPELINE_REVISION,
  type PreparedReferenceDefinition,
  type PreparedReferenceDefinitionV1,
  type ReferencePreparationProvenanceV1,
} from '../../shared/portable-reference/prepared-reference-definition';

export {
  REFERENCE_ASSEMBLY_IDENTITY_V2,
  type ReferenceAssemblyIdentityContigV2,
  referenceAssemblyIdentitySha256V2,
} from './reference-assembly-identity-v2';
export {
  PREPARED_REFERENCE_DEFINITION_V2,
  REFERENCE_PREPARATION_MANIFEST_V2,
  REFERENCE_PREPARATION_PIPELINE_REVISION_V2,
  type LoadedReferencePreparationManifestV2,
  type HostedReferencePreparationManifestAdmissionV2,
  type PreparedReferenceDefinitionV2,
  type ReferencePreparationProvenanceV2,
  type ReferencePreparationSourceV2,
  parsePreparedReferenceDefinitionV2,
  parseReferencePreparationManifestV2,
  parseHostedReferencePreparationManifestV2,
  preparedReferenceAssemblyEntryV2,
  preparedReferenceDefinitionV2,
} from './reference-preparation-manifest-v2';
export {
  PREPARED_REFERENCE_DEFINITION_V3,
  REFERENCE_PREPARATION_PIPELINE_REVISION_V3,
  assertReferenceSemanticGroupIntegrityV1,
  type PreparedReferenceDefinitionV3,
  parsePreparedReferenceDefinitionV3,
  preparedReferenceAssemblyEntryV3,
  preparedReferenceDefinitionV3,
  referenceSemanticsSha256V1,
} from './reference-preparation-manifest-v3';
export {
  PREPARED_REFERENCE_DEFINITION_FILE,
  PREPARED_REFERENCE_DEFINITION_V1,
  REFERENCE_PREPARATION_PIPELINE_REVISION,
  type ParsedPreparedReferenceDefinitionV1,
  type PreparedReferenceDefinition,
  type PreparedReferenceDefinitionV1,
  type ReferencePreparationProvenanceV1,
  parsePreparedReferenceDefinition,
  parsePreparedReferenceDefinitionV1,
  preparedReferenceAssemblyEntry,
  preparedReferenceAssemblyEntryV1,
} from '../../shared/portable-reference/prepared-reference-definition';

export const REFERENCE_PREPARATION_MANIFEST_V1 = 'dnaforge-reference-preparation.v1' as const;

const SHA256 = /^[0-9a-f]{64}$/i;

export interface ReferencePreparationSourceV1 {
  readonly fastaPath: string;
  readonly gffPath: string;
  readonly fastaSha256: string;
  readonly gffSha256: string;
}

export interface LoadedReferencePreparationManifestV1 {
  readonly contract: typeof REFERENCE_PREPARATION_MANIFEST_V1;
  readonly manifestPath: string;
  readonly entry: ReferenceAssemblyEntry;
  readonly source: ReferencePreparationSourceV1;
  readonly provenance: ReferencePreparationProvenanceV1;
}

export type LoadedReferencePreparationManifest =
  | LoadedReferencePreparationManifestV1
  | LoadedReferencePreparationManifestV2;

export async function readReferencePreparationManifestV1(
  manifestPath: string
): Promise<LoadedReferencePreparationManifestV1> {
  const absolutePath = resolve(manifestPath);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(absolutePath, 'utf8')) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read reference preparation manifest ${absolutePath}: ${detail}`);
  }
  return parseReferencePreparationManifestV1(value, absolutePath);
}

export async function readReferencePreparationManifest(
  manifestPath: string,
  hostedAdmission?: HostedReferencePreparationManifestAdmissionV2
): Promise<LoadedReferencePreparationManifest> {
  const absolutePath = resolve(manifestPath);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(absolutePath, 'utf8')) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read reference preparation manifest ${absolutePath}: ${detail}`);
  }
  const root = requireRecord(value, 'manifest');
  if (root.contract === REFERENCE_PREPARATION_MANIFEST_V1) {
    return parseReferencePreparationManifestV1(value, absolutePath);
  }
  if (root.contract === REFERENCE_PREPARATION_MANIFEST_V2) {
    return hostedAdmission
      ? parseHostedReferencePreparationManifestV2(value, absolutePath, hostedAdmission)
      : parseReferencePreparationManifestV2(value, absolutePath);
  }
  throw new Error(
    `manifest.contract must be "${REFERENCE_PREPARATION_MANIFEST_V1}" or "${REFERENCE_PREPARATION_MANIFEST_V2}".`
  );
}

export function parseReferencePreparationManifestV1(
  value: unknown,
  manifestPath: string
): LoadedReferencePreparationManifestV1 {
  const root = requireRecord(value, 'manifest');
  if (root.contract !== REFERENCE_PREPARATION_MANIFEST_V1) {
    throw new Error(`manifest.contract must be "${REFERENCE_PREPARATION_MANIFEST_V1}".`);
  }

  const assembly = requireRecord(root.assembly, 'manifest.assembly');
  const id = requireSafeId(assembly.id, 'manifest.assembly.id');
  const name = requireText(assembly.name, 'manifest.assembly.name');
  const organism = requireText(assembly.organism, 'manifest.assembly.organism');
  const description = requireText(assembly.description, 'manifest.assembly.description');
  const assemblyName = optionalText(assembly.accession, 'manifest.assembly.accession');
  const taxId = optionalPositiveInteger(assembly.taxId, 'manifest.assembly.taxId');

  const sources = requireRecord(root.sources, 'manifest.sources');
  const fasta = requireRecord(sources.fasta, 'manifest.sources.fasta');
  const annotations = requireRecord(sources.annotations, 'manifest.sources.annotations');
  if (annotations.format !== 'gff3') {
    throw new Error('manifest.sources.annotations.format must be "gff3".');
  }
  const manifestDir = dirname(resolve(manifestPath));
  const source: ReferencePreparationSourceV1 = {
    fastaPath: resolveInputPath(
      requireText(fasta.path, 'manifest.sources.fasta.path'),
      manifestDir
    ),
    gffPath: resolveInputPath(
      requireText(annotations.path, 'manifest.sources.annotations.path'),
      manifestDir
    ),
    fastaSha256: requireDigest(fasta.sha256, SHA256, 'manifest.sources.fasta.sha256'),
    gffSha256: requireDigest(annotations.sha256, SHA256, 'manifest.sources.annotations.sha256'),
  };
  const provenance: ReferencePreparationProvenanceV1 = {
    provider: requireText(annotations.provider, 'manifest.sources.annotations.provider'),
    datasetId: requireText(annotations.datasetId, 'manifest.sources.annotations.datasetId'),
    datasetVersion: requireText(
      annotations.datasetVersion,
      'manifest.sources.annotations.datasetVersion'
    ),
    sourceUrl: optionalText(annotations.sourceUrl, 'manifest.sources.annotations.sourceUrl'),
    license: optionalText(annotations.license, 'manifest.sources.annotations.license'),
    attribution: optionalText(annotations.attribution, 'manifest.sources.annotations.attribution'),
  };

  if (!Array.isArray(root.contigs) || root.contigs.length === 0) {
    throw new Error('manifest.contigs must contain at least one contig.');
  }
  const seenChroms = new Set<string>();
  const seenSourceSeqIds = new Set<string>();
  const aliasesByNamespace = new Map<string, Set<string>>();
  const members = root.contigs.map((raw, index) => {
    const label = `manifest.contigs[${index}]`;
    const contig = requireRecord(raw, label);
    const chrom = requireSafeId(contig.chrom, `${label}.chrom`);
    const sourceSeqId = requireText(contig.sourceSeqId, `${label}.sourceSeqId`);
    if (seenChroms.has(chrom)) {
      throw new Error(`manifest contains duplicate contig "${chrom}".`);
    }
    if (seenSourceSeqIds.has(sourceSeqId)) {
      throw new Error(`manifest contains duplicate sourceSeqId "${sourceSeqId}".`);
    }
    seenChroms.add(chrom);
    seenSourceSeqIds.add(sourceSeqId);

    const aliases = optionalAliases(contig.aliases, `${label}.aliases`);
    assertAliasUniqueness(aliases, aliasesByNamespace, label);
    if (contig.md5 !== undefined) {
      throw new Error(
        `${label}.md5 is not supported by manifest v1 because sequence MD5 verification is not implemented.`
      );
    }
    return {
      chrom,
      displayName: optionalText(contig.displayName, `${label}.displayName`) ?? chrom,
      lengthBp: requirePositiveInteger(contig.lengthBp, `${label}.lengthBp`),
      role: optionalSequenceRole(contig.role, `${label}.role`),
      aliases,
      circular: optionalBoolean(contig.circular, `${label}.circular`),
      importSource: {
        ...source,
        sourceSeqId,
      },
      manifest: {
        fastaPath: `prepared/${chrom}/${chrom}.fa.gz`,
        faiPath: `prepared/${chrom}/${chrom}.fa.gz.fai`,
        gffPath: `prepared/${chrom}/${chrom}.gff3.gz`,
        tbiPath: preparedAnnotationIndexPath(
          chrom,
          requirePositiveInteger(contig.lengthBp, `${label}.lengthBp`)
        ),
      },
    } satisfies ReferenceAssemblyMember;
  });

  return {
    contract: REFERENCE_PREPARATION_MANIFEST_V1,
    manifestPath: resolve(manifestPath),
    source,
    provenance,
    entry: {
      id,
      name,
      organism,
      taxId,
      assembly: assemblyName,
      description,
      assetCacheKey: id,
      members,
    },
  };
}

export function preparedReferenceDefinitionV1(
  loaded: LoadedReferencePreparationManifestV1,
  entryWithPreparedLengths: ReferenceAssemblyEntry
): PreparedReferenceDefinitionV1 {
  if (
    loaded.entry.id !== entryWithPreparedLengths.id ||
    loaded.entry.assetCacheKey !== entryWithPreparedLengths.assetCacheKey
  ) {
    throw new Error('Prepared reference definition identity does not match its input manifest.');
  }
  const members = entryWithPreparedLengths.members.map((member) => {
    const sourceSeqId = member.importSource?.sourceSeqId;
    if (!member.manifest || !member.lengthBp || !sourceSeqId) {
      throw new Error(`Prepared reference member ${member.chrom} is incomplete.`);
    }
    const { importSource: _importSource, md5: _unverifiedMd5, ...prepared } = member;
    return {
      ...prepared,
      sourceSeqId,
      lengthBp: member.lengthBp,
      manifest: member.manifest,
    };
  });
  return {
    contract: PREPARED_REFERENCE_DEFINITION_V1,
    pipelineRevision: REFERENCE_PREPARATION_PIPELINE_REVISION,
    id: entryWithPreparedLengths.id,
    name: entryWithPreparedLengths.name,
    organism: entryWithPreparedLengths.organism,
    taxId: entryWithPreparedLengths.taxId,
    assembly: entryWithPreparedLengths.assembly,
    description: entryWithPreparedLengths.description,
    assetCacheKey: entryWithPreparedLengths.assetCacheKey,
    source: {
      fastaSha256: loaded.source.fastaSha256,
      gffSha256: loaded.source.gffSha256,
    },
    provenance: loaded.provenance,
    members,
  };
}

export function preparedReferenceDefinition(
  loaded: LoadedReferencePreparationManifest,
  entryWithPreparedLengths: ReferenceAssemblyEntry
): PreparedReferenceDefinition {
  return loaded.contract === REFERENCE_PREPARATION_MANIFEST_V1
    ? preparedReferenceDefinitionV1(loaded, entryWithPreparedLengths)
    : preparedReferenceDefinitionV2(loaded, entryWithPreparedLengths);
}
