import {
  ActionError as B1ActionError,
  isActionError as b1IsActionError,
  type ActionErrorOptions,
} from '@waypoint/agent-tools';
import type { ActionErrorCode, EntityRef } from '../descriptor/common.ts';
import type {
  ActionDescriptor,
  ActionErrorPayload,
  ActionHandle,
  ActionResult,
  ActionStore,
  DispatchOptions,
} from './types.ts';

const dispatchSerializers = new WeakMap<ActionStore, Promise<unknown>>();

async function acquireDispatchSlot(store: ActionStore): Promise<() => void> {
  const previous = dispatchSerializers.get(store) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  dispatchSerializers.set(
    store,
    previous.then(() => next)
  );
  await previous;
  return release;
}

export function defineAction<Input, Output>(
  descriptor: ActionDescriptor<Input, Output>
): ActionHandle<Input, Output> {
  return async (raw: unknown, options: DispatchOptions): Promise<ActionResult<Output>> => {
    const { store, audit, provenance, sessionId } = options;
    const releaseDispatchSlot = await acquireDispatchSlot(store);
    try {
      let input: Input;
      try {
        input = descriptor.parseInput(raw);
      } catch (err) {
        const errorPayload = errorPayloadFromThrow(err, 'BAD_INPUT');
        audit.append({
          actionName: descriptor.name,
          status: 'error',
          sessionId,
          scope: [...descriptor.effects],
          affectedEntities: [],
          beforeState: {},
          afterState: {},
          error: errorPayload,
        });
        return { ok: false, error: errorPayload };
      }

      let reads: ReturnType<typeof descriptor.reads>;
      let writes: ReturnType<typeof descriptor.writes>;
      try {
        reads = descriptor.reads(input);
        writes = descriptor.writes(input);
      } catch (err) {
        const errorPayload = errorPayloadFromThrow(err, 'EXECUTION_FAILED');
        audit.append({
          actionName: descriptor.name,
          status: 'error',
          sessionId,
          scope: [...descriptor.effects],
          affectedEntities: [],
          beforeState: {},
          afterState: {},
          error: errorPayload,
        });
        return { ok: false, error: errorPayload };
      }
      const touched = dedupEntities([...reads, ...writes]);

      if (options.expectedRevisions) {
        for (const entity of touched) {
          const expected = options.expectedRevisions[entityRevisionKey(entity)];
          if (expected === undefined) continue;
          const live = store.getRevision(entity);
          if (expected !== live) {
            const message = `Stale state: ${entity.kind}/${entity.id} is at revision ${live}, caller expected ${expected}.`;
            const errorPayload = makeErrorPayload('STALE_STATE', message);
            audit.append({
              actionName: descriptor.name,
              status: 'error',
              sessionId,
              scope: [...descriptor.effects],
              affectedEntities: writes,
              beforeState: snapshotEntities(store, touched),
              afterState: snapshotEntities(store, touched),
              error: errorPayload,
            });
            return { ok: false, error: errorPayload };
          }
        }
      }

      const beforeState = snapshotEntities(store, touched);

      try {
        const output = await descriptor.handler(input, { sessionId, store, audit, provenance });
        const afterState = snapshotEntities(store, touched);
        audit.append({
          actionName: descriptor.name,
          status: 'ok',
          sessionId,
          scope: [...descriptor.effects],
          affectedEntities: writes,
          beforeState,
          afterState,
        });
        return { ok: true, result: output };
      } catch (err) {
        const afterState = snapshotEntities(store, touched);
        const errorPayload = errorPayloadFromThrow(err, 'EXECUTION_FAILED');
        audit.append({
          actionName: descriptor.name,
          status: 'error',
          sessionId,
          scope: [...descriptor.effects],
          affectedEntities: writes,
          beforeState,
          afterState,
          error: errorPayload,
        });
        return { ok: false, error: errorPayload };
      }
    } finally {
      releaseDispatchSlot();
    }
  };
}

function snapshotEntities(
  store: { snapshot: (e: EntityRef) => unknown; getRevision: (e: EntityRef) => number },
  entities: readonly EntityRef[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of entities) {
    out[entityRevisionKey(e)] = {
      revision: store.getRevision(e),
      value: store.snapshot(e),
    };
  }
  return out;
}

function dedupEntities(entities: readonly EntityRef[]): readonly EntityRef[] {
  const seen = new Set<string>();
  const out: EntityRef[] = [];
  for (const e of entities) {
    const key = entityRevisionKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function entityRevisionKey(entity: EntityRef): string {
  return `${entity.kind}/${entity.id}`;
}

function errorPayloadFromThrow(err: unknown, fallbackCode: ActionErrorCode): ActionErrorPayload {
  if (isActionError(err)) return err.toPayload();
  const message = err instanceof Error ? err.message : String(err);
  return makeErrorPayload(fallbackCode, message);
}

function makeErrorPayload(
  code: ActionErrorCode,
  message: string,
  retriable?: boolean
): ActionErrorPayload {
  return { code, message, retriable: retriable ?? code === 'STALE_STATE' };
}

export type ActionError = B1ActionError;

export function createActionError(
  code: ActionErrorCode,
  message: string,
  options?: ActionErrorOptions
): B1ActionError {
  return new B1ActionError(code, message, options);
}

export function isActionError(err: unknown): err is B1ActionError {
  return b1IsActionError(err);
}
