import { describe, it, expect, beforeEach } from 'vitest';
import type { EvalDescriptor } from '../descriptor/index.ts';
import { runEvalDescriptor } from './execute.ts';
import { loadDescriptor } from './load-descriptors.ts';
import type { EvalEnvironment } from './types.ts';

const registeredIds = new Set<string>();

export function registerEvalDescriptor(
  descriptorOrList: EvalDescriptor | EvalDescriptor[],
  envFactory: () => EvalEnvironment
): void {
  const raw = Array.isArray(descriptorOrList) ? descriptorOrList : [descriptorOrList];
  const descriptors = raw.map((d) => loadDescriptor(d));

  for (const descriptor of descriptors) {
    if (registeredIds.has(descriptor.id)) {
      throw new Error(
        `registerEvalDescriptor: duplicate descriptor id "${descriptor.id}". ` +
          `Each descriptor needs a globally unique id so failure reasons stay attributable.`
      );
    }
    registeredIds.add(descriptor.id);

    describe(`[${descriptor.kind}] ${descriptor.id}`, () => {
      let env: EvalEnvironment;
      beforeEach(() => {
        env = envFactory();
      });

      it(descriptor.description, async () => {
        const result = await runEvalDescriptor(descriptor, env);
        if (!result.passed) {
          const lines = result.cases
            .filter((c) => !c.passed)
            .map((c) => `  - ${c.caseId}: ${c.reason}`)
            .join('\n');
          throw new Error(`Eval ${descriptor.id} (${descriptor.kind}) failed:\n${lines}`);
        }
        expect(result.passed).toBe(true);
      });
    });
  }
}

export function _resetRegisteredIds(): void {
  registeredIds.clear();
}
