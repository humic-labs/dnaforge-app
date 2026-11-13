import { z } from 'zod';
import { matchScore } from './skill-relevance';
import { rankDiscoveryCandidates } from '../../../services/discovery-ranking';
import type { DiscoveryRanker } from '../../../shared/discovery-ranking';

import { platform } from '../../../platform';
import { managedSkillLocator, selectManagedSkills, type AgentManagedSkill } from '../../../shared/agent-capability-controls';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { getUserFolders } from './path-utils';

const PROVIDERS = ['codex-sdk', 'claude-agent-sdk', 'grok-acp'] as const;
const DEFAULT_LIMIT = 8;
export const SEARCH_SKILLS_DESCRIPTION =
  'Search enabled DNAForge-managed skills on demand. Supply query (the task description) and provider (codex-sdk, claude-agent-sdk, or grok-acp for the current AI route), with optional limit. For Codex CLI use provider: "codex-sdk". Returns bounded descriptions, provenance, and current skill:// locators for the requested host and workspace, never skill bodies or private paths. Read a selected locator with read_file before applying it.';

export { searchSkillsOutputSchema } from './search-skills-output';

export const searchSkillsSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(2)
      .max(500)
      .describe('A concise description of the task or specialized workflow that may help.'),
    provider: z
      .enum(PROVIDERS)
      .describe(
        'The current AI route: codex-sdk for Codex CLI, claude-agent-sdk for Claude Code, or grok-acp for Grok Build. This is not the desktop application name.'
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(12)
      .optional()
      .describe('Maximum number of relevant matches to return. Defaults to 8.'),
  })
  .strict();

function providerLabel(provider: AgentManagedSkill['provider']): string {
  if (provider === 'all') return 'All AI hosts';
  if (provider === 'codex-sdk') return 'Codex CLI';
  if (provider === 'claude-agent-sdk') return 'Claude Code';
  return 'Grok Build';
}

export function createSearchSkillsTool(
  folders: WorkspaceFolder[],
  rank: DiscoveryRanker = rankDiscoveryCandidates
) {
  return resultTool({
    description: SEARCH_SKILLS_DESCRIPTION,
    inputSchema: searchSkillsSchema,
    execute: async ({ query, provider, limit = DEFAULT_LIMIT }, { abortSignal }) => {
      const workspacePaths = getUserFolders(folders).map((folder) => folder.path);


      const contexts: Array<string | null> = workspacePaths.length ? [...new Set(workspacePaths)] : [null];
      const contextSnapshots: Array<{ workspacePath: string | null; snapshotId: string }> = [];
      const discovered: Array<{ skill: AgentManagedSkill; snapshotId: string; workspaceIndex: number | null }> = [];
      for (const [index, workspacePath] of contexts.entries()) {
        const [managed, snapshot] = await Promise.all([
          platform().agentCapabilities.listManaged({ workspacePath, conversationId: null }),
          platform().agentCapabilities.discover({ provider, workspacePath, conversationId: null }),
        ]);
        const current = await platform().agentCapabilities.discover({ provider, workspacePath, conversationId: null });
        if (current.snapshotId !== snapshot.snapshotId) throw new Error('Skill context changed. Search again.');
        contextSnapshots.push({ workspacePath, snapshotId: snapshot.snapshotId });
        for (const skill of selectManagedSkills(managed.skills, provider, workspacePath).filter((skill) => skill.enabled)) {
          discovered.push({ skill, snapshotId: snapshot.snapshotId, workspaceIndex: workspacePath === null ? null : index });
        }
      }

      abortSignal?.throwIfAborted();


      const uniqueSkills = [...new Map(discovered.map(({ skill }) => [skill.id, skill])).values()];
      const ids = await rank(query, uniqueSkills.map(({ id, name, description }) => ({ id, name, description })), abortSignal);
      abortSignal?.throwIfAborted();


      for (const expected of contextSnapshots) {
        const current = await platform().agentCapabilities.discover({ provider, workspacePath: expected.workspacePath, conversationId: null });
        if (current.snapshotId !== expected.snapshotId) throw new Error('Skill context changed. Search again.');
      }
      abortSignal?.throwIfAborted();
      const ranked = ids === null
        ? discovered
            .map((entry) => ({ ...entry, score: matchScore(entry.skill, query) }))
            .filter(({ score }) => score > 0)
            .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name) || left.skill.id.localeCompare(right.skill.id))
        : ids.flatMap((id) => discovered.filter(({ skill }) => skill.id === id));
      const matches = ranked
        .slice(0, limit)
        .map(({ skill, snapshotId, workspaceIndex }) => ({
          name: skill.name,
          description: skill.description,
          source: skill.source
            ? `${skill.source.publisher} · ${skill.source.packName}`
            : 'DNAForge local skill',
          ...(skill.source
            ? {
                revision: skill.source.revision.slice(0, 8),
                ...(skill.source.version ? { version: skill.source.version } : {}),
                license: skill.source.license,
              }
            : {}),
          availableTo: providerLabel(skill.provider),
          scope: skill.scope === 'workspace' ? 'This workspace' : 'All workspaces',
          context: workspaceIndex === null ? 'No workspace' : `Workspace ${workspaceIndex + 1}`,
          locator: managedSkillLocator(skill, { provider, snapshotId }),
        }));

      return toolSuccess({ query, count: matches.length, matches });
    },
  });
}
