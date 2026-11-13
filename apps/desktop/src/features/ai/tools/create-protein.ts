import { resultTool, toolSuccess, toolFailure } from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resolveExplicitProjectRoot } from '../../../shared/project-root-selection';
import {
  normalizeProteinSequence,
  proteinSequenceValidationError,
} from '../../lims/public/protein-sequence';
import { recordProtein, type RecordProteinInput } from '../../proteins/public/record-proteins';
import { getUserFolders, resolveWorkspacePath } from './path-utils';

const optionalWorkspaceSchema = z
  .string()
  .min(1)
  .describe(
    'Optional exact name or absolute path of an open project. Omit this when one user project is open.'
  )
  .optional();

export const createProteinSchema = z
  .object({
    name: z.string().min(1).max(200),
    sequence: z
      .string()
      .min(1)
      .max(5_000_000)
      .describe('Amino-acid sequence using the 20 standard one-letter codes, X, or *.'),
    destinationPath: z
      .string()
      .min(1)
      .max(2000)
      .default('proteins')
      .describe('Project-relative destination folder. Defaults to proteins.'),
    workspace: optionalWorkspaceSchema,
    organism: z.string().max(500).optional(),
    sourceCds: z.string().max(2000).optional(),
    notes: z.string().max(10_000).optional(),
  })
  .strict();

export interface CreateProteinDependencies {
  recordProtein(input: RecordProteinInput): ReturnType<typeof recordProtein>;
}

const defaultDependencies: CreateProteinDependencies = { recordProtein };

   
                                                                              
                                                                            
                                                                     
   
export function createCreateProteinTool(
  folders: WorkspaceFolder[],
  dependencies: CreateProteinDependencies = defaultDependencies
) {
  const inputSchema =
    getUserFolders(folders).length === 1
      ? createProteinSchema.omit({ workspace: true })
      : createProteinSchema;
  return resultTool({
    description:
      'Create a standalone file-authoritative protein package from an amino-acid sequence. ' +
      'The same package writer backs the human Protein Create and protein import workflows; ' +
      'Registry is rebuilt from the package and is never the source of truth. When exactly one ' +
      'project is open, it is selected automatically and the project selector is intentionally unavailable.',
    inputSchema: inputSchema as z.ZodTypeAny,
    execute: async (input: z.infer<typeof createProteinSchema>) => {
      let mutationAttempted = false;
      try {
        const workspaceRoot = selectWorkspaceRoot(folders, input.workspace);
        const sequence = normalizeProteinSequence(input.sequence);
        const validationError = proteinSequenceValidationError(sequence);
        if (validationError) throw new Error(validationError);
        const destinationDir = resolveWorkspacePath(
          workspaceRoot,
          input.destinationPath ?? 'proteins'
        );
        mutationAttempted = true;
        const saved = await dependencies.recordProtein({
          name: input.name,
          sequence,
          workspaceRoot,
          dir: destinationDir,
          ...(input.organism ? { organism: input.organism } : {}),
          ...(input.sourceCds ? { sourceCds: input.sourceCds } : {}),
          ...(input.notes ? { notes: input.notes } : {}),
          actor: 'agent',
        });
        return toolSuccess({
          changed: true,
          proteinId: saved.limsEntity.id,
          name: input.name.trim(),
          sequenceLength: sequence.length,
          artifactPath: saved.artifactPath,
          registryEntityId: saved.limsEntity.id,
          gitCommitted: saved.gitCommitted,
        });
      } catch (error) {
        return {
          ...toolFailure({
            code: 'PROTEIN_MUTATION_FAILED',
            error: error instanceof Error ? error.message : String(error),
            retriable: false,
            stateChanged: mutationAttempted ? 'unknown' : false,
            partialEffects: [],
          }),
          changed: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

function selectWorkspaceRoot(folders: WorkspaceFolder[], requestedWorkspace?: string): string {
  const userFolders = getUserFolders(folders);
  const selected = requestedWorkspace
    ? resolveExplicitProjectRoot(userFolders, requestedWorkspace)
    : userFolders.length === 1
      ? userFolders[0]
      : undefined;
  if (!selected) {
    throw new Error(
      requestedWorkspace
        ? `Project not found or ambiguous: ${requestedWorkspace}`
        : userFolders.length === 0
          ? 'No project is open.'
          : 'Multiple projects are open; provide the project name.'
    );
  }
  return selected.path;
}
