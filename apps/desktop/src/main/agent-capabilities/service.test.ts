import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { AgentCapabilityProviderAdapter } from './service';
import { AgentCapabilityService } from './service';

const stages = {
  advertised: true,
  discoverable: true,
  invocable: true,
  visible: true,
  deterministic: true,
  liveQualified: false,
} as const;

function adapter(
  discover: AgentCapabilityProviderAdapter['discover']
): AgentCapabilityProviderAdapter {
  return { provider: 'claude-agent-sdk', discover };
}

describe('AgentCapabilityService', () => {
  it('reads one selected native skill without exposing every skill body in discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-skill-inspection-'));
    try {
      const skillDirectory = join(root, 'sequence-audit');
      await mkdir(join(skillDirectory, 'references'), { recursive: true });
      const document =
        '---\nname: sequence-audit\ndescription: Audit a sequence.\n---\n\n# Sequence audit\n';
      await writeFile(join(skillDirectory, 'SKILL.md'), document, 'utf8');
      await writeFile(join(skillDirectory, 'references', 'checklist.md'), 'Check every base.\n');
      const service = new AgentCapabilityService({
        adapters: [
          adapter(async () => ({
            providerVersion: '1',
            accountFingerprint: 'account-a',
            workspaceFingerprint: 'workspace-a',
            controls: [
              {
                nativeId: 'sequence-audit',
                kind: 'skill',
                label: 'sequence-audit',
                description: 'Audit a sequence.',
                scope: 'installation',
                effects: ['instructions'],
                availability: { state: 'supported' },
                stages,
                detailSourcePath: join(skillDirectory, 'SKILL.md'),
              },
            ],
          })),
        ],
      });

      const snapshot = await service.discover({
        provider: 'claude-agent-sdk',
        workspacePath: null,
      });
      expect(JSON.stringify(snapshot)).not.toContain(document);
      expect(JSON.stringify(snapshot)).not.toContain(skillDirectory);

      await expect(
        service.inspectSkill({
          snapshotId: snapshot.snapshotId,
          provider: 'claude-agent-sdk',
          capabilityId: 'claude-agent-sdk:skill:sequence-audit',
        })
      ).resolves.toEqual({
        ok: true,
        skill: {
          document,
          sourcePath: expect.stringContaining('/sequence-audit/SKILL.md'),
          files: [
            { path: 'references/checklist.md', byteCount: 18 },
            { path: 'SKILL.md', byteCount: Buffer.byteLength(document) },
          ],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('sanitizes provider data, drops malformed records, and namespaces collisions', async () => {
    const service = new AgentCapabilityService({
      adapters: [
        adapter(async () => ({
          providerVersion: '2.1.261',
          accountFingerprint: 'account-a',
          workspaceFingerprint: 'workspace-a',
          controls: [
            {
              nativeId: 'review',
              kind: 'command',
              label: '/review',
              description: 'Review changes.',
              scope: 'session',
              effects: ['instructions'],
              availability: { state: 'supported' },
              stages,
            },
            {
              nativeId: 'review',
              kind: 'skill',
              label: 'review',
              description: 'Run the review skill.',
              scope: 'workspace',
              effects: ['instructions', 'filesystem-read'],
              availability: { state: 'supported' },
              stages,
            },
            {
              nativeId: '../secret',
              kind: 'memory',
              label: '/Users/person/private-project',
              description: 'contains\u0000control character',
              scope: 'session',
              effects: ['session-state'],
              availability: { state: 'supported' },
              stages,
            },
          ],
        })),
      ],
      now: () => 1234,
    });

    const snapshot = await service.discover({
      provider: 'claude-agent-sdk',
      workspacePath: '/workspace/private',
    });

    expect(snapshot.controls.map((control) => control.id)).toEqual([
      'claude-agent-sdk:command:review',
      'claude-agent-sdk:skill:review',
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('/Users/person');
    expect(snapshot.capturedAt).toBe(1234);
  });

  it('caches an identity-bound snapshot and invalidates it explicitly', async () => {
    const discover = vi.fn(async () => ({
      providerVersion: '1',
      accountFingerprint: 'account-a',
      workspaceFingerprint: 'workspace-a',
      controls: [],
    }));
    const service = new AgentCapabilityService({ adapters: [adapter(discover)], now: () => 1 });
    const request = { provider: 'claude-agent-sdk' as const, workspacePath: '/workspace' };

    const first = await service.discover(request);
    const cached = await service.discover(request);
    expect(cached.snapshotId).toBe(first.snapshotId);
    expect(discover).toHaveBeenCalledTimes(1);

    service.invalidate('claude-agent-sdk');
    const refreshed = await service.discover(request);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(refreshed.snapshotId).not.toBe(first.snapshotId);
  });

  it('reuses a skill snapshot until its definition or containing directory changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-skill-cache-'));
    const skillDirectory = join(root, 'first-skill');
    const definitionPath = join(skillDirectory, 'SKILL.md');
    await mkdir(skillDirectory);
    await writeFile(definitionPath, 'First version');
    const discover = vi.fn(async () => ({
      providerVersion: '1',
      accountFingerprint: null,
      workspaceFingerprint: null,
      controls: [
        {
          nativeId: 'first-skill',
          kind: 'skill' as const,
          label: 'First skill',
          description: 'Test skill.',
          scope: 'installation' as const,
          effects: ['instructions' as const],
          availability: { state: 'supported' as const },
          stages,
          detailSourcePath: definitionPath,
        },
      ],
    }));
    const service = new AgentCapabilityService({ adapters: [adapter(discover)] });
    const request = { provider: 'claude-agent-sdk' as const, workspacePath: null };
    try {
      const first = await service.discover(request);
      expect((await service.discover(request)).snapshotId).toBe(first.snapshotId);
      expect(discover).toHaveBeenCalledTimes(1);

      await writeFile(definitionPath, 'Second version');
      await utimes(definitionPath, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
      const edited = await service.discover(request);
      expect(edited.snapshotId).not.toBe(first.snapshotId);
      expect(discover).toHaveBeenCalledTimes(2);

      await mkdir(join(root, 'second-skill'));
      await utimes(root, new Date(2_000_000_001_000), new Date(2_000_000_001_000));
      const added = await service.discover(request);
      expect(added.snapshotId).not.toBe(edited.snapshotId);
      expect(discover).toHaveBeenCalledTimes(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects stale and cross-provider selections at the main-owned boundary', async () => {
    const service = new AgentCapabilityService({
      adapters: [
        adapter(async () => ({
          providerVersion: '1',
          accountFingerprint: 'account-a',
          workspaceFingerprint: null,
          controls: [
            {
              nativeId: 'review',
              kind: 'command',
              label: '/review',
              description: 'Review changes.',
              scope: 'session',
              effects: ['instructions'],
              availability: { state: 'supported' },
              stages,
            },
          ],
        })),
      ],
    });
    const snapshot = await service.discover({
      provider: 'claude-agent-sdk',
      workspacePath: null,
    });

    expect(
      service.resolve({
        snapshotId: 'old-snapshot',
        provider: 'claude-agent-sdk',
        capabilityId: 'claude-agent-sdk:command:review',
      })
    ).toEqual({ ok: false, reason: 'stale-snapshot' });
    expect(
      service.resolve({
        snapshotId: snapshot.snapshotId,
        provider: 'codex-sdk',
        capabilityId: 'claude-agent-sdk:command:review',
      })
    ).toEqual({ ok: false, reason: 'provider-mismatch' });
  });

  it('redacts adapter failures into an unavailable control without leaking paths', async () => {
    const service = new AgentCapabilityService({
      adapters: [
        adapter(async () => {
          throw new Error('spawn failed at /Users/person/.claude/credentials.json');
        }),
      ],
    });

    const snapshot = await service.discover({
      provider: 'claude-agent-sdk',
      workspacePath: null,
    });

    expect(snapshot.controls).toHaveLength(1);
    expect(snapshot.controls[0]).toMatchObject({
      kind: 'account',
      availability: { state: 'unknown' },
    });
    expect(JSON.stringify(snapshot)).not.toContain('/Users/person');
    expect(JSON.stringify(snapshot)).not.toContain('credentials.json');
  });

  it('adds app-owned controls to the exact workspace and conversation snapshot', async () => {
    const supplementalDiscovery = vi.fn(async () => [
      {
        nativeId: 'memory-1',
        kind: 'memory' as const,
        label: 'Current construct',
        description: 'Attach conversation memory.',
        scope: 'conversation' as const,
        effects: ['instructions' as const],
        availability: { state: 'supported' as const },
        stages,
        source: 'dnaforge-memory:memory-1',
      },
    ]);
    const service = new AgentCapabilityService({
      adapters: [
        adapter(async () => ({
          providerVersion: '1',
          accountFingerprint: 'account-a',
          workspaceFingerprint: 'workspace-a',
          controls: [],
        })),
      ],
      supplementalDiscovery,
    });

    const snapshot = await service.discover({
      provider: 'claude-agent-sdk',
      workspacePath: '/workspace',
      conversationId: 'conversation-1',
    });

    expect(supplementalDiscovery).toHaveBeenCalledWith(
      'claude-agent-sdk',
      expect.objectContaining({
        workspacePath: '/workspace',
        conversationId: 'conversation-1',
      })
    );
    expect(snapshot.controls).toEqual([
      expect.objectContaining({ id: 'claude-agent-sdk:memory:memory-1' }),
    ]);
  });

  it('keeps app-owned controls discoverable when the provider CLI is unavailable', async () => {
    const service = new AgentCapabilityService({
      adapters: [
        adapter(async () => {
          throw new Error('provider executable is missing');
        }),
      ],
      supplementalDiscovery: async () => [
        {
          nativeId: 'review-primers',
          kind: 'custom-command',
          label: '/review-primers',
          description: 'Review a primer pair.',
          scope: 'installation',
          effects: ['instructions'],
          availability: { state: 'supported' },
          stages,
          source: 'dnaforge-custom-command:command-1',
        },
      ],
    });

    const snapshot = await service.discover({
      provider: 'claude-agent-sdk',
      workspacePath: null,
    });

    expect(snapshot.controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'account',
          availability: expect.objectContaining({ state: 'unknown' }),
        }),
        expect.objectContaining({
          id: 'claude-agent-sdk:custom-command:review-primers',
          availability: { state: 'supported' },
        }),
      ])
    );
  });
});
