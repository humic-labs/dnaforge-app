import { access, mkdir, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import {
  createProjectMemoryOwner,
  type AppendProjectMemoryEventInput,
  type ProjectMemorySnapshot,
} from '../db/project-memory-owner';
import {
  canonicalWorkspacePath,
  writeWorkspaceTextFileAtomicInMain,
} from './primer-artifact-files';

export async function appendProjectMemoryEventInMain(
  input: AppendProjectMemoryEventInput,
  assertCurrent: () => void
): Promise<ProjectMemorySnapshot> {
  assertCurrent();
  const workspaceRoot = await realpath(input.workspaceRoot);
  const memoryRoot = join(workspaceRoot, '.waypoint', 'project-memory');
  const safe = async (path: string, allowMissing = true) => {
    const member = await canonicalWorkspacePath({
      workspaceRoot,
      path,
      allowMissing,
      artifactNoun: 'project memory',
    });
    const memberPath = relative(memoryRoot, member.candidate);
    if (
      member.candidate !== join(workspaceRoot, '.waypoint') &&
      (memberPath === '..' || memberPath.startsWith('../'))
    ) {
      throw new Error('The history writer escaped project memory.');
    }
    assertCurrent();
    return member.candidate;
  };
  const owner = createProjectMemoryOwner(() => ({
    mkdir: async (path, options) => {
      await mkdir(await safe(path), options);
      assertCurrent();
    },
    exists: async (path) => {
      try {
        await access(await safe(path));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    readTextFile: async (path) => readFile(await safe(path, false), 'utf8'),
    writeTextFile: async (path, content) => {
      const target = await safe(path);
      let current: string | undefined;
      try {
        current = await readFile(target, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      assertCurrent();
      await writeWorkspaceTextFileAtomicInMain(
        {
          workspaceRoot,
          path: target,
          content,
          mode: current === undefined ? 'create' : 'replace',
          expectedContentHash:
            current === undefined ? undefined : createHash('sha256').update(current).digest('hex'),
          artifactNoun: 'project memory',
        },
        { beforePublish: assertCurrent }
      );
    },
  }));
  const snapshot = await owner.appendProjectMemoryEvent({ ...input, workspaceRoot });
  if (!snapshot) throw new Error('Project memory append produced no snapshot.');
  return snapshot;
}
