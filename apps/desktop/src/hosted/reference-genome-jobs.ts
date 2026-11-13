import type { OperationSnapshot } from '@waypoint/api-client';
import type { WorkspaceSessionSnapshot } from '@waypoint/domain-services';
import { managedOperations } from '../services/managed-operations';
import {
  HostedWorkspaceApiError,
  downloadHostedFile,
  loadHostedManifest,
  loadHostedWorkspaceIndex,
  prepareHostedWorkspaceFiles,
  publishHostedWorkspaceFiles,
  requestJson,
  sha256Hex,
  type HostedManifestFile,
} from './api';
import { hostedDurableSync, hostedWorkspaceSessionController } from './controller';
import { hostedAbsolutePath } from './paths';

export const HOSTED_GENOME_KIND = 'reference-genome-preparation';
export const HOSTED_GENOME_ROOT = '.waypoint/reference-genomes';
export const HOSTED_GENOME_SOURCE_ROOT = 'genomes';
export const MAX_HOSTED_GENOME_SOURCE_BYTES = 100 * 1024 * 1024;
export const HOSTED_GENOME_BLOCK_BYTES = 256 * 1024;
const RECORD_FILE = 'reference-genome.json';
const ASSEMBLY_ID = /^local-[0-9a-f]{24}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OBJECT_KEY = /^objects\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/;
const RECORD_PATH = /^\.waypoint\/reference-genomes\/(local-[0-9a-f]{24})\/reference-genome\.json$/;
const GENOME_FILE = /\.(gb|gbk|gbff)$/i;
const CONTENT_TYPES = new Set(['application/json', 'application/octet-stream']);

export interface HostedGenomeObject {
  readonly objectKey: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly contentType: string;
  readonly blockSha256?: readonly string[];
}

export interface HostedGenomeResult {
  readonly contract: 'dnaforge-user-genome-publication.v1';
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly assembly: {
    readonly id: string;
    readonly name: string;
    readonly organism: string;
    readonly description: string;
    readonly lengthBp: number;
    readonly contigs: ReadonlyArray<{
      readonly chrom: string;
      readonly displayName: string;
      readonly lengthBp: number;
      readonly circular: boolean;
    }>;
  };
  readonly publicationFingerprint: string;
  readonly bundle: {
    readonly objectKey: string;
    readonly sha256: string;
    readonly byteLength: number;
    readonly bundleFingerprint: string;
  };
  readonly objects: readonly HostedGenomeObject[];
  readonly blockBytes?: number;
}

export interface HostedGenomeRecord extends HostedGenomeResult {
  readonly operationId: string;
}

export interface HostedGenomeLocation {
  readonly workspaceId: string;
  readonly versionId: string;
  readonly root: string;
  readonly record: HostedGenomeRecord;
}

export function hostedGenomeObjectPath(assemblyId: string, objectKey: string): string {
  if (!ASSEMBLY_ID.test(assemblyId) || !OBJECT_KEY.test(objectKey)) {
    throw new Error('Invalid prepared genome object.');
  }
  return `${HOSTED_GENOME_ROOT}/${assemblyId}/${objectKey}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function parseHostedGenomeResult(value: unknown): HostedGenomeResult {
  const invalid = () => new Error('The genome indexing result is invalid.');
  if (!isRecord(value) || value.contract !== 'dnaforge-user-genome-publication.v1') throw invalid();
  const { assembly, bundle, objects } = value;
  if (
    typeof value.sourcePath !== 'string' ||
    !SHA256.test(String(value.sourceSha256)) ||
    !SHA256.test(String(value.publicationFingerprint)) ||
    !isRecord(assembly) ||
    !ASSEMBLY_ID.test(String(assembly.id)) ||
    typeof assembly.name !== 'string' ||
    typeof assembly.organism !== 'string' ||
    typeof assembly.description !== 'string' ||
    !positiveInteger(assembly.lengthBp) ||
    !Array.isArray(assembly.contigs) ||
    assembly.contigs.length === 0 ||
    !assembly.contigs.every(
      (contig) =>
        isRecord(contig) &&
        typeof contig.chrom === 'string' &&
        typeof contig.displayName === 'string' &&
        positiveInteger(contig.lengthBp) &&
        typeof contig.circular === 'boolean'
    ) ||
    !isRecord(bundle) ||
    !Array.isArray(objects) ||
    objects.length === 0 ||
    (value.blockBytes !== undefined && value.blockBytes !== HOSTED_GENOME_BLOCK_BYTES)
  )
    throw invalid();
  for (const object of objects) {
    const match = isRecord(object) ? OBJECT_KEY.exec(String(object.objectKey)) : null;
    if (
      !isRecord(object) ||
      !match ||
      match[2] !== object.sha256 ||
      match[1] !== match[2].slice(0, 2) ||
      !Number.isSafeInteger(object.byteLength) ||
      (object.byteLength as number) < 0 ||
      !CONTENT_TYPES.has(String(object.contentType)) ||
      (object.blockSha256 !== undefined &&
        (value.blockBytes !== HOSTED_GENOME_BLOCK_BYTES ||
          !Array.isArray(object.blockSha256) ||
          object.blockSha256.length !==
            Math.ceil((object.byteLength as number) / HOSTED_GENOME_BLOCK_BYTES) ||
          !object.blockSha256.every((digest) => SHA256.test(String(digest)))))
    )
      throw invalid();
  }
  if (
    !SHA256.test(String(bundle.bundleFingerprint)) ||
    !objects.some(
      (object: Record<string, unknown>) =>
        object.objectKey === bundle.objectKey &&
        object.sha256 === bundle.sha256 &&
        object.byteLength === bundle.byteLength
    )
  )
    throw invalid();
  return value as unknown as HostedGenomeResult;
}

function activeSession(): {
  accountId: string;
  workspaceId: string;
  snapshot: WorkspaceSessionSnapshot;
} {
  const state = hostedWorkspaceSessionController.getState();
  const accountId = state.principal?.id;
  const workspaceId = state.activeWorkspaceId;
  const snapshot = state.snapshot;
  if (!accountId || !workspaceId || snapshot?.workspaceId !== workspaceId) {
    throw new Error('Open a project before indexing a genome.');
  }
  return { accountId, workspaceId, snapshot };
}

export function pickHostedGenomeFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.gb,.gbk,.gbff';
    input.hidden = true;
    input.dataset.testid = 'hosted-genome-file-input';
    const finish = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

function safeGenomeFileName(name: string): string {
  const base =
    name
      .replace(/\\/gu, '/')
      .split('/')
      .pop()
      ?.replace(/[^A-Za-z0-9._-]+/gu, '-')
      .replace(/^[.-]+/u, '') ?? '';
  if (!GENOME_FILE.test(base)) {
    throw new Error('Choose a GenBank genome file (.gb, .gbk or .gbff).');
  }
  return base;
}

export async function saveHostedGenomeSource(
  file: File
): Promise<{ workspaceId: string; path: string }> {
  if (file.size > MAX_HOSTED_GENOME_SOURCE_BYTES) {
    throw new Error(
      `This genome file is too large to index in the web app (${Math.ceil(
        file.size / 1024 / 1024
      )} MB; the limit is 100 MB). Bacterial and yeast genomes fit.`
    );
  }
  const { workspaceId, snapshot } = activeSession();
  const path = `${HOSTED_GENOME_SOURCE_ROOT}/${safeGenomeFileName(file.name)}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentSha256 = await sha256Hex(bytes);
  const existing = snapshot.files.find((candidate) => candidate.path === path);
  if (existing && existing.contentSha256 !== contentSha256) {
    throw new Error(`A different genome named ${path.slice(8)} is already in this project.`);
  }
  if (!existing) {
    await hostedWorkspaceSessionController.commit([
      { path, bytes, contentType: 'application/genbank' },
    ]);
  }
  return { workspaceId, path };
}

export async function startHostedGenomeIndexing(source: {
  workspaceId: string;
  path: string;
}): Promise<OperationSnapshot> {
  return managedOperations.startRegisteredOperation(
    async ({ scopeId, submissionKey, acceptedWorkspaceInput, expectedAccountId }) => {
      if (!acceptedWorkspaceInput || !expectedAccountId) {
        throw new Error('Save the genome to the project before indexing it.');
      }
      const snapshot = await requestJson<OperationSnapshot>(
        `/api/hosted-operations/${encodeURIComponent(scopeId)}/operations/${HOSTED_GENOME_KIND}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-DNAForge-Account-ID': expectedAccountId,
          },
          body: JSON.stringify({
            submission_key: submissionKey,
            subject: { scope_id: scopeId, accepted_workspace_input: acceptedWorkspaceInput },
            input: { sourcePath: source.path },
          }),
        }
      );
      if (snapshot.kind !== HOSTED_GENOME_KIND || snapshot.subject.scope_id !== scopeId) {
        throw new Error('Invalid genome indexing operation identity.');
      }
      return snapshot;
    },
    undefined,
    [{ key: 'source', path: hostedAbsolutePath(source.workspaceId, source.path) }]
  );
}

async function settledSnapshot(
  accountId: string,
  workspaceId: string
): Promise<WorkspaceSessionSnapshot> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    await hostedDurableSync.flush(workspaceId);
    const record = await hostedDurableSync.store.load(accountId, workspaceId);
    if (!record?.operations.length) break;
    if (
      record.operations.some(
        (operation) => operation.state === 'blocked' || operation.state === 'conflict'
      ) ||
      Date.now() >= deadline
    ) {
      throw new Error(
        'Sync your saved edits before adding the indexed genome. The job result is retained.'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await hostedWorkspaceSessionController.refreshActiveWorkspace();
  const session = activeSession();
  if (session.accountId !== accountId || session.workspaceId !== workspaceId) {
    throw new Error('The account or project changed. The job result is retained.');
  }
  return session.snapshot;
}

function manifestFile(file: WorkspaceSessionSnapshot['files'][number]): HostedManifestFile {
  if (!file.contentSha256) throw new Error('The saved project is missing a file integrity claim.');
  return {
    ...(file.resourceId ? { resourceId: file.resourceId } : {}),
    path: file.path,
    contentSha256: file.contentSha256,
    sizeBytes: file.sizeBytes,
    contentType: file.contentType,
  };
}

export async function acceptHostedGenomeResult(operationId: string): Promise<HostedGenomeLocation> {
  const envelope: unknown = await managedOperations.getResult(operationId);
  if (
    !isRecord(envelope) ||
    envelope.kind !== HOSTED_GENOME_KIND ||
    envelope.status !== 'available'
  ) {
    throw new Error('The genome indexing result is no longer available. Index the genome again.');
  }
  const result = parseHostedGenomeResult(envelope.result);
  const record: HostedGenomeRecord = { ...result, operationId };
  const { accountId, workspaceId } = activeSession();
  const root = `${HOSTED_GENOME_ROOT}/${result.assembly.id}`;
  const recordPath = `${root}/${RECORD_FILE}`;
  const recordBytes = new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`);
  const recordSha256 = await sha256Hex(recordBytes);
  let versionId: string | null = null;
  for (let attempt = 0; ; attempt += 1) {
    const snapshot = await settledSnapshot(accountId, workspaceId);
    const existing = new Map(snapshot.files.map((file) => [file.path, file]));
    const added: HostedManifestFile[] = result.objects
      .map((object) => ({
        path: hostedGenomeObjectPath(result.assembly.id, object.objectKey),
        contentSha256: object.sha256,
        sizeBytes: object.byteLength,
        contentType: object.contentType,
      }))
      .filter((file) => existing.get(file.path)?.contentSha256 !== file.contentSha256)
      .map((file) => ({ resourceId: crypto.randomUUID(), ...file }));
    if (added.length === 0 && existing.get(recordPath)?.contentSha256 === recordSha256) {
      versionId = snapshot.revisionId;
      break;
    }
    const addedPaths = new Set(added.map((file) => file.path));
    const publication = {
      workspaceId,
      baseVersionId: snapshot.revisionId,
      baseFiles: [
        ...snapshot.files.filter((file) => !addedPaths.has(file.path)).map(manifestFile),
        ...added,
      ],
      files: [
        {
          path: recordPath,
          bytes: recordBytes,
          contentType: 'application/json',
          resourceId: existing.get(recordPath)?.resourceId ?? crypto.randomUUID(),
        },
      ],
      expectedAccountId: accountId,
      operationId,
    };
    try {
      versionId = (
        await publishHostedWorkspaceFiles(
          publication,
          await prepareHostedWorkspaceFiles(publication)
        )
      ).id;
      break;
    } catch (error) {
      if (!(error instanceof HostedWorkspaceApiError) || error.status !== 409 || attempt >= 2) {
        throw error;
      }
    }
  }
  if (!versionId) throw new Error('The indexed genome was not saved to the project.');
  await hostedWorkspaceSessionController.refreshActiveWorkspace();
  await managedOperations.releaseResult(operationId).catch(() => undefined);
  return { workspaceId, versionId, root, record };
}

export async function waitForHostedGenomeIndexing(
  operationId: string,
  signal?: AbortSignal
): Promise<HostedGenomeLocation> {
  const terminal = await managedOperations.waitForTerminal(operationId, {
    timeoutMs: 60 * 60_000,
    signal,
  });
  if (terminal.state !== 'succeeded') {
    throw new Error(
      terminal.error?.message ??
        (terminal.state === 'canceled'
          ? 'Genome indexing was canceled.'
          : 'Genome indexing failed.')
    );
  }
  return acceptHostedGenomeResult(operationId);
}

export async function reconcileHostedGenomeJobs(): Promise<void> {
  const finished = managedOperations
    .getSnapshot()
    .records.map((record) => record.snapshot)
    .filter(
      (operation) =>
        operation.kind === HOSTED_GENOME_KIND &&
        operation.state === 'succeeded' &&
        operation.result_status === 'available'
    );
  for (const operation of finished) {
    await acceptHostedGenomeResult(operation.id).catch((error: unknown) => {
      console.warn(
        '[hosted-genomes] could not attach a finished indexing job',
        operation.id,
        error
      );
    });
  }
}

export async function listHostedGenomes(): Promise<HostedGenomeLocation[]> {
  const state = hostedWorkspaceSessionController.getState();
  const workspaceId = state.activeWorkspaceId;
  const accountId = state.principal?.id;
  if (!workspaceId) return [];
  const versionId = (await loadHostedWorkspaceIndex(accountId)).workspaces.find(
    (workspace) => workspace.workspaceId === workspaceId
  )?.latest.versionId;
  if (!versionId) return [];
  const { manifest } = await loadHostedManifest(workspaceId, versionId, accountId);
  const paths = new Map(manifest.files.map((file) => [file.path, file]));
  const genomes: HostedGenomeLocation[] = [];
  for (const file of manifest.files) {
    const match = RECORD_PATH.exec(file.path);
    if (!match) continue;
    try {
      const bytes = await downloadHostedFile({ workspaceId, versionId, file });
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      const result = parseHostedGenomeResult(parsed);
      if (result.assembly.id !== match[1]) {
        console.warn('[hosted-genomes] saved genome record names another assembly', file.path);
        continue;
      }
      const complete = result.objects.every(
        (object) =>
          paths.get(hostedGenomeObjectPath(result.assembly.id, object.objectKey))?.contentSha256 ===
          object.sha256
      );
      if (!complete) {
        console.warn('[hosted-genomes] saved genome is missing objects', file.path);
        continue;
      }
      genomes.push({
        workspaceId,
        versionId,
        root: `${HOSTED_GENOME_ROOT}/${result.assembly.id}`,
        record: {
          ...result,
          operationId: isRecord(parsed) ? String(parsed.operationId ?? '') : '',
        },
      });
    } catch (error) {
      console.warn('[hosted-genomes] could not read a saved genome record', file.path, error);
    }
  }
  return genomes;
}
