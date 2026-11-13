import { describe, expect, it, vi } from 'vitest';
import { buildCodexMcpIsolationConfig } from './codex-mcp-session-config';
import {
  runLocalCodexAppServerTurn,
  type LocalCodexAppServerTransport,
} from './local-codex-app-server';

describe('tool-free conversation naming runtime', () => {
  it.each([{ servers: ['dnaforge'] }, { servers: ['dnaforge', 'other-server'] }, { servers: [] }])(
    'generates a title with isolated inherited servers $servers',
    async ({ servers }) => {
      let notify: (notification: { method: string; params: unknown }) => void = () => {};
      const transport: LocalCodexAppServerTransport = {
        request: vi.fn(async (method) => {
          if (method === 'thread/start') return { thread: { id: 'title-thread' } };
          if (method === 'turn/start') {
            notify({
              method: 'item/completed',
              params: { item: { type: 'agentMessage', text: 'RNA Sequencing vs qPCR' } },
            });
            notify({
              method: 'turn/completed',
              params: { turn: { id: 'title-turn', status: 'completed' } },
            });
            return { turn: { id: 'title-turn' } };
          }
          throw new Error(`Tool-free naming must not request ${method}`);
        }),
        onNotification: (listener) => {
          notify = listener;
        },
        onServerRequest: vi.fn(),
        onExit: vi.fn(),
        interrupt: vi.fn(),
      };
      const config = buildCodexMcpIsolationConfig(servers);
      const result = await runLocalCodexAppServerTurn({
        transport,
        message: 'Name this conversation for a chat history list.',
        cwd: '/scratch/title-session',
        conversationId: null,
        config,
        requiredMcpTools: [],
        developerInstructions: 'Return only the title.',
        requestUserInput: vi.fn(),
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({ ok: true, text: 'RNA Sequencing vs qPCR' });
      expect(transport.request).toHaveBeenCalledWith(
        'thread/start',
        expect.objectContaining({ config })
      );
      expect(transport.request).not.toHaveBeenCalledWith('mcpServerStatus/list', expect.anything());
    }
  );
});
