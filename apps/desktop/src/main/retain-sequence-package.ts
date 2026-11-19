import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { lstatSync, type Stats } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  parseSequencePackageDocument,
  sequencePackageMetaPaths,
  sequencePrimerArtifactLookupPaths,
} from '../db/sequence-package';
import { captureSavedFileMembers, type SavedFileSourceMember } from './saved-file-sources';
import { savedFileWorkspace } from './saved-file-publication';
import { assertPhysicalPackageMember } from './workspace-git/package-member-boundary';

async function sequenceMarkers(packageRoot: string): Promise<string[]> {
  const markers: string[] = [];
  for (const path of sequencePackageMetaPaths(packageRoot)) {
    try {
      await lstat(path);
      markers.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return markers;
}

async function existingPrimerExportPaths(root: string, declared: string): Promise<string[]> {
  const members = [];
  for (const name of new Set([declared, ...sequencePrimerArtifactLookupPaths(declared)])) {
    const path = join(root, name);
    await assertPhysicalPackageMember(root, path);
    try {
      await lstat(path);
      members.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!members.length) throw new Error(`A declared primer export is missing: ${declared}`);
  return members;
}

export async function retainSequencePackage(
  db: Database.Database,
  input: { workspaceRoot: string; packageRoot: string },
  expectedPackageId?: string,
  assertCurrent?: () => void
): Promise<string> {
  const { workspaceRoot, packageRoot } = input;
  assertCurrent?.();
  if (resolve(workspaceRoot) === resolve(packageRoot))
    throw new Error('A saved sequence package must be inside its own project.');
  await assertPhysicalPackageMember(workspaceRoot, packageRoot);
  const markers = await sequenceMarkers(packageRoot);
  if (markers.length !== 1)
    throw new Error('The saved sequence package must have one authoritative marker.');
  const marker = markers[0];
  const markerMember = await assertPhysicalPackageMember(packageRoot, marker);
  const markerStat = await lstat(marker);
  if (!markerStat.isFile()) throw new Error('The sequence package marker must be a regular file.');
  const raw = await readFile(marker);
  const document = parseSequencePackageDocument(raw.toString('utf8'));
  if (expectedPackageId !== undefined && document.id !== expectedPackageId)
    throw new Error('The package identity changed during publication.');
  const paths = [markerMember, document.product.file];
  for (const member of document.members) {
    if (member.role === 'primer-export') {
      paths.push(...(await existingPrimerExportPaths(packageRoot, member.path)));
    } else {
      paths.push(member.path);
    }
  }
  const members: SavedFileSourceMember[] = [];
  const identities: Array<{ path: string; stat: Stats }> = [];
  for (const member of new Set(paths)) {
    const path = join(packageRoot, member);
    await assertPhysicalPackageMember(packageRoot, path);
    const stat = await lstat(path);
    if (!stat.isFile())
      throw new Error('A declared sequence package member is not a regular file.');
    identities.push({ path, stat });
    members.push({
      relativePath: member,
      sourcePath: path,
      ...(path === marker
        ? { expectedSha256: createHash('sha256').update(raw).digest('hex') }
        : {}),
    });
  }
  assertCurrent?.();
  const workspace = savedFileWorkspace(db, workspaceRoot);
  if (!workspace) throw new Error('The sequence package has no owning project.');
  await captureSavedFileMembers(
    db,
    {
      workspaceId: workspace.id,
      entityId: document.id,
      path: packageRoot,
      members,
    },
    () => {
      assertCurrent?.();
      for (const { path, stat } of identities) {
        const now = lstatSync(path);
        if (
          !now.isFile() ||
          stat.dev !== now.dev ||
          stat.ino !== now.ino ||
          stat.size !== now.size ||
          stat.mtimeMs !== now.mtimeMs ||
          stat.ctimeMs !== now.ctimeMs
        )
          throw new Error(
            'A sequence package member changed while saving its recoverable version.'
          );
      }
    }
  );
  return document.id;
}

export async function withRetainedSequencePackage<T>(
  db: Database.Database,
  workspaceRoot: string,
  packageRoot: string,
  operation: () => Promise<T>,
  assertCurrent?: () => void,
  allowUncreated = false
): Promise<T> {
  const input = { workspaceRoot, packageRoot };
  const creating = allowUncreated && (await sequenceMarkers(packageRoot)).length === 0;
  const id = creating
    ? undefined
    : await retainSequencePackage(db, input, undefined, assertCurrent);
  const result = await operation();
  if (!creating || (await sequenceMarkers(packageRoot)).length)
    await retainSequencePackage(db, input, id, assertCurrent);
  return result;
}
