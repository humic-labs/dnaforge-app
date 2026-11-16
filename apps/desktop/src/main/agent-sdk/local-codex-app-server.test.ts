import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { BUILT_IN_AGENT_PERMISSIONS } from '../../shared/agent-permissions';
import {
  AppServerSupervisor,
  MAX_FRAME_BYTES,
  type SupervisedChild,
} from '../hosted-codex/app-server-supervisor';

import {
  LOCAL_CODEX_MAX_FRAME_BYTES,
  appServerNotificationAsCodexSdkEvent,
  FRESH_MOLECULAR_AUTHOR_CONFIG,
  freshMolecularAuthorConfig,
  validateLocalCodexProtocol,
  runLocalCodexAppServerTurn,
  type LocalCodexAppServerTransport,
} from './local-codex-app-server';

describe('appServerNotificationAsCodexSdkEvent', () => {
  it('preserves the visible Codex plan instead of reducing it to an unknown event', () => {
    expect(
      appServerNotificationAsCodexSdkEvent({
        method: 'turn/plan/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          explanation: 'I will inspect before editing.',
          plan: [
            { step: 'Inspect the sequence', status: 'completed' },
            { step: 'Design primers', status: 'inProgress' },
          ],
        },
      })
    ).toMatchObject({
      type: 'item.updated',
      item: {
        id: 'plan:turn-1',
        type: 'todo_list',
        text: 'I will inspect before editing.\n✓ Inspect the sequence\n→ Design primers',
      },
    });
  });
});

describe('runLocalCodexAppServerTurn', () => {
  it('rejects an owned startup failure even if inventory contains cached tools', async () => {
    let notification: ((value: { method: string; params: unknown }) => void) | null = null;
    const transport: LocalCodexAppServerTransport = {
      request: vi.fn(async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'mcpServerStatus/list') {
          notification?.({
            method: 'mcpServer/startupStatus/updated',
            params: {
              threadId: 'thread-1',
              name: 'dnaforge',
              status: 'failed',
              error: 'Startup failed',
              failureReason: null,
            },
          });
          return {
            data: [{ name: 'dnaforge', tools: { mol_data: { name: 'mol_data' } } }],
            nextCursor: null,
          };
        }
        throw new Error(`Unexpected request ${method}`);
      }),
      onNotification(listener) {
        notification = listener;
      },
      onServerRequest: vi.fn(),
      onExit: vi.fn(),
      interrupt: vi.fn(),
    };
    await expect(
      runLocalCodexAppServerTurn({
        transport,
        message: 'Color my structure.',
        cwd: '/workspace',
        conversationId: null,
        config: { mcp_servers: { dnaforge: { command: '/app/mcp' } } },
        developerInstructions: 'Use DNAForge tools.',
        requestUserInput: vi.fn(),
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('tool companion failed to start');
    expect(transport.request).not.toHaveBeenCalledWith('turn/start', expect.anything());
  });

  it('waits for the correct thread and the complete required inventory across pages', async () => {
    let notification: ((value: { method: string; params: unknown }) => void) | null = null;
    let ownedPages = 0;
    const requests: Array<{ method: string; params: unknown }> = [];
    const transport: LocalCodexAppServerTransport = {
      request: vi.fn(async (method, params) => {
        requests.push({ method, params });
        if (method === 'thread/resume') return { thread: { id: 'thread-existing' } };
        if (method === 'mcpServerStatus/list') {
          expect(params).toMatchObject({ threadId: 'thread-existing' });
          if (!(params as { cursor: string | null }).cursor)
            return {
              data: [{ name: 'other', tools: { mol_data: { name: 'mol_data' } } }],
              nextCursor: 'owned-page',
            };
          ownedPages++;
          return {
            data: [
              {
                name: 'dnaforge',
                tools: {
                  mol_data: { name: 'mol_data' },
                  ...(ownedPages > 1 ? { mol_apply_scene: { name: 'mol_apply_scene' } } : {}),
                },
              },
            ],
            nextCursor: null,
          };
        }
        if (method === 'turn/start') {
          expect(ownedPages).toBe(2);
          queueMicrotask(() =>
            notification?.({
              method: 'turn/completed',
              params: {
                threadId: 'thread-existing',
                turn: { id: 'turn-1', status: 'completed', error: null, items: [] },
              },
            })
          );
          return { turn: { id: 'turn-1' } };
        }
        throw new Error(`Unexpected request ${method}`);
      }),
      onNotification(listener) {
        notification = listener;
      },
      onServerRequest: vi.fn(),
      onExit: vi.fn(),
      interrupt: vi.fn(),
    };
    await expect(
      runLocalCodexAppServerTurn({
        transport,
        message: 'Color my structure.',
        cwd: '/workspace',
        conversationId: null,
        providerConversationId: 'thread-existing',
        config: { mcp_servers: { dnaforge: { command: '/app/mcp' } } },
        requiredMcpTools: ['mol_data', 'mol_apply_scene'],
        developerInstructions: 'Use DNAForge tools.',
        requestUserInput: vi.fn(),
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ ok: true });
    expect(requests.map(({ method }) => method)).toEqual([
      'thread/resume',
      'mcpServerStatus/list',
      'mcpServerStatus/list',
      'mcpServerStatus/list',
      'mcpServerStatus/list',
      'turn/start',
    ]);
  });

  it('stops during native inventory discovery without starting the model turn', async () => {
    const controller = new AbortController();
    const transport: LocalCodexAppServerTransport = {
      request: vi.fn(async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'mcpServerStatus/list') {
          controller.abort();
          return new Promise<never>(() => undefined);
        }
        throw new Error(`Unexpected request ${method}`);
      }),
      onNotification: vi.fn(),
      onServerRequest: vi.fn(),
      onExit: vi.fn(),
      interrupt: vi.fn(),
    };
    await expect(
      runLocalCodexAppServerTurn({
        transport,
        message: 'Color my structure.',
        cwd: '/workspace',
        conversationId: null,
        config: { mcp_servers: { dnaforge: { command: '/app/mcp' } } },
        developerInstructions: 'Use DNAForge tools.',
        requestUserInput: vi.fn(),
        signal: controller.signal,
      })
    ).rejects.toThrow('Stop requested.');
    expect(transport.request).not.toHaveBeenCalledWith('turn/start', expect.anything());
    expect(transport.interrupt).toHaveBeenCalledOnce();
  });

  it('does not start a model turn when its own runtime cannot read the attached app tools', async () => {
    let notification: ((value: { method: string; params: unknown }) => void) | null = null;
    const transport: LocalCodexAppServerTransport = {
      request: vi.fn(async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'mcpServerStatus/list')
          throw new Error('DNAForge tool inventory unavailable');
        if (method === 'turn/start') {
          queueMicrotask(() =>
            notification?.({
              method: 'turn/completed',
              params: {
                threadId: 'thread-1',
                turn: { id: 'turn-1', status: 'completed', error: null, items: [] },
              },
            })
          );
          return { turn: { id: 'turn-1' } };
        }
        throw new Error(`Unexpected request ${method}`);
      }),
      onNotification(listener) {
        notification = listener;
      },
      onServerRequest: vi.fn(),
      onExit: vi.fn(),
      interrupt: vi.fn(),
    };
    await expect(
      runLocalCodexAppServerTurn({
        transport,
        message: 'Color the supplied structure and save it.',
        cwd: '/workspace',
        conversationId: 'conversation-1',
        config: { mcp_servers: { dnaforge: { command: '/app/mcp' } } },
        developerInstructions: 'Use DNAForge tools.',
        requestUserInput: vi.fn(),
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('DNAForge tool inventory unavailable');
    expect(transport.request).not.toHaveBeenCalledWith('turn/start', expect.anything());
  });

  it('removes inherited tools and refuses a foreign MCP catalog before starting a fresh protein turn', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'config/read')
        return { config: { mcp_servers: { personal_files: { enabled: true } } } };
      if (method === 'thread/start') return { thread: { id: 'fresh', environments: [] } };
      if (method === 'mcpServerStatus/list')
        return {
          data: [
            {
              name: 'dnaforge',
              tools: { scene: { name: 'scene' } },
              resources: [],
              resourceTemplates: [],
            },
            {
              name: 'personal_files',
              tools: { read_file: {} },
              resources: [],
              resourceTemplates: [],
            },
          ],
          nextCursor: null,
        };
      throw new Error(`Unexpected ${method}`);
    });
    const supplied = { mcp_servers: { dnaforge: { command: '/companion', args: [] } } };
    expect(await freshMolecularAuthorConfig({ request }, '/scratch', supplied)).toMatchObject({
      ...FRESH_MOLECULAR_AUTHOR_CONFIG,
      mcp_servers: { personal_files: { enabled: false }, dnaforge: supplied.mcp_servers.dnaforge },
    });
    await expect(
      runLocalCodexAppServerTurn({
        transport: {
          request,
          onNotification: vi.fn(),
          onServerRequest: vi.fn(),
          onExit: vi.fn(),
          interrupt: vi.fn(),
        },
        message: 'fixed question',
        cwd: '/scratch',
        conversationId: 'fresh',
        config: supplied,
        molecularTrialAuthor: true,
        developerInstructions: 'fixed guidance',
        requestUserInput: vi.fn(),
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('refuse inherited MCP');
    expect(request).not.toHaveBeenCalledWith('turn/start', expect.anything());
    expect(request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        ephemeral: true,
        environments: [],
        sandbox: 'read-only',
        approvalPolicy: 'never',
        config: expect.objectContaining({ project_doc_max_bytes: 0 }),
      })
    );
  });
  it('refuses to start a protein author when the native runtime cannot confirm no environments', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'config/read') return { config: { mcp_servers: {} } };
      if (method === 'thread/start') return { thread: { id: 'unconfirmed', environments: null } };
      throw new Error(`Unexpected ${method}`);
    });
    await expect(
      runLocalCodexAppServerTurn({
        transport: {
          request,
          onNotification: vi.fn(),
          onServerRequest: vi.fn(),
          onExit: vi.fn(),
          interrupt: vi.fn(),
        },
        message: 'fixed question',
        cwd: '/scratch',
        conversationId: 'fresh',
        config: { mcp_servers: { dnaforge: { command: '/companion', args: [] } } },
        molecularTrialAuthor: true,
        developerInstructions: 'fixed guidance',
        requestUserInput: vi.fn(),
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('environment-free protein author thread');
    expect(request).not.toHaveBeenCalledWith('turn/start', expect.anything());
  });
  it('accepts a large local scene readback within the finite local frame limit', () => {
    const stdout = new EventEmitter();
    const kill = vi.fn();
    const child: SupervisedChild = {
      stdout,
      stdin: { write: vi.fn() },
      on: vi.fn(),
      kill,
    };
    const supervisor = new AppServerSupervisor({
      child,
      maxFrameBytes: LOCAL_CODEX_MAX_FRAME_BYTES,
      allowedNotifications: ['item/completed'],
    });
    const received = vi.fn();
    supervisor.setNotificationListener(received);
    const scene = 'x'.repeat(MAX_FRAME_BYTES + 1);
    stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          method: 'item/completed',
          params: { item: { type: 'mcpToolCall', result: { scene } } },
        })}\n`
      )
    );
    expect(received).toHaveBeenCalledExactlyOnceWith({
      method: 'item/completed',
      params: { item: { type: 'mcpToolCall', result: { scene } } },
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it.each(['oversized_frame', 'child_exit'] as const)(
    'reports the real supervisor termination reason for %s',
    async (reason) => {
      const stdout = new EventEmitter();
      const childEvents = new EventEmitter();
      const kill = vi.fn();
      let turnStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        turnStarted = resolve;
      });
      const child: SupervisedChild = {
        stdout,
        stdin: {
          write(chunk) {
            const request = JSON.parse(chunk) as { id: number; method: string };
            const result =
              request.method === 'thread/start'
                ? { thread: { id: 'thread-exit' } }
                : { turn: { id: 'turn-exit' } };
            stdout.emit('data', Buffer.from(`${JSON.stringify({ id: request.id, result })}\n`));
            if (request.method === 'turn/start') turnStarted();
          },
        },
        on: (event, listener) => {
          childEvents.on(event, listener);
        },
        kill,
      };
      const supervisor = new AppServerSupervisor({
        child,
        maxFrameBytes: LOCAL_CODEX_MAX_FRAME_BYTES,
      });
      const result = runLocalCodexAppServerTurn({
        transport: {
          request: (method, params) => supervisor.request(method, params),
          onNotification: (listener) => supervisor.setNotificationListener(listener),
          onServerRequest: (listener) => supervisor.setServerRequestHandler(listener),
          onExit: (listener) => supervisor.onExit(() => listener(supervisor.terminationReason)),
          interrupt: () => supervisor.interrupt(),
        },
        message: 'Explain the structure.',
        cwd: '/workspace',
        conversationId: 'conversation-exit',
        config: {},
        developerInstructions: 'Use DNAForge tools.',
        requestUserInput: vi.fn(),
        signal: new AbortController().signal,
      });
      await started;
      if (reason === 'oversized_frame') {
        stdout.emit('data', Buffer.alloc(LOCAL_CODEX_MAX_FRAME_BYTES + 1, 'x'));
      } else {
        childEvents.emit('exit', 1, null);
      }

      const outcome = await result;
      expect(outcome).toMatchObject({
        ok: false,
        threadId: 'thread-exit',
        turnId: 'turn-exit',
      });
      expect(supervisor.terminationReason).toBe(reason);
      if (reason === 'oversized_frame') {
        expect(outcome.error).toContain('message-size limit');
        expect(outcome.error).toContain('oversized_frame');
        expect(kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
      } else {
        expect(outcome.error).toBe('The Codex App Server exited.');
      }
    }
  );

  it('answers request_user_input and resumes the same App Server turn', async () => {
    let notification: ((value: { method: string; params: unknown }) => void) | null = null;
    let serverRequest:
      | ((value: {
          method: string;
          params: unknown;
          respond(result: unknown): void;
          refuse(message: string): void;
        }) => void)
      | null = null;
    const responses: unknown[] = [];
    const transport: LocalCodexAppServerTransport = {
      request: vi.fn(async (method, params) => {
        if (method === 'thread/start') {
          notification?.({
            method: 'mcpServer/startupStatus/updated',
            params: {
              threadId: null,
              name: 'dnaforge',
              status: 'failed',
              error: 'Unrelated global server',
              failureReason: null,
            },
          });
          return { thread: { id: 'thread-1' } };
        }
        if (method === 'mcpServerStatus/list')
          return {
            data: [{ name: 'dnaforge', tools: { get_workspace: { name: 'get_workspace' } } }],
            nextCursor: null,
          };
        if (method === 'turn/start') {
          queueMicrotask(() => {
            serverRequest?.({
              method: 'item/tool/requestUserInput',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                itemId: 'question-1',
                isBlocking: true,
                autoResolutionMs: null,
                questions: [
                  {
                    id: 'assembly',
                    header: 'Assembly',
                    question: 'Choose a method',
                    isOther: false,
                    isSecret: false,
                    options: [
                      { label: 'Gibson', description: 'Overlap assembly' },
                      { label: 'Golden Gate', description: 'Type IIS assembly' },
                    ],
                  },
                ],
              },
              respond(result) {
                responses.push(result);
                notification?.({
                  method: 'item/agentMessage/delta',
                  params: {
                    threadId: 'thread-1',
                    turnId: 'turn-1',
                    itemId: 'message-1',
                    delta: 'Using Golden Gate.',
                  },
                });
                notification?.({
                  method: 'item/completed',
                  params: {
                    threadId: 'thread-1',
                    turnId: 'turn-1',
                    completedAtMs: 2,
                    item: {
                      type: 'agentMessage',
                      id: 'message-1',
                      text: 'Using Golden Gate.',
                      phase: 'final_answer',
                      memoryCitation: null,
                    },
                  },
                });
                notification?.({
                  method: 'turn/completed',
                  params: {
                    threadId: 'thread-1',
                    turn: { id: 'turn-1', status: 'completed', error: null, items: [] },
                  },
                });
              },
              refuse: vi.fn(),
            });
          });
          return { turn: { id: 'turn-1' } };
        }
        throw new Error(`unexpected request ${method}: ${JSON.stringify(params)}`);
      }),
      onNotification(listener) {
        notification = listener;
      },
      onServerRequest(listener) {
        serverRequest = listener;
      },
      onExit: vi.fn(),
      interrupt: vi.fn(),
    };

    const requestUserInput = vi.fn(async () => ({
      outcome: 'submitted' as const,
      answers: { assembly: { selectedOptionIds: ['option-1'] } },
    }));
    const result = await runLocalCodexAppServerTurn({
      transport,
      message: 'Choose the assembly method and continue.',
      cwd: '/workspace',
      conversationId: 'conversation-1',
      serviceTier: 'priority',
      personality: 'pragmatic',
      config: { mcp_servers: { dnaforge: { command: '/app/mcp' } } },
      developerInstructions: 'Use DNAForge tools.',
      requestUserInput,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      ok: true,
      text: 'Using Golden Gate.',
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    expect(responses).toEqual([{ answers: { assembly: { answers: ['Golden Gate'] } } }]);
    expect(transport.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        cwd: '/workspace',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        config: { mcp_servers: { dnaforge: { command: '/app/mcp' } } },
        developerInstructions: 'Use DNAForge tools.',
        serviceTier: 'priority',
        personality: 'pragmatic',
      })
    );
    expect(transport.request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [
        { type: 'text', text: 'Choose the assembly method and continue.', text_elements: [] },
      ],
    });
  });

  it('answers an MCP form elicitation without ending the active turn', async () => {
    let notification: ((value: { method: string; params: unknown }) => void) | null = null;
    let serverRequest:
      | ((value: {
          method: string;
          params: unknown;
          respond(result: unknown): void;
          refuse(message: string): void;
        }) => void)
      | null = null;
    const responses: unknown[] = [];
    const transport: LocalCodexAppServerTransport = {
      request: vi.fn(async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-elicitation' } };
        if (method === 'turn/start') {
          queueMicrotask(() => {
            serverRequest?.({
              method: 'mcpServer/elicitation/request',
              params: {
                mode: 'form',
                threadId: 'thread-elicitation',
                turnId: 'turn-elicitation',
                serverName: 'dnaforge',
                _meta: null,
                message: 'Configure the assembly',
                requestedSchema: {
                  type: 'object',
                  required: ['method', 'replicates'],
                  properties: {
                    method: {
                      type: 'string',
                      title: 'Method',
                      enum: ['gibson', 'golden-gate'],
                    },
                    replicates: { type: 'integer', title: 'Replicates', default: 3 },
                  },
                },
              },
              respond(result) {
                responses.push(result);
                notification?.({
                  method: 'item/agentMessage/delta',
                  params: {
                    threadId: 'thread-elicitation',
                    turnId: 'turn-elicitation',
                    itemId: 'message-elicitation',
                    delta: 'Configured.',
                  },
                });
                notification?.({
                  method: 'turn/completed',
                  params: {
                    threadId: 'thread-elicitation',
                    turn: {
                      id: 'turn-elicitation',
                      status: 'completed',
                      error: null,
                      items: [],
                    },
                  },
                });
              },
              refuse: vi.fn(),
            });
          });
          return { turn: { id: 'turn-elicitation' } };
        }
        throw new Error(`unexpected request ${method}`);
      }),
      onNotification(listener) {
        notification = listener;
      },
      onServerRequest(listener) {
        serverRequest = listener;
      },
      onExit: vi.fn(),
      interrupt: vi.fn(),
    };
    const requestUserInput = vi.fn(async () => ({
      outcome: 'submitted' as const,
      answers: {
        method: { selectedOptionIds: ['gibson'] },
        replicates: { selectedOptionIds: [], text: '4' },
      },
    }));

    await expect(
      runLocalCodexAppServerTurn({
        transport,
        message: 'Configure the assembly.',
        cwd: '/workspace',
        conversationId: 'conversation-elicitation',
        config: {},
        developerInstructions: 'Use DNAForge tools.',
        requestUserInput,
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({
      ok: true,
      text: 'Configured.',
      threadId: 'thread-elicitation',
      turnId: 'turn-elicitation',
    });
    expect(requestUserInput).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-elicitation',
        provider: 'codex-sdk',
        questions: expect.arrayContaining([
          expect.objectContaining({ id: 'method', header: 'Method' }),
          expect.objectContaining({ id: 'replicates', header: 'Replicates' }),
        ]),
      }),
      expect.any(AbortSignal)
    );
    expect(responses).toEqual([
      {
        action: 'accept',
        content: { method: 'gibson', replicates: 4 },
        _meta: null,
      },
    ]);
  });

  it('resumes an existing native thread and interrupts the exact active turn on abort', async () => {
    let notification: ((value: { method: string; params: unknown }) => void) | null = null;
    const controller = new AbortController();
    const interrupt = vi.fn();
    const transport: LocalCodexAppServerTransport = {
      request: vi.fn(async (method) => {
        if (method === 'thread/resume') return { thread: { id: 'thread-existing' } };
        if (method === 'turn/start') {
          queueMicrotask(() => {
            notification?.({
              method: 'turn/started',
              params: { threadId: 'thread-existing', turn: { id: 'turn-2' } },
            });
            controller.abort();
            notification?.({
              method: 'turn/completed',
              params: {
                threadId: 'thread-existing',
                turn: { id: 'turn-2', status: 'interrupted', error: null, items: [] },
              },
            });
          });
          return { turn: { id: 'turn-2' } };
        }
        throw new Error(`unexpected request ${method}`);
      }),
      onNotification(listener) {
        notification = listener;
      },
      onServerRequest: vi.fn(),
      onExit: vi.fn(),
      interrupt,
    };

    await expect(
      runLocalCodexAppServerTurn({
        transport,
        message: 'Continue.',
        cwd: '/workspace',
        conversationId: null,
        providerConversationId: 'thread-existing',
        config: {},
        developerInstructions: 'Use DNAForge tools.',
        requestUserInput: vi.fn(),
        signal: controller.signal,
      })
    ).resolves.toMatchObject({ ok: false, threadId: 'thread-existing', turnId: 'turn-2' });
    expect(transport.request).toHaveBeenCalledWith(
      'thread/resume',
      expect.objectContaining({ threadId: 'thread-existing', cwd: '/workspace' })
    );
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it('retains partial text and provider-confirmed cancellation after Stop is acknowledged', async () => {
    let notification: ((value: { method: string; params: unknown }) => void) | null = null;
    const controller = new AbortController();
    const transport: LocalCodexAppServerTransport = {
      request: vi.fn(async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-confirmed-stop' } };
        if (method === 'turn/start') {
          queueMicrotask(() => {
            notification?.({
              method: 'turn/started',
              params: { threadId: 'thread-confirmed-stop', turn: { id: 'turn-confirmed-stop' } },
            });
            notification?.({
              method: 'item/agentMessage/delta',
              params: {
                threadId: 'thread-confirmed-stop',
                turnId: 'turn-confirmed-stop',
                itemId: 'message-confirmed-stop',
                delta: 'The sequence has a partial result.',
              },
            });
            controller.abort();
          });
          return { turn: { id: 'turn-confirmed-stop' } };
        }
        throw new Error(`Unexpected request ${method}`);
      }),
      onNotification(listener) {
        notification = listener;
      },
      onServerRequest: vi.fn(),
      onExit: vi.fn(),
      interrupt: vi.fn(() => {
        notification?.({
          method: 'turn/completed',
          params: {
            threadId: 'thread-confirmed-stop',
            turn: { id: 'turn-confirmed-stop', status: 'interrupted', error: null, items: [] },
          },
        });
      }),
    };

    const result = await runLocalCodexAppServerTurn({
      transport,
      message: 'Inspect the sequence.',
      cwd: '/workspace',
      conversationId: null,
      config: {},
      developerInstructions: 'Use DNAForge tools.',
      requestUserInput: vi.fn(),
      signal: controller.signal,
    });

    expect(transport.interrupt).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      text: 'The sequence has a partial result.',
      threadId: 'thread-confirmed-stop',
      turnId: 'turn-confirmed-stop',
      stopState: 'cancelled',
    });
  });

  it('grants the chat folder and every reachable project as writable on each turn', async () => {
    let notification: ((value: { method: string; params: unknown }) => void) | null = null;
    const transport: LocalCodexAppServerTransport = {
      request: vi.fn(async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-new' } };
        if (method === 'turn/start') {
          queueMicrotask(() => {
            notification?.({
              method: 'turn/completed',
              params: {
                threadId: 'thread-new',
                turn: { id: 'turn-1', status: 'completed', error: null, items: [] },
              },
            });
          });
          return { turn: { id: 'turn-1' } };
        }
        throw new Error(`unexpected request ${method}`);
      }),
      onNotification(listener) {
        notification = listener;
      },
      onServerRequest: vi.fn(),
      onExit: vi.fn(),
      interrupt: vi.fn(),
    };

    await runLocalCodexAppServerTurn({
      transport,
      message: 'Align these.',
      cwd: '/data/chats/conv-1',
      writableRoots: ['/data/projects/a', '/data/chats/conv-1', '/data/projects/b'],
      conversationId: 'conv-1',
      config: {},
      developerInstructions: 'Use DNAForge tools.',
      requestUserInput: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(transport.request).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: ['/data/chats/conv-1', '/data/projects/a', '/data/projects/b'],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      })
    );
  });

  it.each([
    [':read-only', ':read-only', 'on-request', 'user', undefined],
    [':danger-full-access', ':danger-full-access', undefined, undefined, undefined],
    [
      ':approve-for-me',
      ':workspace',
      'on-request',
      'auto_review',
      {
        type: 'workspaceWrite',
        writableRoots: ['/data/chats/conv-1', '/data/projects/a'],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    ],
  ] as const)(
    "selects Codex's %s menu item as profile %s, approval %s, reviewer %s",
    async (choice, profile, approvalPolicy, approvalsReviewer, sandboxPolicy) => {
      let notification: ((value: { method: string; params: unknown }) => void) | null = null;
      const transport: LocalCodexAppServerTransport = {
        request: vi.fn(async (method) => {
          if (method === 'thread/start') return { thread: { id: 'thread-new' } };
          if (method === 'turn/start') {
            queueMicrotask(() => {
              notification?.({
                method: 'turn/completed',
                params: {
                  threadId: 'thread-new',
                  turn: { id: 'turn-1', status: 'completed', error: null, items: [] },
                },
              });
            });
            return { turn: { id: 'turn-1' } };
          }
          throw new Error(`unexpected request ${method}`);
        }),
        onNotification(listener) {
          notification = listener;
        },
        onServerRequest: vi.fn(),
        onExit: vi.fn(),
        interrupt: vi.fn(),
      };

      await runLocalCodexAppServerTurn({
        transport,
        message: 'Align these.',
        cwd: '/data/chats/conv-1',
        writableRoots: ['/data/projects/a'],
        permissions: {
          ...BUILT_IN_AGENT_PERMISSIONS,
          codex: choice,
          ...(approvalPolicy ? { codexApproval: approvalPolicy } : {}),
          ...(approvalsReviewer ? { codexReviewer: approvalsReviewer } : {}),
        },
        conversationId: 'conv-1',
        config: {},
        developerInstructions: 'Use DNAForge tools.',
        requestUserInput: vi.fn(),
        signal: new AbortController().signal,
      });

      const request = vi.mocked(transport.request);
      const threadStart = request.mock.calls.find(([method]) => method === 'thread/start')?.[1];
      expect(threadStart).toMatchObject({ config: { default_permissions: profile } });
      expect(threadStart).not.toHaveProperty('sandbox');
      expect((threadStart as { approvalPolicy?: string }).approvalPolicy).toBe(approvalPolicy);
      expect((threadStart as { approvalsReviewer?: string }).approvalsReviewer).toBe(
        approvalsReviewer
      );
      const turnStart = request.mock.calls.find(([method]) => method === 'turn/start')?.[1];
      expect((turnStart as { sandboxPolicy?: unknown }).sandboxPolicy).toEqual(sandboxPolicy);
    }
  );
});

describe('validateLocalCodexProtocol', () => {
  it('accepts new fire-and-forget notifications when every server request has a decision', () => {
    expect(
      validateLocalCodexProtocol({
        client: ['initialize', 'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt'],
        server: [
          'item/tool/requestUserInput',
          'mcpServer/elicitation/request',
          'item/commandExecution/requestApproval',
          'item/fileChange/requestApproval',
          'item/permissions/requestApproval',
        ],
        notification: ['turn/started', 'turn/completed', 'project/changed'],
      })
    ).toEqual(
      expect.objectContaining({ notification: expect.arrayContaining(['project/changed']) })
    );
  });

  it('refuses protocol drift that adds an undecided server request', () => {
    expect(() =>
      validateLocalCodexProtocol({
        client: ['initialize', 'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt'],
        server: [
          'item/tool/requestUserInput',
          'mcpServer/elicitation/request',
          'item/commandExecution/requestApproval',
          'item/fileChange/requestApproval',
          'item/permissions/requestApproval',
          'machine/deleteEverything',
        ],
        notification: ['turn/completed'],
      })
    ).toThrow(/machine\/deleteEverything/u);
  });
});
