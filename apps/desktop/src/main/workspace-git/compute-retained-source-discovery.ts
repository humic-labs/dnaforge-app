import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../../shared/canonical-json';
import { assertWorkspaceProjectionPathSafe } from '../workspace-projection-boundary';
import { computeRecoveryManifestSchema } from './compute-result-recovery';
import { migrationPathsIntersect } from './migration-paths';

const BASE = '.dnaforge/compute-results';
const completionSchema = z.object({ planSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

export async function collectRetainedComputeSourcePaths(input: {
  workspaceRoot: string;
  committedFiles?: readonly string[];
  readText?: (relativePath: string) => Promise<string>;
}): Promise<ReadonlySet<string>> {
  const paths = new Set<string>();
  const readText =
    input.readText ??
    (async (relativePath: string) => {
      const path = join(input.workspaceRoot, relativePath);
      assertWorkspaceProjectionPathSafe(input.workspaceRoot, path);
      return readFile(path, 'utf8');
    });
  let operations: string[];
  if (input.committedFiles) {
    operations = input.committedFiles.flatMap((path) => {
      const match = /^\.dnaforge\/compute-results\/([a-f0-9]{64})\/complete\.json$/u.exec(path);
      return match ? [match[1]] : [];
    });
  } else {
    const base = join(input.workspaceRoot, BASE);
    assertWorkspaceProjectionPathSafe(input.workspaceRoot, base);
    operations = await readdir(base, { withFileTypes: true }).then(
      (entries) =>
        entries
          .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/u.test(entry.name))
          .map((entry) => entry.name),
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    );
  }
  for (const operationId of operations) {
    const base = `${BASE}/${operationId}`;
    const completionText = await readText(`${base}/complete.json`).catch(
      (error: NodeJS.ErrnoException) => {
        if (!input.committedFiles && error.code === 'ENOENT') return null;
        throw error;
      }
    );
    if (completionText === null) continue;
    const completion = completionSchema.parse(JSON.parse(completionText));
    const manifest = computeRecoveryManifestSchema.parse(
      JSON.parse(await readText(`${base}/manifest.json`))
    );
    if (
      manifest.operationId !== operationId ||
      manifest.witness.sourceRelativePath !==
        `compute/${manifest.witness.provider}/${manifest.witness.remoteId}` ||
      !/^compute\/[^/]+\/[^/]+$/u.test(manifest.witness.sourceRelativePath) ||
      createHash('sha256').update(canonicalJson(manifest)).digest('hex') !== completion.planSha256
    )
      throw new Error('The completed compute recovery record no longer matches its source.');
    paths.add(manifest.witness.sourceRelativePath);
    for (const entry of manifest.source.entries)
      paths.add(`${manifest.witness.sourceRelativePath}/${entry.relativePath}`);
  }
  return paths;
}

export function isRetainedComputeSourceCandidate(
  workspaceRoot: string,
  absolutePath: string,
  retainedPaths: ReadonlySet<string>,
  activeAcceptedPaths: readonly string[] = []
): boolean {
  return (
    retainedPaths.has(relative(workspaceRoot, absolutePath).split(sep).join('/')) &&
    !activeAcceptedPaths.some((path) => migrationPathsIntersect(path, absolutePath))
  );
}
