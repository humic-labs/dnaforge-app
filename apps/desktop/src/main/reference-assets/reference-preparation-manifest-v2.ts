import './node-sha256-sync';
import { dirname, resolve } from 'node:path';

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
  PREPARED_REFERENCE_DEFINITION_V2,
  REFERENCE_PREPARATION_PIPELINE_REVISION_V2,
  type PreparedReferenceDefinitionV2,
  type ReferencePreparationProvenanceV2,
} from '../../shared/portable-reference/prepared-reference-definition-v2';
import {
  assertAliasUniqueness,
  assertOnlyKeys,
  optionalAliases,
  optionalPositiveInteger,
  optionalSequenceRole,
  optionalText,
  requireBoolean,
  preparedAnnotationIndexPath,
  requireDigest,
  requirePositiveInteger,
  requireRecord,
  requireSafeId,
  requireText,
  resolveInputPath,
} from './reference-preparation-validation';

export {
  PREPARED_REFERENCE_DEFINITION_V2,
  REFERENCE_PREPARATION_PIPELINE_REVISION_V2,
  type PreparedReferenceDefinitionV2,
  type ReferencePreparationProvenanceV2,
  parsePreparedReferenceDefinitionV2,
  preparedReferenceAssemblyEntryV2,
} from '../../shared/portable-reference/prepared-reference-definition-v2';

export const REFERENCE_PREPARATION_MANIFEST_V2 = 'dnaforge-reference-preparation.v2' as const;

const SHA256 = /^[0-9a-f]{64}$/i;

export type ReferencePreparationSourceV2 =
  | Readonly<{
      fastaPath: string;
      fastaSha256: string;
      gffPath: string;
      gffSha256: string;
    }>
  | Readonly<{
      fastaPath: string;
      fastaSha256: string;
      gffPath?: undefined;
      gffSha256?: undefined;
    }>;

export interface LoadedReferencePreparationManifestV2 {
  readonly contract: typeof REFERENCE_PREPARATION_MANIFEST_V2;
  readonly manifestPath: string;
  readonly entry: ReferenceAssemblyEntry;
  readonly source: ReferencePreparationSourceV2;
  readonly provenance: ReferencePreparationProvenanceV2;
  readonly assemblyIdentity: Readonly<{
    contract: typeof REFERENCE_ASSEMBLY_IDENTITY_V2;
    sha256: string;
  }>;
  readonly identityContigs: ReadonlyArray<ReferenceAssemblyIdentityContigV2>;
}

export interface HostedReferencePreparationManifestAdmissionV2 {
  readonly expectedCatalogId: string;
  readonly expectedFastaSha256: string;
  readonly expectedGffSha256?: string;
}

export function parseReferencePreparationManifestV2(
  value: unknown,
  manifestPath: string
): LoadedReferencePreparationManifestV2 {
  return parseReferencePreparationManifestV2WithIdentityPolicy(value, manifestPath, null);
}

export function parseHostedReferencePreparationManifestV2(
  value: unknown,
  manifestPath: string,
  admission: HostedReferencePreparationManifestAdmissionV2
): LoadedReferencePreparationManifestV2 {
  return parseReferencePreparationManifestV2WithIdentityPolicy(value, manifestPath, admission);
}

function parseReferencePreparationManifestV2WithIdentityPolicy(
  value: unknown,
  manifestPath: string,
  hostedAdmission: HostedReferencePreparationManifestAdmissionV2 | null
): LoadedReferencePreparationManifestV2 {
  const root = requireRecord(value, 'manifest');
  assertOnlyKeys(
    root,
    ['contract', 'assemblyIdentity', 'assembly', 'sources', 'provenance', 'contigs'],
    'manifest'
  );
  if (root.contract !== REFERENCE_PREPARATION_MANIFEST_V2) {
    throw new Error(`manifest.contract must be "${REFERENCE_PREPARATION_MANIFEST_V2}".`);
  }

  const assemblyIdentity = requireRecord(root.assemblyIdentity, 'manifest.assemblyIdentity');
  assertOnlyKeys(assemblyIdentity, ['contract', 'sha256'], 'manifest.assemblyIdentity');
  if (assemblyIdentity.contract !== REFERENCE_ASSEMBLY_IDENTITY_V2) {
    throw new Error(
      `manifest.assemblyIdentity.contract must be "${REFERENCE_ASSEMBLY_IDENTITY_V2}".`
    );
  }
  const declaredAssemblyIdentitySha256 = requireDigest(
    assemblyIdentity.sha256,
    SHA256,
    'manifest.assemblyIdentity.sha256'
  );

  const assembly = requireRecord(root.assembly, 'manifest.assembly');
  assertOnlyKeys(
    assembly,
    ['id', 'name', 'organism', 'taxId', 'accession', 'description'],
    'manifest.assembly'
  );
  const id = requireSafeId(assembly.id, 'manifest.assembly.id');
  const name = requireText(assembly.name, 'manifest.assembly.name');
  const organism = requireText(assembly.organism, 'manifest.assembly.organism');
  const description = requireText(assembly.description, 'manifest.assembly.description');
  const assemblyName = optionalText(assembly.accession, 'manifest.assembly.accession');
  const taxId = optionalPositiveInteger(assembly.taxId, 'manifest.assembly.taxId');

  const sources = requireRecord(root.sources, 'manifest.sources');
  assertOnlyKeys(sources, ['fasta', 'annotations'], 'manifest.sources');
  const fasta = requireRecord(sources.fasta, 'manifest.sources.fasta');
  assertOnlyKeys(fasta, ['path', 'sha256'], 'manifest.sources.fasta');
  const manifestDir = dirname(resolve(manifestPath));
  const fastaPath = resolveInputPath(
    requireText(fasta.path, 'manifest.sources.fasta.path'),
    manifestDir
  );
  const fastaSha256 = requireDigest(fasta.sha256, SHA256, 'manifest.sources.fasta.sha256');
  let source: ReferencePreparationSourceV2;
  if (sources.annotations === undefined) {
    source = { fastaPath, fastaSha256 };
  } else {
    const annotations = requireRecord(sources.annotations, 'manifest.sources.annotations');
    assertOnlyKeys(annotations, ['format', 'path', 'sha256'], 'manifest.sources.annotations');
    if (annotations.format !== 'gff3') {
      throw new Error('manifest.sources.annotations.format must be "gff3".');
    }
    source = {
      fastaPath,
      fastaSha256,
      gffPath: resolveInputPath(
        requireText(annotations.path, 'manifest.sources.annotations.path'),
        manifestDir
      ),
      gffSha256: requireDigest(annotations.sha256, SHA256, 'manifest.sources.annotations.sha256'),
    };
  }

  const rawProvenance = requireRecord(root.provenance, 'manifest.provenance');
  assertOnlyKeys(
    rawProvenance,
    ['provider', 'datasetId', 'datasetVersion', 'sourceUrl', 'license', 'attribution'],
    'manifest.provenance'
  );
  const provenance: ReferencePreparationProvenanceV2 = {
    provider: requireText(rawProvenance.provider, 'manifest.provenance.provider'),
    datasetId: requireText(rawProvenance.datasetId, 'manifest.provenance.datasetId'),
    datasetVersion: requireText(rawProvenance.datasetVersion, 'manifest.provenance.datasetVersion'),
    sourceUrl: optionalText(rawProvenance.sourceUrl, 'manifest.provenance.sourceUrl'),
    license: optionalText(rawProvenance.license, 'manifest.provenance.license'),
    attribution: optionalText(rawProvenance.attribution, 'manifest.provenance.attribution'),
  };

  if (!Array.isArray(root.contigs) || root.contigs.length === 0) {
    throw new Error('manifest.contigs must contain at least one contig.');
  }
  const seenChroms = new Set<string>();
  const seenSourceSeqIds = new Set<string>();
  const aliasesByNamespace = new Map<string, Set<string>>();
  const identityContigs: ReferenceAssemblyIdentityContigV2[] = [];
  const members = root.contigs.map((raw, index) => {
    const label = `manifest.contigs[${index}]`;
    const contig = requireRecord(raw, label);
    assertOnlyKeys(
      contig,
      [
        'chrom',
        'sourceSeqId',
        'displayName',
        'lengthBp',
        'role',
        'aliases',
        'circular',
        'normalizedSequenceSha256',
      ],
      label
    );
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
    const lengthBp = requirePositiveInteger(contig.lengthBp, `${label}.lengthBp`);
    const circular = requireBoolean(contig.circular, `${label}.circular`);
    const normalizedSequenceSha256 = requireDigest(
      contig.normalizedSequenceSha256,
      SHA256,
      `${label}.normalizedSequenceSha256`
    );
    identityContigs.push({
      sourceSeqId,
      lengthBp,
      circular,
      normalizedSequenceSha256,
    });

    const preparedManifest = source.gffPath
      ? {
          fastaPath: `prepared/${chrom}/${chrom}.fa.gz`,
          faiPath: `prepared/${chrom}/${chrom}.fa.gz.fai`,
          gffPath: `prepared/${chrom}/${chrom}.gff3.gz`,
          tbiPath: preparedAnnotationIndexPath(chrom, lengthBp),
        }
      : {
          fastaPath: `prepared/${chrom}/${chrom}.fa.gz`,
          faiPath: `prepared/${chrom}/${chrom}.fa.gz.fai`,
        };
    return {
      chrom,
      displayName: optionalText(contig.displayName, `${label}.displayName`) ?? chrom,
      lengthBp,
      role: optionalSequenceRole(contig.role, `${label}.role`),
      aliases,
      circular,
      importSource: {
        ...source,
        sourceSeqId,
      },
      manifest: preparedManifest,
    } satisfies ReferenceAssemblyMember;
  });

  const calculatedAssemblyIdentitySha256 = referenceAssemblyIdentitySha256V2(identityContigs);
  if (declaredAssemblyIdentitySha256 !== calculatedAssemblyIdentitySha256) {
    throw new Error(
      'manifest.assemblyIdentity.sha256 does not match the ordered contig coordinate identity.'
    );
  }
  const expectedId =
    hostedAdmission?.expectedCatalogId ?? `local-${calculatedAssemblyIdentitySha256.slice(0, 24)}`;
  if (id !== expectedId) {
    throw new Error(
      `manifest.assembly.id must be "${expectedId}" for its declared sequence identity.`
    );
  }
  if (
    hostedAdmission &&
    (source.fastaSha256 !== hostedAdmission.expectedFastaSha256.toLowerCase() ||
      (source.gffSha256 ?? null) !== (hostedAdmission.expectedGffSha256?.toLowerCase() ?? null))
  ) {
    throw new Error('Hosted preparation manifest source identity does not match its catalog.');
  }

  return {
    contract: REFERENCE_PREPARATION_MANIFEST_V2,
    manifestPath: resolve(manifestPath),
    source,
    provenance,
    assemblyIdentity: {
      contract: REFERENCE_ASSEMBLY_IDENTITY_V2,
      sha256: calculatedAssemblyIdentitySha256,
    },
    identityContigs,
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

export function preparedReferenceDefinitionV2(
  loaded: LoadedReferencePreparationManifestV2,
  entryWithPreparedLengths: ReferenceAssemblyEntry
): PreparedReferenceDefinitionV2 {
  if (
    loaded.entry.id !== entryWithPreparedLengths.id ||
    loaded.entry.assetCacheKey !== entryWithPreparedLengths.assetCacheKey
  ) {
    throw new Error('Prepared reference definition identity does not match its input manifest.');
  }
  const identityBySourceSeqId = new Map(
    loaded.identityContigs.map((contig) => [contig.sourceSeqId, contig] as const)
  );
  const members = entryWithPreparedLengths.members.map((member) => {
    const sourceSeqId = member.importSource?.sourceSeqId;
    if (!member.manifest || !member.lengthBp || !sourceSeqId) {
      throw new Error(`Prepared reference member ${member.chrom} is incomplete.`);
    }
    const identity = identityBySourceSeqId.get(sourceSeqId);
    if (
      !identity ||
      identity.lengthBp !== member.lengthBp ||
      identity.circular !== Boolean(member.circular)
    ) {
      throw new Error(
        `Prepared reference member ${member.chrom} does not match its biological sequence identity.`
      );
    }
    const hasGff = member.manifest.gffPath !== undefined;
    const hasTbi = member.manifest.tbiPath !== undefined;
    if (hasGff !== hasTbi || hasGff !== (loaded.source.gffPath !== undefined)) {
      throw new Error(
        `Prepared reference member ${member.chrom} must contain FASTA/FAI and an optional all-or-none GFF3/TBI pair.`
      );
    }
    const { importSource: _importSource, md5: _unverifiedMd5, ...prepared } = member;
    return {
      ...prepared,
      sourceSeqId,
      normalizedSequenceSha256: identity.normalizedSequenceSha256,
      lengthBp: member.lengthBp,
      manifest: member.manifest,
    };
  });
  const source =
    loaded.source.gffSha256 === undefined
      ? { fastaSha256: loaded.source.fastaSha256 }
      : {
          fastaSha256: loaded.source.fastaSha256,
          gffSha256: loaded.source.gffSha256,
        };
  return {
    contract: PREPARED_REFERENCE_DEFINITION_V2,
    pipelineRevision: REFERENCE_PREPARATION_PIPELINE_REVISION_V2,
    id: entryWithPreparedLengths.id,
    name: entryWithPreparedLengths.name,
    organism: entryWithPreparedLengths.organism,
    taxId: entryWithPreparedLengths.taxId,
    assembly: entryWithPreparedLengths.assembly,
    description: entryWithPreparedLengths.description,
    assetCacheKey: entryWithPreparedLengths.assetCacheKey,
    assemblyIdentity: loaded.assemblyIdentity,
    source,
    provenance: loaded.provenance,
    members,
  };
}
