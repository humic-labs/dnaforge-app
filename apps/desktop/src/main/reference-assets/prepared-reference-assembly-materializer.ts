import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { LoadedReferencePreparationManifest } from './reference-preparation-manifest';
import {
  createLocalPreparedSourceReceipt,
  LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_FILE,
  samePreparedSourceFileIdentity,
  type PreparedOutputIdentitySet,
  type PreparedSourceFileIdentity,
} from './prepared-reference-source-receipt';
import {
  assertAtOrBelow,
  DNA_INDEXER_SCHEMA,
  fileIdentity,
  isBgzfFile,
  readDnaIndexerSchema,
  readPreparedFaiLength,
  type PreparedOutputPaths,
  type PreparedSourcePaths,
  verifyOptionalSha256,
} from './reference-preparation-file-integrity';
import { runDnaIndexerAssemblyIngestProcess } from './dna-indexer-process';
import { preparedAnnotationIndexSuffix } from './reference-preparation-validation';

const DNA_INDEXER_ASSEMBLY_CONTIG_MAP_V1 = 'dna-indexer-ingest-gff3-assembly.v1';
const DNA_INDEXER_SEMANTIC_CANDIDATES_V1 = 'dna-indexer-semantic-candidates.v1';
const MAX_DNA_INDEXER_SEMANTIC_CANDIDATES = 65_536;
const ADMITTED_GFF3_SEMANTIC_TYPES = new Set([
  'centromere',
  'SO:0000577',
  'origin_of_replication',
  'SO:0000296',
]);

export interface DnaIndexerAssemblySemanticCandidate {
  readonly sourceSeqId: string;
  readonly type: 'centromere' | 'SO:0000577' | 'origin_of_replication' | 'SO:0000296';
  readonly start: number;
  readonly end: number;
}

export interface DnaIndexerAssemblyTerminalStatus {
  readonly ok: boolean;
  readonly bundles: ReadonlyArray<{
    readonly sourceSeqId: string;
    readonly name: string;
    readonly length: number;
    readonly featureCount: number;
  }>;
  readonly semanticCandidates?: Readonly<{
    readonly contract: typeof DNA_INDEXER_SEMANTIC_CANDIDATES_V1;
    readonly records: readonly DnaIndexerAssemblySemanticCandidate[];
  }>;
}

type PreparedReferenceMember = LoadedReferencePreparationManifest['entry']['members'][number];

type AssemblyPlanMember = {
  sourceSeqId: string;
  name: string;
  expectedLengthBp: number;
  circular: boolean | undefined;
};

type PreparedSourceIdentityPair = {
  fasta: PreparedSourceFileIdentity;
  gff?: PreparedSourceFileIdentity;
};

function preparedReferenceHasAnnotations(preparation: LoadedReferencePreparationManifest): boolean {
  const hasSourceGff = Boolean(preparation.source.gffPath);
  const hasSourceGffDigest = Boolean(preparation.source.gffSha256);
  if (hasSourceGff !== hasSourceGffDigest) {
    throw new Error('Prepared reference annotation path and digest must be present together.');
  }
  return hasSourceGff && hasSourceGffDigest;
}

function planPreparedReferenceMembers(
  preparation: LoadedReferencePreparationManifest
): AssemblyPlanMember[] {
  return preparation.entry.members.map((member) => {
    if (!member.manifest || !member.importSource?.sourceSeqId || member.lengthBp === undefined) {
      throw new Error(`Prepared reference member ${member.chrom} is incomplete.`);
    }
    if (
      member.importSource.fastaPath !== preparation.source.fastaPath ||
      member.importSource.fastaSha256 !== preparation.source.fastaSha256 ||
      (member.importSource.gffPath ?? null) !== (preparation.source.gffPath ?? null) ||
      (member.importSource.gffSha256 ?? null) !== (preparation.source.gffSha256 ?? null)
    ) {
      throw new Error(
        `Prepared reference member ${member.chrom} does not use the declared assembly source set.`
      );
    }
    return {
      sourceSeqId: member.importSource.sourceSeqId,
      name: member.chrom,
      expectedLengthBp: member.lengthBp,
      circular: member.circular,
    };
  });
}

function dnaIndexerAssemblyIngestArgs(
  sourcePaths: PreparedSourcePaths,
  contigMapPath: string,
  stagingRoot: string
): string[] {
  return sourcePaths.gff
    ? [
        'ingest-gff3-assembly',
        '--in',
        sourcePaths.gff,
        '--in-fasta',
        sourcePaths.fasta,
        '--contig-map',
        contigMapPath,
        '--out-dir',
        stagingRoot,
      ]
    : [
        'ingest-fasta-assembly',
        '--in',
        sourcePaths.fasta,
        '--contig-map',
        contigMapPath,
        '--out-dir',
        stagingRoot,
      ];
}

async function capturePreparedSourceIdentity(
  sourcePaths: PreparedSourcePaths
): Promise<PreparedSourceIdentityPair> {
  return {
    fasta: await fileIdentity(sourcePaths.fasta),
    ...(sourcePaths.gff ? { gff: await fileIdentity(sourcePaths.gff) } : {}),
  };
}

async function verifyPreparedSourceDigests(
  preparation: LoadedReferencePreparationManifest,
  sourcePaths: PreparedSourcePaths
): Promise<void> {
  await Promise.all([
    verifyOptionalSha256(
      sourcePaths.fasta,
      preparation.source.fastaSha256,
      `${preparation.entry.id} FASTA`
    ),
    ...(sourcePaths.gff && preparation.source.gffSha256
      ? [
          verifyOptionalSha256(
            sourcePaths.gff,
            preparation.source.gffSha256,
            `${preparation.entry.id} GFF3`
          ),
        ]
      : []),
  ]);
}

function assertIndexerBundlesMatchPlan(
  terminal: DnaIndexerAssemblyTerminalStatus,
  planMembers: readonly AssemblyPlanMember[]
): void {
  if (
    terminal.bundles.length !== planMembers.length ||
    terminal.bundles.some((bundle, index) => {
      const expected = planMembers[index];
      return (
        bundle.sourceSeqId !== expected.sourceSeqId ||
        bundle.name !== expected.name ||
        bundle.length !== expected.expectedLengthBp
      );
    })
  ) {
    throw new Error('dna-indexer assembly result does not exactly match the contig map.');
  }
}

function assertSourceUnchangedDuringIndex(
  entryId: string,
  sourceBefore: PreparedSourceIdentityPair,
  sourceAfter: PreparedSourceIdentityPair
): void {
  if (
    !samePreparedSourceFileIdentity(sourceBefore.fasta, sourceAfter.fasta) ||
    (sourceBefore.gff &&
      sourceAfter.gff &&
      !samePreparedSourceFileIdentity(sourceBefore.gff, sourceAfter.gff))
  ) {
    throw new Error(`${entryId} source changed while dna-indexer was running.`);
  }
}

async function assertExactStagedAssemblyFiles(
  stagingRoot: string,
  members: readonly PreparedReferenceMember[],
  hasAnnotations: boolean
): Promise<void> {
  const expectedStagedFiles = new Set<string>(['contig-map.v1.json']);
  for (const member of members) {
    const suffixes = hasAnnotations
      ? [
          'fa.gz',
          'fa.gz.fai',
          'fa.gz.gzi',
          'gff3.gz',
          preparedAnnotationIndexSuffix(member.lengthBp ?? 0),
        ]
      : ['fa.gz', 'fa.gz.fai', 'fa.gz.gzi'];
    for (const suffix of suffixes) {
      expectedStagedFiles.add(`${member.chrom}.${suffix}`);
    }
  }
  const stagedEntries = await readdir(stagingRoot, { withFileTypes: true });
  const actualStagedFiles = new Set(
    stagedEntries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  );
  if (
    stagedEntries.some((entry) => !entry.isFile()) ||
    actualStagedFiles.size !== expectedStagedFiles.size ||
    [...expectedStagedFiles].some((name) => !actualStagedFiles.has(name))
  ) {
    throw new Error('dna-indexer assembly staging contains missing or unexpected outputs.');
  }
}

async function inspectStagedChromOutput(
  stagingRoot: string,
  member: PreparedReferenceMember,
  hasAnnotations: boolean
): Promise<PreparedOutputPaths> {
  const staged: PreparedOutputPaths = {
    fasta: join(stagingRoot, `${member.chrom}.fa.gz`),
    fai: join(stagingRoot, `${member.chrom}.fa.gz.fai`),
    gzi: join(stagingRoot, `${member.chrom}.fa.gz.gzi`),
    ...(hasAnnotations
      ? {
          gff: join(stagingRoot, `${member.chrom}.gff3.gz`),
          tbi: join(
            stagingRoot,
            `${member.chrom}.${preparedAnnotationIndexSuffix(member.lengthBp ?? 0)}`
          ),
        }
      : {}),
  };
  for (const path of Object.values(staged)) await fileIdentity(path);
  if (!(await isBgzfFile(staged.fasta))) {
    throw new Error(`${member.chrom} FASTA indexer output is not BGZF.`);
  }
  if (staged.gff && !(await isBgzfFile(staged.gff))) {
    throw new Error(`${member.chrom} indexer output is not BGZF.`);
  }
  if (staged.gff && (await readDnaIndexerSchema(staged.gff)) !== DNA_INDEXER_SCHEMA) {
    throw new Error(`${member.chrom} indexer output has an incompatible schema.`);
  }
  const preparedLength = await readPreparedFaiLength(staged.fai, member.chrom);
  if (preparedLength !== member.lengthBp) {
    throw new Error(
      `${member.chrom} FASTA length ${preparedLength} does not match manifest length ${member.lengthBp}.`
    );
  }
  return staged;
}

async function publishStagedMemberOutput(
  sourceGenerationRoot: string,
  member: PreparedReferenceMember,
  staged: PreparedOutputPaths,
  hasAnnotations: boolean,
  indexerVersion: string,
  sourceAfter: PreparedSourceIdentityPair
): Promise<void> {
  const manifest = member.manifest;
  if (!manifest) {
    throw new Error(`Prepared reference member ${member.chrom} lost its staged output.`);
  }
  const manifestHasGff = Boolean(manifest.gffPath);
  const manifestHasTbi = Boolean(manifest.tbiPath);
  if (manifestHasGff !== manifestHasTbi || (manifestHasGff && manifestHasTbi) !== hasAnnotations) {
    throw new Error(
      `Prepared reference member ${member.chrom} has a mismatched annotation output variant.`
    );
  }
  const manifestAnnotationPaths =
    manifest.gffPath && manifest.tbiPath
      ? { gffPath: manifest.gffPath, tbiPath: manifest.tbiPath }
      : null;
  const output: PreparedOutputPaths = {
    fasta: resolve(sourceGenerationRoot, manifest.fastaPath),
    fai: resolve(sourceGenerationRoot, manifest.faiPath),
    ...(manifest.fastaPath.toLowerCase().endsWith('.gz')
      ? { gzi: resolve(sourceGenerationRoot, `${manifest.fastaPath}.gzi`) }
      : {}),
    ...(manifestAnnotationPaths
      ? {
          gff: resolve(sourceGenerationRoot, manifestAnnotationPaths.gffPath),
          tbi: resolve(sourceGenerationRoot, manifestAnnotationPaths.tbiPath),
        }
      : {}),
  };
  for (const path of Object.values(output)) {
    assertAtOrBelow(sourceGenerationRoot, path, 'Prepared reference assembly output');
  }
  const outputDir = dirname(output.fasta);
  await mkdir(outputDir, { recursive: true });
  await rename(staged.fasta, output.fasta);
  await rename(staged.fai, output.fai);
  if (staged.gzi && output.gzi) {
    await rename(staged.gzi, output.gzi);
  }
  if (staged.gff && staged.tbi && output.gff && output.tbi) {
    await rename(staged.gff, output.gff);
    await rename(staged.tbi, output.tbi);
  }
  await writePreparedSourceReceipt(member.chrom, indexerVersion, sourceAfter, output, outputDir);
}

export async function materializePreparedReferenceAssembly(
  preparation: LoadedReferencePreparationManifest,
  sourceGenerationRoot: string,
  indexer: Readonly<{ binary: string; version: string }>,
  report?: (message: string) => void
): Promise<readonly DnaIndexerAssemblySemanticCandidate[]> {
  const members = preparation.entry.members;
  const hasAnnotations = preparedReferenceHasAnnotations(preparation);
  const sourcePaths: PreparedSourcePaths = {
    fasta: preparation.source.fastaPath,
    ...(hasAnnotations ? { gff: preparation.source.gffPath } : {}),
  };
  const stagingRoot = join(sourceGenerationRoot, `.assembly.${randomUUID()}.reference-staging`);
  const contigMapPath = join(stagingRoot, 'contig-map.v1.json');
  assertAtOrBelow(sourceGenerationRoot, stagingRoot, 'Prepared reference assembly staging');
  assertAtOrBelow(stagingRoot, contigMapPath, 'Prepared reference assembly contig map');
  const planMembers = planPreparedReferenceMembers(preparation);

  try {
    const sourceBefore = await capturePreparedSourceIdentity(sourcePaths);
    await verifyPreparedSourceDigests(preparation, sourcePaths);
    await mkdir(stagingRoot);
    await writeFile(
      contigMapPath,
      `${JSON.stringify(
        {
          contract: DNA_INDEXER_ASSEMBLY_CONTIG_MAP_V1,
          contigs: planMembers,
        },
        null,
        2
      )}\n`,
      { encoding: 'utf8', flag: 'wx' }
    );
    report?.(
      `indexing ${members.length} contig${members.length === 1 ? '' : 's'} in one dna-indexer source pass`
    );
    const stdout = await runDnaIndexerAssemblyIngestProcess({
      binary: indexer.binary,
      args: dnaIndexerAssemblyIngestArgs(sourcePaths, contigMapPath, stagingRoot),
    });
    const terminal = parseDnaIndexerAssemblyTerminalStatus(stdout, planMembers, hasAnnotations);
    assertIndexerBundlesMatchPlan(terminal, planMembers);
    const sourceAfter = await capturePreparedSourceIdentity(sourcePaths);
    assertSourceUnchangedDuringIndex(preparation.entry.id, sourceBefore, sourceAfter);
    await assertExactStagedAssemblyFiles(stagingRoot, members, hasAnnotations);

    const stagedByChrom = new Map<string, PreparedOutputPaths>();
    for (const member of members) {
      stagedByChrom.set(
        member.chrom,
        await inspectStagedChromOutput(stagingRoot, member, hasAnnotations)
      );
    }

    for (const member of members) {
      const staged = stagedByChrom.get(member.chrom);
      if (!staged) {
        throw new Error(`Prepared reference member ${member.chrom} lost its staged output.`);
      }
      await publishStagedMemberOutput(
        sourceGenerationRoot,
        member,
        staged,
        hasAnnotations,
        indexer.version,
        sourceAfter
      );
    }
    report?.(`indexed ${members.length} assembly contig${members.length === 1 ? '' : 's'}`);
    return terminal.semanticCandidates?.records ?? [];
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export function parseDnaIndexerAssemblyTerminalStatus(
  stdout: string,
  planMembers: readonly AssemblyPlanMember[],
  requireSemanticCandidates: boolean
): DnaIndexerAssemblyTerminalStatus {
  const terminalLine = stdout
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.trim().startsWith('{'));
  if (!terminalLine) {
    throw new Error('dna-indexer assembly ingestion emitted no terminal JSON status.');
  }
  const parsed: unknown = JSON.parse(terminalLine);
  if (!isRecord(parsed) || parsed.ok !== true || !Array.isArray(parsed.bundles)) {
    throw new Error('dna-indexer assembly ingestion did not report a complete bundle set.');
  }
  const bundles = parsed.bundles.map((value, index) => {
    if (!isRecord(value)) {
      throw new Error(`dna-indexer assembly bundle ${index} is malformed.`);
    }
    if (
      typeof value.sourceSeqId !== 'string' ||
      typeof value.name !== 'string' ||
      !Number.isSafeInteger(value.length) ||
      !Number.isSafeInteger(value.featureCount)
    ) {
      throw new Error(`dna-indexer assembly bundle ${index} is malformed.`);
    }
    return {
      sourceSeqId: value.sourceSeqId,
      name: value.name,
      length: value.length as number,
      featureCount: value.featureCount as number,
    };
  });
  const semanticCandidates = parseSemanticCandidates(
    parsed.semanticCandidates,
    planMembers,
    requireSemanticCandidates
  );
  return {
    ok: true,
    bundles,
    ...(semanticCandidates ? { semanticCandidates } : {}),
  };
}

function parseSemanticCandidates(
  value: unknown,
  planMembers: readonly AssemblyPlanMember[],
  required: boolean
): DnaIndexerAssemblyTerminalStatus['semanticCandidates'] {
  if (value === undefined) {
    if (required) {
      throw new Error('dna-indexer assembly ingestion omitted semantic candidates.');
    }
    return undefined;
  }
  if (!isRecord(value) || value.contract !== DNA_INDEXER_SEMANTIC_CANDIDATES_V1) {
    throw new Error('dna-indexer semantic candidates use an unsupported contract.');
  }
  if (!Array.isArray(value.records) || value.records.length > MAX_DNA_INDEXER_SEMANTIC_CANDIDATES) {
    throw new Error('dna-indexer semantic candidate records exceed their bounded contract.');
  }
  const memberLengths = new Map(
    planMembers.map((member) => [member.sourceSeqId, member.expectedLengthBp])
  );
  const records = value.records.map((raw, index): DnaIndexerAssemblySemanticCandidate => {
    if (!isRecord(raw)) {
      throw new Error(`dna-indexer semantic candidate ${index} is malformed.`);
    }
    const length = typeof raw.sourceSeqId === 'string' ? memberLengths.get(raw.sourceSeqId) : 0;
    if (
      typeof raw.sourceSeqId !== 'string' ||
      length === undefined ||
      typeof raw.type !== 'string' ||
      !ADMITTED_GFF3_SEMANTIC_TYPES.has(raw.type) ||
      !Number.isSafeInteger(raw.start) ||
      !Number.isSafeInteger(raw.end) ||
      (raw.start as number) < 1 ||
      (raw.end as number) < (raw.start as number) ||
      (raw.end as number) > length
    ) {
      throw new Error(`dna-indexer semantic candidate ${index} is invalid.`);
    }
    return {
      sourceSeqId: raw.sourceSeqId,
      type: raw.type as DnaIndexerAssemblySemanticCandidate['type'],
      start: raw.start as number,
      end: raw.end as number,
    };
  });
  return { contract: DNA_INDEXER_SEMANTIC_CANDIDATES_V1, records };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function writePreparedSourceReceipt(
  chrom: string,
  indexerVersion: string,
  source: Readonly<{ fasta: PreparedSourceFileIdentity; gff?: PreparedSourceFileIdentity }>,
  outputPaths: PreparedOutputPaths,
  outputDir: string
): Promise<void> {
  const receiptPath = join(outputDir, LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_FILE);
  const temporaryReceipt = `${receiptPath}.${randomUUID()}.tmp`;
  const output: PreparedOutputIdentitySet = {
    fasta: await fileIdentity(outputPaths.fasta),
    fai: await fileIdentity(outputPaths.fai),
    ...(outputPaths.gff && outputPaths.tbi
      ? {
          gff: await fileIdentity(outputPaths.gff),
          tbi: await fileIdentity(outputPaths.tbi),
        }
      : {}),
  };
  const receipt = createLocalPreparedSourceReceipt({
    chrom,
    indexerVersion,
    source,
    output,
  });
  try {
    await writeFile(temporaryReceipt, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporaryReceipt, receiptPath);
  } finally {
    await unlink(temporaryReceipt).catch(() => undefined);
  }
}
