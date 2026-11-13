import type { AuditEvalDescriptor } from '../descriptor/audit.ts';
import type { EvalCaseResult, EvalEnvironment } from './types.ts';

export async function executeAuditEval(
  descriptor: AuditEvalDescriptor,
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

  const baselineEntryCount = env.audit.entries().length;

  const sessionId = `session-${descriptor.id}`;
  await handle(descriptor.input, {
    sessionId,
    store: env.store,
    audit: env.audit,
    provenance: env.provenance,
  });

  const entries = env.audit.entries();
  if (entries.length === baselineEntryCount) {
    return [
      {
        caseId: descriptor.id,
        passed: false,
        reason: 'Action did not append any audit entry.',
      },
    ];
  }
  const entry = entries[entries.length - 1];
  if (!entry) {
    return [
      {
        caseId: descriptor.id,
        passed: false,
        reason: 'Audit log unexpectedly empty after action completed.',
      },
    ];
  }
  const expected = descriptor.expectedAudit;

  if (entry.actionName !== expected.actionName) {
    return [
      fail(
        descriptor.id,
        `actionName mismatch: expected ${expected.actionName}, got ${entry.actionName}.`
      ),
    ];
  }
  if (entry.status !== expected.status) {
    return [
      fail(descriptor.id, `status mismatch: expected ${expected.status}, got ${entry.status}.`),
    ];
  }

  const sessionRe = new RegExp(expected.sessionIdMatchesPattern);
  if (!sessionRe.test(entry.sessionId)) {
    return [
      fail(
        descriptor.id,
        `sessionId ${JSON.stringify(entry.sessionId)} does not match ` +
          `pattern ${expected.sessionIdMatchesPattern}.`
      ),
    ];
  }

  for (const needle of expected.scopeIncludes) {
    if (!entry.scope.includes(needle)) {
      return [
        fail(
          descriptor.id,
          `scope missing ${JSON.stringify(needle)}: got ${JSON.stringify(entry.scope)}.`
        ),
      ];
    }
  }

  for (const want of expected.affectedEntities) {
    const found = entry.affectedEntities.some((e) => e.kind === want.kind && e.id === want.id);
    if (!found) {
      return [
        fail(
          descriptor.id,
          `affectedEntities missing ${want.kind}/${want.id}: got ${JSON.stringify(
            entry.affectedEntities
          )}.`
        ),
      ];
    }
  }

  if (expected.expectedError) {
    if (!entry.error) {
      return [fail(descriptor.id, 'Expected audit entry to include error details.')];
    }
    if (entry.error.code !== expected.expectedError.code) {
      return [
        fail(
          descriptor.id,
          `error.code mismatch: expected ${expected.expectedError.code}, got ${entry.error.code}.`
        ),
      ];
    }
    if (
      expected.expectedError.messageContains &&
      !entry.error.message.includes(expected.expectedError.messageContains)
    ) {
      return [
        fail(
          descriptor.id,
          `Expected error message to contain ${JSON.stringify(
            expected.expectedError.messageContains
          )}, got ${JSON.stringify(entry.error.message)}.`
        ),
      ];
    }
  }

  if (expected.expectStateMutated) {
    if (jsonEq(entry.beforeState, entry.afterState)) {
      return [
        fail(
          descriptor.id,
          'Expected before/after states to differ, but audit captured identical snapshots.'
        ),
      ];
    }
  } else if (!jsonEq(entry.beforeState, entry.afterState)) {
    return [
      fail(descriptor.id, 'Expected before/after states to match, but audit captured a mutation.'),
    ];
  }

  const beforeStateMismatch = firstStateMismatch(entry.beforeState, expected.beforeStateIncludes);
  if (beforeStateMismatch) {
    return [fail(descriptor.id, `beforeState mismatch: ${beforeStateMismatch}`)];
  }

  const afterStateMismatch = firstStateMismatch(entry.afterState, expected.afterStateIncludes);
  if (afterStateMismatch) {
    return [fail(descriptor.id, `afterState mismatch: ${afterStateMismatch}`)];
  }

  return [{ caseId: descriptor.id, passed: true }];
}

function fail(caseId: string, reason: string): EvalCaseResult {
  return { caseId, passed: false, reason };
}

function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function firstStateMismatch(
  actual: Record<string, unknown>,
  expectedSubset: Record<string, unknown> | undefined
): string | undefined {
  if (!expectedSubset) return undefined;
  for (const [key, expected] of Object.entries(expectedSubset)) {
    if (!(key in actual)) {
      return `missing key ${JSON.stringify(key)} in ${JSON.stringify(actual)}.`;
    }
    if (!jsonEq(actual[key], expected)) {
      return `for ${JSON.stringify(key)}, expected ${JSON.stringify(expected)}, got ${JSON.stringify(
        actual[key]
      )}.`;
    }
  }
  return undefined;
}
