import type { DiscoveryCandidate } from '../../../shared/discovery-ranking';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentManagedSkill } from '../../../shared/agent-capability-controls';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { execTool as executeTool } from './test-helpers';
import { createSearchSkillsTool } from './search-skills';
import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';

const { listManaged, discover } = vi.hoisted(() => ({ listManaged: vi.fn(), discover: vi.fn() }));

vi.mock('../../../services/discovery-ranking', () => ({ rankDiscoveryCandidates: async () => null }));

vi.mock('../../../platform', () => ({
  platform: () => ({ agentCapabilities: { listManaged, discover } }),
}));

const workspaceFolders: WorkspaceFolder[] = [
  { name: 'project', path: '/workspace/project', addedAt: 1 },
];

const skill = (overrides: Partial<AgentManagedSkill>): AgentManagedSkill => ({
  id: 'primer-review-global',
  name: 'primer-review',
  description: 'Review primer specificity, melting temperature, and product size before ordering.',
  instructions: 'FULL PRIVATE SKILL BODY',
  provider: 'all',
  scope: 'global',
  workspacePath: null,
  directoryPath: '/private/app-data/skills/primer-review-global',
  enabled: true,
  hasSupportingFiles: true,
  origin: 'local',
  source: null,
  contentDigest: null,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

beforeEach(() => {
  discover.mockReset().mockResolvedValue({ snapshotId: 'native-context', controls: [
    ['primer-review-global', 1], ['primer-review-workspace', 2], ['crispr-catalog', 1], ['claude-only', 1],
  ].map(([id, version]) => ({ kind: 'skill', source: `dnaforge-skill:${id}`, sourceVersion: String(version), availability: { state: 'supported' }, stages: { invocable: true } })) });
  listManaged.mockReset().mockImplementation(async ({ workspacePath }) => ({
    commands: [],
    memory: [],
    skills: [
      skill({}),
      skill({
        id: 'crispr-catalog',
        name: 'crispr-guide-audit',
        description: 'Audit CRISPR guide candidates for PAM compatibility and off-target risk.',
        origin: 'catalog',
        source: {
          packId: 'scientific-agent-skills',
          packName: 'Scientific Agent Skills',
          publisher: 'Cadence Scientific',
          repositoryUrl: 'https://example.com/scientific-agent-skills',
          skillPath: 'skills/crispr-guide-audit',
          revision: 'a'.repeat(40),
          version: '1.4.0',
          license: 'MIT',
          additionalLicenses: [],
          compatibility: null,
        },
      }),
      skill({
        id: 'claude-only',
        name: 'claude-protocol-review',
        description: 'Review a laboratory protocol.',
        provider: 'claude-agent-sdk',
      }),
      skill({
        id: 'disabled-skill',
        name: 'disabled-primer-workflow',
        description: 'Disabled primer workflow.',
        enabled: false,
      }),
      ...(workspacePath
        ? [
            skill({
              id: 'primer-review-workspace',
              description: 'Review primers using this project checklist.',
              scope: 'workspace',
              workspacePath,
              updatedAt: 2,
            }),
          ]
        : []),
    ],
  }));
});

describe('search_skills tool', () => {
  it('distinguishes an empty enabled inventory from an unmatched search', async () => {
    const input = { query: 'uvxylophonic', provider: 'codex-sdk' };
    const noMatch = await executeTool(
      createSearchSkillsTool(workspaceFolders),
      input
    );
    expect(noMatch).toMatchObject({ status: 'no-match', count: 0, matches: [] });

    listManaged.mockResolvedValue({ commands: [], memory: [], skills: [
      skill({ enabled: false }),
      skill({ provider: 'claude-agent-sdk' }),
    ] });
    const rank = vi.fn(async () => null);
    const empty = await executeTool(createSearchSkillsTool(workspaceFolders, rank), input);
    expect(empty).toMatchObject({ status: 'no-enabled-skills', count: 0, matches: [] });
    expect(rank).not.toHaveBeenCalled();
  });

  it('returns the global skill context through the public MCP contract without a project', async () => {
    const result = await execTool<{ matches: Array<{ name: string; context: string }> }>(
      createSearchSkillsTool([]),
      { query: 'primer review', provider: 'codex-sdk' }
    );
    expect(result.matches).toContainEqual(expect.objectContaining({
      name: 'primer-review',
      context: 'No workspace',
    }));
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: null }));
  });

  it('lets Jev find semantic matches only among effective enabled skills', async () => {
    const rank = vi.fn(async (_query: string, _candidates: readonly DiscoveryCandidate[]) => [
      'crispr-catalog',
    ]);
    const result = await execTool<{ matches: Array<{ name: string }> }>(
      createSearchSkillsTool(workspaceFolders, rank),
      {
        query: 'ensure Cas9 will cut only the intended locus',
        provider: 'codex-sdk',
      }
    );
    expect(result.matches.map((s) => s.name)).toEqual(['crispr-guide-audit']);
    const descriptors = rank.mock.calls[0]?.[1];
    expect(descriptors).not.toContainEqual(expect.objectContaining({ id: 'disabled-skill' }));
    expect(descriptors).not.toContainEqual(expect.objectContaining({ id: 'claude-only' }));
    expect(descriptors).not.toContainEqual(expect.objectContaining({ id: 'primer-review-global' }));
    expect(JSON.stringify(descriptors)).not.toMatch(/PRIVATE|\/private|directoryPath|instructions/);
  });

  it('preserves an empty Jev result instead of returning weak lexical matches', async () => {
    const result = await execTool<{ matches: unknown[] }>(
      createSearchSkillsTool(workspaceFolders, async () => []),
      {
        query: 'review invoices',
        provider: 'codex-sdk',
      }
    );
    expect(result.matches).toEqual([]);
  });
  it('keeps managed discovery separate from unavailable provider-native capabilities', async () => {
    discover.mockResolvedValue({ snapshotId: 'native-context', controls: [] });
    const result = await execTool<{ matches: unknown[] }>(createSearchSkillsTool(workspaceFolders), { query: 'primer review', provider: 'codex-sdk' });
    expect(result.matches).toHaveLength(1);
  });

  it('blocks global fallback beneath a disabled workspace winner without querying a separate global context', async () => {
    listManaged.mockResolvedValue({ skills: [skill({}), skill({ id: 'disabled-workspace', scope: 'workspace', workspacePath: '/workspace/project', enabled: false })] });
    const result = await execTool<{ count: number; matches: unknown[] }>(createSearchSkillsTool(workspaceFolders), { query: 'primer review', provider: 'codex-sdk' });
    expect(result).toMatchObject({ count: 0, matches: [] });
    expect(listManaged.mock.calls.every(([request]) => request.workspacePath === '/workspace/project')).toBe(true);
  });

  it('returns separately bound effective revisions for two actual folders without changing relevance scoring', async () => {
    const folders = [{ name: 'a', path: '/a', addedAt: 1 }, { name: 'b', path: '/b', addedAt: 2 }];
    listManaged.mockImplementation(async ({ workspacePath }) => ({ skills: [skill({}), skill({ id: workspacePath === '/a' ? 'a' : 'b', scope: 'workspace', workspacePath, updatedAt: workspacePath === '/a' ? 2 : 3 })] }));
    discover.mockImplementation(async ({ workspacePath }) => ({ snapshotId: workspacePath === '/a' ? 'context-a' : 'context-b', controls: [{ kind: 'skill', source: `dnaforge-skill:${workspacePath === '/a' ? 'a' : 'b'}`, sourceVersion: workspacePath === '/a' ? '2' : '3', availability: { state: 'supported' }, stages: { invocable: true } }] }));
    const result = await execTool<{ matches: Array<{ locator: string; context: string }> }>(createSearchSkillsTool(folders), { query: 'primer review', provider: 'codex-sdk' });
    expect(result.matches.map((row) => row.locator).sort()).toEqual(['skill://all/primer-review/SKILL.md?host=codex-sdk&snapshot=context-a&updated=2', 'skill://all/primer-review/SKILL.md?host=codex-sdk&snapshot=context-b&updated=3']);
    expect(result.matches.map((row) => row.context).sort()).toEqual(['Workspace 1', 'Workspace 2']);
    expect(JSON.stringify(result)).not.toContain('/private/app-data');
  });

  it('keeps legitimate inheritance in another folder and ignores another provider override', async () => {
    const folders = [{ name: 'a', path: '/a', addedAt: 1 }, { name: 'b', path: '/b', addedAt: 2 }];
    listManaged.mockImplementation(async ({ workspacePath }) => ({ skills: [skill({}), skill({ id: 'disabled', scope: 'workspace', workspacePath: '/a', enabled: false }), skill({ id: 'other-host', scope: 'workspace', workspacePath, provider: 'claude-agent-sdk', enabled: false })] }));
    discover.mockImplementation(async ({ workspacePath }) => ({ snapshotId: workspacePath === '/a' ? 'context-a' : 'context-b', controls: [{ kind: 'skill', source: 'dnaforge-skill:primer-review-global', sourceVersion: '1', availability: { state: 'supported' }, stages: { invocable: true } }] }));
    const result = await execTool<{ count: number; matches: Array<{ locator: string }> }>(createSearchSkillsTool(folders), { query: 'primer review', provider: 'codex-sdk' });
    expect(result.count).toBe(1); expect(result.matches[0].locator).toContain('snapshot=context-b');
  });

  it('returns bounded relevant metadata and stable locators without skill bodies or private paths', async () => {
    const result = await execTool<{
      ok: true;
      matches: Array<Record<string, unknown>>;
      count: number;
    }>(createSearchSkillsTool(workspaceFolders), {
      query: 'check primer melting temperature before ordering',
      provider: 'codex-sdk',
    });

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.matches).toEqual([
      expect.objectContaining({
        name: 'primer-review',
        description: 'Review primers using this project checklist.',
        source: 'DNAForge local skill',
        availableTo: 'All AI hosts',
        scope: 'This workspace',
        locator: 'skill://all/primer-review/SKILL.md?host=codex-sdk&snapshot=native-context&updated=2',
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('FULL PRIVATE SKILL BODY');
    expect(JSON.stringify(result)).not.toContain('/private/app-data');
  });

  it('preserves catalog provenance in results and filters skills owned by another host', async () => {
    const result = await execTool<{
      matches: Array<Record<string, unknown>>;
    }>(createSearchSkillsTool(workspaceFolders), {
      query: 'CRISPR PAM off target protocol review',
      provider: 'codex-sdk',
    });

    expect(result.matches).toContainEqual(
      expect.objectContaining({
        name: 'crispr-guide-audit',
        source: 'Cadence Scientific · Scientific Agent Skills',
        revision: 'aaaaaaaa',
        locator: 'skill://all/crispr-guide-audit/SKILL.md?host=codex-sdk&snapshot=native-context&updated=1',
      })
    );
    expect(result.matches).not.toContainEqual(
      expect.objectContaining({ name: 'claude-protocol-review' })
    );
    expect(result.matches).not.toContainEqual(
      expect.objectContaining({ name: 'disabled-primer-workflow' })
    );
  });

  it('limits results and returns no arbitrary fallback when nothing matches', async () => {
    const tool = createSearchSkillsTool(workspaceFolders);
    const noMatch = await execTool<{ matches: unknown[]; count: number }>(tool, {
      query: 'quantum accounting invoices',
      provider: 'codex-sdk',
    });
    expect(noMatch).toMatchObject({ ok: true, matches: [], count: 0 });

    const bounded = await execTool<{ matches: unknown[]; count: number }>(tool, {
      query: 'review',
      provider: 'claude-agent-sdk',
      limit: 1,
    });
    expect(bounded.count).toBe(1);
    expect(bounded.matches).toHaveLength(1);
  });
  it('does not send a disabled workspace winner or its shadowed global row to Jev', async () => {
    listManaged.mockResolvedValue({ skills: [skill({}), skill({ id: 'disabled-workspace', scope: 'workspace', workspacePath: '/workspace/project', enabled: false })] });
    const rank = vi.fn(async (_query: string, _candidates: readonly DiscoveryCandidate[]) => []);
    const result = await execTool<{ matches: unknown[] }>(createSearchSkillsTool(workspaceFolders, rank), { query: 'primer review', provider: 'codex-sdk' });
    expect(rank).not.toHaveBeenCalled();
    expect(result.matches).toEqual([]);
  });
  it('ranks one inherited native descriptor once while retaining both admitted real-folder locators', async () => {
    const folders = [{ name: 'a', path: '/a', addedAt: 1 }, { name: 'b', path: '/b', addedAt: 2 }];
    listManaged.mockResolvedValue({ skills: [skill({})] });
    discover.mockImplementation(async ({ workspacePath }) => ({ snapshotId: workspacePath === '/a' ? 'context-a' : 'context-b', controls: [] }));
    const rank = vi.fn(async (_query: string, _candidates: readonly DiscoveryCandidate[]) => ['primer-review-global']);
    const result = await execTool<{ matches: Array<{ locator: string; context: string }> }>(createSearchSkillsTool(folders, rank), { query: 'semantic task', provider: 'codex-sdk' });
    expect(rank.mock.calls[0]![1]).toEqual([{ id: 'primer-review-global', name: 'primer-review', description: skill({}).description }]);
    expect(result.matches.map((row) => row.locator).sort()).toEqual(['skill://all/primer-review/SKILL.md?host=codex-sdk&snapshot=context-a&updated=1', 'skill://all/primer-review/SKILL.md?host=codex-sdk&snapshot=context-b&updated=1']);
    expect(result.matches.map((row) => row.context).sort()).toEqual(['Workspace 1', 'Workspace 2']);
  });
  it('refuses an obsolete snapshot after asynchronous ranking rather than returning a stale approved locator', async () => {
    const rank = async () => { discover.mockResolvedValue({ snapshotId: 'replacement-context', controls: [] }); return ['primer-review-workspace']; };
    await expect(execTool(createSearchSkillsTool(workspaceFolders, rank), { query: 'primer review', provider: 'codex-sdk' })).rejects.toThrow('Skill context changed. Search again.');
  });

  it('preserves semantic-only matches and Jev order opposite the lexical ranking', async () => {
    const rank = vi.fn(async (_query: string, _candidates: readonly DiscoveryCandidate[]) => ['crispr-catalog', 'primer-review-workspace']);
    const result = await execTool<{ matches: Array<{ name: string; locator: string }> }>(createSearchSkillsTool(workspaceFolders, rank), { query: 'primer review', provider: 'codex-sdk' });
    expect(result.matches.map((row) => row.name)).toEqual(['crispr-guide-audit', 'primer-review']);
    expect(result.matches.map((row) => row.locator)).toEqual(['skill://all/crispr-guide-audit/SKILL.md?host=codex-sdk&snapshot=native-context&updated=1', 'skill://all/primer-review/SKILL.md?host=codex-sdk&snapshot=native-context&updated=2']);
    expect(rank).toHaveBeenCalledOnce();
  });

});

import { searchSkillsOutputSchema } from './search-skills';

async function execTool<T>(...args: Parameters<typeof executeTool>): Promise<T> {
  const result = await executeTool<T>(...args);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === true) {
    assertMcpOutput(searchSkillsOutputSchema, result);
  }
  return result;
}
