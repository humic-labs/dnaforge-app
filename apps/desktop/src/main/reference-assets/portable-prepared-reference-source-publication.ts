import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { PreparedReferenceAssemblyEntryV1 } from '../../shared/reference-assets-ipc';
import {
  parseReferenceAssetPublicationV1,
  REFERENCE_ASSET_PUBLICATION_V1,
  referenceAssetPublicationPath,
  type ReferenceAssetPublicationV1,
} from '../../features/sequence/reference-asset-publication';
import type { HostedReferenceCatalogDefinitionV1 } from './hosted-reference-catalog';
import type { PortablePreparedReferenceHydrationResult } from './portable-prepared-reference-hydrator';
import {
  portablePreparedReferenceObjectsForTierV1,
  type PortablePreparedReferenceObjectV1,
} from './portable-prepared-reference-bundle';
import {
  parsePreparedReferenceDefinition,
  preparedReferenceAssemblyEntry,
  PREPARED_REFERENCE_DEFINITION_FILE,
  type PreparedReferenceDefinition,
} from './reference-preparation-manifest';
import {
  PORTABLE_PREPARED_REFERENCE_SOURCE_RECEIPT_V2,
  type PortablePreparedReferenceFileContinuityV2,
  type PortablePreparedReferenceOutputIdentityV2,
  type PortablePreparedReferenceSourceReceiptV2,
} from './portable-prepared-reference-source-receipt';
import type { ReferenceAssetWriterLease } from './reference-asset-writer-lock';

const REFERENCE_SOURCE_RECEIPT_FILE = 'reference-source-materialization.v1.json';
const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_ROLES = new Set([
  'prepared-reference-definition',
  'fasta',
  'fasta-index',
  'gff3-bgzf',
  'gff3-tabix',
  'annotation-overview',
]);

type AnnotatedPreparedReferenceDefinition = PreparedReferenceDefinition & {
  readonly members: ReadonlyArray<
    PreparedReferenceDefinition['members'][number] & {
      readonly manifest: Readonly<{
        fastaPath: string;
        faiPath: string;
        gffPath: string;
        tbiPath: string;
      }>;
    }
  >;
};

export interface PublishPortablePreparedReferenceSourceInput {
  readonly cacheRoot: string;

  readonly publicationRoot?: string;
  readonly definition: HostedReferenceCatalogDefinitionV1;
  readonly hydration: PortablePreparedReferenceHydrationResult;

  readonly writerLease: ReferenceAssetWriterLease;
}

export async function publishPortablePreparedReferenceSourceGenerationV1(
  input: PublishPortablePreparedReferenceSourceInput
): Promise<PreparedReferenceAssemblyEntryV1> {
  const cacheRoot = await realpath(resolve(input.cacheRoot));
  const familyRoot = resolve(cacheRoot, input.definition.id);
  const publicationFamilyRoot = resolve(input.publicationRoot ?? cacheRoot, input.definition.id);
  assertAtOrBelow(cacheRoot, familyRoot, 'Portable prepared-reference family');
  const bundle = input.hydration.bundle;
  if (
    bundle.assembly.id !== input.definition.id ||
    bundle.assembly.assetCacheKey !== input.definition.id ||
    bundle.assembly.contigCount !== input.definition.contigs.length ||
    bundle.assembly.assemblyLengthBp !==
      input.definition.contigs.reduce((total, contig) => total + contig.lengthBp, 0) ||
    bundle.assembly.source.fastaSha256 !== input.definition.sources.fasta.sha256 ||
    bundle.assembly.source.gffSha256 !== input.definition.sources.annotations.sha256
  ) {
    throw new Error('Portable prepared-reference source identity does not match its catalog.');
  }
  if (!input.hydration.hydratedTiers.includes('detail')) {
    throw new Error('Portable prepared-reference source publication requires detail.');
  }

  const definitionObject = uniqueObject(
    bundle.objects.filter((object) => object.role === 'prepared-reference-definition'),
    'prepared-reference definition'
  );
  const definitionPath = input.hydration.objectPaths.get(definitionObject.id);
  if (!definitionPath) {
    throw new Error('Portable prepared-reference definition was not hydrated.');
  }
  const prepared = requireAnnotatedPreparedReferenceDefinition(
    parsePreparedReferenceDefinition(
      JSON.parse(await readFile(definitionPath, 'utf8')) as unknown,
      input.definition.id
    )
  );
  if (bundle.assembly.preparationPipelineRevision !== prepared.pipelineRevision) {
    throw new Error('Portable prepared-reference pipeline revision does not match its definition.');
  }
  assertPreparedDefinitionMatchesCatalog(prepared, input.definition);

  const detailObjects = portablePreparedReferenceObjectsForTierV1(bundle, 'detail');
  const sourceObjects = detailObjects.filter((object) => SOURCE_ROLES.has(object.role));
  const objectsByInstallPath = new Map(sourceObjects.map((object) => [object.installPath, object]));
  if (objectsByInstallPath.size !== sourceObjects.length) {
    throw new Error('Portable prepared-reference source placements are ambiguous.');
  }
  const requiredObjects = requiredSourceObjects(prepared, objectsByInstallPath);
  const publicationId = bundle.bundleFingerprint;
  const generationRoot = resolve(input.hydration.generationRoot);
  const expectedGenerationRoot = resolve(familyRoot, 'generations', publicationId);
  assertAtOrBelow(familyRoot, generationRoot, 'Portable prepared-reference generation');
  if (generationRoot !== expectedGenerationRoot) {
    throw new Error('Portable prepared-reference hydration returned a non-canonical generation.');
  }

  await input.writerLease.assertOwned();
  if (!(await isPlainDirectory(generationRoot))) {
    throw new Error('Portable prepared-reference hydrated generation is unavailable.');
  }
  await verifyHydratedGeneration(generationRoot, requiredObjects, input.hydration.objectPaths);

  const receipts: PortablePreparedReferenceSourceReceiptV2[] = [];
  for (const member of prepared.members) {
    const memberObjects = {
      fasta: sourceObjectForPath(objectsByInstallPath, member.manifest.fastaPath),
      fai: sourceObjectForPath(objectsByInstallPath, member.manifest.faiPath),
      gff: sourceObjectForPath(objectsByInstallPath, member.manifest.gffPath),
      tbi: sourceObjectForPath(objectsByInstallPath, member.manifest.tbiPath),
    };
    const paths = {
      fasta: resolve(generationRoot, member.manifest.fastaPath),
      fai: resolve(generationRoot, member.manifest.faiPath),
      gff: resolve(generationRoot, member.manifest.gffPath),
      tbi: resolve(generationRoot, member.manifest.tbiPath),
    };
    for (const path of Object.values(paths)) {
      assertAtOrBelow(generationRoot, path, `${member.chrom} prepared source`);
    }
    const identities = {
      fasta: outputIdentity(memberObjects.fasta, await fileContinuity(paths.fasta)),
      fai: outputIdentity(memberObjects.fai, await fileContinuity(paths.fai)),
      gff: outputIdentity(memberObjects.gff, await fileContinuity(paths.gff)),
      tbi: outputIdentity(memberObjects.tbi, await fileContinuity(paths.tbi)),
    };
    const receipt: PortablePreparedReferenceSourceReceiptV2 = {
      contract: PORTABLE_PREPARED_REFERENCE_SOURCE_RECEIPT_V2,
      chrom: member.chrom,
      pipelineRevision: bundle.assembly.preparationPipelineRevision,
      bundleFingerprint: bundle.bundleFingerprint,
      indexerContractToken: `portable-source-quartet:${createHash('sha256')
        .update(
          JSON.stringify([
            memberObjects.fasta.contractToken,
            memberObjects.fai.contractToken,
            memberObjects.gff.contractToken,
            memberObjects.tbi.contractToken,
          ])
        )
        .digest('hex')}`,
      source: {
        fastaSha256: bundle.assembly.source.fastaSha256,
        gffSha256: bundle.assembly.source.gffSha256,
      },
      output: identities,
    };
    const receiptPath = join(dirname(paths.gff), REFERENCE_SOURCE_RECEIPT_FILE);
    await writeTextAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    receipts.push(receipt);
  }

  const sourceMaterializationFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        assetCacheKey: prepared.assetCacheKey,
        dnaIndexerSchema: 2,
        receipts,
      })
    )
    .digest('hex');
  const publication: ReferenceAssetPublicationV1 = {
    contract: REFERENCE_ASSET_PUBLICATION_V1,
    assetCacheKey: prepared.assetCacheKey,
    publicationId,
    sourceMaterializationFingerprint,
    publishedAtMs: Date.now(),
  };
  const pointerPath = referenceAssetPublicationPath(publicationFamilyRoot);
  const temporaryPointerPath = `${pointerPath}.${randomUUID()}.tmp`;
  await mkdir(publicationFamilyRoot, { recursive: true });
  try {
    await writeFile(temporaryPointerPath, `${JSON.stringify(publication, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    try {
      await input.writerLease.commitPointer(temporaryPointerPath, pointerPath);
    } catch (error) {
      const committed = await readReferenceAssetPublication(pointerPath, prepared.assetCacheKey);
      if (!committed || !sameReferenceAssetPublication(committed, publication)) throw error;
      await input.writerLease.acceptReconciledCommit();
    }
  } finally {
    await unlink(temporaryPointerPath).catch(() => undefined);
  }
  return preparedReferenceAssemblyEntry(prepared);
}

function requireAnnotatedPreparedReferenceDefinition(
  definition: PreparedReferenceDefinition
): AnnotatedPreparedReferenceDefinition {
  if (definition.members.some((member) => !member.manifest.gffPath || !member.manifest.tbiPath)) {
    throw new Error('Portable prepared-reference definition has an incomplete annotation quartet.');
  }
  return definition as AnnotatedPreparedReferenceDefinition;
}

function sourceObjectForPath(
  objectsByInstallPath: ReadonlyMap<string, PortablePreparedReferenceObjectV1>,
  installPath: string
): PortablePreparedReferenceObjectV1 {
  const object = objectsByInstallPath.get(installPath);
  if (!object) throw new Error(`Portable prepared source object is missing: ${installPath}`);
  return object;
}

function requiredSourceObjects(
  prepared: AnnotatedPreparedReferenceDefinition,
  objectsByInstallPath: ReadonlyMap<string, PortablePreparedReferenceObjectV1>
): readonly PortablePreparedReferenceObjectV1[] {
  const requiredPaths = new Set<string>([PREPARED_REFERENCE_DEFINITION_FILE]);
  for (const member of prepared.members) {
    requiredPaths.add(member.manifest.fastaPath);
    requiredPaths.add(member.manifest.faiPath);
    requiredPaths.add(member.manifest.gffPath);
    requiredPaths.add(member.manifest.tbiPath);
    const overviewPath = `prepared/${member.chrom}/${member.chrom}.annotation-overview.v8.json`;
    if (objectsByInstallPath.has(overviewPath)) requiredPaths.add(overviewPath);
  }
  return [...requiredPaths].map((path) => {
    const object = objectsByInstallPath.get(path);
    if (!object) throw new Error(`Portable prepared source object is missing: ${path}`);
    return object;
  });
}

async function verifyHydratedGeneration(
  generationRoot: string,
  objects: readonly PortablePreparedReferenceObjectV1[],
  objectPaths: ReadonlyMap<string, string>
): Promise<void> {
  for (const object of objects) {
    const path = resolve(generationRoot, object.installPath);
    assertAtOrBelow(generationRoot, path, 'Hydrated portable source object');
    const hydratedPath = objectPaths.get(object.id);
    if (!hydratedPath) {
      throw new Error(`Portable prepared object ${object.id} was not hydrated.`);
    }
    if (resolve(hydratedPath) !== path) {
      throw new Error(`Portable prepared object ${object.id} is not in its canonical generation.`);
    }
    const identity = await fileSha256AndLength(path);
    if (identity.sha256 !== object.sha256 || identity.byteLength !== object.byteLength) {
      throw new Error(`Hydrated portable source generation is corrupt: ${object.id}`);
    }
  }
}

async function readReferenceAssetPublication(
  pointerPath: string,
  assetCacheKey: string
): Promise<ReferenceAssetPublicationV1 | null> {
  try {
    return parseReferenceAssetPublicationV1(
      JSON.parse(await readFile(pointerPath, 'utf8')) as unknown,
      assetCacheKey
    );
  } catch {
    return null;
  }
}

function sameReferenceAssetPublication(
  left: ReferenceAssetPublicationV1,
  right: ReferenceAssetPublicationV1
): boolean {
  return (
    left.contract === right.contract &&
    left.assetCacheKey === right.assetCacheKey &&
    left.publicationId === right.publicationId &&
    left.sourceMaterializationFingerprint === right.sourceMaterializationFingerprint &&
    left.publishedAtMs === right.publishedAtMs
  );
}

function outputIdentity(
  object: PortablePreparedReferenceObjectV1,
  continuity: PortablePreparedReferenceFileContinuityV2
): PortablePreparedReferenceOutputIdentityV2 {
  if (!SHA256.test(object.sha256) || continuity.size !== object.byteLength) {
    throw new Error(`Portable source continuity does not match ${object.id}.`);
  }
  return {
    sha256: object.sha256,
    byteLength: object.byteLength,
    continuity,
  };
}

async function fileContinuity(path: string): Promise<PortablePreparedReferenceFileContinuityV2> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0) {
    throw new Error(`Portable prepared source is missing or empty: ${path}`);
  }
  return {
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  };
}

async function fileSha256AndLength(
  path: string
): Promise<Readonly<{ sha256: string; byteLength: number }>> {
  const hash = createHash('sha256');
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    byteLength += bytes.byteLength;
    hash.update(bytes);
  }
  return { sha256: hash.digest('hex'), byteLength };
}

async function writeTextAtomic(path: string, text: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, text, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function isPlainDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Portable prepared-reference generation is a symbolic link: ${path}`);
    }
    return metadata.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function uniqueObject<T>(objects: readonly T[], label: string): T {
  if (objects.length !== 1) throw new Error(`Portable bundle has no unique ${label}.`);
  return objects[0];
}

function assertPreparedDefinitionMatchesCatalog(
  prepared: PreparedReferenceDefinition,
  definition: HostedReferenceCatalogDefinitionV1
): void {
  const entry = preparedReferenceAssemblyEntry(prepared);
  if (
    entry.id !== definition.id ||
    entry.assetCacheKey !== definition.id ||
    entry.name !== definition.name ||
    entry.organism !== definition.organism ||
    entry.taxId !== definition.taxId ||
    entry.assembly !== definition.assembly ||
    entry.description !== definition.description ||
    prepared.source.fastaSha256 !== definition.sources.fasta.sha256 ||
    prepared.source.gffSha256 !== definition.sources.annotations.sha256 ||
    !sameProvenance(prepared.provenance, definition.provenance) ||
    entry.members.length !== definition.contigs.length ||
    entry.members.some((member, index) => {
      const contig = definition.contigs[index];
      const preparedMember = prepared.members[index];
      return (
        member.chrom !== contig.chrom ||
        member.displayName !== contig.displayName ||
        member.lengthBp !== contig.lengthBp ||
        member.role !== contig.role ||
        member.circular !== contig.circular ||
        JSON.stringify(member.aliases ?? {}) !== JSON.stringify(contig.aliases ?? {}) ||
        preparedMember?.sourceSeqId !== contig.sourceSeqId
      );
    })
  ) {
    throw new Error('Portable prepared-reference definition does not match its hosted catalog.');
  }
}

function sameProvenance(
  left: PreparedReferenceDefinition['provenance'],
  right: HostedReferenceCatalogDefinitionV1['provenance']
): boolean {
  return (
    left.provider === right.provider &&
    left.datasetId === right.datasetId &&
    left.datasetVersion === right.datasetVersion &&
    left.sourceUrl === right.sourceUrl &&
    left.license === right.license &&
    left.attribution === right.attribution
  );
}

function assertAtOrBelow(root: string, candidate: string, label: string): void {
  if (!isAbsolute(root) || !isAbsolute(candidate)) throw new Error(`${label} must be absolute.`);
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`${label} escapes its cache root.`);
  }
}
