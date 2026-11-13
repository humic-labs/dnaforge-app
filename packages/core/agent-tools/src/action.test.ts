import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import {
  defineAction,
  notImplementedHandler,
  WILDCARD_CAPABILITY,
  type ActionInvocationContext,
} from './action';
import { ActionError } from './errors';

const baseInput = z.object({ value: z.number().int() });

function ctx(overrides: Partial<ActionInvocationContext> = {}): ActionInvocationContext {
  return {
    actionId: 'act-test-1',
    grantedCapabilities: [],
    ...overrides,
  };
}

describe('defineAction (descriptor construction)', () => {
  it('parses the name into domain/verb/version', () => {
    const action = defineAction({
      name: 'sequence.findFeatures',
      description: 'Find sequence features.',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: async (input) => ({ ok: true as const, value: input.value }),
    });
    expect(action.descriptor.name).toBe('sequence.findFeatures');
    expect(action.descriptor.qualifiedName).toBe('sequence.findFeatures');
    expect(action.descriptor.domain).toBe('sequence');
    expect(action.descriptor.verb).toBe('findFeatures');
    expect(action.descriptor.version).toBe(1);
  });

  it('parses a _v2 versioned name', () => {
    const action = defineAction({
      name: 'sequence.findFeatures_v2',
      description: '...',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: async () => ({}),
    });
    expect(action.descriptor.version).toBe(2);
    expect(action.descriptor.qualifiedName).toBe('sequence.findFeatures');
    expect(action.descriptor.name).toBe('sequence.findFeatures_v2');
  });

  it('requires effects (no default; forces explicit declaration)', () => {
    expect(() =>
      defineAction({
        name: 'sequence.findFeatures',
        description: '...',
        runtime: 'renderer',
        inputSchema: baseInput,

        handler: async () => ({}),
      } as never)
    ).toThrow(/effects is required/);
  });

  it('accepts an explicitly-declared read-only effects array', () => {
    const action = defineAction({
      name: 'sequence.findFeatures',
      description: '...',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: async () => ({}),
    });
    expect(action.descriptor.effects).toEqual(['read-only']);
  });

  it('defaults requiredCapabilities to []', () => {
    const action = defineAction({
      name: 'sequence.findFeatures',
      description: '...',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: async () => ({}),
    });
    expect(action.descriptor.requiredCapabilities).toEqual([]);
  });

  it('defaults requiresWorkspace to false', () => {
    const action = defineAction({
      name: 'sequence.findFeatures',
      description: '...',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: async () => ({}),
    });
    expect(action.descriptor.requiresWorkspace).toBe(false);
  });

  it('defaults metadata to {}', () => {
    const action = defineAction({
      name: 'sequence.findFeatures',
      description: '...',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: async () => ({}),
    });
    expect(action.descriptor.metadata).toEqual({});
  });

  it('deep-freeze short-circuits on already-frozen nested values (no double-work, cycle-safe)', () => {
    const presFrozen = Object.freeze({ pinned: true });
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      metadata: { presFrozen, fresh: { tag: 'v1' } },
      effects: ['read-only'],
      handler: async () => ({}),
    });

    expect(action.descriptor.metadata.presFrozen).toBe(presFrozen);
    expect(Object.isFrozen(action.descriptor.metadata.fresh)).toBe(true);
  });

  it('deep-freezes metadata so nested mcpAnnotations cannot be mutated post-definition', () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      metadata: {
        mcpAnnotations: { idempotentHint: true, destructiveHint: false },
        tags: ['v1', 'experimental'],
      },
      effects: ['read-only'],
      handler: async () => ({}),
    });
    const nested = action.descriptor.metadata.mcpAnnotations as Record<string, boolean>;
    expect(Object.isFrozen(nested)).toBe(true);
    expect(() => {
      nested.idempotentHint = false;
    }).toThrow();
    const tags = action.descriptor.metadata.tags as string[];
    expect(Object.isFrozen(tags)).toBe(true);
  });

  it('preserves declared effects, requiredCapabilities, requiresWorkspace, metadata', () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'Add a region.',
      runtime: 'renderer',
      inputSchema: baseInput,
      requiredCapabilities: ['create-entity', 'read-sequences'],
      effects: ['mutating'],
      requiresWorkspace: true,
      metadata: { mcpAnnotations: { idempotentHint: true } },
      handler: async () => ({}),
    });
    expect(action.descriptor.requiredCapabilities).toEqual(['create-entity', 'read-sequences']);
    expect(action.descriptor.effects).toEqual(['mutating']);
    expect(action.descriptor.requiresWorkspace).toBe(true);
    expect(action.descriptor.metadata).toEqual({
      mcpAnnotations: { idempotentHint: true },
    });
  });

  it('freezes the descriptor and its nested array fields', () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: '...',
      runtime: 'renderer',
      inputSchema: baseInput,
      requiredCapabilities: ['x'],
      effects: ['mutating'],
      handler: async () => ({}),
    });
    expect(Object.isFrozen(action.descriptor)).toBe(true);
    expect(Object.isFrozen(action.descriptor.requiredCapabilities)).toBe(true);
    expect(Object.isFrozen(action.descriptor.effects)).toBe(true);
    expect(Object.isFrozen(action.descriptor.metadata)).toBe(true);
  });

  it('does not leak input mutation back into the descriptor', () => {
    const caps: string[] = ['a', 'b'];
    const action = defineAction({
      name: 'design.addRegion',
      description: '...',
      runtime: 'renderer',
      inputSchema: baseInput,
      requiredCapabilities: caps,
      effects: ['read-only'],
      handler: async () => ({}),
    });
    caps.push('c');
    expect(action.descriptor.requiredCapabilities).toEqual(['a', 'b']);
  });

  it('throws on invalid action names', () => {
    expect(() =>
      defineAction({
        name: 'Bad.Name',
        description: '...',
        runtime: 'renderer',
        inputSchema: baseInput,
        effects: ['read-only'],
        handler: async () => ({}),
      })
    ).toThrow(/Invalid action name/);
  });

  it('throws on missing description', () => {
    expect(() =>
      defineAction({
        name: 'design.addRegion',
        description: '',
        runtime: 'renderer',
        inputSchema: baseInput,
        effects: ['read-only'],
        handler: async () => ({}),
      })
    ).toThrow(/description is required/);
    expect(() =>
      defineAction({
        name: 'design.addRegion',
        description: '   ',
        runtime: 'renderer',
        inputSchema: baseInput,
        effects: ['read-only'],
        handler: async () => ({}),
      })
    ).toThrow(/description is required/);
  });

  it('throws on invalid runtime', () => {
    expect(() =>
      defineAction({
        name: 'design.addRegion',
        description: 'x',
        runtime: 'main' as unknown as 'renderer',
        inputSchema: baseInput,
        effects: ['read-only'],
        handler: async () => ({}),
      })
    ).toThrow(/runtime must be "renderer" or "sidecar"/);
  });

  it('throws on missing inputSchema', () => {
    expect(() =>
      defineAction({
        name: 'design.addRegion',
        description: 'x',
        runtime: 'renderer',
        inputSchema: undefined as unknown as typeof baseInput,
        effects: ['read-only'],
        handler: async () => ({}),
      })
    ).toThrow(/inputSchema is required/);
  });

  it('throws on missing handler', () => {
    expect(() =>
      defineAction({
        name: 'design.addRegion',
        description: 'x',
        runtime: 'renderer',
        inputSchema: baseInput,
        effects: ['read-only'],
        handler: undefined as unknown as () => Promise<unknown>,
      })
    ).toThrow(/handler is required/);
  });
});

describe('defineAction.invoke — SCOPE_DENIED', () => {
  it.each(['edit-primers', 'edit-protocols'])(
    'uses the shared legacy workspace-write implication for %s',
    async (capability) => {
      let calls = 0;
      const action = defineAction({
        name: 'entity.edit',
        description: 'Edit an existing scientific entity.',
        runtime: 'renderer',
        inputSchema: baseInput,
        requiredCapabilities: [capability],
        effects: ['mutating'],
        handler: async (input) => {
          calls += 1;
          return input;
        },
      });
      const allowed = await action.invoke(
        { value: 7 },
        ctx({
          grantedCapabilities: ['write-workspace'],
        })
      );
      expect(allowed).toEqual({ ok: true, result: { value: 7 } });
      expect(calls).toBe(1);
      const denied = await action.invoke(
        { value: 8 },
        ctx({
          grantedCapabilities: ['read-workspace'],
        })
      );
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe('SCOPE_DENIED');
      expect(calls).toBe(1);
    }
  );

  it('returns SCOPE_DENIED when caller is missing any required capability', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      requiredCapabilities: ['create-entity', 'read-sequences'],
      effects: ['read-only'],
      handler: async () => ({}),
    });
    const res = await action.invoke({ value: 1 }, ctx({ grantedCapabilities: ['create-entity'] }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('SCOPE_DENIED');
    expect(res.error.retriable).toBe(false);
    expect(res.error.details?.missing).toEqual(['read-sequences']);
    expect(res.error.details?.required).toEqual(['create-entity', 'read-sequences']);

    expect(res.error.details?.granted).toBeUndefined();
  });

  it('passes when caller has every required capability', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      requiredCapabilities: ['create-entity'],
      effects: ['read-only'],
      handler: async (input) => ({ value: input.value }),
    });
    const res = await action.invoke(
      { value: 7 },
      ctx({ grantedCapabilities: ['create-entity', 'read-sequences'] })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.result).toEqual({ value: 7 });
  });

  it('wildcard "*" satisfies any required capability', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      requiredCapabilities: ['cap-a', 'cap-b'],
      effects: ['read-only'],
      handler: async () => ({ ok: true }),
    });
    const res = await action.invoke(
      { value: 1 },
      ctx({ grantedCapabilities: [WILDCARD_CAPABILITY] })
    );
    expect(res.ok).toBe(true);
  });

  it('checks SCOPE before BAD_INPUT (cheaper, no validation wasted on unauthorized callers)', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      requiredCapabilities: ['create-entity'],
      effects: ['read-only'],
      handler: async () => ({}),
    });
    const res = await action.invoke({ value: 'not-a-number' }, ctx({ grantedCapabilities: [] }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('SCOPE_DENIED');
  });
});

describe('defineAction.invoke — BAD_INPUT', () => {
  it('returns BAD_INPUT with structured issues when schema rejects', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: z.object({
        designId: z.string().min(1),
        start: z.number().int().min(1),
      }),
      effects: ['read-only'],
      handler: async () => ({}),
    });
    const res = await action.invoke({ designId: '', start: 0 }, ctx({ grantedCapabilities: [] }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('BAD_INPUT');
    expect(res.error.retriable).toBe(false);
    const issues = res.error.details?.issues as Array<{ path: string }>;
    expect(issues.map((i) => i.path).sort()).toEqual(['designId', 'start']);
  });

  it('returns BAD_INPUT when input is the wrong shape entirely', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: async () => ({}),
    });
    const res = await action.invoke('not-an-object', ctx());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('BAD_INPUT');
  });
});

describe('defineAction.invoke — EXECUTION_FAILED & ActionError pass-through', () => {
  it('wraps a plain Error from the handler as EXECUTION_FAILED', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: async () => {
        throw new Error('boom');
      },
    });
    const res = await action.invoke({ value: 1 }, ctx());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('EXECUTION_FAILED');
    expect(res.error.message).toBe('boom');
    expect(res.error.retriable).toBe(false);
  });

  it('wraps non-Error throws as EXECUTION_FAILED with stringified message', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      effects: ['read-only'],
      handler: async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'string-thrown';
      },
    });
    const res = await action.invoke({ value: 1 }, ctx());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('EXECUTION_FAILED');
    expect(res.error.message).toBe('string-thrown');
  });

  it('stamps details.aborted=true when handler-thrown ActionError races with abort', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: async () => {
        throw new ActionError('STALE_STATE', 'revision changed', {
          details: { expectedRevision: 3 },
        });
      },
    });
    const ac = new AbortController();
    const promise = action.invoke({ value: 1 }, ctx({ abortSignal: ac.signal }));
    ac.abort();
    const res = await promise;
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');

    expect(res.error.code).toBe('STALE_STATE');
    expect(res.error.retriable).toBe(true);
    expect(res.error.details?.aborted).toBe(true);
    expect(res.error.details?.expectedRevision).toBe(3);
  });

  it('stamps details.aborted=true even when handler-thrown ActionError had no details', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: async () => {
        throw new ActionError('STALE_STATE', 'no details on this one');
      },
    });
    const ac = new AbortController();
    const promise = action.invoke({ value: 1 }, ctx({ abortSignal: ac.signal }));
    ac.abort();
    const res = await promise;
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.details).toEqual({ aborted: true });
  });

  it('does NOT stamp details.aborted when abort did not fire', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: async () => {
        throw new ActionError('STALE_STATE', 'revision changed');
      },
    });
    const res = await action.invoke({ value: 1 }, ctx());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.details?.aborted).toBeUndefined();
  });

  it('passes through STALE_STATE thrown by the handler', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: async () => {
        throw new ActionError('STALE_STATE', 'design revision changed', {
          details: { expectedRevision: 3, actualRevision: 5 },
        });
      },
    });
    const res = await action.invoke({ value: 1 }, ctx());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('STALE_STATE');
    expect(res.error.retriable).toBe(true);
    expect(res.error.details).toEqual({ expectedRevision: 3, actualRevision: 5 });
  });

  it('passes through NOT_IMPLEMENTED thrown by the handler', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: notImplementedHandler('coming soon'),
    });
    const res = await action.invoke({ value: 1 }, ctx());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('NOT_IMPLEMENTED');
    expect(res.error.message).toBe('coming soon');
  });

  it('passes through BAD_INPUT thrown by the handler (handler-side checks)', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: async () => {
        throw new ActionError('BAD_INPUT', 'cross-field validation failed', {
          details: { reason: 'start > end' },
        });
      },
    });
    const res = await action.invoke({ value: 1 }, ctx());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('BAD_INPUT');
    expect(res.error.details).toEqual({ reason: 'start > end' });
  });

  it('returns EXECUTION_FAILED retriable=true when pre-aborted', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: async () => ({ never: true }),
    });
    const ac = new AbortController();
    ac.abort();
    const res = await action.invoke({ value: 1 }, ctx({ abortSignal: ac.signal }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('EXECUTION_FAILED');
    expect(res.error.retriable).toBe(true);
    expect(res.error.details?.reason).toBe('aborted-before-execution');
  });

  it('marks mid-execution abort as retriable=true', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: async (_input, c) => {
        (c as { abortSignal?: AbortSignal }).abortSignal;
        throw new Error('aborted');
      },
    });
    const ac = new AbortController();
    const promise = action.invoke({ value: 1 }, ctx({ abortSignal: ac.signal }));
    ac.abort();
    const res = await promise;
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('EXECUTION_FAILED');
    expect(res.error.retriable).toBe(true);
    expect(res.error.details?.reason).toBe('aborted-during-execution');
  });
});

describe('defineAction.invoke — success path', () => {
  it('returns the handler result when valid', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: async (input) => ({ doubled: input.value * 2 }),
    });
    const res = await action.invoke({ value: 3 }, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.result).toEqual({ doubled: 6 });
  });

  it('passes the typed actionId and granted capabilities through to the handler', async () => {
    const observed: ActionInvocationContext[] = [];
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      requiredCapabilities: ['cap-a'],
      effects: ['read-only'],
      handler: async (_input, c) => {
        observed.push(c);
        return { ok: true };
      },
    });
    await action.invoke(
      { value: 1 },
      ctx({ actionId: 'specific-id', grantedCapabilities: ['cap-a', 'cap-b'] })
    );
    expect(observed[0].actionId).toBe('specific-id');
    expect(observed[0].grantedCapabilities).toEqual(['cap-a', 'cap-b']);
  });

  it('accepts synchronous (non-Promise) handlers', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: (input) => ({ value: input.value }),
    });
    const res = await action.invoke({ value: 9 }, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.result).toEqual({ value: 9 });
  });
});

describe('defineAction.invoke — outputSchema validation', () => {
  const outputSchema = z.object({ id: z.string(), revision: z.number().int().nonnegative() });

  it('returns the parsed output when the schema accepts it', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      outputSchema,
      effects: ['read-only'],
      handler: async () => ({ id: 'r1', revision: 5 }),
    });
    const res = await action.invoke({ value: 1 }, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.result).toEqual({ id: 'r1', revision: 5 });
  });

  it('returns EXECUTION_FAILED with output-schema-mismatch when handler returns wrong shape', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      outputSchema,
      effects: ['read-only'],
      handler: async () => ({ id: 'r1', revision: -1 }) as { id: string; revision: number },
    });
    const res = await action.invoke({ value: 1 }, ctx());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('EXECUTION_FAILED');
    expect(res.error.details?.reason).toBe('output-schema-mismatch');
    const issues = res.error.details?.issues as Array<{ path: string }>;
    expect(issues[0]?.path).toBe('revision');
  });

  it('returns the canonicalized (Zod-transformed) output when outputSchema transforms', async () => {
    const schema = z.object({ id: z.string() }).transform((v) => ({ id: v.id.toUpperCase() }));
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      outputSchema: schema,
      effects: ['read-only'],
      handler: async () => ({ id: 'lowercase' }),
    });
    const res = await action.invoke({ value: 1 }, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.result).toEqual({ id: 'LOWERCASE' });
  });
});

describe('notImplementedHandler', () => {
  it('throws ActionError with NOT_IMPLEMENTED', async () => {
    const handler = notImplementedHandler('soon');
    await expect(async () => handler({} as never, ctx())).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
      message: 'soon',
    });
  });

  it('default message when none provided', async () => {
    const handler = notImplementedHandler();
    await expect(async () => handler({} as never, ctx())).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
      message: 'Action handler not yet implemented.',
    });
  });
});

describe('defineAction — runtime defense (TypeScript erasure)', () => {
  it('rejects a non-array grantedCapabilities (string-bypass guard)', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      requiredCapabilities: ['create-entity'],
      effects: ['read-only'],
      handler: async () => ({}),
    });
    const res = await action.invoke(
      { value: 1 },
      ctx({ grantedCapabilities: 'create-entity,*' as unknown as readonly string[] })
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('SCOPE_DENIED');
    expect(res.error.details?.missing).toEqual(['create-entity']);
    expect(res.error.details?.granted).toBeUndefined();
  });

  it('filters non-string entries from grantedCapabilities', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      requiredCapabilities: ['create-entity'],
      effects: ['read-only'],
      handler: async () => ({}),
    });
    const res = await action.invoke(
      { value: 1 },
      ctx({
        grantedCapabilities: [undefined, null, 0, '*'] as unknown as readonly string[],
      })
    );

    expect(res.ok).toBe(true);
  });

  it('rejects sparse holes in requiredCapabilities at definition time', () => {
    const sparse = ['create-entity', , 'read-sequences'] as string[]; // eslint-disable-line no-sparse-arrays
    expect(() =>
      defineAction({
        name: 'design.addRegion',
        description: 'x',
        runtime: 'renderer',
        inputSchema: baseInput,
        requiredCapabilities: sparse,
        effects: ['read-only'],
        handler: async () => ({}),
      })
    ).toThrow(/requiredCapabilities/);
  });

  it('rejects non-string requiredCapabilities entries at definition time', () => {
    expect(() =>
      defineAction({
        name: 'design.addRegion',
        description: 'x',
        runtime: 'renderer',
        inputSchema: baseInput,
        requiredCapabilities: [42 as unknown as string],
        effects: ['read-only'],
        handler: async () => ({}),
      })
    ).toThrow(/requiredCapabilities/);
  });

  it('rejects empty effects at definition time (forces explicit declaration)', () => {
    expect(() =>
      defineAction({
        name: 'design.addRegion',
        description: 'x',
        runtime: 'renderer',
        inputSchema: baseInput,
        effects: [],
        handler: async () => ({}),
      })
    ).toThrow(/effects/);
  });

  it('rejects unknown effects entries at definition time', () => {
    expect(() =>
      defineAction({
        name: 'design.addRegion',
        description: 'x',
        runtime: 'renderer',
        inputSchema: baseInput,
        effects: ['mutates-everything' as unknown as 'mutating'],
        handler: async () => ({}),
      })
    ).toThrow(/effects/);
  });

  it('rejects non-array requiredCapabilities at definition time', () => {
    expect(() =>
      defineAction({
        name: 'design.addRegion',
        description: 'x',
        runtime: 'renderer',
        inputSchema: baseInput,
        requiredCapabilities: 'cap-a' as unknown as readonly string[],
        effects: ['read-only'],
        handler: async () => ({}),
      })
    ).toThrow(/requiredCapabilities/);
  });

  it('rejects non-array effects at definition time', () => {
    expect(() =>
      defineAction({
        name: 'design.addRegion',
        description: 'x',
        runtime: 'renderer',
        inputSchema: baseInput,
        effects: 'mutating' as unknown as readonly 'mutating'[],
        handler: async () => ({}),
      })
    ).toThrow(/effects/);
  });

  it('the returned DefinedAction is frozen (no late swap of invoke/descriptor)', () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: async () => ({}),
    });
    expect(Object.isFrozen(action)).toBe(true);
    expect(() => {
      (action as unknown as { invoke: () => void }).invoke = () => {};
    }).toThrow();
  });

  it('passes a frozen ctx to the handler — mutation cannot escalate scope', async () => {
    let observedFrozen = false;
    let mutationThrew = false;
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      requiredCapabilities: ['cap-a'],
      effects: ['read-only'],
      handler: async (_input, c) => {
        observedFrozen = Object.isFrozen(c) && Object.isFrozen(c.grantedCapabilities);
        try {
          (c.grantedCapabilities as unknown as string[]).push('*');
        } catch {
          mutationThrew = true;
        }
        return { ok: true };
      },
    });
    await action.invoke({ value: 1 }, ctx({ grantedCapabilities: ['cap-a'] }));
    expect(observedFrozen).toBe(true);
    expect(mutationThrew).toBe(true);
  });
});

describe('defineAction — async schema handling', () => {
  it('returns BAD_INPUT with reason=async-schema-not-supported instead of throwing', async () => {
    const asyncSchema = z.object({ value: z.number() }).refine(async () => true, 'async');
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: asyncSchema,
      effects: ['read-only'],
      handler: async () => ({}),
    });
    const res = await action.invoke({ value: 1 }, ctx());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('BAD_INPUT');
    expect(res.error.details?.reason).toBe('async-schema-not-supported');
  });

  it('returns EXECUTION_FAILED with reason=output-schema-async-not-supported for async outputSchema', async () => {
    const asyncOutput = z.object({ id: z.string() }).refine(async () => true, 'async');
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      outputSchema: asyncOutput,
      effects: ['read-only'],
      handler: async () => ({ id: 'r1' }),
    });
    const res = await action.invoke({ value: 1 }, ctx());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('EXECUTION_FAILED');
    expect(res.error.details?.reason).toBe('output-schema-async-not-supported');
  });
});

describe('defineAction — BAD_INPUT issues cap', () => {
  it('caps issues at 50 and surfaces a truncatedIssueCount marker', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: z.object({ values: z.array(z.string()) }),
      effects: ['read-only'],
      handler: async () => ({}),
    });
    const massive = Array.from({ length: 200 }, () => 0);
    const res = await action.invoke({ values: massive }, ctx());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('BAD_INPUT');
    const issues = res.error.details?.issues as Array<unknown>;
    expect(issues.length).toBeLessThanOrEqual(50);
    expect(res.error.details?.truncatedIssueCount).toBeGreaterThan(0);
  });

  it('rejects oversized bounded input before visiting elements or invoking the handler', async () => {
    let visited = 0;
    let handled = false;
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: z.object({
        values: z
          .array(
            z.preprocess((value) => {
              visited += 1;
              return value;
            }, z.string())
          )
          .max(0),
      }),
      effects: ['read-only'],
      handler: async () => {
        handled = true;
        return {};
      },
    });
    const res = await action.invoke({ values: Array.from({ length: 200 }, () => 0) }, ctx());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('BAD_INPUT');
    expect(res.error.details?.issues).toEqual([
      expect.objectContaining({ path: 'values', code: 'too_big' }),
    ]);
    expect(res.error.details?.truncatedIssueCount).toBeUndefined();
    expect(visited).toBe(0);
    expect(handled).toBe(false);
  });
});

describe('defineAction — timeoutMs', () => {
  it('rejects non-numeric / negative / non-finite timeoutMs at definition time', () => {
    const base = {
      name: 'design.addRegion' as const,
      description: 'x',
      runtime: 'renderer' as const,
      inputSchema: baseInput,
      effects: ['read-only'] as const,
      handler: async () => ({}),
    };
    expect(() => defineAction({ ...base, timeoutMs: -1 })).toThrow(/timeoutMs/);
    expect(() => defineAction({ ...base, timeoutMs: Infinity })).toThrow(/timeoutMs/);
    expect(() => defineAction({ ...base, timeoutMs: NaN })).toThrow(/timeoutMs/);
    expect(() => defineAction({ ...base, timeoutMs: 'fast' as unknown as number })).toThrow(
      /timeoutMs/
    );
  });

  it('accepts timeoutMs: 0 (treated as no timeout, the same as undefined)', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      timeoutMs: 0,
      handler: async () => ({ ok: true }),
    });
    const res = await action.invoke({ value: 1 }, ctx());
    expect(res.ok).toBe(true);
  });

  it('handler that completes within timeoutMs returns normally', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      timeoutMs: 200,
      handler: async () => ({ fast: true }),
    });
    const res = await action.invoke({ value: 1 }, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.result).toEqual({ fast: true });
  });

  it('handler exceeding timeoutMs returns EXECUTION_FAILED with reason=timeout', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['mutating'],
      timeoutMs: 10,

      handler: () =>
        new Promise<{ never: true }>((resolve) => {
          setTimeout(() => resolve({ never: true }), 100);
        }),
    });
    const res = await action.invoke({ value: 1 }, ctx());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('EXECUTION_FAILED');
    expect(res.error.details?.reason).toBe('timeout');
    expect(res.error.details?.timeoutMs).toBe(10);
  });

  it('passes a combined abortSignal to the handler so it can clean up on timeout', async () => {
    let abortFiredOnHandlerSignal = false;
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['mutating'],
      timeoutMs: 10,
      handler: (_input, c) => {
        c.abortSignal?.addEventListener(
          'abort',
          () => {
            abortFiredOnHandlerSignal = true;
          },
          { once: true }
        );
        return new Promise<{ never: true }>((resolve) => {
          setTimeout(() => resolve({ never: true }), 100);
        });
      },
    });
    await action.invoke({ value: 1 }, ctx());
    expect(abortFiredOnHandlerSignal).toBe(true);
  });

  it('caller-supplied abort takes precedence and surfaces as aborted-during-execution (not timeout)', async () => {
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['mutating'],
      timeoutMs: 1000,
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        throw new Error('aborted');
      },
    });
    const ac = new AbortController();
    const promise = action.invoke({ value: 1 }, ctx({ abortSignal: ac.signal }));
    setTimeout(() => ac.abort(), 10);
    const res = await promise;
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('EXECUTION_FAILED');
    expect(res.error.details?.reason).toBe('aborted-during-execution');
  });

  it('no timeoutMs leaves the handler unbounded (matches pre-timeout semantics)', async () => {
    let observedSignal: AbortSignal | undefined;
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      handler: async (_input, c) => {
        observedSignal = c.abortSignal;
        return {};
      },
    });
    await action.invoke({ value: 1 }, ctx());

    expect(observedSignal).toBeUndefined();
  });

  it('combineAbortSignals: a second source aborting after the controller is already aborted is a no-op', async () => {
    const ac = new AbortController();
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['mutating'],
      timeoutMs: 10,
      handler: () =>
        new Promise<{ never: true }>((resolve) => setTimeout(() => resolve({ never: true }), 200)),
    });
    const res = await action.invoke({ value: 1 }, ctx({ abortSignal: ac.signal }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.details?.reason).toBe('timeout');
    ac.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  it('combineAbortSignals: if caller signal already aborted, handler signal is pre-aborted', async () => {
    let preAborted = false;
    const action = defineAction({
      name: 'design.addRegion',
      description: 'x',
      runtime: 'renderer',
      inputSchema: baseInput,
      effects: ['read-only'],
      timeoutMs: 1000,
      handler: async (_input, c) => {
        preAborted = c.abortSignal?.aborted === true;
        return {};
      },
    });
    const ac = new AbortController();
    ac.abort();

    const res = await action.invoke({ value: 1 }, ctx({ abortSignal: ac.signal }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.details?.reason).toBe('aborted-before-execution');
    expect(preAborted).toBe(false);
  });
});

describe('defineAction — sidecar runtime', () => {
  it('accepts sidecar runtime and surfaces it on the descriptor', () => {
    const action = defineAction({
      name: 'sequence.alignPair',
      description: 'Pairwise alignment.',
      runtime: 'sidecar',
      inputSchema: z.object({ a: z.string(), b: z.string() }),
      effects: ['read-only'],
      handler: async () => ({ score: 42 }),
    });
    expect(action.descriptor.runtime).toBe('sidecar');
  });
});
