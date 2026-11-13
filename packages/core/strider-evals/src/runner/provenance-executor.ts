import type { ProvenanceEvalDescriptor } from '../descriptor/provenance.ts';
import type { EvalCaseResult, EvalEnvironment } from './types.ts';

export async function executeProvenanceEval(
  descriptor: ProvenanceEvalDescriptor,
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

  const sessionId = `session-${descriptor.id}`;
  const result = await handle(descriptor.input, {
    sessionId,
    store: env.store,
    audit: env.audit,
    provenance: env.provenance,
  });
  if (result.ok === false) {
    return [
      {
        caseId: descriptor.id,
        passed: false,
        reason: `Action errored before provenance check: ${result.error.code} ${result.error.message}.`,
      },
    ];
  }

  const expected = descriptor.expectedProvenance;
  const record = env.provenance.recordFor(expected.derivedEntity);
  if (!record) {
    return [
      {
        caseId: descriptor.id,
        passed: false,
        reason: `No ProvenanceRecord attached to ${expected.derivedEntity.kind}/${expected.derivedEntity.id}.`,
      },
    ];
  }

  if (
    record.derivedEntity.kind !== expected.derivedEntity.kind ||
    record.derivedEntity.id !== expected.derivedEntity.id
  ) {
    return [
      fail(
        descriptor.id,
        `derivedEntity mismatch: expected ${expected.derivedEntity.kind}/${expected.derivedEntity.id}, got ${record.derivedEntity.kind}/${record.derivedEntity.id}.`
      ),
    ];
  }
  if (record.derivationKind !== expected.derivationKind) {
    return [
      fail(
        descriptor.id,
        `derivationKind mismatch: expected ${expected.derivationKind}, got ${record.derivationKind}.`
      ),
    ];
  }
  if (record.actionName !== expected.actionName) {
    return [
      fail(
        descriptor.id,
        `actionName mismatch: expected ${expected.actionName}, got ${record.actionName}.`
      ),
    ];
  }
  if (expected.attachedAtFieldExists && typeof record.attachedAt !== 'number') {
    return [
      fail(descriptor.id, 'attachedAt is not a number — provenance record missing timestamp.'),
    ];
  }

  for (const want of expected.sources) {
    const match = record.sources.find(
      (s) =>
        s.entity.kind === want.entity.kind &&
        s.entity.id === want.entity.id &&
        s.role === want.role &&
        (want.externalId === undefined || s.externalId === want.externalId)
    );
    if (!match) {
      return [
        fail(
          descriptor.id,
          `Source missing: ${JSON.stringify(want)} not in ${JSON.stringify(record.sources)}.`
        ),
      ];
    }
  }

  if (record.sources.length !== expected.sources.length) {
    return [
      fail(
        descriptor.id,
        `source count mismatch: expected ${expected.sources.length}, got ${record.sources.length}.`
      ),
    ];
  }

  return [{ caseId: descriptor.id, passed: true }];
}

function fail(caseId: string, reason: string): EvalCaseResult {
  return { caseId, passed: false, reason };
}
