import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip } from 'node:zlib';

import type { LocalReferenceIdentityOverrideV1 } from './local-reference-source-types';
import { LOCAL_REFERENCE_ASSEMBLY_ID_PREFIX } from '../../features/sequence/reference-asset-publication';

import {
  type LoadedReferencePreparationManifestV2,
  parseReferencePreparationManifestV2,
  REFERENCE_ASSEMBLY_IDENTITY_V2,
  REFERENCE_PREPARATION_MANIFEST_V2,
  referenceAssemblyIdentitySha256V2,
} from './reference-preparation-manifest';

const MAX_METADATA_LINE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_ID_CHARACTERS = 2_048;
const SAFE_CONTIG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const GFF3_REGION_FIELD = Buffer.from('\tregion\t');
const GFF3_EMBEDDED_FASTA_DIRECTIVE = Buffer.from('##FASTA');
const GFF3_SEQUENCE_REGION_DIRECTIVE = Buffer.from('##sequence-region ');

export interface LocalReferenceFastaContigInspection {
  readonly sourceSeqId: string;
  readonly lengthBp: number;
  readonly normalizedSequenceSha256: string;
}

export interface LocalReferenceFastaInspection {
  readonly kind: 'fasta';
  readonly path: string;
  readonly sha256: string;
  readonly gzipCompressed: boolean;
  readonly contigs: ReadonlyArray<LocalReferenceFastaContigInspection>;
}

export interface LocalReferenceGff3Inspection {
  readonly kind: 'gff3';
  readonly path: string;
  readonly sha256: string;
  readonly gzipCompressed: boolean;
  readonly seqIds: ReadonlyArray<string>;
  readonly circularSeqIds: ReadonlySet<string>;
  readonly globalCircular: boolean;
  readonly organism?: string;
  readonly taxId?: number;
  readonly assemblyAccession?: string;
  readonly sequenceRegions: ReadonlyMap<string, Readonly<{ start: number; end: number }>>;
}

export interface LocalReferenceSourceInspection {
  readonly fasta: LocalReferenceFastaInspection;
  readonly gff3?: LocalReferenceGff3Inspection;
  readonly assemblyIdentitySha256: string;
  readonly assemblyId: string;
  readonly name: string;
  readonly organism: string;
  readonly taxId?: number;
  readonly assemblyAccession?: string;
}

export interface MachineOwnedReferencePreparationManifestV2 {
  readonly contract: typeof REFERENCE_PREPARATION_MANIFEST_V2;
  readonly assemblyIdentity: Readonly<{
    contract: typeof REFERENCE_ASSEMBLY_IDENTITY_V2;
    sha256: string;
  }>;
  readonly assembly: Readonly<{
    id: string;
    name: string;
    organism: string;
    taxId?: number;
    accession?: string;
    description: string;
  }>;
  readonly sources: Readonly<{
    fasta: Readonly<{
      path: string;
      sha256: string;
    }>;
    annotations?: Readonly<{
      format: 'gff3';
      path: string;
      sha256: string;
    }>;
  }>;
  readonly provenance: Readonly<{
    provider: string;
    datasetId: string;
    datasetVersion: string;
    sourceUrl?: string;
  }>;
  readonly contigs: ReadonlyArray<
    Readonly<{
      chrom: string;
      sourceSeqId: string;
      displayName: string;
      lengthBp: number;
      circular: boolean;
      normalizedSequenceSha256: string;
    }>
  >;
}

export interface LocalReferencePreparationPlan {
  readonly manifestPath: string;
  readonly manifest: MachineOwnedReferencePreparationManifestV2;
  readonly inspection: LocalReferenceSourceInspection;
  readonly loaded: LoadedReferencePreparationManifestV2;
}

export async function inspectLocalReferenceSources(
  sourcePaths: ReadonlyArray<string>
): Promise<LocalReferenceSourceInspection> {
  const canonicalPaths = await validateLocalSourceSet(sourcePaths);
  return inspectCanonicalLocalReferenceSources(canonicalPaths);
}

async function inspectCanonicalLocalReferenceSources(
  canonicalPaths: readonly [string] | readonly [string, string]
): Promise<LocalReferenceSourceInspection> {
  const sources = await Promise.all(canonicalPaths.map(inspectLocalSourceFile));
  const fastaSources = sources.filter(
    (source): source is LocalReferenceFastaInspection => source.kind === 'fasta'
  );
  const gff3Sources = sources.filter(
    (source): source is LocalReferenceGff3Inspection => source.kind === 'gff3'
  );
  if (fastaSources.length !== 1 || gff3Sources.length > 1) {
    throw new Error(
      'Custom reference import requires exactly one FASTA and at most one GFF3. File type is determined from file content, not its name.'
    );
  }

  const fasta = fastaSources[0];
  const gff3 = gff3Sources[0];
  if (gff3) {
    assertExactSequenceIdentityMapping(fasta, gff3);
    assertSequenceRegionLengths(fasta, gff3);
  }
  return buildLocalReferenceSourceInspection(fasta, gff3);
}

function buildLocalReferenceSourceInspection(
  fasta: LocalReferenceFastaInspection,
  gff3?: LocalReferenceGff3Inspection
): LocalReferenceSourceInspection {
  const identityContigs = fasta.contigs.map((contig) => ({
    ...contig,
    circular: Boolean(gff3?.globalCircular || gff3?.circularSeqIds.has(contig.sourceSeqId)),
  }));
  const assemblyIdentitySha256 = referenceAssemblyIdentitySha256V2(identityContigs);

  return {
    fasta,
    gff3,
    assemblyIdentitySha256,
    assemblyId: `${LOCAL_REFERENCE_ASSEMBLY_ID_PREFIX}${assemblyIdentitySha256.slice(0, 24)}`,
    name: gff3?.assemblyAccession ?? sourceDisplayName(fasta.path),
    organism: gff3?.organism ?? 'Imported reference',
    taxId: gff3?.taxId,
    assemblyAccession: gff3?.assemblyAccession,
  };
}

export async function planLocalReferencePreparation(input: {
  readonly sourcePaths: ReadonlyArray<string>;
  readonly manifestPath: string;
  readonly identity?: LocalReferenceIdentityOverrideV1;
  readonly indexerBinary?: string;
}): Promise<LocalReferencePreparationPlan> {
  if (!isAbsolute(input.manifestPath)) {
    throw new Error('The machine-owned reference preparation manifest path must be absolute.');
  }
  const manifestPath = resolve(input.manifestPath);
  const inspection = await inspectLocalReferenceSourcesForPreparation(
    input.sourcePaths,
    input.indexerBinary
  );
  const canonicalNames = canonicalContigNames(
    inspection.fasta.contigs.map((contig) => contig.sourceSeqId)
  );

  const identity = input.identity ?? {};
  const manifest: MachineOwnedReferencePreparationManifestV2 = {
    contract: REFERENCE_PREPARATION_MANIFEST_V2,
    assemblyIdentity: {
      contract: REFERENCE_ASSEMBLY_IDENTITY_V2,
      sha256: inspection.assemblyIdentitySha256,
    },
    assembly: {
      id: inspection.assemblyId,
      name: identity.name ?? inspection.name,
      organism: identity.organism ?? inspection.organism,
      taxId: identity.taxId ?? inspection.taxId,
      accession: identity.accession ?? inspection.assemblyAccession,
      description:
        identity.description ??
        (inspection.gff3
          ? `Custom reference imported from ${basename(inspection.fasta.path)} and ${basename(
              inspection.gff3.path
            )}.`
          : `Custom reference imported from ${basename(inspection.fasta.path)}.`),
    },
    sources: {
      fasta: {
        path: inspection.fasta.path,
        sha256: inspection.fasta.sha256,
      },
      ...(inspection.gff3
        ? {
            annotations: {
              format: 'gff3' as const,
              path: inspection.gff3.path,
              sha256: inspection.gff3.sha256,
            },
          }
        : {}),
    },
    provenance: {
      provider: identity.provenance?.provider ?? 'Local file import',
      datasetId: identity.provenance?.datasetId ?? inspection.assemblyId,
      datasetVersion:
        identity.provenance?.datasetVersion ??
        (inspection.gff3
          ? `sequence-${inspection.assemblyIdentitySha256.slice(
              0,
              16
            )}-annotations-${inspection.gff3.sha256.slice(0, 16)}`
          : `sequence-${inspection.assemblyIdentitySha256.slice(0, 16)}`),
      ...(identity.provenance?.sourceUrl ? { sourceUrl: identity.provenance.sourceUrl } : {}),
    },
    contigs: inspection.fasta.contigs.map((contig, index) => ({
      chrom: canonicalNames[index],
      sourceSeqId: contig.sourceSeqId,
      displayName: contig.sourceSeqId,
      lengthBp: contig.lengthBp,
      circular: Boolean(
        inspection.gff3?.globalCircular || inspection.gff3?.circularSeqIds.has(contig.sourceSeqId)
      ),
      normalizedSequenceSha256: contig.normalizedSequenceSha256,
    })),
  };
  const loaded = parseReferencePreparationManifestV2(manifest, manifestPath);
  return { manifestPath, manifest, inspection, loaded };
}

export async function writeLocalReferencePreparationManifest(
  plan: LocalReferencePreparationPlan
): Promise<LoadedReferencePreparationManifestV2> {
  const destinationDirectory = dirname(plan.manifestPath);
  await mkdir(destinationDirectory, { recursive: true });
  const canonicalDestinationDirectory = await realpath(destinationDirectory);
  const sourcePaths = [
    plan.inspection.fasta.path,
    ...(plan.inspection.gff3 ? [plan.inspection.gff3.path] : []),
  ];
  for (const sourcePath of sourcePaths) {
    const sourceDirectory = await realpath(dirname(sourcePath));
    if (pathIsWithin(canonicalDestinationDirectory, sourceDirectory)) {
      throw new Error(
        `The machine-owned preparation manifest must be written in the private reference cache, not beside source file ${sourcePath}.`
      );
    }
  }

  const serialized = `${JSON.stringify(plan.manifest, null, 2)}\n`;
  try {
    const current = await readFile(plan.manifestPath, 'utf8');
    if (current === serialized) return plan.loaded;
    throw new Error(
      `Refusing to overwrite a different file at machine-owned manifest path ${plan.manifestPath}.`
    );
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }

  const temporaryPath = `${plan.manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, plan.manifestPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return plan.loaded;
}

type InspectedLocalSource = LocalReferenceFastaInspection | LocalReferenceGff3Inspection;

interface LocalReferenceSourceKindProbe {
  readonly kind: InspectedLocalSource['kind'];
  readonly path: string;
  readonly gzipCompressed: boolean;
}

interface PreparationGff3Inspection {
  readonly gff3: LocalReferenceGff3Inspection;
  readonly planningContigs?: ReadonlyArray<LocalReferenceContigRosterEntry>;
}

interface LocalReferenceContigRosterEntry {
  readonly sourceSeqId: string;
  readonly lengthBp: number;
}

async function validateLocalSourceSet(
  sourcePaths: ReadonlyArray<string>
): Promise<readonly [string] | readonly [string, string]> {
  if (sourcePaths.length !== 1 && sourcePaths.length !== 2) {
    throw new Error(
      `Custom reference import requires one FASTA and an optional GFF3; received ${sourcePaths.length} files.`
    );
  }

  const canonicalPaths = await Promise.all(sourcePaths.map(validateLocalSourcePath));
  if (canonicalPaths.length === 2 && canonicalPaths[0] === canonicalPaths[1]) {
    throw new Error('Custom reference import requires two different source files.');
  }
  return canonicalPaths.length === 1 ? [canonicalPaths[0]] : [canonicalPaths[0], canonicalPaths[1]];
}

async function inspectLocalReferenceSourcesForPreparation(
  sourcePaths: ReadonlyArray<string>,
  indexerBinary?: string
): Promise<LocalReferenceSourceInspection> {
  const canonicalPaths = await validateLocalSourceSet(sourcePaths);
  const probes = await Promise.all(canonicalPaths.map(probeLocalSourceKind));
  const fastaProbes = probes.filter((probe) => probe.kind === 'fasta');
  const gff3Probes = probes.filter((probe) => probe.kind === 'gff3');
  if (fastaProbes.length !== 1 || gff3Probes.length > 1) {
    throw new Error(
      'Custom reference import requires exactly one FASTA and at most one GFF3. File type is determined from file content, not its name.'
    );
  }

  const fastaProbe = fastaProbes[0];
  const gff3Probe = gff3Probes[0];
  if (!gff3Probe) {
    return inspectCanonicalLocalReferenceSources(canonicalPaths);
  }
  const [fastaSource, preparationGff3] = await Promise.all([
    inspectFastaSourceFile(fastaProbe.path, indexerBinary),
    inspectGff3ForPreparation(gff3Probe),
  ]);
  if (fastaSource.kind !== 'fasta') {
    throw new Error('The selected sequence source changed while it was being inspected.');
  }
  if (!preparationGff3.planningContigs) {
    return inspectCanonicalLocalReferenceSources(canonicalPaths);
  }

  assertExactSequenceIdentityMapping(fastaSource, preparationGff3.gff3);
  assertSequenceRegionLengths(fastaSource, preparationGff3.gff3);
  return buildLocalReferenceSourceInspection(fastaSource, preparationGff3.gff3);
}

async function validateLocalSourcePath(path: string): Promise<string> {
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new Error('Custom reference source paths must be non-empty strings.');
  }
  const canonicalPath = await realpath(resolve(path)).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not open custom reference source ${resolve(path)}: ${detail}`);
  });
  const metadata = await stat(canonicalPath);
  if (!metadata.isFile()) {
    throw new Error(`Custom reference source is not a regular file: ${canonicalPath}`);
  }
  return canonicalPath;
}

async function probeLocalSourceKind(path: string): Promise<LocalReferenceSourceKindProbe> {
  const gzipCompressed = await hasGzipMagic(path);
  const source = createReadStream(path);
  const decoded = gzipCompressed ? source.pipe(createGunzip()) : source;
  const decoder = new StringDecoder('utf8');
  let probe = '';
  try {
    for await (const chunk of decoded) {
      const text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      assertValidDecodedText(text, path);
      probe += text;
      const firstLine = firstMeaningfulCompleteLine(probe);
      if (firstLine) {
        return {
          kind: classifyFirstMeaningfulLine(firstLine),
          path,
          gzipCompressed,
        };
      }
      assertMetadataLineBound(probe, path);
    }
    const tail = decoder.end();
    assertValidDecodedText(tail, path);
    probe += tail;
    const firstLine = firstMeaningfulLineAtEnd(probe);
    if (!firstLine) throw new Error('The file is empty.');
    return {
      kind: classifyFirstMeaningfulLine(firstLine),
      path,
      gzipCompressed,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not inspect custom reference source ${path}: ${detail}`);
  } finally {
    decoded.destroy();
    source.destroy();
  }
}

function classifyFirstMeaningfulLine(line: string): InspectedLocalSource['kind'] {
  if (line.startsWith('>')) return 'fasta';
  if (line === '##gff-version 3') return 'gff3';
  throw new Error(
    'Unrecognized file content. Expected a FASTA header or "##gff-version 3" as the first non-empty line.'
  );
}

async function inspectGff3ForPreparation(
  probe: LocalReferenceSourceKindProbe
): Promise<PreparationGff3Inspection> {
  const sha256 = createHash('sha256');
  const hashingTransform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sha256.update(chunk);
      callback(null, chunk);
    },
  });
  const decoded = new PassThrough();
  const transport = probe.gzipCompressed
    ? pipeline(createReadStream(probe.path), hashingTransform, createGunzip(), decoded)
    : pipeline(createReadStream(probe.path), hashingTransform, decoded);
  const parser = new PreparationGff3StreamInspector(probe.path);

  try {
    for await (const chunk of decoded) {
      parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    await transport;
    const inspected = parser.finish();
    return {
      gff3: {
        ...inspected.gff3,
        path: probe.path,
        sha256: sha256.digest('hex'),
        gzipCompressed: probe.gzipCompressed,
      },
      planningContigs: inspected.planningContigs,
    };
  } catch (error) {
    decoded.destroy();
    await transport.catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not inspect custom reference source ${probe.path}: ${detail}`);
  }
}

async function inspectFastaSourceFile(
  path: string,
  indexerBinary: string | undefined
): Promise<InspectedLocalSource> {
  const native = indexerBinary ? await inspectFastaWithIndexer(indexerBinary, path) : null;
  return native ?? inspectLocalSourceFile(path);
}

const INDEXER_INSPECTION_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

async function inspectFastaWithIndexer(
  indexerBinary: string,
  path: string
): Promise<LocalReferenceFastaInspection | null> {
  let stdout: string;
  try {
    stdout = await new Promise<string>((resolveOutput, reject) => {
      execFile(
        indexerBinary,
        ['inspect-fasta', '--in', path],
        { maxBuffer: INDEXER_INSPECTION_MAX_OUTPUT_BYTES, encoding: 'utf8' },
        (error, output) => (error ? reject(error) : resolveOutput(output))
      );
    });
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isIndexerFastaInspection(parsed)) return null;
  return {
    kind: 'fasta',
    path,
    sha256: parsed.sha256,
    gzipCompressed: parsed.gzipCompressed,
    contigs: parsed.contigs,
  };
}

function isIndexerFastaInspection(value: unknown): value is {
  status: 'inspected';
  sha256: string;
  gzipCompressed: boolean;
  contigs: LocalReferenceFastaContigInspection[];
} {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.status === 'inspected' &&
    typeof candidate.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(candidate.sha256) &&
    typeof candidate.gzipCompressed === 'boolean' &&
    Array.isArray(candidate.contigs) &&
    candidate.contigs.length > 0 &&
    candidate.contigs.every(
      (contig: unknown) =>
        !!contig &&
        typeof contig === 'object' &&
        typeof (contig as Record<string, unknown>).sourceSeqId === 'string' &&
        Number.isSafeInteger((contig as Record<string, unknown>).lengthBp) &&
        /^[0-9a-f]{64}$/.test(String((contig as Record<string, unknown>).normalizedSequenceSha256))
    )
  );
}

async function inspectLocalSourceFile(path: string): Promise<InspectedLocalSource> {
  const gzipCompressed = await hasGzipMagic(path);
  const sha256 = createHash('sha256');
  const hashingTransform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sha256.update(chunk);
      callback(null, chunk);
    },
  });
  const decoded = new PassThrough();
  const transport = gzipCompressed
    ? pipeline(createReadStream(path), hashingTransform, createGunzip(), decoded)
    : pipeline(createReadStream(path), hashingTransform, decoded);

  try {
    const inspected = await inspectDecodedSource(decoded, path);
    await transport;
    return {
      ...inspected,
      path,
      sha256: sha256.digest('hex'),
      gzipCompressed,
    };
  } catch (error) {
    decoded.destroy();
    await transport.catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not inspect custom reference source ${path}: ${detail}`);
  }
}

async function inspectDecodedSource(
  input: NodeJS.ReadableStream,
  path: string
): Promise<
  | Omit<LocalReferenceFastaInspection, 'path' | 'sha256' | 'gzipCompressed'>
  | Omit<LocalReferenceGff3Inspection, 'path' | 'sha256' | 'gzipCompressed'>
> {
  const decoder = new StringDecoder('utf8');
  const iterator = input[Symbol.asyncIterator]();
  let probe = '';
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      probe += decoder.end();
      break;
    }
    const text = decoder.write(Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value));
    assertValidDecodedText(text, path);
    probe += text;
    const firstLine = firstMeaningfulCompleteLine(probe);
    if (firstLine) {
      if (firstLine.startsWith('>')) {
        const parser = new FastaStreamInspector(path);
        parser.push(probe);
        for await (const chunk of iterator) {
          const decodedChunk = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          assertValidDecodedText(decodedChunk, path);
          parser.push(decodedChunk);
        }
        const tail = decoder.end();
        assertValidDecodedText(tail, path);
        parser.push(tail);
        return { kind: 'fasta', contigs: parser.finish() };
      }
      if (firstLine === '##gff-version 3') {
        const parser = new Gff3StreamInspector(path);
        parser.push(probe);
        for await (const chunk of iterator) {
          const decodedChunk = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          assertValidDecodedText(decodedChunk, path);
          parser.push(decodedChunk);
        }
        const tail = decoder.end();
        assertValidDecodedText(tail, path);
        parser.push(tail);
        return parser.finish();
      }
      throw new Error(
        'Unrecognized file content. Expected a FASTA header or "##gff-version 3" as the first non-empty line.'
      );
    }
    assertMetadataLineBound(probe, path);
  }

  assertValidDecodedText(probe, path);
  const firstLine = firstMeaningfulLineAtEnd(probe);
  if (!firstLine) throw new Error('The file is empty.');
  if (firstLine.startsWith('>')) {
    const parser = new FastaStreamInspector(path);
    parser.push(probe);
    return { kind: 'fasta', contigs: parser.finish() };
  }
  if (firstLine === '##gff-version 3') {
    const parser = new Gff3StreamInspector(path);
    parser.push(probe);
    return parser.finish();
  }
  throw new Error(
    'Unrecognized file content. Expected a FASTA header or "##gff-version 3" as the first non-empty line.'
  );
}

const PLAIN_SEQUENCE_SEGMENT = /^[\x21-\x7E]*$/;
const SEQUENCE_HASH_BATCH_CHARACTERS = 1 << 20;

class FastaStreamInspector {
  private readonly contigs: LocalReferenceFastaContigInspection[] = [];
  private readonly seenIds = new Set<string>();
  private atDocumentStart = true;
  private atLineStart = true;
  private lineKind: 'header' | 'sequence' | undefined;
  private header = '';
  private currentId: string | undefined;
  private currentLength = 0;
  private currentSequenceSha256: ReturnType<typeof createHash> | undefined;
  private pendingSequence: string[] = [];
  private pendingSequenceLength = 0;

  constructor(private readonly path: string) {}

  push(text: string): void {
    let offset = 0;
    if (this.atDocumentStart && text.startsWith('\uFEFF')) offset = 1;
    if (text.length > 0) this.atDocumentStart = false;
    while (offset < text.length) {
      if (text[offset] === '\n') {
        if (this.lineKind === 'header') this.finishHeader();
        this.lineKind = undefined;
        this.atLineStart = true;
        offset += 1;
        continue;
      }
      if (this.atLineStart) {
        if (text[offset] === '>') {
          this.finishCurrentContig();
          this.lineKind = 'header';
          offset += 1;
        } else {
          this.lineKind = 'sequence';
        }
        this.atLineStart = false;
      }

      const newline = text.indexOf('\n', offset);
      const end = newline < 0 ? text.length : newline;
      const segment = text.slice(offset, end);
      if (this.lineKind === 'header') {
        this.header += segment.replaceAll('\r', '');
        assertMetadataLineBound(this.header, this.path);
      } else {
        this.consumeSequenceSegment(segment);
      }
      offset = end;
    }
  }

  finish(): ReadonlyArray<LocalReferenceFastaContigInspection> {
    if (this.lineKind === 'header') this.finishHeader();
    this.finishCurrentContig();
    if (this.contigs.length === 0) throw new Error('FASTA contains no records.');
    return this.contigs;
  }

  private finishHeader(): void {
    const sourceSeqId = this.header.split(/\s+/u, 1)[0]?.trim();
    this.header = '';
    if (!sourceSeqId) throw new Error('FASTA header has no sequence ID.');
    if (sourceSeqId.length > MAX_SOURCE_ID_CHARACTERS) {
      throw new Error(
        `FASTA sequence ID exceeds ${MAX_SOURCE_ID_CHARACTERS} characters: ${sourceSeqId.slice(
          0,
          80
        )}…`
      );
    }
    if (this.seenIds.has(sourceSeqId)) {
      throw new Error(`FASTA contains duplicate sequence ID "${sourceSeqId}".`);
    }
    this.seenIds.add(sourceSeqId);
    this.currentId = sourceSeqId;
    this.currentLength = 0;
    this.currentSequenceSha256 = createHash('sha256');
  }

  private consumeSequenceSegment(segment: string): void {
    const normalized = PLAIN_SEQUENCE_SEGMENT.test(segment)
      ? segment.toUpperCase()
      : segment.replace(/\s+/gu, '').toUpperCase();
    if (normalized.length === 0) return;
    if (Buffer.byteLength(normalized, 'utf8') !== normalized.length) {
      throw new Error('FASTA sequence data must contain ASCII symbols.');
    }
    if (!this.currentId || !this.currentSequenceSha256) {
      throw new Error('FASTA sequence data appears before its first header.');
    }
    if (normalized.includes('>')) {
      throw new Error('A FASTA header marker must begin a new line.');
    }
    this.pendingSequence.push(normalized);
    this.pendingSequenceLength += normalized.length;
    if (this.pendingSequenceLength >= SEQUENCE_HASH_BATCH_CHARACTERS) this.flushSequenceHash();
    this.currentLength += normalized.length;
    if (!Number.isSafeInteger(this.currentLength)) {
      throw new Error(`FASTA sequence ${this.currentId} exceeds the safe integer length limit.`);
    }
  }

  private flushSequenceHash(): void {
    if (this.pendingSequence.length === 0) return;
    this.currentSequenceSha256?.update(this.pendingSequence.join(''), 'latin1');
    this.pendingSequence = [];
    this.pendingSequenceLength = 0;
  }

  private finishCurrentContig(): void {
    if (!this.currentId || !this.currentSequenceSha256) return;
    this.flushSequenceHash();
    if (this.currentLength === 0) {
      throw new Error(`FASTA sequence "${this.currentId}" contains no bases.`);
    }
    this.contigs.push({
      sourceSeqId: this.currentId,
      lengthBp: this.currentLength,
      normalizedSequenceSha256: this.currentSequenceSha256.digest('hex'),
    });
    this.currentId = undefined;
    this.currentLength = 0;
    this.currentSequenceSha256 = undefined;
  }
}

class PreparationGff3StreamInspector {
  private carry = Buffer.alloc(0);
  private sawVersion = false;
  private sawFeature = false;
  private readonly circularSeqIds = new Set<string>();
  private readonly organisms = new Set<string>();
  private readonly taxIds = new Set<number>();
  private readonly sequenceRegions = new Map<string, { start: number; end: number }>();
  private readonly topLevelRegionRows = new Map<string, { start: number; end: number }>();
  private regionRosterUsable = true;
  private sequenceRegionRosterUsable = true;
  private globalCircular = false;
  private assemblyAccession: string | undefined;

  constructor(private readonly path: string) {}

  push(chunk: Buffer): void {
    const bytes = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    const finalNewline = bytes.lastIndexOf(0x0a);
    if (finalNewline < 0) {
      this.carry = Buffer.from(bytes);
      this.assertCarryBound();
      return;
    }

    const completeLines = bytes.subarray(0, finalNewline + 1);
    this.carry = Buffer.from(bytes.subarray(finalNewline + 1));
    if (this.sawFeature) {
      this.scanFeatureBody(completeLines);
    } else {
      this.consumeHeaderAndFeatureBoundary(completeLines);
    }
    this.assertCarryBound();
  }

  finish(): {
    readonly gff3: Omit<LocalReferenceGff3Inspection, 'path' | 'sha256' | 'gzipCompressed'>;
    readonly planningContigs?: ReadonlyArray<LocalReferenceContigRosterEntry>;
  } {
    if (this.carry.length > 0) {
      const finalLine = Buffer.concat([this.carry, Buffer.from('\n')]);
      this.carry = Buffer.alloc(0);
      if (this.sawFeature) this.scanFeatureBody(finalLine);
      else this.consumeHeaderAndFeatureBoundary(finalLine);
    }
    if (!this.sawVersion) throw new Error('GFF3 is missing the "##gff-version 3" directive.');
    if (!this.sawFeature) throw new Error('GFF3 contains no feature rows.');

    const planningRegions = this.selectPlanningRegions();
    const planningContigs = planningRegions
      ? [...planningRegions].map(([sourceSeqId, region]) => ({
          sourceSeqId,
          lengthBp: region.end,
        }))
      : undefined;
    const seqIds = planningContigs?.map((contig) => contig.sourceSeqId) ?? [];

    return {
      gff3: {
        kind: 'gff3',
        seqIds,
        circularSeqIds: this.circularSeqIds,
        globalCircular: this.globalCircular,
        organism: this.organisms.size === 1 ? [...this.organisms][0] : undefined,
        taxId: this.taxIds.size === 1 ? [...this.taxIds][0] : undefined,
        assemblyAccession: this.assemblyAccession,
        sequenceRegions: this.sequenceRegions,
      },
      planningContigs,
    };
  }

  private consumeHeaderAndFeatureBoundary(bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline < 0) return;
      const lineBytes = bytes.subarray(offset, newline);
      if (lineBytes.length === 0 || lineBytes[0] === 0x23 || !this.sawVersion) {
        const line = decodeBoundedGff3Line(lineBytes, this.path);
        if (line.trim().length === 0) {
          offset = newline + 1;
          continue;
        }
        if (!this.sawVersion) {
          const versionLine = line.replace(/^\uFEFF/u, '');
          if (versionLine !== '##gff-version 3') {
            throw new Error('The first non-empty GFF3 line must be exactly "##gff-version 3".');
          }
          this.sawVersion = true;
        } else {
          this.consumeHeaderDirective(line);
        }
        offset = newline + 1;
        continue;
      }

      this.sawFeature = true;
      this.scanFeatureBody(bytes.subarray(offset));
      return;
    }
  }

  private scanFeatureBody(bytes: Buffer): void {
    this.sawFeature = true;
    this.forEachLineContaining(bytes, GFF3_REGION_FIELD, (line) => {
      this.consumeTopLevelRegionRow(decodeBoundedGff3Line(line, this.path));
    });
    this.forEachLineContaining(bytes, GFF3_EMBEDDED_FASTA_DIRECTIVE, (line) => {
      if (decodeBoundedGff3Line(line, this.path).replace(/\r$/u, '') === '##FASTA') {
        throw new Error(
          'GFF3 with an embedded ##FASTA section is not supported by custom import yet. Select a separate FASTA file and a GFF3 without embedded sequence.'
        );
      }
    });
    this.forEachLineContaining(bytes, GFF3_SEQUENCE_REGION_DIRECTIVE, (line) => {
      if (
        decodeBoundedGff3Line(line, this.path).replace(/\r$/u, '').startsWith('##sequence-region ')
      ) {
        this.sequenceRegionRosterUsable = false;
      }
    });
  }

  private forEachLineContaining(
    bytes: Buffer,
    pattern: Buffer,
    callback: (line: Buffer) => void
  ): void {
    let searchOffset = 0;
    for (;;) {
      const match = bytes.indexOf(pattern, searchOffset);
      if (match < 0) return;
      const previousNewline = bytes.lastIndexOf(0x0a, match - 1);
      const nextNewline = bytes.indexOf(0x0a, match + pattern.length);
      if (nextNewline < 0) return;
      callback(bytes.subarray(previousNewline + 1, nextNewline));
      searchOffset = nextNewline + 1;
    }
  }

  private consumeHeaderDirective(rawLine: string): void {
    const line = rawLine.replace(/\r$/u, '');
    if (line === '##FASTA') {
      throw new Error(
        'GFF3 with an embedded ##FASTA section is not supported by custom import yet. Select a separate FASTA file and a GFF3 without embedded sequence.'
      );
    }
    if (line.startsWith('##dna-indexer-topology ')) {
      const topology = line.slice('##dna-indexer-topology '.length).trim();
      if (topology !== 'linear' && topology !== 'circular') {
        throw new Error(`Unsupported dna-indexer topology "${topology}".`);
      }
      this.globalCircular = topology === 'circular';
      return;
    }
    if (line.startsWith('##sequence-region ')) {
      const fields = line.split(/\s+/u);
      const start = Number(fields[2]);
      const end = Number(fields[3]);
      if (
        fields.length !== 4 ||
        !isValidSourceSeqId(fields[1]) ||
        !Number.isSafeInteger(start) ||
        start !== 1 ||
        !Number.isSafeInteger(end) ||
        end <= 0 ||
        this.sequenceRegions.has(fields[1])
      ) {
        this.sequenceRegionRosterUsable = false;
        return;
      }
      this.sequenceRegions.set(fields[1], { start, end });
      return;
    }
    if (line.startsWith('#!genome-build-accession ')) {
      const rawAccession = line.slice('#!genome-build-accession '.length).trim();
      this.assemblyAccession =
        rawAccession.replace(/^NCBI_Assembly:/u, '').trim() || this.assemblyAccession;
      return;
    }
    if (line.startsWith('#!organism ')) {
      const organism = line.slice('#!organism '.length).trim();
      if (organism) this.organisms.add(organism);
    }
  }

  private consumeTopLevelRegionRow(rawLine: string): void {
    const line = rawLine.replace(/\r$/u, '');
    const fields = line.split('\t');
    if (fields.length !== 9 || fields[2] !== 'region') {
      this.regionRosterUsable = false;
      return;
    }
    const [seqId, , , rawStart, rawEnd, , , , rawAttributes] = fields;
    const attributes = parseGff3Attributes(rawAttributes);
    if (attributes.has('Parent') || attributes.get('gbkey') !== 'Src') return;

    const start = Number(rawStart);
    const end = Number(rawEnd);
    if (
      !isValidSourceSeqId(seqId) ||
      !Number.isSafeInteger(start) ||
      start !== 1 ||
      !Number.isSafeInteger(end) ||
      end <= 0 ||
      this.topLevelRegionRows.has(seqId)
    ) {
      this.regionRosterUsable = false;
      return;
    }
    this.topLevelRegionRows.set(seqId, { start, end });

    const circularHint = attributes.get('Is_circular') ?? attributes.get('topology');
    if (circularHint?.toLowerCase() === 'true' || circularHint?.toLowerCase() === 'circular') {
      this.circularSeqIds.add(seqId);
    }
    const organism = attributes.get('organism')?.trim();
    if (organism) this.organisms.add(organism);
    for (const taxId of taxIdsFromAttributes(attributes)) this.taxIds.add(taxId);
  }

  private selectPlanningRegions(): ReadonlyMap<string, { start: number; end: number }> | undefined {
    const sequenceRegions =
      this.sequenceRegionRosterUsable && this.sequenceRegions.size > 0
        ? this.sequenceRegions
        : undefined;
    const regionRows =
      this.regionRosterUsable && this.topLevelRegionRows.size > 0
        ? this.topLevelRegionRows
        : undefined;
    if (sequenceRegions && regionRows) {
      if (!regionsMatchExactly(sequenceRegions, regionRows)) return undefined;
      return sequenceRegions;
    }
    return sequenceRegions ?? regionRows;
  }

  private assertCarryBound(): void {
    if (this.carry.length <= MAX_METADATA_LINE_BYTES) return;
    throw new Error(
      `${this.path} contains a metadata/header line larger than ${MAX_METADATA_LINE_BYTES} bytes.`
    );
  }
}

class Gff3StreamInspector {
  private buffer = '';
  private sawVersion = false;
  private sawFeature = false;
  private readonly seqIds = new Set<string>();
  private readonly circularSeqIds = new Set<string>();
  private readonly organisms = new Set<string>();
  private readonly taxIds = new Set<number>();
  private readonly sequenceRegions = new Map<string, { start: number; end: number }>();
  private globalCircular = false;
  private assemblyAccession: string | undefined;

  constructor(private readonly path: string) {}

  push(text: string): void {
    this.buffer += text;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) {
        assertMetadataLineBound(this.buffer, this.path);
        return;
      }
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line);
    }
  }

  finish(): Omit<LocalReferenceGff3Inspection, 'path' | 'sha256' | 'gzipCompressed'> {
    if (this.buffer.length > 0) this.consumeLine(this.buffer.replace(/\r$/u, ''));
    this.buffer = '';
    if (!this.sawVersion) throw new Error('GFF3 is missing the "##gff-version 3" directive.');
    if (!this.sawFeature) throw new Error('GFF3 contains no feature rows.');
    return {
      kind: 'gff3',
      seqIds: [...this.seqIds],
      circularSeqIds: this.circularSeqIds,
      globalCircular: this.globalCircular,
      organism: this.organisms.size === 1 ? [...this.organisms][0] : undefined,
      taxId: this.taxIds.size === 1 ? [...this.taxIds][0] : undefined,
      assemblyAccession: this.assemblyAccession,
      sequenceRegions: this.sequenceRegions,
    };
  }

  private consumeLine(rawLine: string): void {
    assertMetadataLineBound(rawLine, this.path);
    const line = !this.sawVersion ? rawLine.replace(/^\uFEFF/u, '') : rawLine;
    if (line.trim().length === 0) return;
    if (!this.sawVersion) {
      if (line !== '##gff-version 3') {
        throw new Error('The first non-empty GFF3 line must be exactly "##gff-version 3".');
      }
      this.sawVersion = true;
      return;
    }
    if (line === '##FASTA') {
      throw new Error(
        'GFF3 with an embedded ##FASTA section is not supported by custom import yet. Select a separate FASTA file and a GFF3 without embedded sequence.'
      );
    }
    if (line.startsWith('##dna-indexer-topology ')) {
      const topology = line.slice('##dna-indexer-topology '.length).trim();
      if (topology !== 'linear' && topology !== 'circular') {
        throw new Error(`Unsupported dna-indexer topology "${topology}".`);
      }
      this.globalCircular = topology === 'circular';
      return;
    }
    if (line.startsWith('##sequence-region ')) {
      const fields = line.split(/\s+/u);
      if (fields.length !== 4) {
        throw new Error(`Malformed GFF3 sequence-region directive: ${line}`);
      }
      const start = Number(fields[2]);
      const end = Number(fields[3]);
      if (!Number.isSafeInteger(start) || start !== 1 || !Number.isSafeInteger(end) || end <= 0) {
        throw new Error(`Invalid GFF3 sequence-region coordinates: ${line}`);
      }
      if (this.sequenceRegions.has(fields[1])) {
        throw new Error(`GFF3 contains duplicate sequence-region for "${fields[1]}".`);
      }
      this.sequenceRegions.set(fields[1], { start, end });
      return;
    }
    if (line.startsWith('#!genome-build-accession ')) {
      const rawAccession = line.slice('#!genome-build-accession '.length).trim();
      this.assemblyAccession =
        rawAccession.replace(/^NCBI_Assembly:/u, '').trim() || this.assemblyAccession;
      return;
    }
    if (line.startsWith('#!organism ')) {
      const organism = line.slice('#!organism '.length).trim();
      if (organism) this.organisms.add(organism);
      return;
    }
    if (line.startsWith('#')) return;

    const fields = line.split('\t');
    if (fields.length !== 9) {
      throw new Error(`GFF3 feature rows must have exactly 9 tab-delimited fields: ${line}`);
    }
    const [seqId, , featureType, , , , , , rawAttributes] = fields;
    if (!seqId || /\s/u.test(seqId)) {
      throw new Error(`GFF3 contains an invalid sequence ID "${seqId}".`);
    }
    if (seqId.length > MAX_SOURCE_ID_CHARACTERS) {
      throw new Error(`GFF3 sequence ID exceeds ${MAX_SOURCE_ID_CHARACTERS} characters.`);
    }
    this.sawFeature = true;
    this.seqIds.add(seqId);

    if (featureType === 'region' || featureType === 'chromosome' || featureType === 'source') {
      const attributes = parseGff3Attributes(rawAttributes);
      const circularHint = attributes.get('Is_circular') ?? attributes.get('topology');
      if (circularHint?.toLowerCase() === 'true' || circularHint?.toLowerCase() === 'circular') {
        this.circularSeqIds.add(seqId);
      }
      const organism = attributes.get('organism')?.trim();
      if (organism) this.organisms.add(organism);
      for (const taxId of taxIdsFromAttributes(attributes)) this.taxIds.add(taxId);
    }
  }
}

function assertExactSequenceIdentityMapping(
  fasta: LocalReferenceFastaInspection,
  gff3: LocalReferenceGff3Inspection
): void {
  const fastaIds = new Set(fasta.contigs.map((contig) => contig.sourceSeqId));
  const gffIds = new Set(gff3.seqIds);
  const absentFromFasta = [...gffIds].filter((seqId) => !fastaIds.has(seqId));
  const absentFromGff3 = [...fastaIds].filter((seqId) => !gffIds.has(seqId));
  if (absentFromFasta.length === 0 && absentFromGff3.length === 0) return;

  const details: string[] = [];
  if (absentFromFasta.length > 0) {
    details.push(`GFF3-only sequence IDs: ${summarizeIds(absentFromFasta)}`);
  }
  if (absentFromGff3.length > 0) {
    details.push(`FASTA sequence IDs without GFF3 feature rows: ${summarizeIds(absentFromGff3)}`);
  }
  throw new Error(
    `FASTA and GFF3 sequence IDs must match exactly for the current preparation contract. ${details.join(
      '; '
    )}.`
  );
}

function assertSequenceRegionLengths(
  fasta: LocalReferenceFastaInspection,
  gff3: LocalReferenceGff3Inspection
): void {
  const fastaById = new Map(
    fasta.contigs.map((contig) => [contig.sourceSeqId, contig.lengthBp] as const)
  );
  for (const [seqId, region] of gff3.sequenceRegions) {
    const fastaLength = fastaById.get(seqId);
    if (fastaLength === undefined) {
      throw new Error(`GFF3 sequence-region "${seqId}" is absent from FASTA.`);
    }
    if (region.start !== 1 || region.end !== fastaLength) {
      throw new Error(
        `GFF3 sequence-region for "${seqId}" is ${region.start}..${region.end}, but FASTA length is ${fastaLength}.`
      );
    }
  }
}

function canonicalContigNames(sourceIds: ReadonlyArray<string>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const sourceId of sourceIds) {
    let candidate = SAFE_CONTIG_ID.test(sourceId) ? sourceId : sanitizeContigId(sourceId);
    if (seen.has(candidate)) {
      const suffix = createHash('sha256').update(sourceId).digest('hex').slice(0, 10);
      candidate = `${candidate.slice(0, 117)}-${suffix}`;
    }
    let collision = 2;
    while (seen.has(candidate)) {
      const suffix = `-${collision}`;
      candidate = `${candidate.slice(0, 128 - suffix.length)}${suffix}`;
      collision += 1;
    }
    seen.add(candidate);
    names.push(candidate);
  }
  return names;
}

function sanitizeContigId(sourceId: string): string {
  const ascii = sourceId.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '');
  const sanitized = ascii
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^[^A-Za-z0-9]+/u, '')
    .replace(/-+$/u, '');
  const base = sanitized || 'contig';
  const suffix = createHash('sha256').update(sourceId).digest('hex').slice(0, 10);
  return `${base.slice(0, 117)}-${suffix}`;
}

function isValidSourceSeqId(value: string | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SOURCE_ID_CHARACTERS &&
    !/\s/u.test(value)
  );
}

function regionsMatchExactly(
  left: ReadonlyMap<string, Readonly<{ start: number; end: number }>>,
  right: ReadonlyMap<string, Readonly<{ start: number; end: number }>>
): boolean {
  if (left.size !== right.size) return false;
  for (const [seqId, region] of left) {
    const counterpart = right.get(seqId);
    if (!counterpart || counterpart.start !== region.start || counterpart.end !== region.end) {
      return false;
    }
  }
  return true;
}

function parseGff3Attributes(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const field of raw.split(';')) {
    if (!field) continue;
    const separator = field.indexOf('=');
    if (separator <= 0) continue;
    const key = decodeGff3Component(field.slice(0, separator));
    const value = decodeGff3Component(field.slice(separator + 1));
    attributes.set(key, value);
  }
  return attributes;
}

function taxIdsFromAttributes(attributes: ReadonlyMap<string, string>): number[] {
  const taxIds = new Set<number>();
  for (const value of [attributes.get('Dbxref'), attributes.get('db_xref')]) {
    if (!value) continue;
    for (const match of value.matchAll(/(?:^|,)taxon:(\d+)(?=,|$)/giu)) {
      const taxId = Number(match[1]);
      if (Number.isSafeInteger(taxId) && taxId > 0) taxIds.add(taxId);
    }
  }
  for (const value of [attributes.get('taxon'), attributes.get('tax_id')]) {
    const match = value?.trim().match(/^(?:taxon:)?(\d+)$/iu);
    if (!match) continue;
    const taxId = Number(match[1]);
    if (Number.isSafeInteger(taxId) && taxId > 0) taxIds.add(taxId);
  }
  return [...taxIds];
}

function decodeGff3Component(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sourceDisplayName(fastaPath: string): string {
  const fileName = basename(fastaPath).replace(/\.gz$/iu, '');
  const withoutExtension = fileName.replace(/\.(?:fa|fasta|fna|fas)$/iu, '');
  return withoutExtension.trim() || 'Imported reference';
}

function summarizeIds(ids: ReadonlyArray<string>): string {
  const head = ids.slice(0, 8).map((id) => `"${id}"`);
  return ids.length > head.length
    ? `${head.join(', ')} and ${ids.length - head.length} more`
    : head.join(', ');
}

function firstMeaningfulCompleteLine(text: string): string | undefined {
  let offset = 0;
  for (;;) {
    const newline = text.indexOf('\n', offset);
    if (newline < 0) return undefined;
    const raw = text.slice(offset, newline).replace(/\r$/u, '');
    const line = offset === 0 ? raw.replace(/^\uFEFF/u, '') : raw;
    if (line.trim().length > 0) return line;
    offset = newline + 1;
  }
}

function firstMeaningfulLineAtEnd(text: string): string | undefined {
  return text
    .replace(/^\uFEFF/u, '')
    .split(/\r?\n/u)
    .find((line) => line.trim().length > 0);
}

function assertMetadataLineBound(value: string, path: string): void {
  if (value.length <= MAX_METADATA_LINE_BYTES && isAscii(value)) return;
  if (Buffer.byteLength(value, 'utf8') <= MAX_METADATA_LINE_BYTES) return;
  throw new Error(
    `${path} contains a metadata/header line larger than ${MAX_METADATA_LINE_BYTES} bytes.`
  );
}

function decodeBoundedGff3Line(value: Buffer, path: string): string {
  if (value.length > MAX_METADATA_LINE_BYTES) {
    throw new Error(
      `${path} contains a metadata/header line larger than ${MAX_METADATA_LINE_BYTES} bytes.`
    );
  }
  const decoded = value.toString('utf8');
  assertValidDecodedText(decoded, path);
  return decoded;
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function assertValidDecodedText(value: string, path: string): void {
  if (value.includes('\uFFFD')) {
    throw new Error(`${path} is not valid UTF-8 text after decompression.`);
  }
}

async function hasGzipMagic(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(2);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytesRead === 2 && bytes.equals(GZIP_MAGIC);
  } finally {
    await handle.close();
  }
}

function pathIsWithin(candidatePath: string, parentPath: string): boolean {
  const pathFromParent = relative(parentPath, candidatePath);
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent));
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
