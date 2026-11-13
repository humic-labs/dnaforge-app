import type { ActionHandle } from '../define-action-stub/types.ts';
import {
  InMemoryAuditSink,
  InMemoryProvenanceSink,
  InMemoryStore,
} from '../define-action-stub/in-memory.ts';
import type { EvalEnvironment } from '../runner/types.ts';
import {
  designRenameAction,
  pageUpdateTitleAction,
  pcrAmplifyAction,
  sequenceMutateAction,
  sequenceRenameAction,
  structureSetStyleAction,
} from './example-actions.ts';

interface ExampleEnvironmentSeed {
  sequences?: Record<string, unknown>;
  designs?: Record<string, unknown>;
  pages?: Record<string, unknown>;
  structures?: Record<string, unknown>;
}

export function buildExampleEnvironment(seed?: ExampleEnvironmentSeed): EvalEnvironment {
  const store = new InMemoryStore(seed ? buildStoreSeed(seed) : undefined);

  const registry = new Map<string, ActionHandle<unknown, unknown>>();
  registry.set('sequence.rename', sequenceRenameAction as ActionHandle<unknown, unknown>);
  registry.set('design.rename', designRenameAction as ActionHandle<unknown, unknown>);
  registry.set('page.updateTitle', pageUpdateTitleAction as ActionHandle<unknown, unknown>);
  registry.set('structure.setStyle', structureSetStyleAction as ActionHandle<unknown, unknown>);
  registry.set('sequence.pcrAmplify', pcrAmplifyAction as ActionHandle<unknown, unknown>);
  registry.set('sequence.mutate', sequenceMutateAction as ActionHandle<unknown, unknown>);

  return {
    store,
    audit: new InMemoryAuditSink(),
    provenance: new InMemoryProvenanceSink(),
    resolveAction: (name) => registry.get(name),
  };
}

function buildStoreSeed(
  seed: ExampleEnvironmentSeed
): Record<string, { revision: number; value: unknown }> {
  const entries: Array<[string, { revision: number; value: unknown }]> = [];
  const groups = [
    ['sequence', seed.sequences],
    ['design', seed.designs],
    ['page', seed.pages],
    ['structure', seed.structures],
  ] as const;

  for (const [kind, records] of groups) {
    if (!records) continue;
    for (const [id, value] of Object.entries(records)) {
      entries.push([`${kind}::${id}`, { revision: 0, value }]);
    }
  }

  return Object.fromEntries(entries);
}
