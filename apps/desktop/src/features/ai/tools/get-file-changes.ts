   
                                                                           
  
                                                                     
                                             
   

import { resultTool, toolSuccess, toolFailure } from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import { uniquelyNamedProjectRoot } from '../../../shared/project-root-selection';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { gitStatus, gitLog, gitDiffStat, isGitRepo } from '../../workspace/public/git';

export function getFileChangesSchemaForFolders(folders: WorkspaceFolder[]) {
  return z
    .object({
      includeLog: z.boolean().optional().default(true).describe('Include recent commit log'),
      includeDiff: z.boolean().optional().default(true).describe('Include diff stats'),
      folder: z
        .string()
        .optional()
        .describe(
          folders.length > 1
            ? 'Folder name to scope git status to. Omit to report across all folders.'
            : 'Not needed when one project is open.'
        ),
    })
    .strict();
}

export const getFileChangesSchema = getFileChangesSchemaForFolders([]);

const gitFolderResultSchema = z.discriminatedUnion('tracked', [
  z.object({folder: z.string(), tracked: z.literal(false), error: z.string()}),
  z.object({folder: z.string(), tracked: z.literal(true),
    changedFiles: z.array(z.object({path: z.string(), status: z.string()})), changeCount: z.number().int().nonnegative(),
    recentCommits: z.array(z.object({hash: z.string(), subject: z.string()})).optional(),
    diffStat: z.object({filesChanged: z.number().int().nonnegative(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative()}).optional(),
  }),
]);
export const getFileChangesOutputSchema = z.union([
  gitFolderResultSchema.options[0].extend({ok: z.literal(true)}),
  gitFolderResultSchema.options[1].extend({ok: z.literal(true)}),
  z.object({ok: z.literal(true), folders: z.array(gitFolderResultSchema)}),
]);
type GitFolderResult = z.infer<typeof gitFolderResultSchema>;

export function createGetFileChangesTool(folders: WorkspaceFolder[]) {
  const inputSchema = getFileChangesSchemaForFolders(folders);

  return resultTool({
    description:
      'Get git status and recent changes for open projects. ' +
      'Shows modified/added/deleted files and recent commit history.' +
      (folders.length > 1 ? ' Optionally specify a folder name to scope results.' : ''),
    inputSchema: inputSchema as z.ZodTypeAny,
    execute: async ({
      includeLog,
      includeDiff,
      folder: folderName,
    }: z.infer<typeof inputSchema>) => {
      try {
                                           
        let targetFolders: WorkspaceFolder[];
        if (folderName) {
          const matched = uniquelyNamedProjectRoot(folders, folderName);
          if (!matched) {
            const names = folders.map((f) => `"${f.name}"`).join(', ');
            return {
              ...toolFailure({code: 'PROJECT_NOT_FOUND', error: `Project \"${folderName}\" was not found or is ambiguous. Available projects: ${names}`, retriable: false, stateChanged: false, partialEffects: []}),
              error: `Project "${folderName}" was not found or is ambiguous. Available projects: ${names}`,
              tracked: false,
            };
          }
          targetFolders = [matched];
        } else {
          targetFolders = folders;
        }

        const results: GitFolderResult[] = [];

        for (const f of targetFolders) {
          const isRepo = await isGitRepo(f.path);
          if (!isRepo) {
            results.push({
              folder: f.name,
              tracked: false,
              error: `"${f.name}" is not git-tracked`,
            });
            continue;
          }

          const status = await gitStatus(f.path);
          const statusEntries = Array.from(status.entries()).map(([path, state]) => ({
            path,
            status: state,
          }));

          const folderResult: Extract<GitFolderResult, {tracked: true}> = {
            folder: f.name,
            tracked: true,
            changedFiles: statusEntries,
            changeCount: statusEntries.length,
          };

          if (includeLog) {
            const logOutput = await gitLog(f.path);
            folderResult.recentCommits = logOutput
              .split('\n')
              .filter((l: string) => l.trim())
              .map((l: string) => {
                const spaceIdx = l.indexOf(' ');
                return {
                  hash: spaceIdx > 0 ? l.slice(0, spaceIdx) : l,
                  subject: spaceIdx > 0 ? l.slice(spaceIdx + 1) : '',
                };
              });
          }
          if (includeDiff) {
            const diffOutput = await gitDiffStat(f.path);
            const summaryMatch = diffOutput.match(
              /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/
            );
            folderResult.diffStat = summaryMatch
              ? {
                  filesChanged: parseInt(summaryMatch[1] || '0'),
                  additions: parseInt(summaryMatch[2] || '0'),
                  deletions: parseInt(summaryMatch[3] || '0'),
                }
              : { filesChanged: 0, additions: 0, deletions: 0 };
          }

          results.push(folderResult);
        }

                                                                  
        if (results.length === 1) {
          return toolSuccess(results[0]);
        }

        return toolSuccess({ folders: results });
      } catch (err) {
        return {
          ...toolFailure({code: 'GIT_STATUS_FAILED', error: err instanceof Error ? err.message : String(err), retriable: false, stateChanged: false, partialEffects: []}),
          error: `Failed to get file changes: ${err instanceof Error ? err.message : String(err)}`,
          tracked: false,
        };
      }
    },
  });
}
