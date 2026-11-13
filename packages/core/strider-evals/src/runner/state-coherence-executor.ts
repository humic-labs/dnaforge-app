import type { StateCoherenceEvalDescriptor } from '../descriptor/state-coherence.ts';
import type { EvalCaseResult, EvalEnvironment } from './types.ts';

export async function executeStateCoherenceEval(
  descriptor: StateCoherenceEvalDescriptor,
  env: EvalEnvironment
): Promise<EvalCaseResult[]> {
  const handle = env.resolveAction(descriptor.actionName);
  if (!handle) {
    return [
      {
        caseId: descriptor.id,
        passed: false,
        reason: `No action registered for ${descriptor.actionName}.`,
      },
    ];
  }

  const results: EvalCaseResult[] = [];

  for (let i = 0; i < descriptor.cases.length; i++) {
    const caseId = `${descriptor.id}#case-${i}`;
    const c = descriptor.cases[i];
    if (!c) continue;

    if (c.kind === 'stale-context') {
      const liveRevision = c.liveRevision;
      seedEntityRevision(env.store, descriptor.entity, liveRevision);
      const result = await handle(descriptor.input, {
        sessionId: `session-${caseId}`,
        store: env.store,
        audit: env.audit,
        provenance: env.provenance,
        expectedRevisions: {
          [`${descriptor.entity.kind}/${descriptor.entity.id}`]: c.expectedRevision,
        },
      });
      if (result.ok !== false || result.error.code !== c.expectedError.code) {
        results.push({
          caseId,
          passed: false,
          reason: `Expected error ${c.expectedError.code}, got ${JSON.stringify(result)}.`,
        });
        continue;
      }
      if (
        c.expectedError.messageContains &&
        !result.error.message.includes(c.expectedError.messageContains)
      ) {
        results.push({
          caseId,
          passed: false,
          reason: `Expected error message to contain ${JSON.stringify(
            c.expectedError.messageContains
          )}, got ${JSON.stringify(result.error.message)}.`,
        });
        continue;
      }
      const after = env.store.getRevision(descriptor.entity);
      if (after !== liveRevision) {
        results.push({
          caseId,
          passed: false,
          reason: `Stale rejection must not mutate state. revision went ${liveRevision} → ${after}.`,
        });
        continue;
      }
      results.push({ caseId, passed: true });
      continue;
    }

    if (c.kind === 'revision-bump') {
      seedEntityRevision(env.store, descriptor.entity, c.initialRevision);
      if (env.store.getRevision(descriptor.entity) !== c.initialRevision) {
        results.push({
          caseId,
          passed: false,
          reason: `Could not seed entity to revision ${c.initialRevision} (got ${env.store.getRevision(
            descriptor.entity
          )}). Provide an InMemoryStore.seedRevision-capable store or reset env between cases.`,
        });
        continue;
      }
      const result = await handle(descriptor.input, {
        sessionId: `session-${caseId}`,
        store: env.store,
        audit: env.audit,
        provenance: env.provenance,
      });
      if (result.ok === false) {
        results.push({
          caseId,
          passed: false,
          reason: `Action errored before revision-bump check: ${result.error.code} ${result.error.message}.`,
        });
        continue;
      }
      const after = env.store.getRevision(descriptor.entity);
      if (after !== c.expectedRevisionAfter) {
        results.push({
          caseId,
          passed: false,
          reason: `Expected revision ${c.expectedRevisionAfter} after action, got ${after}.`,
        });
        continue;
      }
      results.push({ caseId, passed: true });
    }
  }

  return results;
}

function seedEntityRevision(
  store: import('../define-action-stub/types.ts').ActionStore,
  entity: import('../descriptor/common.ts').EntityRef,
  target: number
): void {
  if (typeof store.seedRevision === 'function') {
    store.seedRevision(entity, target);
    return;
  }
  let current = store.getRevision(entity);
  while (current < target) {
    current = store.bumpRevision(entity);
  }
}
