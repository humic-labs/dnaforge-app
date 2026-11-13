import {
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackagePaths,
  type SequencePackageDocument,
  type SequencePackageRevision,
  type SequencePackageEvidenceRun,
} from './sequence-package';
import { verifySequencePackageSnapshot } from './sequence-package-versioning';
import { MAX_WORKSPACE_BINARY_WRITE_BYTES } from '../shared/workspace-file-atomic';

export interface SequencePackageHistoryFs {
  exists(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string>;
  readFile?(path: string): Promise<Uint8Array>;
  readFileBounded?(path: string, maxBytes: number): Promise<Uint8Array>;
  validateWorkspacePath(input: {
    workspaceRoot: string;
    path: string;
    artifactNoun?: string;
  }): Promise<boolean>;
}

export interface SequencePackageHistoryIndex {
  document: SequencePackageDocument;
  packageRoot: string;
  markerPath: string;
  productPath: string;
  legacyCurrentHasNoSnapshot: boolean;
  currentProductStatus: 'verified' | 'drifted' | 'unavailable' | 'legacy';
}

export type SequencePackageRevisionRead =
  | { status: 'available'; revision: SequencePackageRevision; content: string }
  | { status: 'unavailable'; revision: SequencePackageRevision; reason: string };

export type SequencePackageEvidenceRead =
  | { status: 'available'; run: SequencePackageEvidenceRun; result: unknown; states: unknown[] }
  | { status: 'unavailable'; run: SequencePackageEvidenceRun; reason: string };

export type SequencePackageUserAttachmentRead =
  | { status: 'available'; present: false }
  | { status: 'available'; present: true; sha256: string; sizeBytes: number }
  | { status: 'unavailable'; reason: string };

export async function readSequencePackageUserAttachment(input: {
  index: SequencePackageHistoryIndex;
  revisionId: string;
  attachmentId: string;
  workspaceRoot: string;
  fs: SequencePackageHistoryFs;
}): Promise<SequencePackageUserAttachmentRead> {
  const revision = input.index.document.versionHistory.revisions.find(
    (candidate) => candidate.id === input.revisionId
  );
  if (!revision) throw new Error(`Unknown sequence package revision: ${input.revisionId}`);
  const map = revision.state.userAttachments;
  if (map === undefined) {
    return { status: 'unavailable', reason: 'This older version did not record attachment state.' };
  }
  const attachment = map[input.attachmentId];
  if (!attachment) return { status: 'available', present: false };
  if (attachment.sha256 === null || !input.fs.readFileBounded) {
    return { status: 'unavailable', reason: 'Attachment bytes were not verified in this version.' };
  }
  const member = input.index.document.members.find(
    (candidate) => candidate.id === attachment.memberId && candidate.role === 'user'
  );
  if (!member || member.replaceable) {
    return { status: 'unavailable', reason: 'Historical attachment has no immutable member.' };
  }
  const path = fromPackageRelative(member.path, input.index.packageRoot);
  await requireOwned(input.fs, input.workspaceRoot, path);
  try {
    const bytes = await input.fs.readFileBounded(path, MAX_WORKSPACE_BINARY_WRITE_BYTES);
    const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
    const actual = `sha256:${Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')}`;
    if (actual !== attachment.sha256) throw new Error('digest mismatch');
    return {
      status: 'available',
      present: true,
      sha256: actual,
      sizeBytes: bytes.byteLength,
    };
  } catch {
    return {
      status: 'unavailable',
      reason: 'Attachment bytes are missing or failed integrity verification.',
    };
  }
}

export async function readSequencePackageHistoryIndex(input: {
  packageRoot: string;
  workspaceRoot: string;
  expectedPackageId?: string;
  fs: SequencePackageHistoryFs;
}): Promise<SequencePackageHistoryIndex> {
  const markerPath = sequencePackagePaths(input.packageRoot).metaPath;
  await requireOwned(input.fs, input.workspaceRoot, markerPath);
  const document = parseSequencePackageDocument(await input.fs.readTextFile(markerPath));
  if (input.expectedPackageId && document.id !== input.expectedPackageId) {
    throw new Error('Sequence history package identity does not match the requested entity.');
  }
  const productPath = sequencePackagePaths(input.packageRoot, {
    productFile: document.product.file,
  }).productPath;
  await requireOwned(input.fs, input.workspaceRoot, productPath);
  const head = document.versionHistory.revisions.find(
    (revision) => revision.id === document.versionHistory.headId
  );
  let currentProductStatus: SequencePackageHistoryIndex['currentProductStatus'] = 'legacy';
  if (head) {
    if (!(await input.fs.exists(productPath))) {
      currentProductStatus = 'unavailable';
    } else {
      try {
        await verifySequencePackageSnapshot({
          revision: head,
          content: await input.fs.readTextFile(productPath),
        });
        currentProductStatus = 'verified';
      } catch {
        currentProductStatus = 'drifted';
      }
    }
  }
  return {
    document,
    packageRoot: input.packageRoot,
    markerPath,
    productPath,
    legacyCurrentHasNoSnapshot: document.versionHistory.headId === null,
    currentProductStatus,
  };
}

export async function readSequencePackageRevision(input: {
  index: SequencePackageHistoryIndex;
  revisionId: string;
  workspaceRoot: string;
  fs: SequencePackageHistoryFs;
}): Promise<SequencePackageRevisionRead> {
  const revision = input.index.document.versionHistory.revisions.find(
    (candidate) => candidate.id === input.revisionId
  );
  if (!revision) throw new Error(`Unknown sequence package revision: ${input.revisionId}`);
  const path = fromPackageRelative(revision.productSnapshot.path, input.index.packageRoot);
  await requireOwned(input.fs, input.workspaceRoot, path);
  if (!(await input.fs.exists(path))) {
    return { status: 'unavailable', revision, reason: 'Snapshot file is missing.' };
  }
  const content = await input.fs.readTextFile(path);
  try {
    await verifySequencePackageSnapshot({ revision, content });
  } catch {
    return { status: 'unavailable', revision, reason: 'Snapshot integrity check failed.' };
  }
  return { status: 'available', revision, content };
}

export async function readSequencePackageEvidenceRun(input: {
  index: SequencePackageHistoryIndex;
  runId: string;
  workspaceRoot: string;
  fs: SequencePackageHistoryFs;
}): Promise<SequencePackageEvidenceRead> {
  const run = input.index.document.evidenceRuns?.find((candidate) => candidate.id === input.runId);
  if (!run) throw new Error(`Unknown sequence evidence run: ${input.runId}`);
  if (run.status !== 'completed' || !run.result) {
    return { status: 'unavailable', run, reason: `Run is ${run.status}.` };
  }
  try {
    if (!input.fs.readFile) {
      return { status: 'unavailable', run, reason: 'Binary evidence verification is unavailable.' };
    }
    for (const artifact of [
      run.reference.artifact,
      ...run.queries.map((query) => query.artifact),
    ]) {
      await readVerifiedArtifact(input, artifact.path, artifact.sha256);
    }
    const resultBytes = await readVerifiedArtifact(input, run.result.path, run.result.sha256);
    const states = [];
    for (const state of run.states ?? []) {
      const bytes = await readVerifiedArtifact(input, state.artifact.path, state.artifact.sha256);
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<
        string,
        unknown
      >;
      if (parsed.schema !== 'waypoint.sequence-evidence-state.v1' || parsed.runId !== run.id) {
        throw new Error('Interpreted evidence state identity is invalid.');
      }
      states.push(parsed);
    }
    const result = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(resultBytes)
    ) as Record<string, unknown>;
    if (
      result.inputRevision !== run.inputRevision ||
      result.referenceRevision !== run.reference.sequenceRevision
    ) {
      throw new Error('Retained result identity is invalid.');
    }
    return { status: 'available', run, result, states };
  } catch {
    return {
      status: 'unavailable',
      run,
      reason: 'Evidence bytes are missing or failed integrity verification.',
    };
  }
}

async function readVerifiedArtifact(
  input: {
    index: SequencePackageHistoryIndex;
    workspaceRoot: string;
    fs: SequencePackageHistoryFs;
  },
  relativePath: string,
  expectedSha256: string
): Promise<Uint8Array> {
  const path = fromPackageRelative(relativePath, input.index.packageRoot);
  await requireOwned(input.fs, input.workspaceRoot, path);
  if (!input.fs.readFile) throw new Error('Binary evidence verification is unavailable.');
  const bytes = await input.fs.readFile(path);
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  const actual = `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
  if (actual !== expectedSha256) throw new Error('Evidence artifact digest changed.');
  return bytes;
}

async function requireOwned(
  fs: SequencePackageHistoryFs,
  workspaceRoot: string,
  path: string
): Promise<void> {
  if (
    !(await fs.validateWorkspacePath({ workspaceRoot, path, artifactNoun: 'sequence history' }))
  ) {
    throw new Error('Sequence history path is outside its owning workspace.');
  }
}
