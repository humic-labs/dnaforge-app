import { z } from 'zod';

import { platform } from '../../../platform';
import { isPathInsideBoundary } from '../../../shared/path-boundary';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { useCanvasStore } from '../../canvas/public/store';
import {
  assemblyIdFromIndexedGenome,
  assemblyReferencesFromIndexedGenome,
} from '../../sequence/public/attach-indexed-bigwig';
import { getUserFolders, resolveMultiRootPath } from '../../workspace/public/path-resolve';
import { isIndexedTab } from './indexed-current-view';

export const managedVariantSourceStartSchema = z
  .object({
    assemblyId: z.string().trim().min(1).max(1024),
    path: z
      .string()
      .min(1)
      .max(4096)
      .describe(
        'A VCF or BCF file inside an open DNAForge project. With multiple projects open, ' +
          'prefix a relative path with the project name.'
      ),
  })
  .strict();

interface PreparedVariantSource {
  readonly assemblyId: string;
  readonly input: {
    readonly variantPath: string;
    readonly references: ReadonlyArray<{ readonly name: string; readonly length: number }>;
  };
}

export function projectManagedVariantSourcePreparation(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
  const value = result as Partial<PreparedVariantSource> & { error?: unknown };
  if (
    typeof value.assemblyId !== 'string' ||
    !value.input ||
    typeof value.input.variantPath !== 'string' ||
    !Array.isArray(value.input.references)
  ) {
    return typeof value.error === 'string' ? { error: value.error } : {};
  }
  return {
    assemblyId: value.assemblyId,
    pathBasename: basename(value.input.variantPath),
    referenceCount: value.input.references.length,
  };
}

export function createPrepareManagedVariantSourceTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Start durable VCF or BCF preparation against a mounted indexed assembly. Returns the ' +
      'managed job immediately so it can be followed in Jobs, the API, the CLI, or agent tools.',
    inputSchema: managedVariantSourceStartSchema,
    execute: async ({ assemblyId, path }) => {
      try {
        const userFolders = getUserFolders(folders);
        if (userFolders.length === 0) {
          return preparationFailure(
            'NO_WORKSPACE',
            'Open a project before starting variant source preparation.'
          );
        }
        const resolved = resolveMultiRootPath(userFolders, path);
        const [source, root] = await Promise.all([
          platform().fs.stat(resolved.absolutePath),
          platform().fs.stat(resolved.folder.path),
        ]);
        if (!source.isFile || !root.isDirectory) {
          return preparationFailure(
            'INVALID_VARIANT_SOURCE',
            'The variant source must be a file inside an open project.'
          );
        }
        if (!isPathInsideBoundary(source.canonicalPath, root.canonicalPath)) {
          return preparationFailure(
            'VARIANT_SOURCE_OUTSIDE_WORKSPACE',
            'The variant source escaped its open project boundary.'
          );
        }

        const referenceSets = Object.values(useCanvasStore.getState().panels).flatMap((panel) =>
          panel.tabs.flatMap((tab) => {
            if (!isIndexedTab(tab)) return [];
            if (assemblyIdFromIndexedGenome(tab.indexedGenome) !== assemblyId) return [];
            const references = assemblyReferencesFromIndexedGenome(tab.indexedGenome);
            return references.length > 0 ? [references] : [];
          })
        );
        if (referenceSets.length === 0) {
          return preparationFailure(
            'VARIANT_ASSEMBLY_NOT_FOUND',
            'No mounted indexed assembly matches that identity with complete references.'
          );
        }
        const references = referenceSets[0];
        const signature = JSON.stringify(references);
        if (referenceSets.some((candidate) => JSON.stringify(candidate) !== signature)) {
          return preparationFailure(
            'VARIANT_ASSEMBLY_AMBIGUOUS',
            'Mounted assemblies with that identity disagree about chromosome names or lengths.'
          );
        }
        return toolSuccess({
          assemblyId,
          input: {
            variantPath: source.canonicalPath,
            references,
          },
        });
      } catch {
        return preparationFailure(
          'VARIANT_SOURCE_RESOLUTION_FAILED',
          'The variant source could not be resolved inside an open project.'
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
