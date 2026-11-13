import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ipcHandlers, mockSenderSend } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: any[]) => unknown>(),
  mockSenderSend: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  },
}));

import { registerAgentSessionHandlers } from '../ipc';
import type { AgentSessionManager } from '../manager';

async function invoke(channel: string, ...args: unknown[]) {
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler({ sender: { send: mockSenderSend } }, ...args);
}

describe('agent-session IPC handlers', () => {
  beforeEach(() => {
    ipcHandlers.clear();
    mockSenderSend.mockClear();
  });

  it('rejects legacy permissionMode start requests at the IPC boundary', async () => {
    const manager = {
      startSession: vi.fn(),
      requestStop: vi.fn(),
      getSession: vi.fn(),
    } as unknown as AgentSessionManager;
    registerAgentSessionHandlers(manager);

    await expect(
      invoke('agentSession:start', {
        sessionId: 'session_1',
        provider: 'codex-sdk',
        permissionMode: 'native-cli',
        prompt: 'hello',
        cwd: '/workspace',
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('concrete authorityProfileId'),
    });
    expect(manager.startSession).not.toHaveBeenCalled();
  });

  it('forwards manager trace envelopes to the requesting renderer', async () => {
    const manager = {
      startSession: vi.fn(async (_request, eventSink) => {
        eventSink({
          sessionId: 'session_1',
          provider: 'codex-sdk',
          type: 'trace',
          event: { providerEventType: 'item.completed' },
        });
        return {
          sessionId: 'session_1',
          provider: 'codex-sdk',
          authorityProfileId: 'codex-sdk:app-supervised',
          ok: true,
          text: 'done',
          durationMs: 1,
          stopState: 'completed',
          workspaceProvenance: {
            policy: 'required',
            grounded: true,
            completedWorkspaceTools: ['list_files'],
          },
        };
      }),
      requestStop: vi.fn(),
      getSession: vi.fn(),
    } as unknown as AgentSessionManager;
    registerAgentSessionHandlers(manager);

    await expect(
      invoke('agentSession:start', {
        sessionId: 'session_1',
        provider: 'codex-sdk',
        authorityProfileId: 'codex-sdk:app-supervised',
        prompt: 'hello',
        cwd: '/workspace',
        workspaceGrounding: 'required',
      })
    ).resolves.toMatchObject({ ok: true, text: 'done' });

    expect(mockSenderSend).toHaveBeenCalledWith('agentSession:event', {
      sessionId: 'session_1',
      provider: 'codex-sdk',
      type: 'trace',
      event: { providerEventType: 'item.completed' },
    });
  });

  it('accepts only absolute custom harness executable paths', async () => {
    const manager = {
      startSession: vi.fn(async () => ({
        sessionId: 'session_1',
        provider: 'codex-sdk',
        authorityProfileId: 'codex-sdk:native-subscription',
        ok: true,
        text: 'done',
        durationMs: 1,
        stopState: 'completed',
        workspaceProvenance: {
          policy: 'not-required',
          grounded: false,
          completedWorkspaceTools: [],
        },
      })),
      requestStop: vi.fn(),
      getSession: vi.fn(),
    } as unknown as AgentSessionManager;
    registerAgentSessionHandlers(manager);
    const base = {
      sessionId: 'session_1',
      provider: 'codex-sdk',
      authorityProfileId: 'codex-sdk:native-subscription',
      prompt: 'hello',
      cwd: '/workspace',
      workspaceGrounding: 'not-required',
    };

    await expect(
      invoke('agentSession:start', { ...base, binaryPathOverride: './codex-wrapper' })
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('absolute path') });
    expect(manager.startSession).not.toHaveBeenCalled();

    await expect(
      invoke('agentSession:start', { ...base, binaryPathOverride: '/opt/lab/bin/codex' })
    ).resolves.toMatchObject({ ok: true });
    expect(manager.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ binaryPathOverride: '/opt/lab/bin/codex' }),
      expect.any(Function)
    );
  });

  it('sanitizes and forwards turnId on durable session starts', async () => {
    const manager = {
      startSession: vi.fn(async () => ({
        sessionId: 'session_1',
        provider: 'codex-sdk',
        authorityProfileId: 'codex-sdk:app-supervised',
        ok: true,
        text: 'done',
        durationMs: 1,
        stopState: 'completed',
        workspaceProvenance: {
          policy: 'required',
          grounded: true,
          completedWorkspaceTools: ['list_files'],
        },
      })),
      requestStop: vi.fn(),
      getSession: vi.fn(),
    } as unknown as AgentSessionManager;
    registerAgentSessionHandlers(manager);

    await invoke('agentSession:start', {
      sessionId: 'session_1',
      conversationId: 'conv_1',
      turnId: 'turn_1',
      provider: 'codex-sdk',
      authorityProfileId: 'codex-sdk:app-supervised',
      prompt: 'hello',
      continuationPrompt: 'follow-up only',
      cwd: '/workspace',
      workspaceGrounding: 'required',
      permissions: { codex: ':read-only' },
      additionalAgentInstructions: 'Use short paragraphs.',
      model: '  gpt-5-codex  ',
      modelReasoningEffort: 'high',
      modelServiceTier: ' priority ',
      modelPersonality: 'pragmatic',
      capabilitySelection: {
        snapshotId: 'snapshot-1',
        provider: 'codex-sdk',
        capabilityId: 'codex-sdk:custom-command:review',
      },
    });

    expect(manager.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session_1',
        conversationId: 'conv_1',
        continuationPrompt: 'follow-up only',
        permissions: { codex: ':read-only' },
        additionalAgentInstructions: 'Use short paragraphs.',
        turnId: 'turn_1',
        model: 'gpt-5-codex',
        modelReasoningEffort: 'high',
        modelServiceTier: 'priority',
        modelPersonality: 'pragmatic',
        capabilitySelection: {
          snapshotId: 'snapshot-1',
          provider: 'codex-sdk',
          capabilityId: 'codex-sdk:custom-command:review',
        },
        workspaceGrounding: 'required',
      }),
      expect.any(Function)
    );
  });

  it('rejects a capability token owned by a different provider', async () => {
    const manager = {
      startSession: vi.fn(),
      requestStop: vi.fn(),
      getSession: vi.fn(),
    } as unknown as AgentSessionManager;
    registerAgentSessionHandlers(manager);

    await expect(
      invoke('agentSession:start', {
        sessionId: 'session_1',
        provider: 'codex-sdk',
        authorityProfileId: 'codex-sdk:app-supervised',
        prompt: 'hello',
        cwd: '/workspace',
        workspaceGrounding: 'not-required',
        capabilitySelection: {
          snapshotId: 'snapshot-1',
          provider: 'claude-agent-sdk',
          capabilityId: 'claude-agent-sdk:command:review',
        },
      })
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('capabilitySelection') });
    expect(manager.startSession).not.toHaveBeenCalled();
  });

  it('sanitizes immutable attachment manifests and rejects forged identities', async () => {
    const manager = {
      startSession: vi.fn(async () => ({ ok: true })),
      requestStop: vi.fn(),
      getSession: vi.fn(),
    } as unknown as AgentSessionManager;
    registerAgentSessionHandlers(manager);
    const sha256 = 'b'.repeat(64);
    const base = {
      sessionId: 'session_attachment',
      provider: 'codex-sdk',
      authorityProfileId: 'codex-sdk:app-supervised',
      prompt: 'analyze',
      cwd: '/workspace',
      workspaceGrounding: 'not-required',
    };
    const manifest = {
      id: `attachment-${sha256}`,
      sha256,
      name: 'sequence.fasta',
      kind: 'text',
      mediaType: 'text/x-fasta',
      size: 12,
    } as const;

    await invoke('agentSession:start', { ...base, attachments: [manifest] });
    expect(manager.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [{ ...manifest }] }),
      expect.any(Function)
    );

    manager.startSession = vi.fn();
    await expect(
      invoke('agentSession:start', {
        ...base,
        attachments: [{ ...manifest, id: `attachment-${'c'.repeat(64)}` }],
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('invalid attachment manifest'),
    });
    expect(manager.startSession).not.toHaveBeenCalled();
  });

  it('rejects duplicate, over-count, and aggregate-overflow attachment sets before start', async () => {
    const manager = {
      startSession: vi.fn(async () => ({ ok: true })),
      requestStop: vi.fn(),
      getSession: vi.fn(),
    } as unknown as AgentSessionManager;
    registerAgentSessionHandlers(manager);
    const base = {
      sessionId: 'session_attachment_limits',
      provider: 'codex-sdk',
      authorityProfileId: 'codex-sdk:app-supervised',
      prompt: 'analyze',
      cwd: '/workspace',
      workspaceGrounding: 'not-required',
    };
    const manifest = (index: number, size: number) => {
      const sha256 = index.toString(16).padStart(64, '0');
      return {
        id: `attachment-${sha256}`,
        sha256,
        name: `attachment-${index}.txt`,
        kind: 'text' as const,
        mediaType: 'text/plain',
        size,
      };
    };

    await expect(
      invoke('agentSession:start', {
        ...base,
        attachments: [manifest(1, 1), manifest(1, 1)],
      })
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('must be unique') });
    await expect(
      invoke('agentSession:start', {
        ...base,
        attachments: Array.from({ length: 9 }, (_, index) => manifest(index + 1, 1)),
      })
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('at most 8') });
    await expect(
      invoke('agentSession:start', {
        ...base,
        attachments: Array.from({ length: 5 }, (_, index) => manifest(index + 1, 1024 * 1024)),
      })
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('4 MiB combined') });
    expect(manager.startSession).not.toHaveBeenCalled();

    await expect(
      invoke('agentSession:start', {
        ...base,
        attachments: Array.from({ length: 4 }, (_, index) => manifest(index + 1, 1024 * 1024)),
      })
    ).resolves.toMatchObject({ ok: true });
    expect(manager.startSession).toHaveBeenCalledOnce();
  });

  it('rejects unsupported model effort values at the IPC boundary', async () => {
    const manager = {
      startSession: vi.fn(),
      requestStop: vi.fn(),
      getSession: vi.fn(),
    } as unknown as AgentSessionManager;
    registerAgentSessionHandlers(manager);

    await expect(
      invoke('agentSession:start', {
        sessionId: 'session_1',
        provider: 'codex-sdk',
        authorityProfileId: 'codex-sdk:app-supervised',
        prompt: 'hello',
        cwd: '/workspace',
        workspaceGrounding: 'required',
        modelReasoningEffort: 'extreme',
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('modelReasoningEffort is not supported'),
    });
    expect(manager.startSession).not.toHaveBeenCalled();
  });

  it('accepts advertised-style ids for Claude but keeps Codex personalities bounded', async () => {
    const manager = {
      startSession: vi.fn(),
      requestStop: vi.fn(),
      getSession: vi.fn(),
    } as unknown as AgentSessionManager;
    registerAgentSessionHandlers(manager);
    const base = {
      sessionId: 'session_1',
      authorityProfileId: 'codex-sdk:app-supervised',
      prompt: 'hello',
      cwd: '/workspace',
      workspaceGrounding: 'not-required',
    };

    await expect(
      invoke('agentSession:start', {
        ...base,
        provider: 'codex-sdk',
        modelPersonality: 'sarcastic',
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('modelPersonality is invalid'),
    });
    await expect(
      invoke('agentSession:start', {
        ...base,
        provider: 'claude-agent-sdk',
        authorityProfileId: 'claude-agent-sdk:native-subscription',
        modelPersonality: 'explanatory',
      })
    ).resolves.toBeUndefined();
    expect(manager.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude-agent-sdk',
        modelPersonality: 'explanatory',
      }),
      expect.any(Function)
    );
  });

  it('rejects a start request that omits the grounding policy', async () => {
    const manager = {
      startSession: vi.fn(),
      requestStop: vi.fn(),
      getSession: vi.fn(),
    } as unknown as AgentSessionManager;
    registerAgentSessionHandlers(manager);

    await expect(
      invoke('agentSession:start', {
        sessionId: 'session_1',
        provider: 'codex-sdk',
        authorityProfileId: 'codex-sdk:app-supervised',
        prompt: 'hello',
        cwd: '/workspace',
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('workspaceGrounding policy'),
      workspaceProvenance: {
        policy: 'not-required',
        grounded: false,
        completedWorkspaceTools: [],
      },
    });
    expect(manager.startSession).not.toHaveBeenCalled();
  });

  it('allows a mounted workspace without imposing a per-turn grounding gate', async () => {
    const manager = {
      startSession: vi.fn(async (request) => ({ ok: true, request })),
      requestStop: vi.fn(),
      getSession: vi.fn(),
    } as unknown as AgentSessionManager;
    registerAgentSessionHandlers(manager);

    await expect(
      invoke('agentSession:start', {
        sessionId: 'session_1',
        provider: 'codex-sdk',
        authorityProfileId: 'codex-sdk:app-supervised',
        prompt: 'list the workspace',
        cwd: '/workspace',
        workspaceGrounding: 'not-required',
      })
    ).resolves.toMatchObject({ ok: true });
    expect(manager.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/workspace', workspaceGrounding: 'not-required' }),
      expect.any(Function)
    );
  });

  it('lists native schedules and routes explicit cancellation through the manager', async () => {
    const schedules = [
      {
        id: 'claude-agent-sdk:native_1',
        nativeId: 'native_1',
        status: 'active',
      },
    ];
    const manager = {
      startSession: vi.fn(),
      requestStop: vi.fn(),
      getSession: vi.fn(),
      listSchedules: vi.fn(() => schedules),
      cancelSchedule: vi.fn(async () => ({ ok: true, schedule: null })),
    } as unknown as AgentSessionManager;
    registerAgentSessionHandlers(manager);

    await expect(invoke('agentSession:listSchedules')).resolves.toEqual(schedules);
    await expect(
      invoke('agentSession:cancelSchedule', 'claude-agent-sdk:native_1')
    ).resolves.toEqual({ ok: true, schedule: null });
    expect(manager.cancelSchedule).toHaveBeenCalledWith('claude-agent-sdk:native_1');
  });

  it('rejects malformed schedule IDs before they reach the manager', async () => {
    const manager = {
      startSession: vi.fn(),
      requestStop: vi.fn(),
      getSession: vi.fn(),
      listSchedules: vi.fn(() => []),
      cancelSchedule: vi.fn(),
    } as unknown as AgentSessionManager;
    registerAgentSessionHandlers(manager);

    await expect(invoke('agentSession:cancelSchedule', '../native_1')).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('valid scheduleId'),
    });
    expect(manager.cancelSchedule).not.toHaveBeenCalled();
  });
});
