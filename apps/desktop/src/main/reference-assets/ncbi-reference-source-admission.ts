import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import type { AssemblySequenceAliases, AssemblySequenceRole } from '@waypoint/genome-data';

import type {
  HostedReferenceCatalogDefinitionV1,
  HostedReferenceContigV1,
} from './hosted-reference-catalog';
import { inspectLocalReferenceSources } from './local-reference-source-plan';
import { resolveNcbiDatasetsSelection } from './ncbi-datasets-reference-resolver';
import { normalizeNcbiExternalAnnotationGff3 } from './ncbi-external-annotation-normalizer';
import {
  NCBI_REFERENCE_PACKAGE_ACQUISITION_V1,
  NCBI_REFERENCE_PACKAGE_ACQUISITION_V2,
  readNcbiDatasetsSequenceReport,
  type NcbiReferencePackageAcquisitionReceipt,
  type NcbiReferencePackageAcquisitionReceiptV2,
  type NcbiSequenceReportRecordV1,
} from './ncbi-reference-package-acquisition';
import {
  writePrimaryFastaSnapshot,
  writePrimaryGff3Snapshot,
} from './ncbi-reference-primary-snapshot';

export const NCBI_REFERENCE_SOURCE_ADMISSION_V1 =
  'dnaforge-ncbi-reference-source-admission.v1' as const;

const ACCESSION = /^GC[AF]_[0-9]+\.[0-9]+$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SEQUENCE_ROLES = new Set<AssemblySequenceRole>([
  'assembled-molecule',
  'unlocalized-scaffold',
  'unplaced-scaffold',
  'mitochondrion',
  'plastid',
  'other',
]);

export interface AdmitNcbiReferenceSourceInput {
  readonly receiptPath: string;
  readonly packagePath: string;
  readonly annotationPath?: string;
  readonly assemblyId: string;
  readonly name: string;
  readonly organism: string;
  readonly taxId?: number;
  readonly assembly?: string;
  readonly description: string;
  readonly contigRoster: ReadonlyArray<HostedReferenceContigV1>;
  readonly outputDirectory: string;
}

export interface NcbiReferenceCatalogCandidateV1 {
  readonly contract: typeof NCBI_REFERENCE_SOURCE_ADMISSION_V1;
  readonly accession: string;
  readonly acquisition: Readonly<{
    receiptPath: string;
    packagePath: string;
    receiptSha256: string;
    packageSha256: string;
    externalAnnotationPath?: string;
    externalAnnotationSha256?: string;
  }>;
  readonly snapshots: Readonly<{
    fasta: Readonly<{ relativePath: string; sha256: string; byteLength: number; fileName: string }>;
    annotations: Readonly<{
      relativePath: string;
      sha256: string;
      byteLength: number;
      fileName: string;
    }>;
  }>;
  readonly candidate: HostedReferenceCatalogDefinitionV1;
}

export interface AdmitNcbiReferenceSourceResult {
  readonly fastaPath: string;
  readonly gff3Path: string;
  readonly candidatePath: string;
  readonly candidate: NcbiReferenceCatalogCandidateV1;
}

export async function admitNcbiReferenceSource(
  rawInput: AdmitNcbiReferenceSourceInput
): Promise<AdmitNcbiReferenceSourceResult> {
  const input = validateInput(rawInput);
  const receipt = await readReceipt(input.receiptPath);
  await mkdir(input.outputDirectory, { recursive: true, mode: 0o700 });

  const fastaFileName = `${receipt.accession}_primary.fna`;
  const gff3FileName = `${receipt.accession}_primary.gff3`;
  const candidateFileName = `${receipt.accession}.source-admission.json`;
  const fastaPath = join(input.outputDirectory, fastaFileName);
  const gff3Path = join(input.outputDirectory, gff3FileName);
  const candidatePath = join(input.outputDirectory, candidateFileName);
  await Promise.all([fastaPath, gff3Path, candidatePath].map(assertPathAbsent));

  const temporaryRoot = await mkdtemp(join(input.outputDirectory, `.${receipt.accession}.admit-`));
  const createdFinals = new Set<string>();
  try {
    const packageBytes = await hashFile(input.packagePath);
    if (packageBytes.sha256 !== receipt.package.sha256) {
      throw new Error('NCBI package bytes do not match the acquisition receipt.');
    }

    const sequenceReport = await readNcbiDatasetsSequenceReport(
      input.packagePath,
      receipt.accession
    );
    const resolved = await resolveNcbiDatasetsSelection({
      selectedPath: input.packagePath,
      selectedKind: 'file',
      stagingRoot: join(temporaryRoot, 'validated-sources'),
    });
    if (!resolved || resolved.kind !== 'ncbi-datasets') {
      throw new Error('Admitted NCBI package is not a valid NCBI Datasets package.');
    }
    const externalReceipt =
      receipt.contract === NCBI_REFERENCE_PACKAGE_ACQUISITION_V2 ? receipt : undefined;
    if (!externalReceipt && resolved.sourcePaths.length !== 2) {
      throw new Error('Admitted NCBI package must contain genomic FASTA and GFF3 annotations.');
    }
    if (externalReceipt && resolved.sourcePaths.length !== 1) {
      throw new Error('External-annotation admission requires a sequence-only NCBI package.');
    }
    const fastaSourcePath = resolved.sourcePaths[0];
    const packageGff3Path = resolved.sourcePaths[1];
    if (!fastaSourcePath || (!externalReceipt && !packageGff3Path)) {
      throw new Error('Admitted NCBI package has an incomplete source set.');
    }
    if (!externalReceipt && input.annotationPath !== undefined) {
      throw new Error('NCBI v1 source admission does not accept an external annotation path.');
    }
    if (externalReceipt && input.annotationPath === undefined) {
      throw new Error('NCBI v2 source admission requires the receipt-bound annotation path.');
    }

    const externalAnnotationPath = input.annotationPath;
    if (
      externalReceipt &&
      externalAnnotationPath &&
      basename(externalAnnotationPath) !== externalReceipt.sources.gff3.fileName
    ) {
      throw new Error('External annotation filename does not match the acquisition receipt.');
    }
    if (externalAnnotationPath) {
      await assertPlainFile(externalAnnotationPath, 'External annotation source');
    }
    const rawGff3Path = externalAnnotationPath ?? packageGff3Path;
    if (!rawGff3Path) throw new Error('NCBI source admission has no annotation source.');
    const [extractedFasta, extractedGff3] = await Promise.all([
      hashFile(fastaSourcePath),
      hashFile(rawGff3Path),
    ]);
    if (
      extractedFasta.sha256 !== receipt.sources.fasta.sha256 ||
      extractedGff3.sha256 !== receipt.sources.gff3.sha256
    ) {
      throw new Error('Extracted NCBI sources do not match the acquisition receipt.');
    }

    let fastaContigs: ReadonlyArray<{
      readonly sourceSeqId: string;
      readonly lengthBp: number;
    }>;
    let gffIds: ReadonlySet<string>;
    let snapshotGff3Path: string;
    if (externalReceipt) {
      const normalizedPath = join(temporaryRoot, 'normalized-external-annotation.gff3');
      const fastaInspection = await inspectLocalReferenceSources([fastaSourcePath]);
      const normalized = await normalizeNcbiExternalAnnotationGff3({
        sourcePath: rawGff3Path,
        destinationPath: normalizedPath,
        sequenceReport,
        targetSourceSeqIds: new Set(
          fastaInspection.fasta.contigs.map((contig) => contig.sourceSeqId)
        ),
      });
      fastaContigs = fastaInspection.fasta.contigs;
      gffIds = normalized.sourceSeqIds;
      snapshotGff3Path = normalizedPath;
    } else {
      const inspection = await inspectLocalReferenceSources(resolved.sourcePaths);
      if (!inspection.gff3) {
        throw new Error('NCBI source admission refuses sequence-only packages.');
      }
      fastaContigs = inspection.fasta.contigs;
      gffIds = new Set([...inspection.gff3.seqIds, ...inspection.gff3.sequenceRegions.keys()]);
      snapshotGff3Path = packageGff3Path as string;
    }
    const boundContigs = bindContigRoster(input.contigRoster, fastaContigs, gffIds, sequenceReport);

    const fastaReceipt = await writePrimaryFastaSnapshot({
      sourcePath: fastaSourcePath,
      destinationPath: fastaPath,
      orderedSourceSeqIds: boundContigs.map((contig) => contig.sourceSeqId),
    });
    createdFinals.add(fastaPath);
    const gff3Receipt = await writePrimaryGff3Snapshot({
      sourcePath: snapshotGff3Path,
      destinationPath: gff3Path,
      orderedContigs: boundContigs.map((contig) => ({
        sourceSeqId: contig.sourceSeqId,
        lengthBp: contig.lengthBp,
      })),
    });
    createdFinals.add(gff3Path);
    await inspectLocalReferenceSources([fastaPath, gff3Path]);

    const fastaRelativePath = hostedReferenceSourceRelativePath({
      assemblyId: input.assemblyId,
      accession: receipt.accession,
      fileName: fastaFileName,
      sha256: fastaReceipt.sha256,
    });
    const gff3RelativePath = hostedReferenceSourceRelativePath({
      assemblyId: input.assemblyId,
      accession: receipt.accession,
      fileName: gff3FileName,
      sha256: gff3Receipt.sha256,
    });

    const provenance: HostedReferenceCatalogDefinitionV1['provenance'] = externalReceipt
      ? externalAnnotationProvenance(externalReceipt, input.assembly)
      : {
          provider: 'NCBI RefSeq',
          datasetId: receipt.accession,
          datasetVersion: input.assembly ?? receipt.accession,
          sourceUrl: `https://www.ncbi.nlm.nih.gov/datasets/genome/${receipt.accession}/`,
          license: 'NCBI public-domain data',
          attribution: 'National Center for Biotechnology Information (NCBI)',
        };
    const candidateDefinition: HostedReferenceCatalogDefinitionV1 = {
      id: input.assemblyId,
      name: input.name,
      organism: input.organism,
      ...(input.taxId !== undefined ? { taxId: input.taxId } : {}),
      ...(input.assembly !== undefined ? { assembly: input.assembly } : {}),
      description: input.description,
      sources: {
        fasta: {
          relativePath: fastaRelativePath,
          sha256: fastaReceipt.sha256,
          byteLength: fastaReceipt.byteLength,
        },
        annotations: {
          relativePath: gff3RelativePath,
          sha256: gff3Receipt.sha256,
          byteLength: gff3Receipt.byteLength,
        },
      },
      provenance,
      contigs: boundContigs,
    };
    if ('preparedBundle' in candidateDefinition) {
      throw new Error('NCBI source admission must not emit a prepared bundle.');
    }

    const receiptSha256 = (await hashFile(input.receiptPath)).sha256;
    const candidate: NcbiReferenceCatalogCandidateV1 = {
      contract: NCBI_REFERENCE_SOURCE_ADMISSION_V1,
      accession: receipt.accession,
      acquisition: {
        receiptPath: basename(input.receiptPath),
        packagePath: basename(input.packagePath),
        receiptSha256,
        packageSha256: packageBytes.sha256,
        ...(externalReceipt && externalAnnotationPath
          ? {
              externalAnnotationPath: basename(externalAnnotationPath),
              externalAnnotationSha256: extractedGff3.sha256,
            }
          : {}),
      },
      snapshots: {
        fasta: { ...fastaReceipt, relativePath: fastaRelativePath, fileName: fastaFileName },
        annotations: { ...gff3Receipt, relativePath: gff3RelativePath, fileName: gff3FileName },
      },
      candidate: candidateDefinition,
    };

    const candidateHandle = await open(candidatePath, 'wx', 0o600);
    createdFinals.add(candidatePath);
    try {
      await candidateHandle.writeFile(`${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
      await candidateHandle.sync();
    } finally {
      await candidateHandle.close();
    }

    return { fastaPath, gff3Path, candidatePath, candidate };
  } catch (error) {
    await Promise.all([...createdFinals].map((path) => rm(path, { force: true })));
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function parseAdmitNcbiReferenceSourceCli(argv: readonly string[]): Omit<
  AdmitNcbiReferenceSourceInput,
  'contigRoster' | 'taxId' | 'assembly'
> &
  Readonly<{
    contigRosterPath: string;
    taxId?: number;
    assembly?: string;
  }> {
  const values = new Map<string, string>();
  const allowed = new Set([
    'receipt',
    'package',
    'annotation',
    'assembly-id',
    'name',
    'organism',
    'tax-id',
    'assembly',
    'description',
    'contig-roster',
    'output-directory',
  ]);
  for (const argument of argv) {
    const match = /^--([^=]+)=(.+)$/u.exec(argument);
    if (!match || !allowed.has(match[1])) {
      throw new Error(`Unknown NCBI source-admission argument: ${argument}`);
    }
    if (values.has(match[1])) {
      throw new Error(`Duplicate NCBI source-admission argument: --${match[1]}`);
    }
    values.set(match[1], match[2]);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) {
      throw new Error(
        'Usage: pnpm exec vite-node tools/devops/scripts/admit-ncbi-reference-source.ts ' +
          '--receipt=<path> --package=<path> --assembly-id=<id> --name=<name> ' +
          '--organism=<organism> --description=<text> --contig-roster=<json> ' +
          '--output-directory=<directory> [--annotation=<path>] ' +
          '[--tax-id=<int>] [--assembly=<label>]'
      );
    }
    return value;
  };
  const taxIdRaw = values.get('tax-id');
  let taxId: number | undefined;
  if (taxIdRaw !== undefined) {
    taxId = Number(taxIdRaw);
    if (!Number.isSafeInteger(taxId) || taxId < 1) {
      throw new Error('NCBI source admission tax ID must be a positive safe integer.');
    }
  }
  return {
    receiptPath: resolve(required('receipt')),
    packagePath: resolve(required('package')),
    ...(values.has('annotation')
      ? { annotationPath: resolve(values.get('annotation') as string) }
      : {}),
    assemblyId: required('assembly-id'),
    name: required('name'),
    organism: required('organism'),
    description: required('description'),
    contigRosterPath: resolve(required('contig-roster')),
    outputDirectory: resolve(required('output-directory')),
    ...(taxId === undefined ? {} : { taxId }),
    ...(values.has('assembly') ? { assembly: values.get('assembly') } : {}),
  };
}

export async function loadContigRoster(
  path: string
): Promise<ReadonlyArray<HostedReferenceContigV1>> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('NCBI source admission contig roster must be a non-empty JSON array.');
  }
  return parsed.map((entry, index) => admitContig(entry, `contigRoster[${index}]`));
}

function validateInput(input: AdmitNcbiReferenceSourceInput): AdmitNcbiReferenceSourceInput {
  if (!SAFE_SEGMENT.test(input.assemblyId)) {
    throw new Error('NCBI source admission assembly ID is invalid.');
  }
  if (input.name.trim().length === 0 || input.organism.trim().length === 0) {
    throw new Error('NCBI source admission name and organism are required.');
  }
  if (input.description.trim().length === 0) {
    throw new Error('NCBI source admission description is required.');
  }
  if (input.contigRoster.length === 0) {
    throw new Error('NCBI source admission requires an explicit contig roster.');
  }
  return {
    ...input,
    receiptPath: resolve(input.receiptPath),
    packagePath: resolve(input.packagePath),
    ...(input.annotationPath ? { annotationPath: resolve(input.annotationPath) } : {}),
    outputDirectory: resolve(input.outputDirectory),
  };
}

async function readReceipt(path: string): Promise<NcbiReferencePackageAcquisitionReceipt> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  const contract =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { contract?: unknown }).contract
      : undefined;
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    ![NCBI_REFERENCE_PACKAGE_ACQUISITION_V1, NCBI_REFERENCE_PACKAGE_ACQUISITION_V2].includes(
      contract as
        | typeof NCBI_REFERENCE_PACKAGE_ACQUISITION_V1
        | typeof NCBI_REFERENCE_PACKAGE_ACQUISITION_V2
    )
  ) {
    throw new Error('NCBI source admission receipt is not a supported acquisition receipt.');
  }
  const receipt = parsed as NcbiReferencePackageAcquisitionReceipt;
  if (!ACCESSION.test(receipt.accession)) {
    throw new Error('NCBI acquisition receipt accession must be an exact versioned assembly.');
  }
  return receipt;
}

function bindContigRoster(
  roster: ReadonlyArray<HostedReferenceContigV1>,
  fastaContigs: ReadonlyArray<{ readonly sourceSeqId: string; readonly lengthBp: number }>,
  gffIds: ReadonlySet<string>,
  sequenceReport: ReadonlyArray<NcbiSequenceReportRecordV1>
): readonly HostedReferenceContigV1[] {
  const fastaById = new Map(fastaContigs.map((contig) => [contig.sourceSeqId, contig]));
  const chroms = new Set<string>();
  const sourceSeqIds = new Set<string>();
  return roster.map((contig, index) => {
    const admitted = admitContig(contig, `contigRoster[${index}]`);
    if (chroms.has(admitted.chrom)) {
      throw new Error(`Contig roster chrom is duplicated: ${admitted.chrom}`);
    }
    if (sourceSeqIds.has(admitted.sourceSeqId)) {
      throw new Error(`Contig roster sourceSeqId is duplicated: ${admitted.sourceSeqId}`);
    }
    chroms.add(admitted.chrom);
    sourceSeqIds.add(admitted.sourceSeqId);

    const fasta = fastaById.get(admitted.sourceSeqId);
    if (!fasta) {
      throw new Error(`Contig roster sequence ${admitted.sourceSeqId} is absent from the FASTA.`);
    }
    if (fasta.lengthBp !== admitted.lengthBp) {
      throw new Error(
        `Contig roster length for ${admitted.sourceSeqId} does not match FASTA (${admitted.lengthBp} vs ${fasta.lengthBp}).`
      );
    }
    const report = sequenceReport.find(
      (record) =>
        record.refseqAccession === admitted.sourceSeqId ||
        record.genbankAccession === admitted.sourceSeqId
    );
    if (!report) {
      throw new Error(
        `Contig roster sequence ${admitted.sourceSeqId} is absent from the NCBI sequence report.`
      );
    }
    if (report.length !== admitted.lengthBp) {
      throw new Error(
        `Contig roster length for ${admitted.sourceSeqId} does not match the NCBI sequence report.`
      );
    }
    if (!gffIds.has(admitted.sourceSeqId)) {
      throw new Error(`Contig roster sequence ${admitted.sourceSeqId} is absent from the GFF3.`);
    }
    return admitted;
  });
}

function admitContig(value: unknown, label: string): HostedReferenceContigV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const raw = value as Record<string, unknown>;
  const chrom = requiredText(raw.chrom, `${label}.chrom`);
  const sourceSeqId = requiredText(raw.sourceSeqId, `${label}.sourceSeqId`);
  const displayName = requiredText(raw.displayName, `${label}.displayName`);
  if (typeof raw.lengthBp !== 'number' || !Number.isSafeInteger(raw.lengthBp) || raw.lengthBp < 1) {
    throw new Error(`${label}.lengthBp must be a positive safe integer.`);
  }
  if (typeof raw.role !== 'string' || !SEQUENCE_ROLES.has(raw.role as AssemblySequenceRole)) {
    throw new Error(`${label}.role is not a supported assembly sequence role.`);
  }
  if (typeof raw.circular !== 'boolean') {
    throw new Error(`${label}.circular must be a boolean.`);
  }
  const aliases = admitAliases(raw.aliases, `${label}.aliases`);
  const contig: HostedReferenceContigV1 = {
    chrom,
    sourceSeqId,
    displayName,
    lengthBp: raw.lengthBp,
    role: raw.role as AssemblySequenceRole,
    circular: raw.circular,
    ...(aliases ? { aliases } : {}),
    ...(typeof raw.cytobandId === 'string' ? { cytobandId: raw.cytobandId } : {}),
  };
  return contig;
}

function admitAliases(value: unknown, label: string): AssemblySequenceAliases | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const raw = value as Record<string, unknown>;
  const aliases: AssemblySequenceAliases = {};
  for (const key of ['refseq', 'genbank', 'ucsc', 'ensembl'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || raw[key].trim().length === 0) {
      throw new Error(`${label}.${key} must be a non-empty string.`);
    }
    aliases[key] = raw[key];
  }
  const unknown = Object.keys(raw).filter(
    (key) => !['refseq', 'genbank', 'ucsc', 'ensembl'].includes(key)
  );
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported alias keys: ${unknown.join(', ')}`);
  }
  return Object.keys(aliases).length > 0 ? aliases : undefined;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function externalAnnotationProvenance(
  receipt: NcbiReferencePackageAcquisitionReceiptV2,
  assembly: string | undefined
): HostedReferenceCatalogDefinitionV1['provenance'] {
  return {
    provider: 'NCBI GenBank + Figshare',
    datasetId: `${receipt.accession}; ${receipt.externalAnnotation.datasetId}`,
    datasetVersion: `${assembly ?? receipt.accession}; ${receipt.externalAnnotation.datasetVersion}`,
    sourceUrl: receipt.externalAnnotation.sourceUrl,
    license: `NCBI public-domain data; ${receipt.externalAnnotation.license}`,
    attribution:
      `National Center for Biotechnology Information (NCBI); ` +
      receipt.externalAnnotation.attribution,
  };
}

function hostedReferenceSourceRelativePath(input: {
  readonly assemblyId: string;
  readonly accession: string;
  readonly fileName: string;
  readonly sha256: string;
}): string {
  if (!SAFE_SEGMENT.test(input.assemblyId) || !SAFE_SEGMENT.test(input.accession)) {
    throw new Error('Hosted reference source path segments are invalid.');
  }
  if (!SHA256.test(input.sha256)) {
    throw new Error('Hosted reference source SHA-256 must be 64 lowercase hexadecimal characters.');
  }
  return `${input.assemblyId}/${input.accession}/${input.sha256.slice(0, 16)}/${input.fileName}`;
}

async function hashFile(
  path: string
): Promise<{ readonly sha256: string; readonly byteLength: number }> {
  const hash = createHash('sha256');
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    byteLength += bytes.byteLength;
  }
  if (byteLength === 0) throw new Error(`File is empty: ${basename(path)}`);
  return { sha256: hash.digest('hex'), byteLength };
}

async function assertPlainFile(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file.`);
  }
}

async function assertPathAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`NCBI source admission output already exists: ${path}`);
}
