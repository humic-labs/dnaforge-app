import { open, readFile } from 'node:fs/promises';

import { fromPackageRelative } from '../db/sequence-package';
import {
  verifyPreparedUserAttachmentAsset,
  type PreparedUserAttachmentAsset,
} from '../db/sequence-package-user-attachment-mutation';
import {
  canonicalWorkspacePath,
  sha256Bytes,
  writeWorkspaceBinaryFileAtomicInMain,
} from './primer-artifact-files';
import { syncDirectory } from './fs-durability';
import { stageAcceptedSequencePackageFile } from './sequence-package-publication-owner';

export async function stagePreparedUserAttachmentAssetInMain(input: {
  workspaceRoot: string;
  packageRoot: string;
  asset: PreparedUserAttachmentAsset;
}): Promise<string> {
  await verifyPreparedUserAttachmentAsset(input.asset);
  const path = fromPackageRelative(input.asset.path, input.packageRoot);
  if (await stageAcceptedSequencePackageFile({ ...input, path, content: input.asset.content }))
    return path;
  const safe = await canonicalWorkspacePath({
    workspaceRoot: input.workspaceRoot,
    path,
    allowMissing: true,
    artifactNoun: 'user attachment',
  });
  try {
    const existing = await readFile(safe.candidate);
    if (`sha256:${await sha256Bytes(existing)}` !== input.asset.sha256) {
      throw new Error(`Immutable user attachment conflicts at ${input.asset.path}.`);
    }
    await flushStagedAsset(safe.candidate, safe.parent);
    return safe.candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await writeWorkspaceBinaryFileAtomicInMain({
      workspaceRoot: input.workspaceRoot,
      path,
      content: input.asset.content,
      artifactNoun: 'user attachment',
    });
  } catch (error) {
    if (!(error instanceof Error) || !/already exists at that location/.test(error.message)) {
      throw error;
    }
  }
  const saved = await readFile(safe.candidate);
  if (`sha256:${await sha256Bytes(saved)}` !== input.asset.sha256) {
    throw new Error(`User attachment bytes failed verification at ${input.asset.path}.`);
  }
  await flushStagedAsset(safe.candidate, safe.parent);
  return safe.candidate;
}

async function flushStagedAsset(path: string, parent: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(parent);
}
