import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { fromPackageRelative } from '../db/sequence-package';
import { syncDirectory } from './fs-durability';
import {
  canonicalWorkspacePath,
  writeWorkspaceBinaryFileAtomicInMain,
} from './primer-artifact-files';
import type { OrganizationSavedSequenceSnapshot } from './org-registry-saved-sequence-snapshot-contract';

export async function stageOrganizationSavedSequenceMembers(input: {
  workspaceRoot: string;
  packageRoot: string;
  snapshot: OrganizationSavedSequenceSnapshot;
}): Promise<void> {
  const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
  const members = await Promise.all(
    input.snapshot.members.map(async (member) => {
      const safe = await canonicalWorkspacePath({
        workspaceRoot: input.workspaceRoot,
        path: fromPackageRelative(member.path, input.packageRoot),
        allowMissing: true,
        artifactNoun: 'saved sequence member',
      });
      const content = Buffer.from(member.contentBase64, 'base64');
      if (digest(content) !== member.contentSha256)
        throw new Error('The approved sequence member changed.');
      try {
        if (digest(await readFile(safe.candidate)) !== member.contentSha256)
          throw new Error('An existing sequence member conflicts with the approved saved bytes.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return { member, safe, content };
    })
  );
  for (const { member, safe, content } of members) {
    try {
      await writeWorkspaceBinaryFileAtomicInMain({
        workspaceRoot: input.workspaceRoot,
        path: fromPackageRelative(member.path, input.packageRoot),
        content,
        artifactNoun: 'saved sequence member',
      });
    } catch (error) {
      if (!(error instanceof Error) || !/already exists at that location/.test(error.message))
        throw error;
    }
    if (digest(await readFile(safe.candidate)) !== member.contentSha256)
      throw new Error('The installed sequence member failed its exact digest check.');
    const handle = await open(safe.candidate, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(safe.parent);
  }
}
