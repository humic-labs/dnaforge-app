import { z } from 'zod';

import { platform } from '../../../platform';
import { isPathInsideBoundary } from '../../../shared/path-boundary';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { getUserFolders, resolveMultiRootPath } from '../../workspace/public/path-resolve';

export const managedAlignmentIndexStartSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .describe(
        'A BAM or CRAM file inside an open DNAForge project. With multiple projects open, ' +
          'prefix a relative path with the project name.'
      ),
  })
  .strict();

interface PreparedAlignmentIndex {
  readonly input: { readonly bamPath: string };
}

export function projectManagedAlignmentIndexPreparation(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
  const value = result as Partial<PreparedAlignmentIndex> & { error?: unknown };
  if (!value.input || typeof value.input.bamPath !== 'string') {
    return typeof value.error === 'string' ? { error: value.error } : {};
  }
  return { input: { basename: basename(value.input.bamPath) } };
}

export function createPrepareManagedAlignmentIndexTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Start durable index preparation for a BAM or CRAM file inside an open project. ' +
      'Returns the managed job immediately so it can be followed in Jobs, the API, the CLI, ' +
      'or agent tools.',
    inputSchema: managedAlignmentIndexStartSchema,
    execute: async ({ path }) => {
      try {
        const userFolders = getUserFolders(folders);
        if (userFolders.length === 0) {
          return preparationFailure(
            'NO_WORKSPACE',
            'Open a project before starting alignment index preparation.'
          );
        }
        const resolved = resolveMultiRootPath(userFolders, path);
        const [source, root] = await Promise.all([
          platform().fs.stat(resolved.absolutePath),
          platform().fs.stat(resolved.folder.path),
        ]);
        if (!source.isFile || !root.isDirectory) {
          return preparationFailure(
            'INVALID_ALIGNMENT_SOURCE',
            'The alignment source must be a file inside an open project.'
          );
        }
        if (!isPathInsideBoundary(source.canonicalPath, root.canonicalPath)) {
          return preparationFailure(
            'ALIGNMENT_SOURCE_OUTSIDE_WORKSPACE',
            'The alignment source escaped its open project boundary.'
          );
        }
        return toolSuccess({ input: { bamPath: source.canonicalPath } });
      } catch {
        return preparationFailure(
          'ALIGNMENT_SOURCE_RESOLUTION_FAILED',
          'The alignment source could not be resolved inside an open project.'
        );
      }
    },
  });
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
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
