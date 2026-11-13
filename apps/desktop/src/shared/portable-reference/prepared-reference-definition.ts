import { referenceContentIdentity } from './reference-content-identity';
import type {
  ReferenceAssemblyEntry,
  ReferenceAssemblyMember,
} from '../../features/sequence/reference-catalog';
import {
  PREPARED_REFERENCE_DEFINITION_V2,
  type PreparedReferenceDefinitionV2,
  parsePreparedReferenceDefinitionV2,
  preparedReferenceAssemblyEntryV2,
} from './prepared-reference-definition-v2';
import {
  PREPARED_REFERENCE_DEFINITION_V3,
  type PreparedReferenceDefinitionV3,
  parsePreparedReferenceDefinitionV3,
  preparedReferenceAssemblyEntryV3,
} from './prepared-reference-definition-v3';
import {
  assertAliasUniqueness,
  assertOnlyKeys,
  optionalAliases,
  optionalBoolean,
  optionalPositiveInteger,
  optionalSafeId,
  optionalSequenceRole,
  optionalText,
  preparedAnnotationIndexPath,
  requireCanonicalPreparedPath,
  requirePreparedSequenceManifestPaths,
  requireDigest,
  requirePositiveInteger,
  requireRecord,
  requireSafeId,
  requireText,
} from './reference-preparation-validation';

export const PREPARED_REFERENCE_DEFINITION_V1 =
  'dnaforge-prepared-reference-definition.v1' as const;
export const PREPARED_REFERENCE_DEFINITION_FILE = 'prepared-reference-definition.v1.json';
export const REFERENCE_PREPARATION_PIPELINE_REVISION = 1 as const;

const SHA256 = /^[0-9a-f]{64}$/i;

export interface ReferencePreparationProvenanceV1 {
  readonly provider: string;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly sourceUrl?: string;
  readonly license?: string;
  readonly attribution?: string;
}

export interface PreparedReferenceDefinitionV1 {
  readonly contract: typeof PREPARED_REFERENCE_DEFINITION_V1;
  readonly pipelineRevision: typeof REFERENCE_PREPARATION_PIPELINE_REVISION;
  readonly id: string;
  readonly name: string;
  readonly organism: string;
  readonly taxId?: number;
  readonly assembly?: string;
  readonly description: string;
  readonly assetCacheKey: string;
  readonly source: Readonly<{
    fastaSha256: string;
    gffSha256: string;
  }>;
  readonly provenance: ReferencePreparationProvenanceV1;
  readonly members: ReadonlyArray<
    Omit<ReferenceAssemblyMember, 'importSource' | 'md5'> & {
      readonly sourceSeqId: string;
      readonly lengthBp: number;
      readonly manifest: NonNullable<ReferenceAssemblyMember['manifest']>;
    }
  >;
}

export interface ParsedPreparedReferenceDefinitionV1 extends PreparedReferenceDefinitionV1 {
  readonly members: ReadonlyArray<
    PreparedReferenceDefinitionV1['members'][number] & {
      readonly manifest: Readonly<{
        fastaPath: string;
        faiPath: string;
        gffPath: string;
        tbiPath: string;
      }>;
    }
  >;
}

export type PreparedReferenceDefinition =
  | PreparedReferenceDefinitionV1
  | PreparedReferenceDefinitionV2
  | PreparedReferenceDefinitionV3;

export function parsePreparedReferenceDefinitionV1(
  value: unknown,
  expectedAssetCacheKey?: string
): ParsedPreparedReferenceDefinitionV1 {
  const root = requireRecord(value, 'prepared reference definition');
  assertOnlyKeys(
    root,
    [
      'contract',
      'pipelineRevision',
      'id',
      'name',
      'organism',
      'taxId',
      'assembly',
      'description',
      'assetCacheKey',
      'source',
      'provenance',
      'members',
    ],
    'prepared reference definition'
  );
  if (root.contract !== PREPARED_REFERENCE_DEFINITION_V1) {
    throw new Error(
      `prepared reference definition.contract must be "${PREPARED_REFERENCE_DEFINITION_V1}".`
    );
  }
  if (root.pipelineRevision !== REFERENCE_PREPARATION_PIPELINE_REVISION) {
    throw new Error(
      `prepared reference definition.pipelineRevision must be ${REFERENCE_PREPARATION_PIPELINE_REVISION}.`
    );
  }

  const id = requireSafeId(root.id, 'prepared reference definition.id');
  const assetCacheKey = requireSafeId(
    root.assetCacheKey,
    'prepared reference definition.assetCacheKey'
  );
  if (expectedAssetCacheKey !== undefined && assetCacheKey !== expectedAssetCacheKey) {
    throw new Error(
      `prepared reference definition.assetCacheKey must match cache family "${expectedAssetCacheKey}".`
    );
  }

  const source = requireRecord(root.source, 'prepared reference definition.source');
  assertOnlyKeys(source, ['fastaSha256', 'gffSha256'], 'prepared reference definition.source');
  const parsedSource = {
    fastaSha256: requireDigest(
      source.fastaSha256,
      SHA256,
      'prepared reference definition.source.fastaSha256'
    ),
    gffSha256: requireDigest(
      source.gffSha256,
      SHA256,
      'prepared reference definition.source.gffSha256'
    ),
  };

  const provenance = requireRecord(root.provenance, 'prepared reference definition.provenance');
  assertOnlyKeys(
    provenance,
    ['provider', 'datasetId', 'datasetVersion', 'sourceUrl', 'license', 'attribution'],
    'prepared reference definition.provenance'
  );
  const parsedProvenance: ReferencePreparationProvenanceV1 = {
    provider: requireText(provenance.provider, 'prepared reference definition.provenance.provider'),
    datasetId: requireText(
      provenance.datasetId,
      'prepared reference definition.provenance.datasetId'
    ),
    datasetVersion: requireText(
      provenance.datasetVersion,
      'prepared reference definition.provenance.datasetVersion'
    ),
    sourceUrl: optionalText(
      provenance.sourceUrl,
      'prepared reference definition.provenance.sourceUrl'
    ),
    license: optionalText(provenance.license, 'prepared reference definition.provenance.license'),
    attribution: optionalText(
      provenance.attribution,
      'prepared reference definition.provenance.attribution'
    ),
  };

  if (!Array.isArray(root.members) || root.members.length === 0) {
    throw new Error('prepared reference definition.members must contain at least one member.');
  }
  const seenChroms = new Set<string>();
  const seenSourceSeqIds = new Set<string>();
  const aliasesByNamespace = new Map<string, Set<string>>();
  let assemblyLengthBp = 0;
  const members = root.members.map((raw, index) => {
    const label = `prepared reference definition.members[${index}]`;
    const member = requireRecord(raw, label);
    assertOnlyKeys(
      member,
      [
        'chrom',
        'displayName',
        'lengthBp',
        'role',
        'aliases',
        'circular',
        'cytobandId',
        'sourceSeqId',
        'manifest',
      ],
      label
    );
    const chrom = requireSafeId(member.chrom, `${label}.chrom`);
    const sourceSeqId = requireText(member.sourceSeqId, `${label}.sourceSeqId`);
    if (seenChroms.has(chrom)) {
      throw new Error(`prepared reference definition contains duplicate member "${chrom}".`);
    }
    if (seenSourceSeqIds.has(sourceSeqId)) {
      throw new Error(
        `prepared reference definition contains duplicate sourceSeqId "${sourceSeqId}".`
      );
    }
    seenChroms.add(chrom);
    seenSourceSeqIds.add(sourceSeqId);

    const aliases = optionalAliases(member.aliases, `${label}.aliases`);
    assertAliasUniqueness(aliases, aliasesByNamespace, label);
    const lengthBp = requirePositiveInteger(member.lengthBp, `${label}.lengthBp`);
    assemblyLengthBp += lengthBp;
    if (!Number.isSafeInteger(assemblyLengthBp)) {
      throw new Error('prepared reference definition total length exceeds a safe integer.');
    }
    const manifest = requireRecord(member.manifest, `${label}.manifest`);
    assertOnlyKeys(manifest, ['fastaPath', 'faiPath', 'gffPath', 'tbiPath'], `${label}.manifest`);
    const { fastaPath, faiPath } = requirePreparedSequenceManifestPaths(
      manifest,
      chrom,
      `${label}.manifest`
    );
    const expectedManifest = {
      gffPath: `prepared/${chrom}/${chrom}.gff3.gz`,
      tbiPath: preparedAnnotationIndexPath(chrom, lengthBp),
    };
    const parsedManifest = {
      fastaPath,
      faiPath,
      gffPath: requireCanonicalPreparedPath(
        manifest.gffPath,
        `${label}.manifest.gffPath`,
        expectedManifest.gffPath
      ),
      tbiPath: requireCanonicalPreparedPath(
        manifest.tbiPath,
        `${label}.manifest.tbiPath`,
        expectedManifest.tbiPath
      ),
    };

    return {
      chrom,
      displayName: optionalText(member.displayName, `${label}.displayName`) ?? chrom,
      lengthBp,
      role: optionalSequenceRole(member.role, `${label}.role`),
      aliases,
      circular: optionalBoolean(member.circular, `${label}.circular`),
      cytobandId: optionalSafeId(member.cytobandId, `${label}.cytobandId`),
      sourceSeqId,
      manifest: parsedManifest,
    };
  });

  return {
    contract: PREPARED_REFERENCE_DEFINITION_V1,
    pipelineRevision: REFERENCE_PREPARATION_PIPELINE_REVISION,
    id,
    name: requireText(root.name, 'prepared reference definition.name'),
    organism: requireText(root.organism, 'prepared reference definition.organism'),
    taxId: optionalPositiveInteger(root.taxId, 'prepared reference definition.taxId'),
    assembly: optionalText(root.assembly, 'prepared reference definition.assembly'),
    description: requireText(root.description, 'prepared reference definition.description'),
    assetCacheKey,
    source: parsedSource,
    provenance: parsedProvenance,
    members,
  };
}

export function parsePreparedReferenceDefinition(
  value: unknown,
  expectedAssetCacheKey?: string
): PreparedReferenceDefinition {
  const root = requireRecord(value, 'prepared reference definition');
  if (root.contract === PREPARED_REFERENCE_DEFINITION_V1) {
    return parsePreparedReferenceDefinitionV1(value, expectedAssetCacheKey);
  }
  if (root.contract === PREPARED_REFERENCE_DEFINITION_V2) {
    return parsePreparedReferenceDefinitionV2(value, expectedAssetCacheKey);
  }
  if (root.contract === PREPARED_REFERENCE_DEFINITION_V3) {
    return parsePreparedReferenceDefinitionV3(value, expectedAssetCacheKey);
  }
  throw new Error(
    `prepared reference definition.contract must be "${PREPARED_REFERENCE_DEFINITION_V1}", "${PREPARED_REFERENCE_DEFINITION_V2}", or "${PREPARED_REFERENCE_DEFINITION_V3}".`
  );
}

export function preparedReferenceAssemblyEntryV1(
  definition: PreparedReferenceDefinitionV1
): ReferenceAssemblyEntry {
  return {
    id: definition.id,
    name: definition.name,
    organism: definition.organism,
    taxId: definition.taxId,
    assembly: definition.assembly,
    description: definition.description,
    assetCacheKey: definition.assetCacheKey,
    members: definition.members.map(
      ({ sourceSeqId: _sourceSeqId, ...member }): ReferenceAssemblyMember => ({
        ...member,
        manifest: { ...member.manifest },
        aliases: member.aliases ? { ...member.aliases } : undefined,
      })
    ),
  };
}

export function preparedReferenceAssemblyEntry(
  definition: PreparedReferenceDefinition
): ReferenceAssemblyEntry {
  const referenceIdentity = referenceContentIdentity(definition);
  if (definition.contract === PREPARED_REFERENCE_DEFINITION_V1) {
    return { ...preparedReferenceAssemblyEntryV1(definition), referenceIdentity };
  }
  if (definition.contract === PREPARED_REFERENCE_DEFINITION_V2) {
    return { ...preparedReferenceAssemblyEntryV2(definition), referenceIdentity };
  }
  return { ...preparedReferenceAssemblyEntryV3(definition), referenceIdentity };
}
