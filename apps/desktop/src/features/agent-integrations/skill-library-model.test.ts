// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type {
  AgentCapabilityControl,
  AgentCapabilitySnapshot,
  AgentManagedSkill,
} from '../../shared/agent-capability-controls';
import {
  buildDiscoveredBiologyPlugins,
  buildInstalledSkillRows,
  normalizeCapabilitySearchText,
} from './skill-library-model';

const managedSkill: AgentManagedSkill = {
  id: 'managed-sequence-audit',
  name: 'sequence-audit',
  description: 'Audit a biological sequence.',
  instructions: 'Inspect every sequence region.',
  provider: 'all',
  scope: 'global',
  workspacePath: null,
  directoryPath: '/dnaforge/skills/sequence-audit',
  enabled: true,
  hasSupportingFiles: false,
  origin: 'catalog',
  source: {
    packId: 'bioconductor',
    packName: 'Bioconductor AI Agent Skills',
    publisher: 'Bioconductor',
    repositoryUrl: 'https://github.com/Bioconductor/ai-agent-skills',
    skillPath: 'skills/sequence-audit',
    revision: 'a'.repeat(40),
    version: '1.0.0',
    license: 'MIT',
    additionalLicenses: [],
    compatibility: null,
  },
  contentDigest: 'b'.repeat(64),
  createdAt: 1,
  updatedAt: 1,
};

function nativeSkill(
  provider: AgentCapabilitySnapshot['provider'],
  enabled = true
): AgentCapabilityControl {
  return {
    id: `${provider}:skill:sequence-audit`,
    provider,
    nativeId: 'sequence-audit',
    kind: 'skill',
    label: 'sequence-audit',
    description: 'Audit a biological sequence.',
    scope: 'installation',
    effects: ['instructions'],
    availability: enabled
      ? { state: 'supported' }
      : { state: 'disabled-by-policy', reason: 'Disabled in DNAForge.' },
    stages: {
      advertised: true,
      discoverable: true,
      invocable: enabled,
      visible: true,
      deterministic: true,
      liveQualified: false,
    },
    source: `/runtime/${provider}/skills/sequence-audit/SKILL.md`,
    dnaforgePolicy: { enabled, scope: 'installation' },
  };
}

function snapshot(
  provider: AgentCapabilitySnapshot['provider'],
  controls: AgentCapabilityControl[]
): AgentCapabilitySnapshot {
  return {
    schemaVersion: 1,
    snapshotId: `snapshot-${provider}`,
    provider,
    providerVersion: '1',
    accountFingerprint: null,
    workspaceFingerprint: null,
    capturedAt: 1,
    controls,
  };
}

describe('buildInstalledSkillRows', () => {
  it('uses shared scope/host precedence while showing disabled winners and their actual host coverage', () => {
    const disabled = {
      ...managedSkill,
      id: 'workspace-disabled',
      scope: 'workspace' as const,
      workspacePath: '/a',
      enabled: false,
    };
    const codex = {
      ...disabled,
      id: 'workspace-codex',
      provider: 'codex-sdk' as const,
      enabled: true,
    };
    const rows = buildInstalledSkillRows([managedSkill, disabled, codex], [], '/a');
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.managedSkill?.id === disabled.id)).toMatchObject({
      enabled: false,
      runtimes: ['claude-agent-sdk', 'grok-acp'],
    });
    expect(rows.find((row) => row.managedSkill?.id === codex.id)).toMatchObject({
      enabled: true,
      runtimes: ['codex-sdk'],
    });
    expect(buildInstalledSkillRows([managedSkill, disabled], [], '/b')[0].managedSkill?.id).toBe(
      managedSkill.id
    );
  });

  it('keeps one portable skill independently switchable from same-named CLI skills', () => {
    const rows = buildInstalledSkillRows(
      [managedSkill],
      [
        snapshot('codex-sdk', [nativeSkill('codex-sdk')]),
        snapshot('claude-agent-sdk', [nativeSkill('claude-agent-sdk')]),
        snapshot('grok-acp', []),
      ]
    );

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      name: 'sequence-audit',
      enabled: true,
      managedSkill,
      nativeSkill: null,
      runtimes: ['codex-sdk', 'claude-agent-sdk', 'grok-acp'],
      sourceKey: 'dnaforge',
      sourceLabel: 'DNAForge',
    });
    expect(rows.slice(1)).toMatchObject([
      {
        managedSkill: null,
        runtimes: ['claude-agent-sdk'],
        sourceLabel: 'Claude Code',
      },
      {
        managedSkill: null,
        runtimes: ['codex-sdk'],
        sourceLabel: 'Codex',
      },
    ]);
  });

  it('keeps same-named runtime-owned skills independently switchable', () => {
    const rows = buildInstalledSkillRows(
      [],
      [
        snapshot('codex-sdk', [nativeSkill('codex-sdk', false)]),
        snapshot('grok-acp', [nativeSkill('grok-acp', false)]),
      ]
    );

    expect(rows).toHaveLength(2);
    expect(rows).toMatchObject([
      {
        name: 'sequence-audit',
        enabled: false,
        toggleable: true,
        managedSkill: null,
        runtimes: ['codex-sdk'],
        sourceLabel: 'Codex',
      },
      {
        name: 'sequence-audit',
        enabled: false,
        toggleable: true,
        managedSkill: null,
        runtimes: ['grok-acp'],
        sourceLabel: 'Grok Build',
      },
    ]);
  });

  it('preserves the CLI association for same-named managed skills', () => {
    const codexSkill = {
      ...managedSkill,
      id: 'managed-codex-sequence-audit',
      provider: 'codex-sdk' as const,
    };
    const claudeSkill = {
      ...managedSkill,
      id: 'managed-claude-sequence-audit',
      provider: 'claude-agent-sdk' as const,
      updatedAt: 2,
    };

    const rows = buildInstalledSkillRows([codexSkill, claudeSkill], []);

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'app:codex-sdk:sequence-audit',
          managedSkill: codexSkill,
          runtimes: ['codex-sdk'],
          sourceKey: 'codex-sdk',
          sourceLabel: 'Codex',
        }),
        expect.objectContaining({
          key: 'app:claude-agent-sdk:sequence-audit',
          managedSkill: claudeSkill,
          runtimes: ['claude-agent-sdk'],
          sourceKey: 'claude-agent-sdk',
          sourceLabel: 'Claude Code',
        }),
      ])
    );
  });

  it('does not present a provider-disabled native skill as enabled in DNAForge', () => {
    const providerDisabled = {
      ...nativeSkill('claude-agent-sdk'),
      availability: {
        state: 'disabled-by-policy' as const,
        reason: 'This skill is disabled in Claude Code.',
      },
      stages: {
        ...nativeSkill('claude-agent-sdk').stages,
        invocable: false,
      },
      dnaforgePolicy: { enabled: true, scope: 'installation' as const },
    };

    const [row] = buildInstalledSkillRows([], [snapshot('claude-agent-sdk', [providerDisabled])]);

    expect(row).toMatchObject({
      enabled: false,
      toggleable: false,
      unavailableReason: 'This skill is disabled in Claude Code.',
    });
  });

  it('uses the workspace app copy as the effective canonical row', () => {
    const workspaceSkill = {
      ...managedSkill,
      id: 'workspace-sequence-audit',
      scope: 'workspace' as const,
      workspacePath: '/workspace',
      enabled: false,
      updatedAt: 2,
    };
    const [row] = buildInstalledSkillRows([managedSkill, workspaceSkill], []);

    expect(row.managedSkill?.id).toBe('workspace-sequence-audit');
    expect(row.enabled).toBe(false);
  });
});

describe('buildDiscoveredBiologyPlugins', () => {
  function plugin(
    provider: AgentCapabilitySnapshot['provider'],
    nativeId: string,
    label: string,
    description: string
  ): AgentCapabilityControl {
    return {
      id: `${provider}:plugin:${nativeId}`,
      provider,
      nativeId,
      kind: 'plugin',
      label,
      description,
      scope: 'installation',
      effects: ['process'],
      availability: { state: 'supported' },
      stages: {
        advertised: true,
        discoverable: true,
        invocable: true,
        visible: true,
        deterministic: true,
        liveQualified: false,
      },
      providerPlugin: {
        installed: false,
        updateAvailable: false,
        installable: true,
        removable: false,
      },
    };
  }

  it('discovers future biology plugins from provider metadata without a product-name catalog', () => {
    const futureGenomics = plugin(
      'claude-agent-sdk',
      'future-genomics-suite',
      'Future Genomics Suite',
      'A newly advertised provider plugin.'
    );
    const proteinWorkbench = plugin(
      'grok-acp',
      'research-workbench',
      'Research Workbench',
      'Protein structure analysis for laboratory teams.'
    );
    const calendar = plugin(
      'codex-sdk',
      'calendar',
      'Calendar',
      'Manage project schedules and meetings.'
    );
    const dataLab = plugin(
      'claude-agent-sdk',
      'data-lab',
      'Data Lab',
      'Manage model deployment and experiment tracking for data science teams.'
    );
    const projectArtifact = plugin(
      'grok-acp',
      'project-artifact',
      'Project Artifact',
      'Publish the workstream sequence and next steps as a status page.'
    );
    const biography = plugin(
      'codex-sdk',
      'biography-writer',
      'Biography Writer',
      'Draft a professional profile.'
    );

    const discovered = buildDiscoveredBiologyPlugins([
      snapshot('codex-sdk', [calendar, biography]),
      snapshot('claude-agent-sdk', [futureGenomics, dataLab]),
      snapshot('grok-acp', [proteinWorkbench, projectArtifact]),
    ]);

    expect(discovered.map(({ control }) => control.nativeId)).toEqual([
      'future-genomics-suite',
      'research-workbench',
    ]);
  });

  it('normalizes provider slugs for friendly search', () => {
    expect(normalizeCapabilitySearchText('NGS-Analysis_Workbench')).toBe('ngs analysis workbench');
  });
});
