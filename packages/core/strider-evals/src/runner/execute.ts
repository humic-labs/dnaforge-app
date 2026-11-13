import type { EvalDescriptor } from '../descriptor/index.ts';
import type { EvalEnvironment, EvalRunResult } from './types.ts';
import { executeActionEval } from './action-executor.ts';
import { executeStateCoherenceEval } from './state-coherence-executor.ts';
import { executeAuditEval } from './audit-executor.ts';
import { executeProvenanceEval } from './provenance-executor.ts';

export async function runEvalDescriptor(
  descriptor: EvalDescriptor,
  env: EvalEnvironment
): Promise<EvalRunResult> {
  const cases =
    descriptor.kind === 'action'
      ? await executeActionEval(descriptor, env)
      : descriptor.kind === 'state-coherence'
        ? await executeStateCoherenceEval(descriptor, env)
        : descriptor.kind === 'audit'
          ? await executeAuditEval(descriptor, env)
          : await executeProvenanceEval(descriptor, env);
  return {
    descriptorId: descriptor.id,
    kind: descriptor.kind,
    passed: cases.every((c) => c.passed),
    cases,
  };
}
