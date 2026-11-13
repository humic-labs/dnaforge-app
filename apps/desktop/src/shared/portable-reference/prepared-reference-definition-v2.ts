import { hubGenomeTrackTargetFromProvenance } from '../hub-genome-provenance';

import type {
  ReferenceAssemblyEntry,
  ReferenceAssemblyMember,
} from '../../features/sequence/reference-catalog';
import {
  REFERENCE_ASSEMBLY_IDENTITY_V2,
  type ReferenceAssemblyIdentityContigV2,
  referenceAssemblyIdentitySha256V2,
} from './reference-assembly-identity-v2';
import {
  assertAliasUniqueness,
  assertOnlyKeys,
  optionalAliases,
  optionalDigest,
  optionalPositiveInteger,
  optionalSafeId,
  optionalSequenceRole,
  optionalText,
  requireBoolean,
  preparedAnnotationIndexPath,
  requireCanonicalPreparedPath,
  requirePreparedSequenceManifestPaths,
  requireDigest,
  requirePositiveInteger,
  requireRecord,
  requireSafeId,
  requireText,
} from './reference-preparation-validation';

export const PREPARED_REFERENCE_DEFINITION_V2 =
  'dnaforge-prepared-reference-definition.v2' as const;
export const REFERENCE_PREPARATION_PIPELINE_REVISION_V2 = 2 as const;

const SHA256 = /^[0-9a-f]{64}$/i;

export interface ReferencePreparationProvenanceV2 {
  readonly provider: string;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly sourceUrl?: string;
  readonly license?: string;
  readonly attribution?: string;
}

export interface PreparedReferenceDefinitionV2 {
  readonly contract: typeof PREPARED_REFERENCE_DEFINITION_V2;
  readonly pipelineRevision: typeof REFERENCE_PREPARATION_PIPELINE_REVISION_V2;
  readonly id: string;
  readonly name: string;
  readonly organism: string;
  readonly taxId?: number;
  readonly assembly?: string;
  readonly description: string;
  readonly assetCacheKey: string;
  readonly assemblyIdentity: Readonly<{
    contract: typeof REFERENCE_ASSEMBLY_IDENTITY_V2;
    sha256: string;
  }>;
  readonly source:
    | Readonly<{
        fastaSha256: string;
        gffSha256: string;
      }>
    | Readonly<{
        fastaSha256: string;
        gffSha256?: undefined;
      }>;
  readonly provenance: ReferencePreparationProvenanceV2;
  readonly members: ReadonlyArray<
    Omit<ReferenceAssemblyMember, 'importSource' | 'md5'> & {
      readonly sourceSeqId: string;
      readonly normalizedSequenceSha256: string;
      readonly lengthBp: number;
      readonly manifest: NonNullable<ReferenceAssemblyMember['manifest']>;
    }
  >;
}

export function parsePreparedReferenceDefinitionV2(
  value: unknown,
  expectedAssetCacheKey?: string,
  identityPolicy: 'local-content-addressed' | 'cache-key' = 'local-content-addressed'
): PreparedReferenceDefinitionV2 {
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
      'assemblyIdentity',
      'source',
      'provenance',
      'members',
    ],
    'prepared reference definition'
  );
  if (root.contract !== PREPARED_REFERENCE_DEFINITION_V2) {
    throw new Error(
      `prepared reference definition.contract must be "${PREPARED_REFERENCE_DEFINITION_V2}".`
    );
  }
  if (root.pipelineRevision !== REFERENCE_PREPARATION_PIPELINE_REVISION_V2) {
    throw new Error(
      `prepared reference definition.pipelineRevision must be ${REFERENCE_PREPARATION_PIPELINE_REVISION_V2}.`
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

  const rawAssemblyIdentity = requireRecord(
    root.assemblyIdentity,
    'prepared reference definition.assemblyIdentity'
  );
  assertOnlyKeys(
    rawAssemblyIdentity,
    ['contract', 'sha256'],
    'prepared reference definition.assemblyIdentity'
  );
  if (rawAssemblyIdentity.contract !== REFERENCE_ASSEMBLY_IDENTITY_V2) {
    throw new Error(
      `prepared reference definition.assemblyIdentity.contract must be "${REFERENCE_ASSEMBLY_IDENTITY_V2}".`
    );
  }
  const declaredAssemblyIdentitySha256 = requireDigest(
    rawAssemblyIdentity.sha256,
    SHA256,
    'prepared reference definition.assemblyIdentity.sha256'
  );

  const source = requireRecord(root.source, 'prepared reference definition.source');
  assertOnlyKeys(source, ['fastaSha256', 'gffSha256'], 'prepared reference definition.source');
  const fastaSha256 = requireDigest(
    source.fastaSha256,
    SHA256,
    'prepared reference definition.source.fastaSha256'
  );
  const gffSha256 = optionalDigest(
    source.gffSha256,
    SHA256,
    'prepared reference definition.source.gffSha256'
  );
  const parsedSource = gffSha256 === undefined ? { fastaSha256 } : { fastaSha256, gffSha256 };

  const provenance = requireRecord(root.provenance, 'prepared reference definition.provenance');
  assertOnlyKeys(
    provenance,
    ['provider', 'datasetId', 'datasetVersion', 'sourceUrl', 'license', 'attribution'],
    'prepared reference definition.provenance'
  );
  const parsedProvenance: ReferencePreparationProvenanceV2 = {
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
  const identityContigs: ReferenceAssemblyIdentityContigV2[] = [];
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
        'normalizedSequenceSha256',
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
    const circular = requireBoolean(member.circular, `${label}.circular`);
    const normalizedSequenceSha256 = requireDigest(
      member.normalizedSequenceSha256,
      SHA256,
      `${label}.normalizedSequenceSha256`
    );
    identityContigs.push({
      sourceSeqId,
      lengthBp,
      circular,
      normalizedSequenceSha256,
    });

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
    const hasGff = manifest.gffPath !== undefined;
    const hasTbi = manifest.tbiPath !== undefined;
    if (hasGff !== hasTbi || hasGff !== (gffSha256 !== undefined)) {
      throw new Error(
        `${label}.manifest must contain FASTA/FAI and an optional all-or-none GFF3/TBI pair consistent with its source.`
      );
    }
    const parsedManifest = hasGff
      ? {
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
        }
      : { fastaPath, faiPath };

    return {
      chrom,
      displayName: optionalText(member.displayName, `${label}.displayName`) ?? chrom,
      lengthBp,
      role: optionalSequenceRole(member.role, `${label}.role`),
      aliases,
      circular,
      cytobandId: optionalSafeId(member.cytobandId, `${label}.cytobandId`),
      sourceSeqId,
      normalizedSequenceSha256,
      manifest: parsedManifest,
    };
  });

  const calculatedAssemblyIdentitySha256 = referenceAssemblyIdentitySha256V2(identityContigs);
  if (declaredAssemblyIdentitySha256 !== calculatedAssemblyIdentitySha256) {
    throw new Error(
      'prepared reference definition.assemblyIdentity.sha256 does not match its ordered members.'
    );
  }
  const expectedId = `local-${calculatedAssemblyIdentitySha256.slice(0, 24)}`;
  if (
    identityPolicy === 'local-content-addressed' &&
    (id !== expectedId || assetCacheKey !== expectedId)
  ) {
    throw new Error(
      `prepared reference definition identity and cache key must both be "${expectedId}".`
    );
  }
  if (identityPolicy === 'cache-key' && id !== assetCacheKey) {
    throw new Error('prepared reference definition identity must match its cache key.');
  }

  return {
    contract: PREPARED_REFERENCE_DEFINITION_V2,
    pipelineRevision: REFERENCE_PREPARATION_PIPELINE_REVISION_V2,
    id,
    name: requireText(root.name, 'prepared reference definition.name'),
    organism: requireText(root.organism, 'prepared reference definition.organism'),
    taxId: optionalPositiveInteger(root.taxId, 'prepared reference definition.taxId'),
    assembly: optionalText(root.assembly, 'prepared reference definition.assembly'),
    description: requireText(root.description, 'prepared reference definition.description'),
    assetCacheKey,
    assemblyIdentity: {
      contract: REFERENCE_ASSEMBLY_IDENTITY_V2,
      sha256: calculatedAssemblyIdentitySha256,
    },
    source: parsedSource,
    provenance: parsedProvenance,
    members,
  };
}

export function preparedReferenceAssemblyEntryV2(
  definition: PreparedReferenceDefinitionV2
): ReferenceAssemblyEntry {
  const hubTarget = hubGenomeTrackTargetFromProvenance(definition.provenance);
  return {
    id: definition.id,
    name: definition.name,
    organism: definition.organism,
    taxId: definition.taxId,
    assembly: definition.assembly,
    description: definition.description,
    assetCacheKey: definition.assetCacheKey,
    members: definition.members.map(
      ({
        sourceSeqId: _sourceSeqId,
        normalizedSequenceSha256: _normalizedSequenceSha256,
        ...member
      }): ReferenceAssemblyMember => ({
        ...member,
        manifest: { ...member.manifest },
        aliases: member.aliases ? { ...member.aliases } : undefined,
      })
    ),
    ...(hubTarget ? { ucscTrackTarget: hubTarget } : {}),
  };
}
