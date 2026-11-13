import { describe, expect, it, vi } from 'vitest';

import { hostedCodexToolWireName, type HostedCodexToolCatalog } from './dynamic-tool-catalog';
import {
  AppServerTurnDriverError,
  createAppServerTurnDriver,
  type AppServerTurnTransport,
} from './app-server-turn-driver';
import type { IncomingServerRequest } from './app-server-supervisor';
import { HOSTED_TOOL_DISPATCH_NAME } from '@waypoint/hosted-ai-contract';
import { buildHostedProviderToolCatalog } from './hosted-tool-discovery';

const CATALOG: HostedCodexToolCatalog = {
  digest: 'a'.repeat(64),
  tools: [
    {
      name: 'assembly.listEditableFields',
      description: 'List editable assembly fields.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        additionalProperties: false,
      },
      effects: ['read-only'],
      requiresWorkspace: true,
    },
  ],
};

function transport(): AppServerTurnTransport & {
  requests: { method: string; params: unknown }[];
  emitNotification(method: string, params: unknown): void;
  emitServerRequest(request: IncomingServerRequest): void;
  emitExit(): void;
} {
  const requests: { method: string; params: unknown }[] = [];
  let notificationListener: ((notification: { method: string; params: unknown }) => void) | null =
    null;
  let requestListener: ((request: IncomingServerRequest) => void) | null = null;
  let exitListener: (() => void) | null = null;
  return {
    requests,
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        return { turn: { id: 'turn-1' } };
      }
      if (method === 'turn/interrupt') return {};
      throw new Error(`unexpected ${method}`);
    },
    onNotification: (listener) => {
      notificationListener = listener;
    },
    onServerRequest: (listener) => {
      requestListener = listener;
    },
    onExit: (listener) => {
      exitListener = listener;
    },
    emitNotification: (method, params) => notificationListener?.({ method, params }),
    emitServerRequest: (request) => requestListener?.(request),
    emitExit: () => exitListener?.(),
  };
}

describe('createAppServerTurnDriver', () => {
  it('resolves a transport call to the original canonical action before execution', () => {
    const subject = transport();
    const driver = createAppServerTurnDriver({
      transport: subject,
      model: 'gpt-5-codex',
      cwd: '/private/hosted-runtime',
      catalog: CATALOG,
      offeredCatalog: buildHostedProviderToolCatalog(CATALOG),
    });
    const received = vi.fn();
    driver.onServerRequest(received);
    subject.emitServerRequest({
      method: 'item/tool/call',
      params: {
        callId: 'original-provider-call',
        tool: hostedCodexToolWireName(HOSTED_TOOL_DISPATCH_NAME),
        arguments: { name: 'assembly.listEditableFields', arguments: '{"path":"owned.gb"}' },
      },
      respond: vi.fn(),
      refuse: vi.fn(),
    });
    expect(received).toHaveBeenCalledOnce();
    expect(received.mock.calls[0]?.[0].params).toMatchObject({
      callId: 'original-provider-call',
      tool: 'assembly.listEditableFields',
      arguments: { path: 'owned.gb' },
    });
  });

  it.each(['unknown_action', 'close_tab'])(
    'refuses transport target %s before original execution',
    (name) => {
      const subject = transport();
      const driver = createAppServerTurnDriver({
        transport: subject,
        model: 'gpt-5-codex',
        cwd: '/private/hosted-runtime',
        catalog: CATALOG,
        offeredCatalog: buildHostedProviderToolCatalog(CATALOG),
      });
      const received = vi.fn();
      const respond = vi.fn();
      driver.onServerRequest(received);
      subject.emitServerRequest({
        method: 'item/tool/call',
        params: {
          callId: 'refused-provider-call',
          tool: hostedCodexToolWireName(HOSTED_TOOL_DISPATCH_NAME),
          arguments: { name, arguments: '{}' },
        },
        respond,
        refuse: vi.fn(),
      });
      expect(received).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    }
  );

  it('starts one isolated thread and one real turn with the canonical dynamic tools', async () => {
    const subject = transport();
    const driver = createAppServerTurnDriver({
      transport: subject,
      model: 'gpt-5.1-codex-mini',
      cwd: '/private/hosted-runtime',
      catalog: CATALOG,
      developerInstructions: 'Use only the offered DNAForge tools.',
      priorConversationContext: '<wp-conversation-history>Earlier turn</wp-conversation-history>',
    });

    await driver.send('inspect this workspace');

    expect(subject.requests).toEqual([
      {
        method: 'thread/start',
        params: {
          model: 'gpt-5.1-codex-mini',
          modelProvider: 'dnaforge-hosted',
          allowProviderModelFallback: false,
          cwd: '/private/hosted-runtime',
          approvalPolicy: 'never',
          sandbox: 'read-only',
          ephemeral: true,
          developerInstructions: 'Use only the offered DNAForge tools.',
          dynamicTools: [
            {
              type: 'function',
              name: hostedCodexToolWireName('assembly.listEditableFields'),
              description: 'List editable assembly fields.',
              inputSchema: CATALOG.tools[0]?.inputSchema,
              deferLoading: false,
            },
          ],
        },
      },
      {
        method: 'turn/start',
        params: {
          threadId: 'thread-1',
          input: [{ type: 'text', text: 'inspect this workspace', text_elements: [] }],
          additionalContext: {
            dnaforgeConversationHistory: {
              kind: 'application',
              value: '<wp-conversation-history>Earlier turn</wp-conversation-history>',
            },
          },
        },
      },
    ]);
    expect(driver.threadId).toBe('thread-1');
    expect(driver.turnId).toBe('turn-1');
  });

  it('forwards notifications and wraps a successful dynamic-tool result in the real protocol', async () => {
    const subject = transport();
    const driver = createAppServerTurnDriver({
      transport: subject,
      model: 'gpt-5.1-codex-mini',
      cwd: '/private/hosted-runtime',
      catalog: CATALOG,
    });
    const notification = vi.fn();
    const toolRequest = vi.fn((request: IncomingServerRequest) => request.respond({ rows: 2 }));
    driver.onNotification(notification);
    driver.onServerRequest(toolRequest);

    subject.emitNotification('item/agentMessage/delta', { delta: 'two files' });
    const respond = vi.fn();
    subject.emitServerRequest({
      method: 'item/tool/call',
      params: {
        callId: 'call-1',
        tool: hostedCodexToolWireName('assembly.listEditableFields'),
        arguments: { path: '.' },
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
      respond,
      refuse: vi.fn(),
    });

    expect(notification).toHaveBeenCalledWith({
      method: 'item/agentMessage/delta',
      params: { delta: 'two files' },
    });
    expect(toolRequest).toHaveBeenCalledOnce();
    expect(toolRequest.mock.calls[0]?.[0].params).toMatchObject({
      tool: 'assembly.listEditableFields',
    });
    expect(respond).toHaveBeenCalledWith({
      success: true,
      contentItems: [{ type: 'inputText', text: '{"rows":2}' }],
    });
  });

  it('forwards child exit to the active turn', () => {
    const subject = transport();
    const driver = createAppServerTurnDriver({
      transport: subject,
      model: 'gpt-5.1-codex-mini',
      cwd: '/private/hosted-runtime',
      catalog: CATALOG,
    });
    const exited = vi.fn();
    driver.onExit(exited);

    subject.emitExit();

    expect(exited).toHaveBeenCalledOnce();
  });

  it('returns a protocol failure result for a refused dynamic tool instead of stranding the child', () => {
    const subject = transport();
    const driver = createAppServerTurnDriver({
      transport: subject,
      model: 'gpt-5.1-codex-mini',
      cwd: '/private/hosted-runtime',
      catalog: CATALOG,
    });
    driver.onServerRequest((request) => request.refuse('unknown_tool'));
    const respond = vi.fn();
    const refuse = vi.fn();

    subject.emitServerRequest({
      method: 'item/tool/call',
      params: {},
      respond,
      refuse,
    });

    expect(respond).toHaveBeenCalledWith({
      success: false,
      contentItems: [{ type: 'inputText', text: '{"error":"unknown_tool"}' }],
    });
    expect(refuse).not.toHaveBeenCalled();
  });

  it('interrupts the exact active turn before the child is disposed', async () => {
    const subject = transport();
    const driver = createAppServerTurnDriver({
      transport: subject,
      model: 'gpt-5.1-codex-mini',
      cwd: '/private/hosted-runtime',
      catalog: CATALOG,
    });
    await driver.send('stop me');

    await driver.interrupt();

    expect(subject.requests.at(-1)).toEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
  });

  it('fails closed when the App Server returns no real thread identity', async () => {
    const subject = transport();
    subject.request = async () => ({ thread: {} });
    const driver = createAppServerTurnDriver({
      transport: subject,
      model: 'gpt-5.1-codex-mini',
      cwd: '/private/hosted-runtime',
      catalog: CATALOG,
    });

    await expect(driver.send('hello')).rejects.toMatchObject({
      code: 'malformed_thread_start',
    } satisfies Partial<AppServerTurnDriverError>);
  });
});
