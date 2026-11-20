import type Database from 'better-sqlite3';
import { lstatSync, realpathSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { notebookPackagePaths } from '../db/notebook-package';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { captureValidatedNotebookPackage } from './notebook-sync-package';
import { captureSavedFileMembers } from './saved-file-sources';
import { scientificWorkspaceIdForRoot } from './scientific-workspace-identity';

export async function retainNotebookPackage(
  db: Database.Database,
  input: { workspaceRoot: string; packageRoot: string },
  embeddedId: string,
  stage: 'before' | 'published',
  assertCurrent?: () => void
): Promise<void> {
  const { workspaceRoot, packageRoot } = input;
  assertCurrent?.();
  if (stage === 'before') {
    try {
      await lstat(notebookPackagePaths(packageRoot).metaPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  const capture = await captureValidatedNotebookPackage(
    workspaceRoot,
    packageRoot,
    {
      maxMemberBytes: Number.MAX_SAFE_INTEGER,
      maxParsedMemberBytes: HARD_CAP_BYTES,
      maxMembers: 200000,
      maxTotalBytes: Number.MAX_SAFE_INTEGER,
    },
    'retention'
  );
  if (!capture || capture.notebookId !== embeddedId)
    throw new Error('The notebook package does not contain its declared identity.');
  assertCurrent?.();
  const workspaceId = scientificWorkspaceIdForRoot(db, workspaceRoot);
  if (workspaceId === null) throw new Error('The saved notebook has no registered project.');
  const project = db.prepare('SELECT repo_uuid FROM workspaces WHERE id=?').get(workspaceId) as {
    repo_uuid: string | null;
  };
  await captureSavedFileMembers(
    db,
    {
      workspaceId,
      entityId: scopedProjectionId(workspaceScopeKey(project.repo_uuid, workspaceId), embeddedId),
      path: packageRoot,
      members: capture.members.map((member) => ({
        relativePath: relative(packageRoot, member.absolutePath).split(sep).join('/'),
        sourcePath: member.readPath,
      })),
    },
    () => {
      assertCurrent?.();
      for (const member of capture.members) {
        const current = lstatSync(member.readPath);
        const prior = member.deferredIdentity;
        if (
          !current.isFile() ||
          current.dev !== prior.dev ||
          current.ino !== prior.ino ||
          current.size !== prior.size ||
          current.mtimeMs !== prior.mtimeMs ||
          current.ctimeMs !== prior.ctimeMs ||
          realpathSync(member.absolutePath) !== member.readPath
        )
          throw new Error('The notebook package changed while retaining its files.');
      }
    }
  );
}
