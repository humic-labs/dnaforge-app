import { describe, expect, it, vi } from 'vitest';
import { HOSTED_TOOL_DISCOVERY_NAME } from '@waypoint/hosted-ai-contract';

import { createTestDb } from '../__tests__/test-db';
import { AgentStateCapsuleStore, createAgentStateCapsuleTable } from './agent-state-capsule';
import type { HostedCodexTool, HostedCodexToolCatalog } from './dynamic-tool-catalog';
import { createRunBudget, type RunBudgetLimits } from './run-budget';
import { createTurnCoordinator } from './turn-coordinator';
import { createRecordingTurn } from './turn-recovery';
import { PINNED_PROTOCOL_NOTIFICATIONS } from './app-server-protocol';
import * as hostedDiscovery from './hosted-tool-discovery';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  PROGRESS_NOTIFICATIONS,
  runHostedTurn,
  TurnLoopError,
  type ChildNotification,
  type IncomingToolRequest,
  type TurnDriver,
} from './turn-loop';

const LIMITS: RunBudgetLimits = {
  providerAttempts: 5,
  totalTokens: 10_000,
  spendMicros: 100_000,
  toolCalls: 10,
  mutations: 5,
  parallelEffects: 2,
  compactions: 2,
  recoveries: 2,
  deadlineMs: 600_000,
};

const READ_TOOL: HostedCodexTool = {
  name: 'read_thing',
  description: 'Reads a thing.',
  inputSchema: { type: 'object' },
  effects: ['read-only'],
  requiresWorkspace: false,
};

const CATALOG: HostedCodexToolCatalog = { tools: [READ_TOOL], digest: 'a'.repeat(64) };

function turn(limits: Partial<RunBudgetLimits> = {}) {
  const db = createTestDb();
  createAgentStateCapsuleTable(db);
  return createRecordingTurn({
    runId: 'run-1',
    store: new AgentStateCapsuleStore(db),
    coordinator: createTurnCoordinator({
      budget: createRunBudget({ limits: { ...LIMITS, ...limits }, now: () => 0 }),
    }),
    generations: {},
  });
}

type Scripted = ChildNotification | { readonly request: { method: string; params: unknown } };

function scriptedDriver(script: readonly Scripted[]): TurnDriver & {
  sent: unknown[];
  answers: { callId: unknown; result: unknown }[];
  refusals: string[];
  emit: (notification: ChildNotification) => void;
  exit: () => void;
} {
  const sent: unknown[] = [];
  const answers: { callId: unknown; result: unknown }[] = [];
  const refusals: string[] = [];
  let emit: ((notification: ChildNotification) => void) | null = null;
  let ask: ((request: IncomingToolRequest) => void) | null = null;
  let exit: (() => void) | null = null;
  return {
    sent,
    answers,
    refusals,
    emit: (notification: ChildNotification) => emit?.(notification),
    exit: () => exit?.(),
    send: async (message) => {
      sent.push(message);
      for (const entry of script) {
        if ('request' in entry) {
          const params = entry.request.params as { callId?: unknown };
          ask?.({
            method: entry.request.method,
            params: entry.request.params,
            respond: (result) => answers.push({ callId: params.callId, result }),
            refuse: (message) => refusals.push(message),
          });
        } else {
          emit?.(entry);
        }
      }
    },
    onNotification: (listener) => {
      emit = listener;
    },
    onServerRequest: (listener) => {
      ask = listener;
    },
    onExit: (listener) => {
      exit = listener;
    },
  };
}

function toolCall(callId: string, tool: string, args: unknown = {}): Scripted {
  return {
    request: {
      method: 'item/tool/call',
      params: { callId, tool, arguments: args, threadId: 'thread-1', turnId: 'turn-1' },
    },
  };
}

const COMPLETED: ChildNotification = {
  method: 'turn/completed',
  params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
};
const FAILED: ChildNotification = { method: 'error', params: { message: 'provider said no' } };

async function refusal(run: () => Promise<unknown>): Promise<TurnLoopError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof TurnLoopError) return error;
    throw error;
  }
  throw new Error('expected the turn loop to refuse');
}

describe('runHostedTurn', () => {
  it('publishes the awaited trusted discovery page before responding to the child', async () => {
    const page = { tools: [READ_TOOL], total: 1, nextOffset: null };
    let release!: (value: typeof page) => void;
    const held = new Promise<typeof page>((resolve) => {
      release = resolve;
    });
    const discover = vi.fn(() => held);
    const factory = vi
      .spyOn(hostedDiscovery, 'createHostedToolDiscovery')
      .mockReturnValue(discover);
    const child = scriptedDriver([
      toolCall('discover-1', HOSTED_TOOL_DISCOVERY_NAME, { query: 'read_thing' }),
      COMPLETED,
    ]);
    const order: string[] = [];
    const driver: TurnDriver = {
      ...child,
      onServerRequest: (listener) =>
        child.onServerRequest((request) =>
          listener({
            ...request,
            respond: (result) => {
              order.push('respond');
              request.respond(result);
            },
          })
        ),
    };
    const onToolDiscovery = vi.fn(() => {
      order.push('publish');
    });
    let running: ReturnType<typeof runHostedTurn> | undefined;
    try {
      running = runHostedTurn({
        turn: turn(),
        driver,
        catalog: CATALOG,
        message: 'inspect',
        execute: async () => ({ outcome: 'applied', output: null }),
        approve: async () => 'approved',
        onToolDiscovery,
      });
      await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce());
      expect(onToolDiscovery).not.toHaveBeenCalled();
      expect(child.answers).toEqual([]);
      release(page);
      await expect(running).resolves.toMatchObject({ outcome: 'completed' });
      expect(onToolDiscovery).toHaveBeenCalledExactlyOnceWith(page);
      expect(order).toEqual(['publish', 'respond']);
      expect(child.answers).toEqual([{ callId: 'discover-1', result: page }]);
    } finally {
      release(page);
      await running?.catch(() => undefined);
      factory.mockRestore();
    }
  });

  it('does not retain or respond with a late discovery page after Stop wins the await', async () => {
    const page = { tools: [READ_TOOL], total: 1, nextOffset: null };
    let release!: (value: typeof page) => void;
    const held = new Promise<typeof page>((resolve) => {
      release = resolve;
    });
    const discover = vi.fn(() => held);
    const factory = vi
      .spyOn(hostedDiscovery, 'createHostedToolDiscovery')
      .mockReturnValue(discover);
    const driver = scriptedDriver([
      toolCall('discover-stop', HOSTED_TOOL_DISCOVERY_NAME, { query: 'read_thing' }),
      COMPLETED,
    ]);
    const current = turn();
    const onToolDiscovery = vi.fn();
    let running: ReturnType<typeof runHostedTurn> | undefined;
    try {
      running = runHostedTurn({
        turn: current,
        driver,
        catalog: CATALOG,
        message: 'inspect',
        execute: async () => ({ outcome: 'applied', output: null }),
        approve: async () => 'approved',
        onToolDiscovery,
      });
      await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce());
      current.stop();
      release(page);
      await expect(running).resolves.toMatchObject({ outcome: 'stopped' });
      expect(onToolDiscovery).not.toHaveBeenCalled();
      expect(driver.answers).toEqual([]);
      expect(driver.refusals).toEqual(['stopped']);
    } finally {
      release(page);
      await running?.catch(() => undefined);
      factory.mockRestore();
    }
  });

  it('lets a long provider step stay silent for the reviewed ten-minute bound', () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(10 * 60_000);
  });

  it('fails immediately when the child exits before a terminal outcome', async () => {
    const driver = scriptedDriver([]);
    const running = runHostedTurn({
      turn: turn(),
      driver,
      catalog: CATALOG,
      message: 'summarize the plate',
      execute: async () => ({ outcome: 'applied', output: null }),
      approve: async () => 'approved',
      idleTimeoutMs: 60_000,
    });

    driver.exit();

    const error = await refusal(() => running);
    expect(error.code).toBe('child_exited');
  });

  it('preserves a stopped streamed answer when shutdown beats the child terminal event', async () => {
    const driver = scriptedDriver([
      { method: 'item/agentMessage/delta', params: { delta: 'partial answer' } },
    ]);
    const subject = turn();
    const running = runHostedTurn({
      turn: subject,
      driver,
      catalog: CATALOG,
      message: 'keep streaming',
      execute: async () => ({ outcome: 'applied', output: null }),
      approve: async () => 'approved',
    });

    subject.stop();
    driver.exit();

    await expect(running).resolves.toEqual({ outcome: 'stopped', text: 'partial answer' });
    expect(subject.phase).toBe('finished');
  });

  it('keeps unresolved effects blocked when a stopped child exits', async () => {
    const driver = scriptedDriver([]);
    const subject = turn();
    const running = runHostedTurn({
      turn: subject,
      driver,
      catalog: CATALOG,
      message: 'apply the reviewed change',
      execute: async () => ({ outcome: 'applied', output: null }),
      approve: async () => 'approved',
    });
    subject.beginApproval('unfinished-write');
    subject.settleApproval('unfinished-write', 'approved');
    subject.beginEffect('unfinished-write');
    subject.stop();
    driver.exit();

    const error = await refusal(() => running);
    expect(error.code).toBe('refused');
    expect(subject.phase).not.toBe('finished');
    expect(subject.outcome).toBeNull();
  });

  it('sends the user message and completes on the turn-completed event', async () => {
    const driver = scriptedDriver([COMPLETED]);
    const subject = turn();
    const result = await runHostedTurn({
      turn: subject,
      driver,
      catalog: CATALOG,
      message: 'summarize the plate',
      execute: async () => ({ outcome: 'applied', output: null }),
      approve: async () => 'approved',
    });
    expect(driver.sent).toEqual(['summarize the plate']);
    expect(result.outcome).toBe('completed');
    expect(result.text).toBe('');
    expect(subject.phase).toBe('finished');
  });

  it('reads exact streamed assistant text before returning', async () => {
    const driver = scriptedDriver([
      {
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'two ' },
      },
      {
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'files' },
      },
      COMPLETED,
    ]);
    const onTextDelta = vi.fn();

    const result = await runHostedTurn({
      turn: turn(),
      driver,
      catalog: CATALOG,
      message: 'hello',
      execute: async () => ({ outcome: 'applied', output: null }),
      approve: async () => 'approved',
      onTextDelta,
    });

    expect(result.text).toBe('two files');
    expect(onTextDelta.mock.calls).toEqual([['two '], ['files']]);
  });

  it('preserves typed child failure facts without carrying the raw provider message', async () => {
    const driver = scriptedDriver([
      {
        method: 'error',
        params: {
          error: {
            message: 'deployment staging-secret-model failed at https://private.example.invalid',
            codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 503 } },
            additionalDetails: '{"provider":"internal"}',
          },
          willRetry: false,
          threadId: 'thread-secret',
          turnId: 'turn-secret',
        },
      },
    ]);

    const result = await runHostedTurn({
      turn: turn(),
      driver,
      catalog: CATALOG,
      message: 'hello',
      execute: async () => ({ outcome: 'applied', output: null }),
      approve: async () => 'approved',
    });

    expect(result).toEqual({
      outcome: 'failed',
      text: '',
      failure: {
        code: 'response_stream_connection_failed',
        httpStatusCode: 503,
        willRetry: false,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /staging-secret-model|private\.example|thread-secret|turn-secret|provider/u
    );
  });

  it('keeps listening when the child says it will retry the failure', async () => {
    const driver = scriptedDriver([
      {
        method: 'error',
        params: {
          error: {
            message: 'temporary stream interruption',
            codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
            additionalDetails: null,
          },
          willRetry: true,
          threadId: 'thread-1',
          turnId: 'turn-1',
        },
      },
      {
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'recovered' },
      },
      COMPLETED,
    ]);

    const result = await runHostedTurn({
      turn: turn(),
      driver,
      catalog: CATALOG,
      message: 'hello',
      execute: async () => ({ outcome: 'applied', output: null }),
      approve: async () => 'approved',
    });

    expect(result).toEqual({ outcome: 'completed', text: 'recovered' });
  });

  it('charges a provider step before the child is asked to do anything', async () => {
    const driver = scriptedDriver([COMPLETED]);
    const subject = turn();
    await runHostedTurn({
      turn: subject,
      driver,
      catalog: CATALOG,
      message: 'hello',
      execute: async () => ({ outcome: 'applied', output: null }),
      approve: async () => 'approved',
    });
    expect(subject.budgetSnapshot().providerAttempts).toBe(1);
  });

  it('routes a tool call through the dispatcher and answers the child', async () => {
    const driver = scriptedDriver([toolCall('call-1', 'read_thing', { a: 1 }), COMPLETED]);
    const execute = vi.fn(async () => ({ outcome: 'applied' as const, output: { rows: 2 } }));
    await runHostedTurn({
      turn: turn(),
      driver,
      catalog: CATALOG,
      message: 'hello',
      execute,
      approve: async () => 'approved',
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(driver.answers).toEqual([{ callId: 'call-1', result: { rows: 2 } }]);
  });

  it('answers a Hosted Codex structured question through the shared conversation card', async () => {
    const driver = scriptedDriver([
      {
        request: {
          method: 'item/tool/requestUserInput',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'question-1',
            isBlocking: true,
            autoResolutionMs: null,
            questions: [
              {
                id: 'method',
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
        },
      },
      COMPLETED,
    ]);
    const requestUserInput = vi.fn(async (request) => {
      expect(request).toMatchObject({
        provider: 'hosted-codex',
        conversationId: 'workflow-1',
      });
      return {
        outcome: 'submitted' as const,
        answers: { method: { selectedOptionIds: ['option-1'] } },
      };
    });

    await expect(
      runHostedTurn({
        turn: turn(),
        driver,
        catalog: CATALOG,
        message: 'choose and continue',
        execute: async () => ({ outcome: 'applied', output: null }),
        approve: async () => 'approved',
        requestUserInput,
        conversationId: 'workflow-1',
      })
    ).resolves.toMatchObject({ outcome: 'completed' });
    expect(driver.answers).toEqual([
      {
        callId: undefined,
        result: { answers: { method: { answers: ['Golden Gate'] } } },
      },
    ]);
  });

  it('tells the child a refused tool call was refused rather than silently dropping it', async () => {
    const driver = scriptedDriver([toolCall('call-1', 'not_offered'), COMPLETED]);
    const execute = vi.fn(async () => ({ outcome: 'applied' as const, output: null }));
    await runHostedTurn({
      turn: turn(),
      driver,
      catalog: CATALOG,
      message: 'hello',
      execute,
      approve: async () => 'approved',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(driver.refusals).toEqual(['unknown_tool']);
  });

  it('treats every notification the supervisor accepts as progress', () => {
    const terminal = ['turn/completed', 'error'];
    const unhandled = PINNED_PROTOCOL_NOTIFICATIONS.filter(
      (method) => !terminal.includes(method) && !PROGRESS_NOTIFICATIONS.has(method)
    );
    expect(unhandled).toEqual([]);
  });

  it('does not abort the turn on the status update a real session always sends', async () => {
    const driver = scriptedDriver([
      { method: 'remoteControl/status/changed', params: { status: 'disabled' } },
      COMPLETED,
    ]);
    const result = await runHostedTurn({
      turn: turn(),
      driver,
      catalog: CATALOG,
      message: 'hello',
      execute: async () => ({ outcome: 'applied', output: null }),
      approve: async () => 'approved',
    });
    expect(result.outcome).toBe('completed');
  });

  it('does not abort on the clean-runner config warning emitted before a turn starts', async () => {
    const driver = scriptedDriver([
      {
        method: 'configWarning',
        params: {
          summary: 'Could not load optional user configuration',
          details: null,
        },
      },
      { method: 'thread/started', params: { thread: { id: 'thread-1' } } },
      COMPLETED,
    ]);
    const result = await runHostedTurn({
      turn: turn(),
      driver,
      catalog: CATALOG,
      message: 'hello',
      execute: async () => ({ outcome: 'applied', output: null }),
      approve: async () => 'approved',
    });
    expect(result.outcome).toBe('completed');
  });

  describe('what ends the turn', () => {
    it.each([
      ['failed', 'failed'],
      ['interrupted', 'stopped'],
    ] as const)('uses the real terminal status %s', async (status, expected) => {
      const driver = scriptedDriver([
        {
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status } },
        },
      ]);
      const result = await runHostedTurn({
        turn: turn(),
        driver,
        catalog: CATALOG,
        message: 'hello',
        execute: async () => ({ outcome: 'applied', output: null }),
        approve: async () => 'approved',
      });
      expect(result.outcome).toBe(expected);
    });

    it.each([
      {},
      { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } },
      { threadId: 'thread-1', turn: { id: 'turn-1', status: 'something-new' } },
    ])('fails closed on a malformed or nonterminal completion %#', async (params) => {
      const error = await refusal(() =>
        runHostedTurn({
          turn: turn(),
          driver: scriptedDriver([{ method: 'turn/completed', params }]),
          catalog: CATALOG,
          message: 'hello',
          execute: async () => ({ outcome: 'applied', output: null }),
          approve: async () => 'approved',
        })
      );
      expect(error.code).toBe('unexpected_notification');
    });

    it('reports a turn the child failed', async () => {
      const driver = scriptedDriver([FAILED]);
      const subject = turn();
      const result = await runHostedTurn({
        turn: subject,
        driver,
        catalog: CATALOG,
        message: 'hello',
        execute: async () => ({ outcome: 'applied', output: null }),
        approve: async () => 'approved',
      });
      expect(result.outcome).toBe('failed');
      expect(subject.phase).toBe('finished');
    });

    it('ends the turn on a notification this build does not model', async () => {
      const driver = scriptedDriver([{ method: 'turn/somethingNew', params: {} }]);
      const error = await refusal(() =>
        runHostedTurn({
          turn: turn(),
          driver,
          catalog: CATALOG,
          message: 'hello',
          execute: async () => ({ outcome: 'applied', output: null }),
          approve: async () => 'approved',
        })
      );
      expect(error.code).toBe('unexpected_notification');
    });

    it('ends the turn on a notification method this build does not model', async () => {
      const driver = scriptedDriver([{ method: 'workspace/readFile', params: {} }]);
      const error = await refusal(() =>
        runHostedTurn({
          turn: turn(),
          driver,
          catalog: CATALOG,
          message: 'hello',
          execute: async () => ({ outcome: 'applied', output: null }),
          approve: async () => 'approved',
        })
      );
      expect(error.code).toBe('unexpected_notification');
    });

    it('does not abandon a child that is still talking', async () => {
      const driver = scriptedDriver([]);
      let stop = false;
      const running = runHostedTurn({
        turn: turn(),
        driver,
        catalog: CATALOG,
        message: 'hello',
        execute: async () => ({ outcome: 'applied', output: null }),
        approve: async () => 'approved',
        idleTimeoutMs: 200,
      });
      const chatter = (async () => {
        for (let i = 0; i < 8 && !stop; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 80));
          driver.emit({ method: 'item/agentMessage/delta', params: { delta: 'x' } });
        }
        driver.emit(COMPLETED);
      })();
      const result = await running;
      stop = true;
      await chatter;
      expect(result.outcome).toBe('completed');
    }, 15_000);

    it('does not blame the child for time this runtime spends in a tool', async () => {
      const driver = scriptedDriver([toolCall('call-1', 'read_thing')]);
      const result = await runHostedTurn({
        turn: turn(),
        driver,
        catalog: CATALOG,
        message: 'hello',
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 900));
          const answer = { outcome: 'applied' as const, output: { slow: true } };
          setTimeout(() => driver.emit(COMPLETED), 10);
          return answer;
        },
        approve: async () => 'approved',
        idleTimeoutMs: 250,
      });
      expect(result.outcome).toBe('completed');
      expect(driver.answers).toEqual([{ callId: 'call-1', result: { slow: true } }]);
    }, 15_000);

    it('starts blaming the child again once its answer has been delivered', async () => {
      const driver = scriptedDriver([toolCall('call-1', 'read_thing')]);
      const error = await refusal(() =>
        runHostedTurn({
          turn: turn(),
          driver,
          catalog: CATALOG,
          message: 'hello',
          execute: async () => ({ outcome: 'applied', output: null }),
          approve: async () => 'approved',
          idleTimeoutMs: 200,
        })
      );
      expect(error.code).toBe('child_went_quiet');
      expect(driver.answers).toHaveLength(1);
    }, 15_000);

    it('ends the turn when the child stops talking without finishing', async () => {
      const driver = scriptedDriver([]);
      const error = await refusal(() =>
        runHostedTurn({
          turn: turn(),
          driver,
          catalog: CATALOG,
          message: 'hello',
          execute: async () => ({ outcome: 'applied', output: null }),
          approve: async () => 'approved',
          idleTimeoutMs: 50,
        })
      );
      expect(error.code).toBe('child_went_quiet');
    });
  });

  describe('what it must not do', () => {
    it('surfaces a budget refusal rather than continuing without one', async () => {
      const driver = scriptedDriver([COMPLETED]);
      const error = await refusal(() =>
        runHostedTurn({
          turn: turn({ providerAttempts: 0 }),
          driver,
          catalog: CATALOG,
          message: 'hello',
          execute: async () => ({ outcome: 'applied', output: null }),
          approve: async () => 'approved',
        })
      );
      expect(error.code).toBe('refused');
      expect(driver.sent).toEqual([]);
    });

    it('never retries a provider step', async () => {
      const driver = scriptedDriver([FAILED]);
      const subject = turn();
      await runHostedTurn({
        turn: subject,
        driver,
        catalog: CATALOG,
        message: 'hello',
        execute: async () => ({ outcome: 'applied', output: null }),
        approve: async () => 'approved',
      });
      expect(subject.budgetSnapshot().providerAttempts).toBe(1);
      expect(driver.sent).toHaveLength(1);
    });

    it('honours a Stop that arrives mid-turn', async () => {
      const subject = turn();
      const driver = scriptedDriver([toolCall('call-1', 'read_thing'), COMPLETED]);
      const execute = vi.fn(async () => {
        subject.stop();
        return { outcome: 'applied' as const, output: null };
      });
      const result = await runHostedTurn({
        turn: subject,
        driver,
        catalog: CATALOG,
        message: 'hello',
        execute,
        approve: async () => 'approved',
      });
      expect(result.outcome).toBe('stopped');
    });
  });

  it('waits for a tool call still running when the child says the turn is done', async () => {
    let release = (): void => {};
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const driver = scriptedDriver([toolCall('call-1', 'read_thing'), COMPLETED]);
    let finishedExecuting = false;
    const execute = vi.fn(async () => {
      await started;
      finishedExecuting = true;
      return { outcome: 'applied' as const, output: { done: true } };
    });

    const running = runHostedTurn({
      turn: turn(),
      driver,
      catalog: CATALOG,
      message: 'hello',
      execute,
      approve: async () => 'approved',
    });
    expect(finishedExecuting).toBe(false);
    release();
    await running;
    expect(finishedExecuting).toBe(true);
    expect(driver.answers).toEqual([{ callId: 'call-1', result: { done: true } }]);
  });

  it('does not return while a change is still applying', async () => {
    const subject = turn();
    const driver = scriptedDriver([COMPLETED]);
    subject.beginProviderStep();
    subject.beginApproval('stuck');
    subject.settleApproval('stuck', 'approved');
    subject.beginEffect('stuck');
    const error = await refusal(() =>
      runHostedTurn({
        turn: subject,
        driver,
        catalog: CATALOG,
        message: 'hello',
        execute: async () => ({ outcome: 'applied', output: null }),
        approve: async () => 'approved',
      })
    );
    expect(error.code).toBe('refused');
  });
});
