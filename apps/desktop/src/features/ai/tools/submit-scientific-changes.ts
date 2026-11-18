import { z } from 'zod';
import { parseWorkspaceIdentity } from '@waypoint/domain-services';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { platform } from '../../../platform';
import { resolveWorkspaceScope } from '../../../db/workspace-catalog';
import { resolveExplicitProjectRoot } from '../../../shared/project-root-selection';
import { submitScientificChangesSchema } from '../../../shared/scientific-file-submission';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { getUserFolders } from './path-utils';

export { submitScientificChangesSchema };

export function createSubmitScientificChangesTool(folders: WorkspaceFolder[], operationId: string) {
  return resultTool({
    description:
      'Submit the complete scientific identity map and its native files from current working data, or from one immutable Git commit, through the existing atomic acceptance owner. For an unenrolled project with no authored map, explicitly set initializeEmptyNamespace:true with expectedHead:null and no gitCommit to set up versioned designs; this does not enroll legacy files or create DNA. Working file writes and Git commits alone do not change accepted scientific state. Read list_scientific_objects for expectedHead first. Acceptance, conflicts and file delivery are reported separately; never replace an operation ID merely to hide an unresolved outcome.',
    inputSchema: submitScientificChangesSchema,
    execute: async (input: z.infer<typeof submitScientificChangesSchema>, context) => {
      let attempted = false;
      try {
        const roots = getUserFolders(folders);
        const project = input.workspace
          ? resolveExplicitProjectRoot(roots, input.workspace)
          : roots.length === 1
            ? roots[0]
            : undefined;
        if (!project)
          throw new Error(
            'Select one open project, providing workspace when multiple projects are open.'
          );
        const scope = await resolveWorkspaceScope(project.path);
        if (!scope) throw new Error('The owning project identity is unavailable.');
        context.abortSignal?.throwIfAborted();
        attempted = true;
        const source = input.initializeEmptyNamespace
          ? { kind: 'initialize-empty-namespace' as const }
          : input.gitCommit
            ? { kind: 'git-commit' as const, commit: input.gitCommit }
            : { kind: 'working-files' as const };
        const result = await platform().scientificObjects.submit({
          workspaceRoot: project.path,
          request: {
            workspace: parseWorkspaceIdentity(scope),
            operationId,
            expectedHead: input.expectedHead,
            source,
          },
        });
        if (result.receipt.outcome === 'conflict' || result.receipt.outcome === 'rejected')
          return toolFailure({
            code:
              result.receipt.outcome === 'conflict'
                ? 'SCIENTIFIC_SUBMISSION_CONFLICT'
                : 'SCIENTIFIC_SUBMISSION_REJECTED',
            error:
              'The complete batch was not accepted. Inspect the receipt and preserve working edits before resolving it.',
            retriable: false,
            stateChanged: false,
            partialEffects: [],
            details: {
              operationId,
              receipt: result.receipt,
              currentHead: result.currentHead,
              replayed: result.replayed,
            },
          });
        return toolSuccess({
          accepted: true,
          operationId,
          replayed: result.replayed,
          receipt: result.receipt,
          currentHead: result.currentHead,
          delivery: result.delivery,
          source,
        });
      } catch (error) {
        return toolFailure({
          code: 'SCIENTIFIC_SUBMISSION_FAILED',
          error: error instanceof Error ? error.message : String(error),
          retriable: false,
          stateChanged: attempted ? 'unknown' : false,
          partialEffects: [],
          details: {
            operationId,
            instruction: attempted
              ? 'Inspect accepted state and this original operation before repeating the submission.'
              : 'No submission was started.',
          },
        });
      }
    },
  });
}
