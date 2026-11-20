import fs from 'node:fs';
import { basename, join, posix } from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import git from 'isomorphic-git';
import {
  primerRestoreBindingQuery,
  PRIMER_SAVED_SOURCE_EVENT,
  PRIMER_RELOCATION_SOURCE_EVENT,
  type PrimerRestoreBinding,
} from '../shared/primer-artifacts/primer-source-history';
import { readBoundPrimerArtifact } from '../shared/primers/primer-artifact';
import { isSafeWorkspaceRelativePath, pathRelativeToBoundary } from '../shared/path-boundary';
import { assertPhysicalPackageMember } from './workspace-git/package-member-boundary';
import { readLooseBlobContentIdentity } from './workspace-git/blob-content-identity';
import { readBlobBytesAtCommit } from './workspace-git';

export async function readCommittedPrimerSource(
  db: Database.Database,
  runDatabase: <T>(read: () => T) => T,
  entityId: string
): Promise<string | null> {
  const binding = runDatabase(() =>
    db
      .prepare(primerRestoreBindingQuery)
      .get(PRIMER_SAVED_SOURCE_EVENT, PRIMER_RELOCATION_SOURCE_EVENT, entityId)
  ) as PrimerRestoreBinding | undefined;
  if (
    !binding ||
    !isSafeWorkspaceRelativePath(binding.relativePath) ||
    pathRelativeToBoundary(binding.path, binding.root) !== binding.relativePath ||
    !/^[a-f0-9]{64}$/u.test(binding.sha256)
  )
    return null;
  const root = binding.root;
  const gitdir = join(root, '.git');
  if (!fs.existsSync(gitdir)) return null;
  await assertPhysicalPackageMember(root, gitdir);
  if (!(await fs.promises.lstat(gitdir)).isDirectory()) return null;
  const visited = new Set<string>();
  for (const ref of ['HEAD', 'refs/heads/main']) {
    try {
      const oid = await git.resolveRef({ fs, dir: root, gitdir, ref });
      if (visited.has(oid)) continue;
      visited.add(oid);
      const parent = posix.dirname(binding.relativePath);
      const { tree } = await git.readTree({
        fs,
        dir: root,
        gitdir,
        oid,
        ...(parent === '.' ? {} : { filepath: parent }),
      });
      const member = tree.find(
        (entry) =>
          entry.path === basename(binding.relativePath) &&
          entry.type === 'blob' &&
          (entry.mode === '100644' || entry.mode === '100755')
      );
      if (!member) continue;
      const objectPath = join(gitdir, 'objects', member.oid.slice(0, 2), member.oid.slice(2));
      await assertPhysicalPackageMember(root, objectPath);
      const measured = await readLooseBlobContentIdentity(objectPath, member.oid, 16 * 1024 * 1024);
      if (measured.contentSha256 !== binding.sha256) continue;
      const bytes = await readBlobBytesAtCommit(root, oid, binding.relativePath);
      if (
        bytes.byteLength !== measured.sizeBytes ||
        createHash('sha256').update(bytes).digest('hex') !== binding.sha256
      )
        continue;
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (
        readBoundPrimerArtifact(content, binding.relativePath, entityId).artifactRevision ===
        binding.revision
      )
        return content;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' ||
        (error as { code?: string }).code === 'NotFoundError'
      )
        continue;
      throw error;
    }
  }
  return null;
}
