import { describe, expect, it, vi } from 'vitest';

import { createTestDb } from '../__tests__/test-db';
import { AgentStateCapsuleStore, createAgentStateCapsuleTable } from './agent-state-capsule';
import {
  buildHostedCodexToolCatalog,
  DENIED_NATIVE_TOOL_NAMES,
  type HostedCodexTool,
  type HostedCodexToolCatalog,
} from './dynamic-tool-catalog';
import { createRunBudget, type RunBudgetLimits } from './run-budget';
import { createTurnCoordinator } from './turn-coordinator';
import { createRecordingTurn } from './turn-recovery';
import {
  dispatchToolCall,
  ToolDispatchError,
  type ToolExecutor,
  type ToolCallRequest,
} from './tool-dispatch';

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

const WRITE_TOOL: HostedCodexTool = {
  name: 'write_thing',
  description: 'Writes a thing.',
  inputSchema: { type: 'object' },
  effects: ['mutating'],
  requiresWorkspace: true,
};

function catalog(
  tools: readonly HostedCodexTool[] = [READ_TOOL, WRITE_TOOL]
): HostedCodexToolCatalog {
  return { tools, digest: 'a'.repeat(64) };
}

interface Harness {
  readonly turn: ReturnType<typeof createRecordingTurn>;
  readonly store: AgentStateCapsuleStore;
  readonly runId: string;
}

function harness(): Harness {
  const db = createTestDb();
  createAgentStateCapsuleTable(db);
  const store = new AgentStateCapsuleStore(db);
  const runId = 'run-1';
  const turn = createRecordingTurn({
    runId,
    store,
    coordinator: createTurnCoordinator({
      budget: createRunBudget({ limits: LIMITS, now: () => 0 }),
    }),
    generations: { catalog: 'cat-1' },
  });
  turn.beginProviderStep();
  return { turn, store, runId };
}

function request(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return { callId: 'call-1', name: 'read_thing', input: { a: 1 }, ...overrides };
}

async function refusal(run: () => Promise<unknown>): Promise<ToolDispatchError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ToolDispatchError) return error;
    throw error;
  }
  throw new Error('expected the dispatch to be refused');
}

describe('dispatchToolCall', () => {
  describe('read-only calls', () => {
    it('runs a read without approval, effect, or observation', async () => {
      const h = harness();
      const execute: ToolExecutor = vi.fn(async () => ({
        outcome: 'applied' as const,
        output: { ok: true },
      }));
      const result = await dispatchToolCall(request(), {
        catalog: catalog(),
        turn: h.turn,
        execute,
        approve: async () => 'approved',
      });
      expect(result.output).toEqual({ ok: true });
      expect(execute).toHaveBeenCalledOnce();
      expect(h.turn.budgetSnapshot().toolCalls).toBe(1);
      expect(h.turn.budgetSnapshot().mutations).toBe(0);
    });

    it('checks gateway approval before executing a read', async () => {
      const h = harness();
      const approve = vi.fn(async () => 'approved' as const);
      await dispatchToolCall(request(), {
        catalog: catalog(),
        turn: h.turn,
        execute: async () => ({ outcome: 'applied', output: null }),
        approve,
      });
      expect(approve).toHaveBeenCalledOnce();
      expect(approve).toHaveBeenCalledWith(READ_TOOL, request());
    });

    it('does not execute a read whose signed ticket requires approval', async () => {
      const h = harness();
      const execute = vi.fn(async () => ({ outcome: 'no_effect' as const, output: null }));
      const error = await refusal(() =>
        dispatchToolCall(request(), {
          catalog: catalog(),
          turn: h.turn,
          execute,
          approve: async () => 'declined',
        })
      );
      expect(error.code).toBe('declined');
      expect(execute).not.toHaveBeenCalled();
      expect(h.turn.budgetSnapshot().mutations).toBe(0);
    });

    it('reports a read that failed without claiming anything changed', async () => {
      const h = harness();
      const error = await refusal(() =>
        dispatchToolCall(request(), {
          catalog: catalog(),
          turn: h.turn,
          execute: async () => {
            throw new Error('the file is gone');
          },
          approve: async () => 'approved',
        })
      );
      expect(error.code).toBe('execution_failed');
      expect(h.turn.outcome).not.toBe('outcome_unknown');
    });
  });

  describe('mutating calls', () => {
    it('claims, applies, and observes in that order', async () => {
      const h = harness();
      const order: string[] = [];
      await dispatchToolCall(request({ name: 'write_thing' }), {
        catalog: catalog(),
        turn: h.turn,
        execute: async () => {
          order.push('execute');
          return { outcome: 'applied', output: { written: true } };
        },
        approve: async () => {
          order.push('approve');
          return 'approved';
        },
      });
      expect(order).toEqual(['approve', 'execute']);
      expect(h.turn.budgetSnapshot().mutations).toBe(1);
    });

    it('does not execute a declined call', async () => {
      const h = harness();
      const execute = vi.fn(async () => ({ outcome: 'applied' as const, output: null }));
      const error = await refusal(() =>
        dispatchToolCall(request({ name: 'write_thing' }), {
          catalog: catalog(),
          turn: h.turn,
          execute,
          approve: async () => 'declined',
        })
      );
      expect(error.code).toBe('declined');
      expect(execute).not.toHaveBeenCalled();
      expect(h.turn.budgetSnapshot().mutations).toBe(0);
    });

    it('records the observation before the result is released', async () => {
      const h = harness();
      const result = await dispatchToolCall(request({ name: 'write_thing' }), {
        catalog: catalog(),
        turn: h.turn,
        execute: async () => ({ outcome: 'applied', output: { written: true } }),
        approve: async () => 'approved',
      });
      expect(() => h.turn.finish('completed')).not.toThrow();
      expect(result.outcome).toBe('applied');
    });

    it('reports an execution whose fate cannot be established as outcome-unknown', async () => {
      const h = harness();
      await dispatchToolCall(request({ name: 'write_thing' }), {
        catalog: catalog(),
        turn: h.turn,
        execute: async () => ({ outcome: 'outcome_unknown', output: null }),
        approve: async () => 'approved',
      });
      h.turn.finish('completed');
      expect(h.turn.outcome).toBe('outcome_unknown');
    });

    it('treats a write that threw as outcome-unknown, not as a clean failure', async () => {
      const h = harness();
      const error = await refusal(() =>
        dispatchToolCall(request({ name: 'write_thing' }), {
          catalog: catalog(),
          turn: h.turn,
          execute: async () => {
            throw new Error('disk went away mid-write');
          },
          approve: async () => 'approved',
        })
      );
      expect(error.code).toBe('execution_failed');
      h.turn.finish('failed');
      expect(h.turn.outcome).toBe('outcome_unknown');
    });
  });

  describe('what must fail closed', () => {
    it('refuses a name the catalog does not offer', async () => {
      const h = harness();
      const execute = vi.fn(async () => ({ outcome: 'applied' as const, output: null }));
      const error = await refusal(() =>
        dispatchToolCall(request({ name: 'not_offered' }), {
          catalog: catalog(),
          turn: h.turn,
          execute,
          approve: async () => 'approved',
        })
      );
      expect(error.code).toBe('unknown_tool');
      expect(execute).not.toHaveBeenCalled();
    });

    it.each([...DENIED_NATIVE_TOOL_NAMES])(
      'refuses the Codex built-in %s even if a catalog offers it',
      async (name) => {
        const h = harness();
        const rogue: HostedCodexTool = { ...WRITE_TOOL, name };
        const execute = vi.fn(async () => ({ outcome: 'applied' as const, output: null }));
        const error = await refusal(() =>
          dispatchToolCall(request({ name }), {
            catalog: catalog([rogue]),
            turn: h.turn,
            execute,
            approve: async () => 'approved',
          })
        );
        expect(error.code).toBe('denied_native_tool');
        expect(execute).not.toHaveBeenCalled();
      }
    );

    it('refuses to reuse a call id for different arguments', async () => {
      const h = harness();
      const options = {
        catalog: catalog(),
        turn: h.turn,
        execute: async () => ({ outcome: 'applied' as const, output: null }),
        approve: async () => 'approved' as const,
      };
      await dispatchToolCall(request({ input: { a: 1 } }), options);
      const error = await refusal(() => dispatchToolCall(request({ input: { a: 2 } }), options));
      expect(error.code).toBe('replayed_call');
    });

    it('refuses to reuse a call id for a different tool, even with identical arguments', async () => {
      const h = harness();
      const execute = vi.fn(async () => ({ outcome: 'applied' as const, output: { read: true } }));
      const approve = vi.fn(async () => 'approved' as const);
      const options = { catalog: catalog(), turn: h.turn, execute, approve };
      await dispatchToolCall(request({ name: 'read_thing', input: { a: 1 } }), options);
      const error = await refusal(() =>
        dispatchToolCall(request({ name: 'write_thing', input: { a: 1 } }), options)
      );
      expect(error.code).toBe('replayed_call');
      expect(execute).toHaveBeenCalledOnce();
      expect(approve).toHaveBeenCalledOnce();
    });

    it('returns the recorded result for an exact replay rather than running twice', async () => {
      const h = harness();
      const execute = vi.fn(async () => ({ outcome: 'applied' as const, output: { n: 1 } }));
      const options = {
        catalog: catalog(),
        turn: h.turn,
        execute,
        approve: async () => 'approved' as const,
      };
      const first = await dispatchToolCall(request(), options);
      const second = await dispatchToolCall(request(), options);
      expect(second).toEqual(first);
      expect(execute).toHaveBeenCalledOnce();
    });

    it('refuses to re-run a change that was in flight when the app died', async () => {
      const h = harness();
      const execute = vi.fn(async () => ({ outcome: 'applied' as const, output: null }));
      const error = await refusal(() =>
        dispatchToolCall(request({ callId: 'call-from-before', name: 'write_thing' }), {
          catalog: catalog(),
          turn: h.turn,
          execute,
          approve: async () => 'approved',
          unresolvedFromRecovery: ['call-from-before'],
        })
      );
      expect(error.code).toBe('outcome_unknown');
      expect(execute).not.toHaveBeenCalled();
    });

    it('still runs a call that was not outstanding when the app died', async () => {
      const h = harness();
      const execute = vi.fn(async () => ({ outcome: 'applied' as const, output: null }));
      await dispatchToolCall(request({ callId: 'a-new-call' }), {
        catalog: catalog(),
        turn: h.turn,
        execute,
        approve: async () => 'approved',
        unresolvedFromRecovery: ['some-other-call'],
      });
      expect(execute).toHaveBeenCalledOnce();
    });

    it('refuses once the turn is stopped', async () => {
      const h = harness();
      h.turn.stop();
      const execute = vi.fn(async () => ({ outcome: 'applied' as const, output: null }));
      await refusal(() =>
        dispatchToolCall(request(), {
          catalog: catalog(),
          turn: h.turn,
          execute,
          approve: async () => 'approved',
        })
      );
      expect(execute).not.toHaveBeenCalled();
    });

    it('refuses once the tool budget is spent', async () => {
      const db = createTestDb();
      createAgentStateCapsuleTable(db);
      const turn = createRecordingTurn({
        runId: 'run-2',
        store: new AgentStateCapsuleStore(db),
        coordinator: createTurnCoordinator({
          budget: createRunBudget({ limits: { ...LIMITS, toolCalls: 0 }, now: () => 0 }),
        }),
        generations: {},
      });
      turn.beginProviderStep();
      const execute = vi.fn(async () => ({ outcome: 'applied' as const, output: null }));
      const error = await refusal(() =>
        dispatchToolCall(request(), {
          catalog: catalog(),
          turn,
          execute,
          approve: async () => 'approved',
        })
      );
      expect(error.code).toBe('budget_exhausted');
      expect(execute).not.toHaveBeenCalled();
    });
  });

  it('uses the real catalog without special-casing it', async () => {
    const real = buildHostedCodexToolCatalog();
    const h = harness();
    const first = real.tools[0];
    if (!first) throw new Error('the real catalog offered nothing');
    const result = await dispatchToolCall(request({ name: first.name }), {
      catalog: real,
      turn: h.turn,
      execute: async () => ({ outcome: 'applied', output: 'ok' }),
      approve: async () => 'approved',
    });
    expect(result.output).toBe('ok');
  });
});
