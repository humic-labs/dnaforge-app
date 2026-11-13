import { z } from 'zod';

import { platform } from '../../../platform';
import { buildIndexedGenomePaths } from '../../sequence/public/indexed-genome-paths';
import { isPathInsideBoundary } from '../../../shared/path-boundary';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import {
  getUserFolders,
  resolveMultiRootPath,
} from '../../workspace/public/path-resolve';

export const managedGenomeIndexStartSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .describe(
        'A genome source inside an open DNAForge project. With multiple projects open, ' +
          'prefix a relative path with the project name.'
      ),
  })
  .strict();

interface PreparedGenomeIndex {
  input: {
    input: string;
    outputDir: string;
    name: string;
    workspaceRoot: string;
  };
}

export function projectManagedGenomeIndexPreparation(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
  const value = result as Partial<PreparedGenomeIndex> & { error?: unknown };
  if (!value.input || typeof value.input.name !== 'string') {
    return typeof value.error === 'string' ? { error: value.error } : {};
  }
  return { input: { name: value.input.name } };
}

export function createPrepareManagedGenomeIndexTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Start a durable genome-indexing job for a source inside an open project. Returns the ' +
      'managed operation immediately so it can be followed or stopped from Jobs, the API, ' +
      'the CLI, or agent tools.',
    inputSchema: managedGenomeIndexStartSchema,
    execute: async ({ path }) => {
      try {
        const userFolders = getUserFolders(folders);
        if (userFolders.length === 0) {
          return preparationFailure(
            'NO_WORKSPACE',
            'Open a writable project before starting genome indexing.'
          );
        }
        const resolved = resolveMultiRootPath(userFolders, path);
        const [source, root] = await Promise.all([
          platform().fs.stat(resolved.absolutePath),
          platform().fs.stat(resolved.folder.path),
        ]);
        if (!source.isFile || !root.isDirectory) {
          return preparationFailure(
            'INVALID_GENOME_SOURCE',
            'The genome source must be a file inside an open project.'
          );
        }
        if (!isPathInsideBoundary(source.canonicalPath, root.canonicalPath)) {
          return preparationFailure(
            'GENOME_SOURCE_OUTSIDE_WORKSPACE',
            'The genome source escaped its open project boundary.'
          );
        }

        const paths = buildIndexedGenomePaths({
          sourcePath: source.canonicalPath,
          workspaceRoot: root.canonicalPath,
          sizeBytes: source.size,
          sourceMtimeMs: source.mtime,
          sourceCtimeMs: source.ctime,
        });
        return toolSuccess({
          input: {
            input: source.canonicalPath,
            outputDir: paths.outputDir,
            name: paths.chrom,
            workspaceRoot: root.canonicalPath,
          },
        });
      } catch {
        return preparationFailure(
          'GENOME_SOURCE_RESOLUTION_FAILED',
          'The genome source could not be resolved inside an open project.'
        );
      }
    },
  });
}

function preparationFailure(code: string, error: string) {
  return toolFailure({
    code,
    error,
    retriable: false,
    stateChanged: false,
    partialEffects: [],
  });
}
