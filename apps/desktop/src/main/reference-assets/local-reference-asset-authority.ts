import { referencePreparationTiming } from './reference-prep-timing';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  HUB_GENOME_PROVIDER_ASSEMBLY_HUB,
  HUB_GENOME_PROVIDER_GENARK,
} from '../../shared/hub-genome-provenance';
import type {
  HubGenomeReferenceSourceV1,
  PreparedReferenceAssemblyEntryV1,
  ReferenceAssetLocalPreparationStatusV1,
  ReferenceAssetPreparationProgressUpdateV1,
  ReferenceAssetThemeModeV1,
} from '../../shared/reference-assets-ipc';
import {
  acquireHubGenomeFasta,
  type AcquireHubGenomeFastaResult,
  type HubGenomeUrlPolicy,
} from './hub-genome-import';
import {
  planLocalReferencePreparation,
  writeLocalReferencePreparationManifest,
} from './local-reference-source-plan';
import {
  resolveLocalReferenceSelection,
  type LocalReferenceSourceSelection,
  type ResolvedLocalReferenceSources,
} from './local-reference-source-resolver';
import type { LocalReferenceIdentityOverrideV1 } from './local-reference-source-types';
import {
  listPreparedReferenceAssemblyEntries,
  readPreparedReferenceProductRepairInput,
  type PreparedReferenceProductRepairInput,
} from './prepared-reference-library';
import {
  inspectPreparedReferenceSourcePublication,
  runReferenceAssetPreparation,
  type PreparedReferenceSourcePublicationStatusV1,
  type ReferenceAssetPreparationInput,
  type ReferenceAssetPreparationReceipt,
} from './reference-preparation-engine';

export interface LocalReferenceAssetAuthority {
  importLocal(input: {
    selection: LocalReferenceSourceSelection;
    themeMode: ReferenceAssetThemeModeV1;
    onProgress: (progress: ReferenceAssetPreparationProgressUpdateV1) => void;
  }): Promise<PreparedReferenceAssemblyEntryV1>;
  importHubGenome(input: {
    source: HubGenomeReferenceSourceV1;
    themeMode: ReferenceAssetThemeModeV1;
    onProgress: (progress: ReferenceAssetPreparationProgressUpdateV1) => void;
  }): Promise<PreparedReferenceAssemblyEntryV1>;
  listLocal(): Promise<ReadonlyArray<PreparedReferenceAssemblyEntryV1>>;
  getLocalPreparationStatus(
    assemblyId: string
  ): Promise<ReferenceAssetLocalPreparationStatusV1 | null>;
  retryLocal(input: {
    assemblyId: string;
    themeMode: ReferenceAssetThemeModeV1;
    onProgress: (progress: ReferenceAssetPreparationProgressUpdateV1) => void;
  }): Promise<PreparedReferenceAssemblyEntryV1>;
}

export type LocalReferencePreparationRunner = (
  input: ReferenceAssetPreparationInput
) => Promise<ReferenceAssetPreparationReceipt>;

export type LocalReferenceSourceReadinessInspector = (input: {
  readonly entry: PreparedReferenceAssemblyEntryV1;
  readonly cacheRoot: string;
  readonly publicationRoot?: string;
  readonly fallbackPublicationRoot?: string | null;
  readonly expectedSource: Readonly<{
    fastaSha256: string;
    gffSha256?: string;
  }>;
}) => Promise<PreparedReferenceSourcePublicationStatusV1>;

export interface CreateLocalReferenceAssetAuthorityInput {
  readonly cacheRoot: string;
  readonly publicationRoot?: string;
  readonly fallbackPublicationRoot?: string | null;
  readonly projectRoot: string;
  readonly sourceBuildFingerprint: string;
  readonly indexerBinary: string;
  readonly runPreparation?: LocalReferencePreparationRunner;
  readonly inspectSourcePublication?: LocalReferenceSourceReadinessInspector;
  readonly listPrepared?: (
    cacheRoot: string,
    publicationRoot?: string,
    fallbackPublicationRoot?: string | null
  ) => Promise<ReadonlyArray<PreparedReferenceAssemblyEntryV1>>;
  readonly readRepairInput?: (
    cacheRoot: string,
    assemblyId: string,
    publicationRoot?: string,
    fallbackPublicationRoot?: string | null
  ) => Promise<PreparedReferenceProductRepairInput | null>;
  readonly resolveSelection?: (input: {
    readonly selection: LocalReferenceSourceSelection;
    readonly stagingRoot: string;
  }) => Promise<ResolvedLocalReferenceSources>;
  readonly hubGenomePolicy?: HubGenomeUrlPolicy;
  readonly acquireHubGenome?: typeof acquireHubGenomeFasta;
}

function formatBases(bases: number): string {
  const compact = (value: number) =>
    new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
  if (bases >= 1_000_000_000) return `${compact(bases / 1_000_000_000)} Gb`;
  if (bases >= 1_000_000) return `${compact(bases / 1_000_000)} Mb`;
  if (bases >= 1_000) return `${compact(bases / 1_000)} kb`;
  return `${bases.toLocaleString('en-US')} bp`;
}

function recognizedSourceLabel(resolved: ResolvedLocalReferenceSources): string {
  switch (resolved.kind) {
    case 'ncbi-datasets':
      return 'NCBI Datasets ZIP recognized';
    case 'standalone-fasta':
      return 'Standalone FASTA recognized';
    case 'hub-genome':
      return 'Hub genome sequence recognized';
    default:
      return resolved.sourcePaths.length === 2
        ? 'FASTA and GFF3 folder recognized'
        : 'FASTA folder recognized';
  }
}

export function hubGenomeIdentity(
  source: HubGenomeReferenceSourceV1,
  acquired: Pick<AcquireHubGenomeFastaResult, 'sequences' | 'totalBases'>
): LocalReferenceIdentityOverrideV1 {
  const hubHost = new URL(source.hubUrl).host;
  const sequenceSummary = `${acquired.sequences.length.toLocaleString('en-US')} ${
    acquired.sequences.length === 1 ? 'sequence' : 'sequences'
  }, ${formatBases(acquired.totalBases)}`;
  const genark = source.provider === 'genark';
  return {
    name: source.assemblyName ? `${source.assemblyName} (${source.genome})` : source.genome,
    organism: source.organism?.trim() || 'Imported reference',
    ...(source.taxId ? { taxId: source.taxId } : {}),
    accession: source.genome,
    description: genark
      ? `UCSC GenArk assembly ${source.genome}, unpacked from its hub sequence: ${sequenceSummary}.`
      : `Assembly hub genome ${source.genome} from ${hubHost}, unpacked from its hub sequence: ${sequenceSummary}.`,
    provenance: {
      provider: genark ? HUB_GENOME_PROVIDER_GENARK : HUB_GENOME_PROVIDER_ASSEMBLY_HUB,
      datasetId: source.genome,
      sourceUrl: source.hubUrl,
    },
  };
}

export const LOCAL_REFERENCE_PREPARATION_STATUS_FILE = 'local-preparation-status.v1.json' as const;
const LOCAL_REFERENCE_PREPARATION_STATUS_V1 = 'local-reference-preparation-status.v1' as const;
const SAFE_ASSEMBLY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface PersistedLocalReferencePreparationStatusV1 extends ReferenceAssetLocalPreparationStatusV1 {
  readonly contract: typeof LOCAL_REFERENCE_PREPARATION_STATUS_V1;
}

function localPreparationStatus(
  assemblyId: string,
  status: ReferenceAssetLocalPreparationStatusV1['status'],
  update: ReferenceAssetPreparationProgressUpdateV1
): ReferenceAssetLocalPreparationStatusV1 {
  return {
    assemblyId,
    status,
    phase: update.phase,
    label: update.label,
    ...(update.completed !== undefined && update.total !== undefined
      ? { completed: update.completed, total: update.total }
      : {}),
    updatedAtMs: Date.now(),
  };
}

function parsePersistedLocalPreparationStatus(
  value: unknown,
  expectedAssemblyId: string
): ReferenceAssetLocalPreparationStatusV1 | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    record.contract !== LOCAL_REFERENCE_PREPARATION_STATUS_V1 ||
    record.assemblyId !== expectedAssemblyId ||
    (record.status !== 'preparing' && record.status !== 'ready' && record.status !== 'failed') ||
    typeof record.phase !== 'string' ||
    record.phase.trim() === '' ||
    typeof record.label !== 'string' ||
    record.label.trim() === '' ||
    typeof record.updatedAtMs !== 'number' ||
    !Number.isFinite(record.updatedAtMs)
  ) {
    return null;
  }
  const hasCompleted = record.completed !== undefined;
  const hasTotal = record.total !== undefined;
  if (
    hasCompleted !== hasTotal ||
    (hasCompleted &&
      (typeof record.completed !== 'number' ||
        typeof record.total !== 'number' ||
        !Number.isFinite(record.completed) ||
        !Number.isFinite(record.total) ||
        record.completed < 0 ||
        record.total <= 0 ||
        record.completed > record.total))
  ) {
    return null;
  }
  return {
    assemblyId: expectedAssemblyId,
    status: record.status,
    phase: record.phase,
    label: record.label,
    ...(hasCompleted
      ? { completed: record.completed as number, total: record.total as number }
      : {}),
    updatedAtMs: record.updatedAtMs,
  };
}

export function createLocalReferenceAssetAuthority(
  input: CreateLocalReferenceAssetAuthorityInput
): LocalReferenceAssetAuthority {
  const cacheRoot = resolve(input.cacheRoot);
  const publicationRoot = resolve(input.publicationRoot ?? cacheRoot);
  const fallbackPublicationRoot = input.fallbackPublicationRoot
    ? resolve(input.fallbackPublicationRoot)
    : null;
  const runPreparation = input.runPreparation ?? runReferenceAssetPreparation;
  const inspectSourcePublication =
    input.inspectSourcePublication ?? inspectPreparedReferenceSourcePublication;
  const listPrepared = input.listPrepared ?? listPreparedReferenceAssemblyEntries;
  const readRepairInput = input.readRepairInput ?? readPreparedReferenceProductRepairInput;
  const resolveSelection = input.resolveSelection ?? resolveLocalReferenceSelection;
  const acquireHubGenome = input.acquireHubGenome ?? acquireHubGenomeFasta;
  const hubGenomePolicy: HubGenomeUrlPolicy = input.hubGenomePolicy ?? {
    allowLoopbackHttpForTests: false,
  };
  const statusByAssemblyId = new Map<string, ReferenceAssetLocalPreparationStatusV1>();
  const statusWrites = new Map<string, Promise<void>>();
  const retryTasks = new Map<string, Promise<PreparedReferenceAssemblyEntryV1>>();

  const statusPath = (assemblyId: string): string => {
    if (!SAFE_ASSEMBLY_ID.test(assemblyId)) {
      throw new Error('Invalid local reference assembly id.');
    }
    return join(publicationRoot, assemblyId, LOCAL_REFERENCE_PREPARATION_STATUS_FILE);
  };
  const rememberStatus = (status: ReferenceAssetLocalPreparationStatusV1): void => {
    statusByAssemblyId.set(status.assemblyId, status);
  };
  const persistStatus = async (status: ReferenceAssetLocalPreparationStatusV1): Promise<void> => {
    const destination = statusPath(status.assemblyId);
    const previous = statusWrites.get(status.assemblyId) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
        const serialized: PersistedLocalReferencePreparationStatusV1 = {
          contract: LOCAL_REFERENCE_PREPARATION_STATUS_V1,
          ...status,
        };
        try {
          await writeFile(temporary, `${JSON.stringify(serialized)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
          });
          await rename(temporary, destination);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    statusWrites.set(status.assemblyId, write);
    try {
      await write;
      rememberStatus(status);
    } finally {
      if (statusWrites.get(status.assemblyId) === write) {
        statusWrites.delete(status.assemblyId);
      }
    }
  };
  const readStatus = async (
    assemblyId: string
  ): Promise<ReferenceAssetLocalPreparationStatusV1 | null> => {
    if (!SAFE_ASSEMBLY_ID.test(assemblyId)) return null;
    const current = statusByAssemblyId.get(assemblyId);
    if (current) return current;
    try {
      const parsed = parsePersistedLocalPreparationStatus(
        JSON.parse(await readFile(statusPath(assemblyId), 'utf8')) as unknown,
        assemblyId
      );
      if (!parsed) return null;
      if (parsed.status === 'preparing') {
        const interrupted = localPreparationStatus(assemblyId, 'failed', {
          assemblyId,
          phase: 'background-preparation-failed',
          label: 'Reference preparation was interrupted. Retry to finish annotations and search.',
        });
        await persistStatus(interrupted);
        return interrupted;
      }
      rememberStatus(parsed);
      return parsed;
    } catch {
      return null;
    }
  };

  const prepareFromSources = async (job: {
    readonly operationRoot: string;
    readonly themeMode: ReferenceAssetThemeModeV1;
    readonly onProgress: (progress: ReferenceAssetPreparationProgressUpdateV1) => void;
    readonly resolveSources: () => Promise<ResolvedLocalReferenceSources>;
  }): Promise<PreparedReferenceAssemblyEntryV1> => {
    const { operationRoot, themeMode, onProgress } = job;
    const manifestPath = join(operationRoot, 'reference-preparation.json');
    const timing = referencePreparationTiming('import');
    let plan: Awaited<ReturnType<typeof planLocalReferencePreparation>>;
    try {
      timing('resolve-sources:start');
      const resolved = await job.resolveSources();
      timing('resolve-sources:done');
      const sourcePaths = [...resolved.sourcePaths];
      plan = await planLocalReferencePreparation({
        sourcePaths,
        manifestPath,
        indexerBinary: input.indexerBinary,
        ...(resolved.identity ? { identity: resolved.identity } : {}),
      });
      timing('plan:done');
      onProgress({ phase: 'source-recognized', label: recognizedSourceLabel(resolved) });
      await writeLocalReferencePreparationManifest(plan);
    } catch (error) {
      await rm(operationRoot, { recursive: true, force: true });
      throw error;
    }
    const reportPreparingProgress = (update: ReferenceAssetPreparationProgressUpdateV1): void => {
      const scoped = {
        ...update,
        assemblyId: plan.loaded.entry.id,
      };
      rememberStatus(localPreparationStatus(plan.loaded.entry.id, 'preparing', scoped));
      onProgress(scoped);
    };

    let sourceOpened = false;
    let resolveSource!: (entry: PreparedReferenceAssemblyEntryV1) => void;
    let rejectSource!: (error: unknown) => void;
    const sourceReady = new Promise<PreparedReferenceAssemblyEntryV1>((resolvePromise, reject) => {
      resolveSource = resolvePromise;
      rejectSource = reject;
    });
    const admitPublishedSource = async (): Promise<PreparedReferenceAssemblyEntryV1> => {
      const published = await listPrepared(cacheRoot, publicationRoot, fallbackPublicationRoot);
      const entry = published.find((candidate) => candidate.id === plan.loaded.entry.id);
      if (!entry) {
        throw new Error('The prepared reference was not visible after atomic publication.');
      }
      const sourceReadiness = await inspectSourcePublication({
        entry,
        cacheRoot,
        publicationRoot,
        fallbackPublicationRoot,
        expectedSource: {
          fastaSha256: plan.loaded.source.fastaSha256,
          ...(plan.loaded.source.gffSha256 ? { gffSha256: plan.loaded.source.gffSha256 } : {}),
        },
      });
      if (sourceReadiness.status !== 'ready') {
        throw new Error(
          sourceReadiness.message ?? 'The prepared reference source publication is unavailable.'
        );
      }
      if (!sourceOpened) {
        sourceOpened = true;
        resolveSource(entry);
      }
      return entry;
    };

    const continuePreparation = async (): Promise<void> => {
      let failure: unknown = null;
      try {
        const indexing = {
          phase: 'indexing-reference',
          label: plan.loaded.source.gffPath
            ? 'Indexing reference sequence and annotations'
            : 'Indexing reference sequence',
        } satisfies ReferenceAssetPreparationProgressUpdateV1;
        await persistStatus(
          localPreparationStatus(plan.loaded.entry.id, 'preparing', {
            ...indexing,
            assemblyId: plan.loaded.entry.id,
          })
        );
        reportPreparingProgress(indexing);
        const receipt = await runPreparation({
          command: 'ensure',
          assemblyId: plan.loaded.entry.id,
          manifestPath,
          projectRoot: input.projectRoot,
          cacheRoot,
          publicationRoot,
          fallbackPublicationRoot,
          themeMode,
          sourceBuildFingerprint: input.sourceBuildFingerprint,
          indexerBinary: input.indexerBinary,
          onProgress: (message) => {
            timing(`engine: ${message}`);
            reportPreparingProgress(progressForEngineMessage(message));
          },
          onSourcePublished: async () => {
            timing('source-published');
            await admitPublishedSource();
            timing('source-admitted');
          },
        }).catch((error: unknown) => {
          timing(`engine-returned:error ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        });
        timing(`engine-returned:${receipt.status}`);
        if (receipt.status !== 'ready' && receipt.status !== 'source-ready') {
          throw new Error(receipt.message ?? 'Prepared reference products are unavailable.');
        }

        reportPreparingProgress({
          phase: 'verifying-publication',
          label: 'Verifying prepared reference',
        });
        const entry = await admitPublishedSource();
        const ready = {
          phase: 'ready',
          label: `${entry.name} is ready`,
          completed: 1,
          total: 1,
          assemblyId: plan.loaded.entry.id,
        } satisfies ReferenceAssetPreparationProgressUpdateV1;
        await persistStatus(localPreparationStatus(plan.loaded.entry.id, 'ready', ready));
        onProgress(ready);
      } catch (error) {
        failure = error;
      }
      try {
        await rm(operationRoot, { recursive: true, force: true });
      } catch (error) {
        failure ??= error;
      }
      if (!failure) return;
      if (!sourceOpened) {
        rejectSource(failure);
        return;
      }
      const detail = failure instanceof Error ? failure.message : String(failure);
      const failed = {
        phase: 'background-preparation-failed',
        label: plan.loaded.source.gffPath
          ? `${plan.loaded.entry.name} annotations, search, or visualization are unavailable: ${detail}`
          : `${plan.loaded.entry.name} sequence preparation is unavailable: ${detail}`,
        assemblyId: plan.loaded.entry.id,
      } satisfies ReferenceAssetPreparationProgressUpdateV1;
      try {
        await persistStatus(localPreparationStatus(plan.loaded.entry.id, 'failed', failed));
      } finally {
        onProgress(failed);
      }
    };
    void continuePreparation();
    return sourceReady;
  };

  return {
    importLocal({ selection, themeMode, onProgress }) {
      const operationRoot = join(publicationRoot, '.import-staging', randomUUID());
      return prepareFromSources({
        operationRoot,
        themeMode,
        onProgress,
        resolveSources: async () => {
          onProgress({ phase: 'inspecting-sources', label: 'Inspecting reference package' });
          return resolveSelection({ selection, stagingRoot: operationRoot });
        },
      });
    },
    importHubGenome({ source, themeMode, onProgress }) {
      const operationRoot = join(publicationRoot, '.import-staging', randomUUID());
      return prepareFromSources({
        operationRoot,
        themeMode,
        onProgress,
        resolveSources: async () => {
          const acquired = await acquireHubGenome({
            locator: {
              hubUrl: source.hubUrl,
              genome: source.genome,
              twoBitPath: source.twoBitPath,
            },
            stagingRoot: join(operationRoot, 'hub-genome'),
            policy: hubGenomePolicy,
            onProgress,
          });
          return {
            kind: 'hub-genome',
            sourcePaths: [acquired.fastaPath],
            identity: hubGenomeIdentity(source, acquired),
          };
        },
      });
    },
    listLocal: () => listPrepared(cacheRoot, publicationRoot, fallbackPublicationRoot),
    getLocalPreparationStatus: (assemblyId) => readStatus(assemblyId),
    async retryLocal({ assemblyId, themeMode, onProgress }) {
      if (!SAFE_ASSEMBLY_ID.test(assemblyId)) {
        throw new Error('Invalid local reference assembly id.');
      }
      const existing = retryTasks.get(assemblyId);
      if (existing) return existing;

      const retry = (async (): Promise<PreparedReferenceAssemblyEntryV1> => {
        const repair = await readRepairInput(
          cacheRoot,
          assemblyId,
          publicationRoot,
          fallbackPublicationRoot
        );
        if (!repair) {
          throw new Error(
            'The prepared local reference is unavailable. Add it again from its original source.'
          );
        }
        const publishPreparing = (update: ReferenceAssetPreparationProgressUpdateV1): void => {
          const scoped = { ...update, assemblyId };
          rememberStatus(localPreparationStatus(assemblyId, 'preparing', scoped));
          onProgress(scoped);
        };
        const starting = {
          phase: 'preparing-reference-products',
          label: `Retrying ${repair.entry.name} annotations, search, and visualization`,
          assemblyId,
        } satisfies ReferenceAssetPreparationProgressUpdateV1;
        await persistStatus(localPreparationStatus(assemblyId, 'preparing', starting));
        onProgress(starting);

        try {
          const receipt = await runPreparation({
            command: 'ensure',
            assemblyId,
            manifestPath: null,
            publishedEntry: repair.entry,
            expectedPublishedSource: repair.expectedSource,
            projectRoot: input.projectRoot,
            cacheRoot,
            publicationRoot,
            fallbackPublicationRoot,
            themeMode,
            sourceBuildFingerprint: input.sourceBuildFingerprint,
            indexerBinary: input.indexerBinary,
            onProgress: (message) => publishPreparing(progressForEngineMessage(message)),
          });
          if (receipt.status !== 'ready' && receipt.status !== 'source-ready') {
            throw new Error(receipt.message ?? 'Prepared reference products are unavailable.');
          }
          const current =
            (await listPrepared(cacheRoot, publicationRoot, fallbackPublicationRoot)).find(
              (candidate) => candidate.id === assemblyId
            ) ?? repair.entry;
          const ready = {
            phase: 'ready',
            label: `${current.name} is ready`,
            completed: 1,
            total: 1,
            assemblyId,
          } satisfies ReferenceAssetPreparationProgressUpdateV1;
          await persistStatus(localPreparationStatus(assemblyId, 'ready', ready));
          onProgress(ready);
          return current;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const failed = {
            phase: 'background-preparation-failed',
            label: `${repair.entry.name} annotations, search, or visualization are unavailable: ${detail}`,
            assemblyId,
          } satisfies ReferenceAssetPreparationProgressUpdateV1;
          try {
            await persistStatus(localPreparationStatus(assemblyId, 'failed', failed));
          } finally {
            onProgress(failed);
          }
          throw error;
        }
      })().finally(() => {
        if (retryTasks.get(assemblyId) === retry) {
          retryTasks.delete(assemblyId);
        }
      });
      retryTasks.set(assemblyId, retry);
      return retry;
    },
  };
}

export function resolveDnaIndexerHelperPath(input: {
  readonly appPath: string;
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
  readonly explicitPath?: string;
  readonly developmentSnapshotRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}): string {
  const explicitPath = input.explicitPath?.trim();
  if (explicitPath) return resolve(explicitPath);

  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const suffix =
    platform === 'darwin' && (arch === 'arm64' || arch === 'aarch64')
      ? 'aarch64-apple-darwin'
      : platform === 'darwin' && (arch === 'x64' || arch === 'x86_64')
        ? 'x86_64-apple-darwin'
        : platform === 'linux' && (arch === 'arm64' || arch === 'aarch64')
          ? 'aarch64-unknown-linux-musl'
          : platform === 'linux' && (arch === 'x64' || arch === 'x86_64')
            ? 'x86_64-unknown-linux-musl'
            : platform === 'win32' && (arch === 'x64' || arch === 'x86_64' || arch === 'amd64')
              ? 'x86_64-pc-windows-msvc'
              : null;
  if (!suffix) {
    throw new Error(`dna-indexer is unsupported on ${platform}/${arch}.`);
  }
  const helperName = `dna-indexer-${suffix}${platform === 'win32' ? '.exe' : ''}`;
  if (input.isPackaged) {
    return join(dirname(input.resourcesPath), 'Helpers', helperName);
  }

  const directPath = join(input.appPath, 'resources', 'helpers', helperName);
  const sourcePath = existsSync(directPath)
    ? directPath
    : resolve(input.appPath, '..', '..', 'resources', 'helpers', helperName);
  if (!input.developmentSnapshotRoot || !existsSync(sourcePath)) return sourcePath;
  return snapshotDevelopmentHelperForExecution(
    sourcePath,
    input.developmentSnapshotRoot,
    helperName,
    platform
  );
}

export function developmentHelperSnapshotNeedsFsync(platform: NodeJS.Platform): boolean {
  return platform !== 'win32';
}

function snapshotDevelopmentHelperForExecution(
  sourcePath: string,
  snapshotRoot: string,
  helperName: string,
  platform: NodeJS.Platform
): string {
  const sourceBytes = readFileSync(sourcePath);
  const sha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const generationRoot = join(resolve(snapshotRoot), 'sha256', sha256);
  const destination = join(generationRoot, helperName);
  if (existsSync(destination)) {
    const metadata = lstatSync(destination);
    const existingSha256 = metadata.isFile()
      ? createHash('sha256').update(readFileSync(destination)).digest('hex')
      : null;
    if (metadata.isSymbolicLink() || existingSha256 !== sha256) {
      throw new Error(`Immutable development helper snapshot is corrupt: ${destination}`);
    }
    return destination;
  }

  mkdirSync(generationRoot, { recursive: true, mode: 0o700 });
  const temporary = join(generationRoot, `.${helperName}.${process.pid}.${randomUUID()}.tmp`);
  try {
    copyFileSync(sourcePath, temporary, fsConstants.COPYFILE_EXCL);
    chmodSync(temporary, 0o700);
    const copiedSha256 = createHash('sha256').update(readFileSync(temporary)).digest('hex');
    if (copiedSha256 !== sha256) {
      throw new Error('Development helper snapshot changed while it was being copied.');
    }
    if (developmentHelperSnapshotNeedsFsync(platform)) {
      const handle = openSync(temporary, 'r');
      try {
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
    }
    renameSync(temporary, destination);
    return destination;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function progressForEngineMessage(message: string): ReferenceAssetPreparationProgressUpdateV1 {
  const normalized = message.trim();
  if (/published source generation/i.test(normalized)) {
    return {
      phase: 'source-published',
      label: 'Reference sequence and coordinates are ready',
      completed: 1,
      total: 1,
    };
  }
  if (/source summary/i.test(normalized)) {
    return {
      phase: 'summarizing-annotations',
      label: 'Summarizing annotations',
    };
  }
  if (/search/i.test(normalized)) {
    return {
      phase: 'building-search',
      label: 'Building annotation and protein search',
    };
  }
  if (/raster|scene|product/i.test(normalized)) {
    return {
      phase: 'building-visualization',
      label: 'Building visualization tiles',
    };
  }
  return {
    phase: 'indexing-reference',
    label: 'Indexing reference sequence and annotations',
  };
}
