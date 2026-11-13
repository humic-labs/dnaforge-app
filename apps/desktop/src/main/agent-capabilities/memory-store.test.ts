import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentMemoryStore } from './memory-store';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fixture(): Promise<{ filePath: string; store: AgentMemoryStore }> {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-agent-memory-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, 'memory.json');
  return { filePath, store: new AgentMemoryStore({ filePath, now: () => 15 }) };
}

describe('AgentMemoryStore', () => {
  it('keeps global, workspace, and conversation memory in their declared scopes', async () => {
    const { filePath, store } = await fixture();
    await store.saveMemory({
      name: 'Writing preference',
      content: 'Use concise headings.',
      provider: 'all',
      scope: 'global',
      workspacePath: null,
      conversationId: null,
    });
    await store.saveMemory({
      name: 'Organism',
      content: 'This workspace uses E. coli K-12.',
      provider: 'claude-agent-sdk',
      scope: 'workspace',
      workspacePath: '/workspace/a',
      conversationId: null,
    });
    await store.saveMemory({
      name: 'Current construct',
      content: 'The active construct is pUC19-derived.',
      provider: 'codex-sdk',
      scope: 'conversation',
      workspacePath: '/workspace/a',
      conversationId: 'conversation-a',
    });
    await store.saveMemory({
      name: 'Workspace-free organism',
      content: 'This workspace-free chat concerns S. cerevisiae.',
      provider: 'all',
      scope: 'conversation',
      workspacePath: null,
      conversationId: 'conversation-without-workspace',
    });

    const reopened = new AgentMemoryStore({ filePath, now: () => 20 });
    expect(
      (
        await reopened.list({ workspacePath: '/workspace/a', conversationId: 'conversation-a' })
      ).memory.map((entry) => entry.name)
    ).toEqual(['Writing preference', 'Organism', 'Current construct']);
    expect(
      (
        await reopened.list({ workspacePath: '/workspace/b', conversationId: 'conversation-b' })
      ).memory.map((entry) => entry.name)
    ).toEqual(['Writing preference']);
    expect(
      (
        await reopened.list({
          workspacePath: null,
          conversationId: 'conversation-without-workspace',
        })
      ).memory.map((entry) => entry.name)
    ).toEqual(['Writing preference', 'Workspace-free organism']);
  });

  it('makes removal authoritative and fails closed on corrupt memory', async () => {
    const { filePath, store } = await fixture();
    const memory = await store.saveMemory({
      name: 'Temporary fact',
      content: 'Remove this fact.',
      provider: 'grok-acp',
      scope: 'global',
      workspacePath: null,
      conversationId: null,
    });
    await store.removeMemory(memory.id);
    expect((await store.list({ workspacePath: null, conversationId: null })).memory).toEqual([]);

    await writeFile(filePath, '{"schemaVersion":999,"memory":[]}', 'utf8');
    await expect(store.list({ workspacePath: null, conversationId: null })).rejects.toThrow(
      'corrupt'
    );
  });
});
