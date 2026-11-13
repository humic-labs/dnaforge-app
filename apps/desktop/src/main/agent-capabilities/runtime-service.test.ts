import { describe, expect, it, vi } from 'vitest';

vi.mock('../analytics', () => ({
  captureOptionalTelemetryOrigin: () => null,
  enqueueOptionalAnalyticsEvent: () => false,
  enqueueOptionalAnalyticsEventFromReceipt: () => false,
}));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/dnaforge-test' } }));

import type { AgentManagedSkill } from '../../shared/agent-capability-controls';
import {
  appOwnedControls,
  applyProviderSkillPolicies,
  automaticSkillsForProvider,
  buildAutomaticSkillDiscoveryInstructions,
  managedSkillsForProvider,
  managedSkillInstructions,
  nativeSkillPolicyFromSnapshot,
} from './runtime-service';

const skill: AgentManagedSkill = {
  id: 'skill-1',
  name: 'primer-review',
  description: 'Review primer designs.',
  instructions: 'Follow the checklist in references/checklist.md.',
  provider: 'all',
  scope: 'workspace',
  workspacePath: '/workspace',
  directoryPath: '/app-data/skills/skill-1',
  enabled: true,
  hasSupportingFiles: true,
  origin: 'local',
  source: null,
  contentDigest: null,
  createdAt: 1,
  updatedAt: 1,
};

describe('managed skill runtime projection', () => {
  it('uses the same disabled workspace winner for discovery and automatic instructions without global fallback', async () => {
    const global = {
      ...skill,
      id: 'global',
      scope: 'global' as const,
      workspacePath: null,
      enabled: true,
    };
    const disabled = { ...skill, enabled: false };
    const store = { list: vi.fn(async () => ({ commands: [], skills: [global, disabled] })) };
    const controls = await appOwnedControls(
      store,
      { list: vi.fn(async () => ({ memory: [] })) },
      'codex-sdk',
      { workspacePath: '/workspace', conversationId: null, forceRefresh: false }
    );
    expect(controls.filter((control) => control.kind === 'skill')).toEqual([
      expect.objectContaining({
        source: 'dnaforge-skill:skill-1',
        sourceVersion: '1',
        availability: { state: 'disabled-by-policy', reason: 'This DNAForge skill is disabled.' },
        stages: expect.objectContaining({ invocable: false }),
      }),
    ]);
    expect(automaticSkillsForProvider([global, disabled], 'codex-sdk', '/workspace')).toEqual([]);
    expect(automaticSkillsForProvider([global, disabled], 'codex-sdk', '/other')).toEqual([global]);
  });

  it('does not advertise legacy prompt shortcuts as agent actions', async () => {
    const controls = await appOwnedControls(
      {
        list: vi.fn(async () => ({
          commands: [
            {
              id: 'command-1',
              name: 'review-primers',
              description: 'Review primers.',
              instructions: 'Review this primer pair.',
              provider: 'all' as const,
              scope: 'global' as const,
              workspacePath: null,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          skills: [],
        })),
      },
      { list: vi.fn(async () => ({ memory: [] })) },
      'codex-sdk',
      { workspacePath: '/workspace', conversationId: null, forceRefresh: false }
    );

    expect(controls).not.toContainEqual(expect.objectContaining({ kind: 'custom-command' }));
    expect(controls).not.toContainEqual(expect.objectContaining({ nativeId: 'review-primers' }));
  });

  it('discovers a saved skill as an invocable action with its supporting-file effect', async () => {
    const controls = await appOwnedControls(
      { list: vi.fn(async () => ({ commands: [], skills: [skill] })) },
      { list: vi.fn(async () => ({ memory: [] })) },
      'claude-agent-sdk',
      { workspacePath: '/workspace', conversationId: null, forceRefresh: false }
    );

    expect(controls).toContainEqual(
      expect.objectContaining({
        nativeId: 'primer-review',
        kind: 'skill',
        effects: ['instructions', 'filesystem-read'],
        availability: { state: 'supported' },
        stages: expect.objectContaining({ invocable: true, visible: true }),
        source: 'dnaforge-skill:skill-1',
      })
    );
  });

  it('labels an explicit selection as a pin instead of the normal discovery path', () => {
    expect(managedSkillInstructions(skill)).toContain(skill.instructions);
    expect(managedSkillInstructions(skill)).toContain('skill://all/primer-review/');
    expect(managedSkillInstructions(skill)).not.toContain(skill.directoryPath);
    expect(managedSkillInstructions(skill)).toContain('pinned');
    expect(managedSkillInstructions(skill).toLowerCase()).not.toContain('user explicitly selected');
  });

  it('offers a host only shared skills and skills assigned to that host', () => {
    const codexOnly = {
      ...skill,
      id: 'codex-only',
      name: 'codex-only',
      provider: 'codex-sdk' as const,
    };
    const claudeOnly = {
      ...skill,
      id: 'claude-only',
      name: 'claude-only',
      provider: 'claude-agent-sdk' as const,
    };

    expect(managedSkillsForProvider([skill, codexOnly, claudeOnly], 'codex-sdk')).toEqual([
      skill,
      codexOnly,
    ]);
    expect(
      automaticSkillsForProvider(
        [
          { ...skill, updatedAt: 100 },
          { ...codexOnly, name: skill.name, updatedAt: 1 },
          claudeOnly,
        ],
        'codex-sdk'
      )
    ).toEqual([{ ...codexOnly, name: skill.name, updatedAt: 1 }]);
  });

  it('advertises on-demand skill discovery without injecting the library index or skill bodies', () => {
    const instructions = buildAutomaticSkillDiscoveryInstructions([
      {
        ...skill,
        id: 'global-primer-review',
        scope: 'global',
        workspacePath: null,
        description: 'Use the global primer review.',
      },
      skill,
      {
        ...skill,
        id: 'disabled-sequence-audit',
        name: 'sequence-audit',
        description: 'Audit a DNA sequence.',
        enabled: false,
      },
    ]);

    expect(instructions).toContain('search_skills');
    expect(instructions).toContain('query');
    expect(instructions).toContain('provider');
    expect(instructions).toContain('codex-sdk');
    expect(instructions).toContain('claude-agent-sdk');
    expect(instructions).toContain('grok-acp');
    expect(instructions).toContain('read_file');
    expect(instructions).toContain('exact skill:// locator returned by search_skills');
    expect(instructions).not.toContain('/app-data/skills/skill-1');
    expect(instructions).not.toContain('Use the global primer review.');
    expect(instructions).not.toContain('sequence-audit');
    expect(instructions).not.toContain('primer-review');
    expect(instructions).not.toContain('Review primer designs.');
    expect(instructions).not.toContain(skill.instructions);
    expect(Buffer.byteLength(instructions ?? '', 'utf8')).toBeLessThan(1_000);
  });

  it('does not leak catalog provenance into every prompt', () => {
    const instructions = buildAutomaticSkillDiscoveryInstructions([
      {
        ...skill,
        id: 'catalog-scientific-writing',
        name: 'scientific-writing',
        description: 'Plan and draft a scientific manuscript.',
        origin: 'catalog',
        source: {
          packId: 'k-dense-scientific-agent-skills',
          packName: 'Scientific Agent Skills',
          publisher: 'K-Dense AI',
          repositoryUrl: 'https://github.com/K-Dense-AI/scientific-agent-skills',
          skillPath: 'skills/scientific-writing',
          revision: 'a'.repeat(40),
          version: '1.0.0',
          license: 'MIT',
          additionalLicenses: [],
          compatibility: null,
        },
      },
    ]);

    expect(instructions).toContain('search_skills');
    expect(instructions).not.toContain('scientific-writing');
    expect(instructions).not.toContain('K-Dense AI');
    expect(instructions).not.toContain('aaaaaaaa');
  });

  it('keeps prompt cost constant even when hundreds of skills are enabled', () => {
    const skills = Array.from({ length: 500 }, (_, index) => ({
      ...skill,
      id: `skill-${String(index).padStart(2, '0')}`,
      name: `skill-${String(index).padStart(2, '0')}`,
      description: `Description ${index} ${'x'.repeat(80)}`,
      directoryPath: `/app-data/skills/skill-${index}`,
      scope: 'global' as const,
      workspacePath: null,
    }));

    const first = buildAutomaticSkillDiscoveryInstructions([...skills].reverse());
    const second = buildAutomaticSkillDiscoveryInstructions(skills);
    expect(first).toBe(second);
    expect(Buffer.byteLength(first ?? '', 'utf8')).toBeLessThan(1_000);
    expect(first).not.toContain('skill-000');
    expect(first).not.toContain('skill-499');
  });

  it('uses the same on-demand discovery contract for Grok without listing names', () => {
    const instructions = buildAutomaticSkillDiscoveryInstructions([skill]);

    expect(instructions).toContain('search_skills');
    expect(instructions).toContain('read_file');
    expect(instructions).not.toContain('primer-review');
    expect(instructions).toContain('skill://');
  });

  it('adds no skill-discovery prompt when no enabled managed skills exist', () => {
    expect(buildAutomaticSkillDiscoveryInstructions([])).toBeNull();
    expect(buildAutomaticSkillDiscoveryInstructions([{ ...skill, enabled: false }])).toBeNull();
  });

  it('keeps a disabled skill visible but not invocable', async () => {
    const controls = await appOwnedControls(
      { list: vi.fn(async () => ({ commands: [], skills: [{ ...skill, enabled: false }] })) },
      { list: vi.fn(async () => ({ memory: [] })) },
      'codex-sdk',
      { workspacePath: '/workspace', conversationId: null, forceRefresh: false }
    );

    expect(controls).toContainEqual(
      expect.objectContaining({
        nativeId: 'primer-review',
        availability: { state: 'disabled-by-policy', reason: 'This DNAForge skill is disabled.' },
        stages: expect.objectContaining({ invocable: false, visible: true }),
      })
    );
  });

  it('applies a workspace DNAForge policy to provider-owned skills without hiding ownership', async () => {
    const controls = await applyProviderSkillPolicies(
      {
        listProviderSkillPolicies: vi.fn(async () => [
          {
            id: 'policy-global',
            provider: 'codex-sdk' as const,
            nativeId: 'native-primer-review',
            scope: 'global' as const,
            workspacePath: null,
            enabled: true,
            updatedAt: 1,
          },
          {
            id: 'policy-workspace',
            provider: 'codex-sdk' as const,
            nativeId: 'native-primer-review',
            scope: 'workspace' as const,
            workspacePath: '/workspace',
            enabled: false,
            updatedAt: 2,
          },
        ]),
      },
      'codex-sdk',
      '/workspace',
      [
        {
          nativeId: 'native-primer-review',
          kind: 'skill',
          label: 'native-primer-review',
          description: 'Provider-owned primer review.',
          scope: 'installation',
          effects: ['instructions'],
          availability: { state: 'supported' },
          stages: {
            advertised: true,
            discoverable: true,
            invocable: true,
            visible: true,
            deterministic: true,
            liveQualified: false,
          },
          source: 'codex-skills-list',
        },
      ]
    );

    expect(controls).toEqual([
      expect.objectContaining({
        nativeId: 'native-primer-review',
        source: 'codex-skills-list',
        availability: {
          state: 'disabled-by-policy',
          reason: 'This CLI skill is disabled in DNAForge for the current workspace.',
        },
        stages: expect.objectContaining({ invocable: false, visible: true }),
        dnaforgePolicy: { enabled: false, scope: 'workspace' },
      }),
    ]);
  });

  it('projects enabled and DNAForge-disabled native skills into the turn policy', () => {
    const common = {
      provider: 'claude-agent-sdk' as const,
      kind: 'skill' as const,
      label: 'skill',
      description: 'A native skill.',
      scope: 'installation' as const,
      effects: ['instructions' as const],
      stages: {
        advertised: true,
        discoverable: true,
        invocable: true,
        visible: true,
        deterministic: true,
        liveQualified: false,
      },
    };
    const result = nativeSkillPolicyFromSnapshot({
      schemaVersion: 1,
      snapshotId: 'snapshot-1',
      provider: 'claude-agent-sdk',
      providerVersion: '2.1.265',
      accountFingerprint: null,
      workspaceFingerprint: null,
      capturedAt: 1,
      controls: [
        {
          ...common,
          id: 'claude-agent-sdk:skill:primer-review',
          nativeId: 'primer-review',
          availability: { state: 'supported' },
          dnaforgePolicy: { enabled: true, scope: 'installation' },
          source: 'claude-supportedSkills',
        },
        {
          ...common,
          id: 'claude-agent-sdk:skill:old-review',
          nativeId: 'old-review',
          availability: { state: 'disabled-by-policy', reason: 'Disabled in DNAForge.' },
          stages: { ...common.stages, invocable: false },
          dnaforgePolicy: { enabled: false, scope: 'workspace' },
          source: 'claude-supportedSkills',
        },
        {
          ...common,
          id: 'claude-agent-sdk:skill:app-skill',
          nativeId: 'app-skill',
          availability: { state: 'supported' },
          dnaforgePolicy: { enabled: true, scope: 'installation' },
          source: 'dnaforge-skill:managed-1',
        },
      ],
    });

    expect(result).toEqual({
      enabledNativeSkillIds: ['primer-review'],
      disabledNativeSkillIds: ['old-review'],
    });
  });
});
