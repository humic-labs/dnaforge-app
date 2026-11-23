import { constants, type Stats } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { LocalIndexedGenomeDataSource } from '@waypoint/genome-data/node';
import { app } from 'electron';
import {
  buildIndexedGenomePaths,
  extensionForPath,
} from '../features/sequence/indexed-genome-paths';
import { DocumentReadError, documentReadError } from '../shared/document-read-failure';
import type { IndexedGenomeManifest } from '../shared/indexed-genome';
import type { DocumentOpenSource } from './document-open-source';
import { readCurrentIndexedGenomeCache } from './ipc/indexed-genome-session-prep';
import { execDnaIndexerFile } from './reference-assets/dna-indexer-process';
import { resolveDnaIndexerHelperPath } from './reference-assets/local-reference-asset-authority';
import { sidecarSessionAuthority } from './sidecar-session-runtime';

const probeTimeoutMs = 30_000;
const genomeIndexProbeName = 'source';
const fastaCompanionSuffixes = ['.fa', '.fa.gz', '.fasta', '.fasta.gz', '.fna', '.fna.gz'];

// Serialize scratch index creation so parallel sidebar and agent checks cannot
// exhaust native readers. A busy reader does not make the next file unopenable.
let lastProbe = Promise.resolve();

async function acquireProbe(): Promise<() => void> {
  const previous = lastProbe;
  let release!: () => void;
  lastProbe = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}

export async function inspectIndexedGenomeDocument(
  source: DocumentOpenSource,
  canonicalPath: string,
  metadata: Stats
): Promise<void> {
  if (!source.workspaceRoot) throw new DocumentReadError('project');
  const extension = extensionForPath(canonicalPath);
  const cached = await readCurrentIndexedGenomeCache(
    {
      source: { sourcePath: canonicalPath, sourceExt: extension },
      stat: metadata,
      workspaceRoot: source.workspaceRoot,
    },
    source
  );
  if (cached) {
    try {
      await readPreparedSequence(cached.manifest);
    } catch (error) {
      if (documentReadError(error).code === 'permission') throw error;
      throw new DocumentReadError('runtime', false, { cause: error });
    }
    return;
  }
  const isGff = extension === 'gff' || extension === 'gff3';
  const companionPath = isGff ? await findCompanionFasta(source, canonicalPath) : undefined;
  const releaseProbe = await acquireProbe();
  try {
    await source.observeRevision('genome-index-runtime', () => {
      const { generation, state } = sidecarSessionAuthority.snapshot();
      if (state !== 'ready') throw new DocumentReadError('runtime');
      return String(generation);
    });
    const { outputDir } = buildIndexedGenomePaths({
      sourcePath: canonicalPath,
      workspaceRoot: source.workspaceRoot,
      sizeBytes: metadata.size,
      sourceMtimeMs: metadata.mtimeMs,
      sourceCtimeMs: metadata.ctimeMs,
    });
    await checkIndexDestination(source, dirname(outputDir));
    const binary = getNativeIndexer();
    const output = await mkdtemp(join(tmpdir(), 'dnaforge-index-read-'));
    try {
      const args = [
        companionPath ? 'ingest-gff3' : 'index',
        '--in',
        canonicalPath,
        '--out-dir',
        output,
        '--name',
        genomeIndexProbeName,
        ...(companionPath ? ['--in-fasta', companionPath] : []),
      ];
      let stdout: string;
      try {
        ({ stdout } = await execDnaIndexerFile(binary, args, probeTimeoutMs));
      } catch (error) {
        throw indexerFailure(error);
      }
      const response = terminalStatus(stdout);
      if (response?.ok !== true || typeof response.length !== 'number' || response.length < 1)
        throw new DocumentReadError('runtime');

      const hasAnnotations = (response.annotation_rows ?? response.feature_count ?? 0) > 0;
      const prefix = join(output, genomeIndexProbeName);
      await readPreparedSequence({
        chrom: genomeIndexProbeName,
        fastaPath: `${prefix}.fa.gz`,
        faiPath: `${prefix}.fa.gz.fai`,
        gziPath: `${prefix}.fa.gz.gzi`,
        gffPath: hasAnnotations ? `${prefix}.gff3.gz` : null,
        tbiPath: hasAnnotations ? `${prefix}.gff3.gz.tbi` : null,
        length: response.length,
      });
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  } finally {
    releaseProbe();
  }
}

async function findCompanionFasta(source: DocumentOpenSource, path: string): Promise<string> {
  // This is the search order used by the sidecar's dna_indexer_shellout.find_companion_fasta.
  const fileStem = basename(path).replace(/\.gff3?(?:\.gz)?$/iu, '');
  for (const suffix of fastaCompanionSuffixes) {
    const candidate = join(dirname(path), `${fileStem}${suffix}`);
    try {
      return await source.localPath(candidate);
    } catch (error) {
      const { code } = documentReadError(error);
      if (code !== 'missing' && code !== 'missing-asset' && code !== 'unsupported-format')
        throw error;
    }
  }
  throw new DocumentReadError('missing-asset');
}

async function checkIndexDestination(source: DocumentOpenSource, directory: string): Promise<void> {
  await source.observe(directory);
  try {
    await access(directory, constants.W_OK | constants.X_OK);
  } catch (error) {
    if (documentReadError(error).code !== 'missing' || directory === source.workspaceRoot)
      throw error;
    await checkIndexDestination(source, dirname(directory));
  }
}

function getNativeIndexer(): string {
  try {
    return resolveDnaIndexerHelperPath({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
      explicitPath: process.env.DNA_INDEXER_PATH,
    });
  } catch (error) {
    throw new DocumentReadError('runtime', false, { cause: error });
  }
}

async function readPreparedSequence(manifest: IndexedGenomeManifest): Promise<void> {
  const reader = new LocalIndexedGenomeDataSource(manifest);
  try {
    const length = await reader.getChromosomeLength(manifest.chrom);
    if (!length || !(await reader.getSequence(manifest.chrom, 0, 1)))
      throw new DocumentReadError('runtime');
  } finally {
    await reader.close();
  }
}

interface TerminalStatus {
  ok?: boolean;
  code?: string;
  message?: string;
  length?: number;
  annotation_rows?: number;
  feature_count?: number;
}

function terminalStatus(stdout: string): TerminalStatus | null {
  try {
    return JSON.parse(stdout.trimEnd().split('\n').at(-1) ?? '') as TerminalStatus;
  } catch {
    return null;
  }
}

function indexerFailure(error: unknown): DocumentReadError {
  const stdout = error && typeof error === 'object' && 'stdout' in error ? error.stdout : null;
  const status = typeof stdout === 'string' ? terminalStatus(stdout) : null;
  const message = typeof status?.message === 'string' ? status.message : '';
  if (status?.ok !== false) return new DocumentReadError('runtime', false, { cause: error });
  if (/multi-record (?:FASTA|GenBank) (?:is )?not supported/u.test(message))
    return new DocumentReadError('unsupported-format', true, { cause: error });
  if (/FASTA sequence ID \S+ does not match GFF3 sequence ID /u.test(message))
    return new DocumentReadError('missing-asset', true, { cause: error });
  if (/Permission denied \(os error 13\)/u.test(message))
    return new DocumentReadError('permission', false, { cause: error });
  if (/No such file or directory \(os error 2\)/u.test(message))
    return new DocumentReadError('changed', false, { cause: error });
  if (/unexpected end of file|corrupt gzip stream/u.test(message))
    return new DocumentReadError('malformed', false, { cause: error });
  if (
    /expected 9 tab-separated columns|feature (?:start|end) \S+|GFF3 input contained no feature rows|cannot index an empty FASTA sequence/u.test(
      message
    )
  )
    return new DocumentReadError('malformed', true, { cause: error });
  if (status?.code === 'GENBANK_PARSE_FAILED' && /Syntax error:/u.test(message))
    return new DocumentReadError('malformed', false, { cause: error });
  return new DocumentReadError('unknown', false, { cause: error });
}
