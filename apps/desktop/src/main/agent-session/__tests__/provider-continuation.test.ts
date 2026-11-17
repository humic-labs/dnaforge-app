import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0'), isPackaged: false },
}));
vi.mock('../../analytics', () => ({ trackEvent: vi.fn() }));

import { ensureSchema } from '../../schema';
import { createTestDb } from '../../__tests__/test-db';
import { findProviderContinuation } from '../provider-continuation';

let db: ReturnType<typeof createTestDb>;

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  db.prepare(
    `INSERT INTO conversations (id, title, created_at, updated_at, provider, model)
     VALUES ('conversation-1', 'Continuation', 1, 1, 'codex-sdk', 'codex-sdk')`
  ).run();
});

function insertTurn(input: {
  id: string;
  transport: 'codex-sdk' | 'claude-agent-sdk';
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'cancelled' | 'interrupted';
  routeKind?: 'cli' | 'provider' | 'hosted';
  startedAt: number;
  conversationId?: string;
}): void {
  db.prepare(
    `INSERT INTO chat_turns (
      id, conversation_id, route_kind, host_id, transport, route_snapshot_json,
      status, started_at, completed_at
    ) VALUES (?, ?, ?, 'test-host', ?, '{}', ?, ?, ?)`
  ).run(
    input.id,
    input.conversationId ?? 'conversation-1',
    input.routeKind ?? 'cli',
    input.transport,
    input.status,
    input.startedAt,
    input.status === 'running' ? null : input.startedAt + 1
  );
}

function insertSession(input: {
  id: string;
  turnId: string;
  provider: 'codex-sdk' | 'claude-agent-sdk';
  status: 'completed' | 'failed' | 'stop_unconfirmed' | 'cancelled' | 'interrupted';
  providerConversationId: string | null;
  conversationId?: string;
}): void {
  db.prepare(
    `INSERT INTO agent_sessions (
      id, conversation_id, turn_id, provider, authority_profile_id, authority_class,
      release_mode, status, cwd, provider_conversation_id, provider_versions_json,
      authority_json, started_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, 'profile', 'app-supervised', 'read_only',
      ?, '/workspace', ?, '{}', '{}', 1, 1, 2)`
  ).run(
    input.id,
    input.conversationId ?? 'conversation-1',
    input.turnId,
    input.provider,
    input.status,
    input.providerConversationId
  );
}

function lookup(provider: 'codex-sdk' | 'claude-agent-sdk'): string | null {
  return findProviderContinuation(db, {
    conversationId: 'conversation-1',
    turnId: 'turn-current',
    provider,
  });
}

describe('findProviderContinuation', () => {
  it('returns the completed same-provider immediate predecessor', () => {
    insertTurn({ id: 'turn-previous', transport: 'codex-sdk', status: 'completed', startedAt: 1 });
    insertSession({
      id: 'session-previous',
      turnId: 'turn-previous',
      provider: 'codex-sdk',
      status: 'completed',
      providerConversationId: 'codex-thread-1',
    });
    insertTurn({ id: 'turn-current', transport: 'codex-sdk', status: 'running', startedAt: 2 });

    expect(lookup('codex-sdk')).toBe('codex-thread-1');
  });

  it.each([
    ['stopped', 'stop_unconfirmed'],
    ['cancelled', 'cancelled'],
    ['interrupted', 'interrupted'],
  ] as const)('resumes the explicit follow-up after a %s turn', (turnStatus, sessionStatus) => {
    insertTurn({ id: 'turn-previous', transport: 'codex-sdk', status: turnStatus, startedAt: 1 });
    insertSession({
      id: 'session-previous',
      turnId: 'turn-previous',
      provider: 'codex-sdk',
      status: sessionStatus,
      providerConversationId: 'codex-thread-with-goal',
    });
    insertTurn({ id: 'turn-current', transport: 'codex-sdk', status: 'running', startedAt: 2 });
    expect(lookup('codex-sdk')).toBe('codex-thread-with-goal');
  });

  it.each([
    ['failed chat turn', 'failed', 'completed', 'codex-sdk', 'cli', 'codex-thread-1'],
    ['failed provider session', 'completed', 'failed', 'codex-sdk', 'cli', 'codex-thread-1'],
    ['provider switch', 'completed', 'completed', 'claude-agent-sdk', 'cli', 'claude-session-1'],
    ['hosted interlude', 'completed', 'completed', 'codex-sdk', 'hosted', 'codex-thread-1'],
    [
      'direct-provider interlude',
      'completed',
      'completed',
      'codex-sdk',
      'provider',
      'codex-thread-1',
    ],
    ['legacy missing id', 'completed', 'completed', 'codex-sdk', 'cli', null],
  ] as const)(
    'rejects %s',
    (_label, turnStatus, sessionStatus, previousProvider, routeKind, providerConversationId) => {
      insertTurn({
        id: 'turn-previous',
        transport: previousProvider,
        status: turnStatus,
        routeKind,
        startedAt: 1,
      });
      insertSession({
        id: 'session-previous',
        turnId: 'turn-previous',
        provider: previousProvider,
        status: sessionStatus,
        providerConversationId,
      });
      insertTurn({ id: 'turn-current', transport: 'codex-sdk', status: 'running', startedAt: 2 });

      expect(lookup('codex-sdk')).toBeNull();
    }
  );

  it('never reuses a provider handle across DNAForge conversations', () => {
    insertTurn({ id: 'turn-previous', transport: 'codex-sdk', status: 'completed', startedAt: 1 });
    insertSession({
      id: 'session-previous',
      turnId: 'turn-previous',
      provider: 'codex-sdk',
      status: 'completed',
      providerConversationId: 'codex-thread-1',
    });
    insertTurn({ id: 'turn-current', transport: 'codex-sdk', status: 'running', startedAt: 2 });

    expect(
      findProviderContinuation(db, {
        conversationId: 'different-conversation',
        turnId: 'turn-current',
        provider: 'codex-sdk',
      })
    ).toBeNull();
  });

  it('rejects a session row whose conversation does not own its referenced turn', () => {
    db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at, provider, model)
       VALUES ('conversation-2', 'Other conversation', 1, 1, 'codex-sdk', 'codex-sdk')`
    ).run();
    insertTurn({
      id: 'turn-previous-other',
      conversationId: 'conversation-2',
      transport: 'codex-sdk',
      status: 'completed',
      startedAt: 1,
    });
    insertSession({
      id: 'session-crossed',
      conversationId: 'conversation-1',
      turnId: 'turn-previous-other',
      provider: 'codex-sdk',
      status: 'completed',
      providerConversationId: 'thread-from-conversation-1',
    });
    insertTurn({
      id: 'turn-current-other',
      conversationId: 'conversation-2',
      transport: 'codex-sdk',
      status: 'running',
      startedAt: 2,
    });

    expect(
      findProviderContinuation(db, {
        conversationId: 'conversation-2',
        turnId: 'turn-current-other',
        provider: 'codex-sdk',
      })
    ).toBeNull();
  });

  it('does not skip an incompatible immediate turn to reuse an older matching provider', () => {
    insertTurn({ id: 'turn-codex-old', transport: 'codex-sdk', status: 'completed', startedAt: 1 });
    insertSession({
      id: 'session-codex-old',
      turnId: 'turn-codex-old',
      provider: 'codex-sdk',
      status: 'completed',
      providerConversationId: 'stale-codex-thread',
    });
    insertTurn({
      id: 'turn-claude',
      transport: 'claude-agent-sdk',
      status: 'completed',
      startedAt: 2,
    });
    insertSession({
      id: 'session-claude',
      turnId: 'turn-claude',
      provider: 'claude-agent-sdk',
      status: 'completed',
      providerConversationId: 'claude-session',
    });
    insertTurn({ id: 'turn-current', transport: 'codex-sdk', status: 'running', startedAt: 3 });

    expect(lookup('codex-sdk')).toBeNull();
  });
});
