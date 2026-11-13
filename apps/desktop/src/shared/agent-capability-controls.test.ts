import {
  managedSkillLocator,
  selectManagedSkills,
  type AgentManagedSkill,
} from './agent-capability-controls';
// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  capabilityHasStage,
  resolveCapabilitySelection,
  validateAgentCapabilitySnapshot,
  type AgentCapabilitySnapshot,
} from './agent-capability-controls';

function snapshot(): AgentCapabilitySnapshot {
  return {
    schemaVersion: 1,
    snapshotId: 'codex-sdk:0.153.3:account-1:workspace-1:catalog-1',
    provider: 'codex-sdk',
    providerVersion: '0.153.3',
    accountFingerprint: 'account-1',
    workspaceFingerprint: 'workspace-1',
    capturedAt: 1_788_566_400_000,
    controls: [
      {
        id: 'codex-sdk:skill:review',
        provider: 'codex-sdk',
        nativeId: 'review',
        kind: 'skill',
        label: 'Review',
        description: 'Review the current change.',
        scope: 'turn',
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
      },
    ],
  };
}

describe('agent capability controls', () => {
  it('rejects duplicate or cross-provider capability identities', () => {
    const candidate = snapshot();
    candidate.controls.push({ ...candidate.controls[0]! });
    expect(() => validateAgentCapabilitySnapshot(candidate)).toThrow(/duplicate capability/i);

    const wrongProvider = snapshot();
    wrongProvider.controls[0] = { ...wrongProvider.controls[0]!, provider: 'grok-acp' };
    expect(() => validateAgentCapabilitySnapshot(wrongProvider)).toThrow(/provider/i);
  });

  it('rejects stale selections instead of invoking a same-named current control', () => {
    const current = snapshot();
    expect(
      resolveCapabilitySelection(current, {
        snapshotId: 'older-snapshot',
        provider: 'codex-sdk',
        capabilityId: 'codex-sdk:skill:review',
      })
    ).toEqual({ ok: false, reason: 'stale-snapshot' });
  });

  it('keeps protocol advertisement separate from deterministic and live proof', () => {
    const control = snapshot().controls[0]!;
    expect(capabilityHasStage(control, 'advertised')).toBe(true);
    expect(capabilityHasStage(control, 'deterministic')).toBe(true);
    expect(capabilityHasStage(control, 'liveQualified')).toBe(false);
  });
});

describe('managed skill effective selection', () => {
  const base: AgentManagedSkill = {
    id: 'global',
    name: 'review',
    description: 'Synthetic review',
    instructions: 'PRIVATE FIXTURE',
    provider: 'all',
    scope: 'global',
    workspacePath: null,
    directoryPath: '/private/skills/global',
    enabled: true,
    hasSupportingFiles: false,
    origin: 'local',
    source: null,
    contentDigest: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const workspace = {
    ...base,
    id: 'workspace',
    scope: 'workspace' as const,
    workspacePath: '/a',
    enabled: false,
  };
  it('retains a disabled workspace winner before enablement, independently of unrelated contexts', () => {
    const values = [
      base,
      { ...base, id: 'host', provider: 'codex-sdk' as const, updatedAt: 999 },
      workspace,
      { ...workspace, id: 'foreign', provider: 'claude-agent-sdk' as const, workspacePath: '/b' },
    ];
    expect(selectManagedSkills(values, 'codex-sdk', '/a')).toEqual([workspace]);
    expect(selectManagedSkills(values, 'codex-sdk', '/b')).toEqual([values[1]]);
    expect(selectManagedSkills(values, 'grok-acp', '/b')).toEqual([base]);
  });
  it.each([
    ['global all', [], 'global'],
    ['global host', [{ ...base, id: 'host', provider: 'codex-sdk' as const }], 'host'],
    ['workspace all', [workspace], 'workspace'],
    [
      'workspace host',
      [
        workspace,
        { ...workspace, id: 'workspace-host', provider: 'codex-sdk' as const, enabled: true },
      ],
      'workspace-host',
    ],
    [
      'other host',
      [{ ...workspace, id: 'other-host', provider: 'claude-agent-sdk' as const }],
      'global',
    ],
    ['other workspace', [{ ...workspace, workspacePath: '/b' }], 'global'],
  ] as const)('uses the agreed priority for %s', (_name, extra, expected) => {
    expect(
      selectManagedSkills([base, ...extra], 'codex-sdk', '/a').map((skill) => skill.id)
    ).toEqual([expected]);
  });
  it('accepts a valid later native revision and has deterministic same-priority ties', () => {
    const newer = { ...base, id: 'newer', updatedAt: 2, enabled: false };
    expect(selectManagedSkills([newer, base], 'codex-sdk', '/a')).toEqual([newer]);
    expect(selectManagedSkills([base, newer], 'codex-sdk', '/a')).toEqual([newer]);
  });
  it('binds a locator to existing native context and update revision without a private path or directory id', () => {
    const locator = managedSkillLocator(base, { provider: 'codex-sdk', snapshotId: 'context-one' });
    expect(locator).toBe(
      'skill://all/review/SKILL.md?host=codex-sdk&snapshot=context-one&updated=1'
    );
    expect(locator).not.toContain(base.directoryPath);
    expect(locator).not.toContain(base.instructions);
    expect(
      managedSkillLocator(
        { ...base, updatedAt: 2 },
        { provider: 'codex-sdk', snapshotId: 'context-two' }
      )
    ).not.toBe(locator);
  });
});
