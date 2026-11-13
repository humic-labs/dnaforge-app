import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { defineBlob, type BlobHash } from '@waypoint/workspace-revisions';
import type { NativeFileDocumentOwner } from './file-document-owner';
import { trashAcceptedScientificPath } from './scientific-resource-lifecycle';
import { runWorkspaceFileTrash } from './workspace-file-trash';
import { setCatalogFileStateInDb } from './catalog-projection-commands';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';
import { basename, join } from 'node:path';
import {
  addSequencePackageMember,
  findEnclosingSequencePackageRoot,
  type SequencePackageIoFs,
} from '../db/sequence-package-io';
import {
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackagePaths,
  type SequencePackageDocument,
  type SequencePackageEvidenceRun,
} from '../db/sequence-package';
import { pathIsAtOrUnder } from '../shared/path-boundary';
import {
  MAX_SEQUENCE_EVIDENCE_INPUT_BYTES,
  type PrepareSequenceEvidenceRunRequest,
  type PrepareSequenceEvidenceRunResult,
} from '../shared/sequence-package-evidence';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';
import { canonicalWorkspacePath } from './primer-artifact-files';
import { readAcceptedSequencePackageBytes } from './sequence-package-publication-owner';

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const readBytes = (path: string) =>
  readAcceptedSequencePackageBytes(path) ??
  readFileBoundedFromHandle(path, MAX_SEQUENCE_EVIDENCE_INPUT_BYTES);
const exists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

export async function prepareSequenceQueryAttachments(input: {
  workspaceRoot: string;
  packageRoot: string;
  markerContent: string;
  queries: ReadonlyArray<{ id: string; path: string; bytes: Uint8Array }>;
}) {
  const paths = sequencePackagePaths(input.packageRoot);
  let marker = input.markerContent;
  const sourceBytes = new Map(input.queries.map((query) => [query.path, query.bytes]));
  const files = new Map<string, Uint8Array>();
  const has = async (path: string) => files.has(path) || (await exists(path));
  const read = async (path: string) => files.get(path) ?? sourceBytes.get(path) ?? readBytes(path);
  const stage = async (path: string, bytes: Uint8Array) => {
    if (!pathIsAtOrUnder(path, paths.contentsDir))
      throw new Error('The query attachment left its package contents.');
    if (await has(path)) throw new Error('MOVE_EXISTS: Query attachment destination exists.');
    files.set(path, Uint8Array.from(bytes));
  };
  const io: SequencePackageIoFs = {
    exists: has,
    readFile: read,
    readTextFile: async (path) =>
      path === paths.metaPath
        ? marker
        : new TextDecoder('utf-8', { fatal: true }).decode(await read(path)),
    writeTextFile: async () => {
      throw new Error('Query attachment requires the package marker precondition.');
    },
    writeWorkspaceTextFileAtomic: async (request) => {
      if (request.path !== paths.metaPath || request.expectedContentHash !== digest(marker))
        throw new Error('The query attachment package marker changed.');
      marker = request.content;
    },
    mkdir: async (path) => {
      if (!pathIsAtOrUnder(path, input.packageRoot))
        throw new Error('The query attachment directory left its package.');
    },
    move: async (source, directory) => {
      const destPath = join(directory, basename(source));
      await stage(destPath, await read(source));
      return { destPath };
    },
    rename: async (source, destination) => stage(destination, await read(source)),
    writeFile: stage,
  };
  for (const query of input.queries) {
    await addSequencePackageMember({
      packageRoot: input.packageRoot,
      workspaceRoot: input.workspaceRoot,
      role: 'sequencing-read',
      sourcePath: query.path,
      fs: io,
    });
  }
  return {
    document: parseSequencePackageDocument(marker),
    files: [...files].map(([path, bytes]) => ({ path, bytes })),
  };
}

export async function readAttachedEvidenceQueryPaths(
  packageRoot: string,
  document: SequencePackageDocument,
  run: SequencePackageEvidenceRun,
  requested: PrepareSequenceEvidenceRunRequest['queries']
): Promise<Record<string, string>> {
  const matches = new Map<string, string>();
  for (const member of document.members) {
    if (member.role !== 'sequencing-read') continue;
    const path = fromPackageRelative(member.path, packageRoot);
    matches.set(`sha256:${digest(await readBytes(path))}`, path);
  }
  const paths: Record<string, string> = {};
  for (const query of run.queries) {
    const attached = matches.get(query.artifact.sha256);
    if (attached) {
      paths[query.id] = attached;
      continue;
    }
    const original = requested.find((entry) => entry.id === query.id)?.path;
    if (
      original &&
      pathIsAtOrUnder(original, packageRoot) &&
      (await exists(original)) &&
      `sha256:${digest(await readBytes(original))}` === query.artifact.sha256
    )
      paths[query.id] = original;
  }
  return paths;
}

export async function retireSequenceEvidenceQuerySources(
  input: PrepareSequenceEvidenceRunRequest,
  prepared: PrepareSequenceEvidenceRunResult,
  context: {
    db: Database.Database;
    renderer?: { ownerId: number; mutationToken?: string };
    mutationLease?: () => void;
    assertCurrent: () => void;
    documents: Pick<NativeFileDocumentOwner, 'assertClean' | 'withCleanPaths'>;
    assertMutationAllowed: (paths: readonly string[]) => void | Promise<void>;
    runDatabase: <T>(operation: () => T) => T;
  }
): Promise<void> {
  const retirements = new Map<
    string,
    { source: string; destination: string; hash: BlobHash; revision: string }
  >();
  const acceptedTrash = (path: string, expectedContentHash: BlobHash) =>
    trashAcceptedScientificPath({
      db: context.db,
      path,
      renderer: context.renderer,
      mutationLease: context.mutationLease,
      assertCurrent: context.assertCurrent,
      expectedContentHash,
    });
  for (const query of input.queries) {
    const destination = prepared.attachedQueryPaths?.[query.id];
    if (
      !destination ||
      pathIsAtOrUnder(query.path, input.packageRoot) ||
      !pathIsAtOrUnder(query.path, input.workspaceRoot)
    )
      continue;
    if (await findEnclosingSequencePackageRoot(query.path, { exists })) continue;
    const source = (
      await canonicalWorkspacePath({
        workspaceRoot: input.workspaceRoot,
        path: query.path,
        allowMissing: true,
        artifactNoun: 'alignment query',
      })
    ).candidate;
    context.runDatabase(() => {
      const binding = context.db
        .prepare(
          'SELECT w.path FROM catalog_entity_files f LEFT JOIN workspaces w ON w.id=f.workspace_id WHERE f.path=?'
        )
        .get(source);
      if (
        binding &&
        (typeof binding !== 'object' ||
          !('path' in binding) ||
          typeof binding.path !== 'string' ||
          workspaceMutationRootIdentity(binding.path) !==
            workspaceMutationRootIdentity(input.workspaceRoot))
      )
        throw new Error('The query source catalog belongs to another workspace.');
    });
    const expected = prepared.run.queries.find((entry) => entry.id === query.id)?.artifact.sha256;
    const hash = defineBlob(await readBytes(destination)).hash;
    if (!expected || hash !== expected)
      throw new Error('The attached alignment query changed before its source could be retired.');
    if (!(await exists(source))) {
      await acceptedTrash(source, hash);
      context.assertCurrent();
      context.runDatabase(() => {
        const binding = context.db
          .prepare('SELECT status FROM catalog_entity_files WHERE path=?')
          .get(source);
        if (
          typeof binding === 'object' &&
          binding !== null &&
          'status' in binding &&
          binding.status === 'current'
        )
          setCatalogFileStateInDb(context.db, source, 'missing', 'alignment-query-attached');
      });
      continue;
    }
    const inspected = await runWorkspaceFileTrash({
      kind: 'inspect',
      workspaceRoot: input.workspaceRoot,
      path: source,
    });
    if (
      inspected.kind !== 'inspect' ||
      inspected.source.type !== 'file' ||
      inspected.source.contentHash !== hash
    )
      throw new Error('The alignment query changed before its source could be retired.');
    retirements.set(source, { source, destination, hash, revision: inspected.source.revision });
  }
  await context.documents.withCleanPaths(
    [...retirements.values()].flatMap(({ source, destination }) => [source, destination]),
    async () => {
      for (const retirement of retirements.values()) {
        context.assertCurrent();
        await context.documents.assertClean(retirement.source);
        await context.documents.assertClean(retirement.destination);
        if (defineBlob(await readBytes(retirement.destination)).hash !== retirement.hash)
          throw new Error('The attached alignment query changed before source retirement.');
        if (await acceptedTrash(retirement.source, retirement.hash)) continue;
        const result = await runWorkspaceFileTrash(
          {
            kind: 'trash',
            workspaceRoot: input.workspaceRoot,
            path: retirement.source,
            expectedRevision: retirement.revision,
          },
          context.assertCurrent,
          undefined,
          context.assertMutationAllowed
        );
        if (result.kind !== 'trash')
          throw new Error(
            result.kind === 'failed'
              ? result.error
              : 'The native query source retirement was not completed.'
          );
        context.runDatabase(() =>
          setCatalogFileStateInDb(
            context.db,
            retirement.source,
            'missing',
            'alignment-query-attached'
          )
        );
        if (result.warnings.length) throw new Error(result.warnings.join(' '));
        if (await exists(retirement.source))
          throw new Error('The native query source retirement left its source in place.');
      }
    }
  );
}
