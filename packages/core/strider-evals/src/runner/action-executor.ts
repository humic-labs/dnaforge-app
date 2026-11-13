import type { ActionEvalDescriptor } from '../descriptor/action.ts';
import type { EvalCaseResult, EvalEnvironment } from './types.ts';

export async function executeActionEval(
  descriptor: ActionEvalDescriptor,
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

  const result = await handle(descriptor.input, {
    sessionId: `session-${descriptor.id}`,
    store: env.store,
    audit: env.audit,
    provenance: env.provenance,
  });

  const { assertions } = descriptor;

  if (assertions.failure) {
    if (result.ok !== false) {
      return [
        fail(
          descriptor.id,
          `Expected failure with code ${assertions.failure.code}, got ok=true with result=${JSON.stringify(
            result.result
          )}.`
        ),
      ];
    }
    if (result.error.code !== assertions.failure.code) {
      return [
        fail(
          descriptor.id,
          `Expected error code ${assertions.failure.code}, got ${result.error.code} (${result.error.message}).`
        ),
      ];
    }
    if (
      assertions.failure.messageContains &&
      !result.error.message.includes(assertions.failure.messageContains)
    ) {
      return [
        fail(
          descriptor.id,
          `Expected error message to contain ${JSON.stringify(
            assertions.failure.messageContains
          )}, got ${JSON.stringify(result.error.message)}.`
        ),
      ];
    }
    if (
      assertions.failure.retriable !== undefined &&
      result.error.retriable !== assertions.failure.retriable
    ) {
      return [
        fail(
          descriptor.id,
          `Expected retriable=${assertions.failure.retriable}, got ${result.error.retriable}.`
        ),
      ];
    }
    return [{ caseId: descriptor.id, passed: true }];
  }

  if (assertions.success) {
    if (result.ok !== true) {
      return [
        fail(
          descriptor.id,
          `Expected success, got ok=false with error=${result.error.code}: ${result.error.message}.`
        ),
      ];
    }
    if (
      assertions.success.resultEquals !== undefined &&
      JSON.stringify(result.result) !== JSON.stringify(assertions.success.resultEquals)
    ) {
      return [
        fail(
          descriptor.id,
          `Result mismatch.\n  expected: ${JSON.stringify(
            assertions.success.resultEquals
          )}\n  actual:   ${JSON.stringify(result.result)}`
        ),
      ];
    }
    return [{ caseId: descriptor.id, passed: true }];
  }

  return [fail(descriptor.id, 'No assertion branch matched — descriptor invalid.')];
}

function fail(caseId: string, reason: string): EvalCaseResult {
  return { caseId, passed: false, reason };
}
