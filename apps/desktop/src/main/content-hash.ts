import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

export interface ContentHashInput {
  workspaceRoot: string;
  workspaceRelativePath: string;
}

export type ContentHash = `sha256:${string}`;

function isInside(candidate: string, root: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root.slice(0, -1) : root;
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}${sep}`);
}

export async function contentHashInMain(input: ContentHashInput): Promise<ContentHash> {
  const { workspaceRoot, workspaceRelativePath } = input;

  if (!workspaceRelativePath || workspaceRelativePath.trim() === '') {
    throw new Error('[fs:contentHash] path must be workspace-relative and non-empty');
  }
  if (isAbsolute(workspaceRelativePath)) {
    throw new Error(
      `[fs:contentHash] path must be workspace-relative, got absolute: ${workspaceRelativePath}`
    );
  }

  const canonicalRoot = await realpath(workspaceRoot);
  const lexicalTarget = resolve(canonicalRoot, workspaceRelativePath);

  if (!isInside(lexicalTarget, canonicalRoot)) {
    throw new Error(
      `[fs:contentHash] refusing: ${workspaceRelativePath} resolves outside the workspace`
    );
  }

  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(lexicalTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`[fs:contentHash] file not found: ${workspaceRelativePath}`);
    }
    throw error;
  }

  if (!isInside(canonicalTarget, canonicalRoot)) {
    throw new Error(
      `[fs:contentHash] refusing: ${workspaceRelativePath} resolves outside the workspace`
    );
  }

  const stats = await stat(canonicalTarget);
  if (!stats.isFile()) {
    throw new Error(`[fs:contentHash] not a file: ${workspaceRelativePath}`);
  }

  return await new Promise<ContentHash>((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const stream = createReadStream(canonicalTarget);
    stream.on('error', rejectPromise);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(`sha256:${hash.digest('hex')}`));
  });
}
