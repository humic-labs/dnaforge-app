import { describe, expect, it } from 'vitest';
import {
  defineAction,
  createActionError,
  isActionError,
} from '../define-action-stub/define-action.ts';
import {
  InMemoryAuditSink,
  InMemoryProvenanceSink,
  InMemoryStore,
} from '../define-action-stub/in-memory.ts';
import type { DispatchOptions } from '../define-action-stub/types.ts';

const readAction = defineAction<{ id: string }, { revision: number }>({
  name: 'sequence.getRevision',
  runtime: 'renderer',
  effects: ['read-only'],
  actionClass: 'read',
  parseInput: (raw) => raw as { id: string },
  reads: (input) => [{ kind: 'sequence', id: input.id }],
  writes: () => [],
  handler: (input, ctx) => ({
    revision: ctx.store.getRevision({ kind: 'sequence', id: input.id }),
  }),
});

const mutatingAction = defineAction<{ id: string }, { ok: true }>({
  name: 'sequence.touch',
  runtime: 'renderer',
  effects: ['mutating'],
  actionClass: 'modify',
  parseInput: (raw) => raw as { id: string },
  reads: (input) => [{ kind: 'sequence', id: input.id }],
  writes: (input) => [{ kind: 'sequence', id: input.id }],
  handler: (input, ctx) => {
    ctx.store.writeSnapshot({ kind: 'sequence', id: input.id }, { touched: true });
    return { ok: true };
  },
});

function dispatchOptions(): DispatchOptions {
  return {
    sessionId: 'session-test',
    store: new InMemoryStore(),
    audit: new InMemoryAuditSink(),
    provenance: new InMemoryProvenanceSink(),
  };
}

describe('defineAction wrapper', () => {
  it('read-only actions return ok:true with result', async () => {
    const out = await readAction({ id: 'a' }, dispatchOptions());
    expect(out.ok).toBe(true);
    if (out.ok === true) expect(out.result.revision).toBe(0);
  });

  it('mutating actions return ok:true with result and run the handler synchronously', async () => {
    const opts = dispatchOptions();
    const out = await mutatingAction({ id: 'a' }, opts);
    expect(out.ok).toBe(true);
    if (out.ok === true) expect(out.result.ok).toBe(true);
    expect(opts.store.getRevision({ kind: 'sequence', id: 'a' })).toBe(1);
  });

  it('records an audit entry with status=ok after success', async () => {
    const opts = dispatchOptions();
    await mutatingAction({ id: 'b' }, opts);
    const entries = opts.audit.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('ok');
    expect(entries[0]?.affectedEntities).toEqual([{ kind: 'sequence', id: 'b' }]);
  });

  it('maps handler ActionError to ok:false envelope with code preserved', async () => {
    const explode = defineAction<Record<string, never>, never>({
      name: 'sequence.explode',
      runtime: 'renderer',
      effects: ['read-only'],
      actionClass: 'read',
      parseInput: () => ({}),
      reads: () => [],
      writes: () => [],
      handler: () => {
        throw createActionError('NOT_IMPLEMENTED', 'no impl yet');
      },
    });
    const out = await explode({}, dispatchOptions());
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.error.code).toBe('NOT_IMPLEMENTED');
      expect(out.error.message).toBe('no impl yet');
    }
  });

  it('appends an audit entry with status=error when handler throws', async () => {
    const explode = defineAction<{ id: string }, never>({
      name: 'sequence.explode',
      runtime: 'renderer',
      effects: ['mutating'],
      actionClass: 'modify',
      parseInput: (raw) => raw as { id: string },
      reads: (input) => [{ kind: 'sequence', id: input.id }],
      writes: (input) => [{ kind: 'sequence', id: input.id }],
      handler: () => {
        throw createActionError('NOT_IMPLEMENTED', 'gone');
      },
    });
    const opts = dispatchOptions();
    const out = await explode({ id: 'x' }, opts);
    expect(out.ok).toBe(false);
    const entries = opts.audit.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('error');
    expect(entries[0]?.error?.code).toBe('NOT_IMPLEMENTED');
    expect(entries[0]?.error?.message).toBe('gone');
    expect(entries[0]?.beforeState).toEqual(entries[0]?.afterState);
  });

  it('parseInput plain-Error failures map to BAD_INPUT + emit error audit entry', async () => {
    const strict = defineAction<{ n: number }, void>({
      name: 'sequence.strict',
      runtime: 'renderer',
      effects: ['mutating'],
      actionClass: 'modify',
      parseInput: () => {
        throw new Error('schema fail');
      },
      reads: () => [],
      writes: () => [],
      handler: () => undefined,
    });
    const opts = dispatchOptions();
    const out = await strict({ wrong: true }, opts);
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.error.code).toBe('BAD_INPUT');
      expect(out.error.message).toBe('schema fail');
    }
    const entries = opts.audit.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('error');
    expect(entries[0]?.error?.code).toBe('BAD_INPUT');
  });

  it('parseInput-thrown ActionError preserves its code (does NOT collapse to BAD_INPUT)', async () => {
    const lookup = defineAction<{ id: string }, void>({
      name: 'sequence.lookup',
      runtime: 'renderer',
      effects: ['read-only'],
      actionClass: 'read',
      parseInput: () => {
        throw createActionError('NOT_IMPLEMENTED', 'lookup parser not yet wired');
      },
      reads: () => [],
      writes: () => [],
      handler: () => undefined,
    });
    const out = await lookup({ id: 'X' }, dispatchOptions());
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.error.code).toBe('NOT_IMPLEMENTED');
      expect(out.error.message).toBe('lookup parser not yet wired');
    }
  });

  it('isActionError narrows correctly', () => {
    expect(isActionError(createActionError('EXECUTION_FAILED', 'x'))).toBe(true);
    expect(isActionError(new Error('plain'))).toBe(false);
  });

  it('stale-context guard covers `writes` even when `reads` is empty', async () => {
    const writeOnly = defineAction<{ id: string }, void>({
      name: 'sequence.writeOnly',
      runtime: 'renderer',
      effects: ['mutating'],
      actionClass: 'modify',
      parseInput: (raw) => raw as { id: string },
      reads: () => [],
      writes: (input) => [{ kind: 'sequence', id: input.id }],
      handler: (input, ctx) => {
        ctx.store.writeSnapshot({ kind: 'sequence', id: input.id }, { value: 'NEW' });
      },
    });
    const store = new InMemoryStore({
      'sequence::wo-1': { revision: 5, value: { value: 'OLD' } },
    });
    const opts: DispatchOptions = {
      sessionId: 'session-stale',
      store,
      audit: new InMemoryAuditSink(),
      provenance: new InMemoryProvenanceSink(),
      expectedRevisions: { 'sequence/wo-1': 0 },
    };
    const out = await writeOnly({ id: 'wo-1' }, opts);
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.error.code).toBe('STALE_STATE');
      expect(out.error.retriable).toBe(true);
    }
    expect(store.snapshot({ kind: 'sequence', id: 'wo-1' })).toEqual({ value: 'OLD' });
  });

  it('afterState captures the real post-throw store, not beforeState', async () => {
    const partialThenThrow = defineAction<{ id: string }, void>({
      name: 'sequence.partial',
      runtime: 'renderer',
      effects: ['mutating'],
      actionClass: 'modify',
      parseInput: (raw) => raw as { id: string },
      reads: (input) => [{ kind: 'sequence', id: input.id }],
      writes: (input) => [{ kind: 'sequence', id: input.id }],
      handler: (input, ctx) => {
        ctx.store.writeSnapshot({ kind: 'sequence', id: input.id }, { content: 'PARTIAL' });
        throw new Error('boom');
      },
    });
    const opts = dispatchOptions();
    opts.store.writeSnapshot({ kind: 'sequence', id: 'p-1' }, { content: 'ORIGINAL' });
    const out = await partialThenThrow({ id: 'p-1' }, opts);
    expect(out.ok).toBe(false);
    const errorEntry = opts.audit.entries().find((e) => e.status === 'error');
    expect(errorEntry).toBeDefined();
    expect(errorEntry?.beforeState).not.toEqual(errorEntry?.afterState);
    expect(JSON.stringify(errorEntry?.afterState)).toContain('PARTIAL');
  });

  it('revision-only mutations register as state-changed in audit snapshots', async () => {
    const publishAction = defineAction<{ id: string }, void>({
      name: 'sequence.publish',
      runtime: 'renderer',
      effects: ['mutating'],
      actionClass: 'modify',
      parseInput: (raw) => raw as { id: string },
      reads: (input) => [{ kind: 'sequence', id: input.id }],
      writes: (input) => [{ kind: 'sequence', id: input.id }],
      handler: (input, ctx) => {
        ctx.store.bumpRevision({ kind: 'sequence', id: input.id });
      },
    });
    const opts = dispatchOptions();
    opts.store.writeSnapshot({ kind: 'sequence', id: 'pub-1' }, { content: 'SAME' });
    const before = opts.audit.entries().length;
    await publishAction({ id: 'pub-1' }, opts);
    const entry = opts.audit.entries()[before];
    expect(entry?.beforeState).not.toEqual(entry?.afterState);
  });

  it('audit entry scope is a COPY of descriptor.effects (no aliasing)', async () => {
    const opts = dispatchOptions();
    await mutatingAction({ id: 'alias-1' }, opts);
    await mutatingAction({ id: 'alias-2' }, opts);
    const entries = opts.audit.entries();
    expect(Array.isArray(entries[0]?.scope)).toBe(true);
    expect(entries[0]?.scope).not.toBe(entries[1]?.scope);
  });

  it('createActionError preserves retriable override on the envelope', async () => {
    const flaky = defineAction<Record<string, never>, never>({
      name: 'sequence.flaky',
      runtime: 'renderer',
      effects: ['read-only'],
      actionClass: 'read',
      parseInput: () => ({}),
      reads: () => [],
      writes: () => [],
      handler: () => {
        throw createActionError('EXECUTION_FAILED', 'transient', { retriable: true });
      },
    });
    const out = await flaky({}, dispatchOptions());
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.error.code).toBe('EXECUTION_FAILED');
      expect(out.error.retriable).toBe(true);
    }
  });

  it('createActionError preserves details on the envelope', async () => {
    const detailed = defineAction<Record<string, never>, never>({
      name: 'sequence.detailed',
      runtime: 'renderer',
      effects: ['read-only'],
      actionClass: 'read',
      parseInput: () => ({}),
      reads: () => [],
      writes: () => [],
      handler: () => {
        throw createActionError('BAD_INPUT', 'bad shape', {
          details: { field: 'newName', expected: 'string' },
        });
      },
    });
    const out = await detailed({}, dispatchOptions());
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.error.details).toEqual({ field: 'newName', expected: 'string' });
    }
  });

  it('isActionError recognizes B1 ActionError instances (dual-module-load safe)', async () => {
    const { ActionError: B1ActionError } = await import('@waypoint/agent-tools');
    const direct = new B1ActionError('STALE_STATE', 'concurrent edit');
    expect(isActionError(direct)).toBe(true);
    const handler = defineAction<Record<string, never>, never>({
      name: 'sequence.b1Throw',
      runtime: 'renderer',
      effects: ['read-only'],
      actionClass: 'read',
      parseInput: () => ({}),
      reads: () => [],
      writes: () => [],
      handler: () => {
        throw new B1ActionError('NOT_IMPLEMENTED', 'stub-only path');
      },
    });
    const out = await handler({}, dispatchOptions());
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.error.code).toBe('NOT_IMPLEMENTED');
    }
  });

  it('descriptor.reads/.writes throws funnel to EXECUTION_FAILED envelope (never escape as rejected promise)', async () => {
    const buggyReads = defineAction<{ id: string }, void>({
      name: 'sequence.buggyReads',
      runtime: 'renderer',
      effects: ['mutating'],
      actionClass: 'modify',
      parseInput: (raw) => raw as { id: string },
      reads: () => {
        throw new Error('reads closure exploded');
      },
      writes: () => [],
      handler: () => undefined,
    });
    const opts = dispatchOptions();
    const out = await buggyReads({ id: 'x' }, opts);
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.error.code).toBe('EXECUTION_FAILED');
      expect(out.error.message).toBe('reads closure exploded');
    }
    const entries = opts.audit.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('error');
    expect(entries[0]?.error?.code).toBe('EXECUTION_FAILED');
  });

  it('concurrent dispatch against same store serializes — audit entries are non-corrupt, revisions monotonic', async () => {
    const opts = dispatchOptions();
    await Promise.all([
      mutatingAction({ id: 'concurrent' }, opts),
      mutatingAction({ id: 'concurrent' }, opts),
    ]);
    const entries = opts.audit.entries().filter((e) => e.actionName === 'sequence.touch');
    expect(entries).toHaveLength(2);
    expect(opts.store.getRevision({ kind: 'sequence', id: 'concurrent' })).toBe(2);
    expect(entries[1]?.beforeState).toEqual(entries[0]?.afterState);
  });
});
