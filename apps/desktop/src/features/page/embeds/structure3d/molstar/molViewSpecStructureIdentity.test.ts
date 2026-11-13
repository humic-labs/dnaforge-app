import { molstarPluginFixture } from '@/test/fixtures/molstar-plugin';
import { describe, expect, it } from 'vitest';
import {
  resolveMolViewSpecStructureRef,
  molViewSpecStructureBindingKey,
} from './molViewSpecStructureIdentity';

it('treats an omitted model index as the standard first model while preserving distinct sources', () => {
  const binding = (params: Record<string, unknown>, resourceUri = 'structure.pdb') => ({
    ref: 'structure:one',
    resourceUri,
    parseParams: { format: 'pdb' },
    node: { kind: 'structure', params },
  });
  const implicit = molViewSpecStructureBindingKey(binding({ type: 'model' }));
  expect(molViewSpecStructureBindingKey(binding({ type: 'model', model_index: 0 }))).toBe(implicit);
  expect(molViewSpecStructureBindingKey(binding({ type: 'model', model_index: 1 }))).not.toBe(
    implicit
  );
  expect(molViewSpecStructureBindingKey(binding({ type: 'model' }, 'other.pdb'))).not.toBe(
    implicit
  );
  expect(molViewSpecStructureBindingKey(binding({ type: 'assembly', assembly_id: '1' }))).not.toBe(
    implicit
  );
});

describe('native structure identity after a tag-only scene edit', () => {
  it('uses the current native tree rather than a reused cell’s old MVS tag', () => {
    const structure = { elementCount: 42 };
    const cell = {
      transform: { ref: '!mvs:source:0', tags: ['mvs-ref:old-parent'] },
      obj: { data: structure },
    };
    const plugin = molstarPluginFixture({
      state: {
        data: {
          cells: new Map([[cell.transform.ref, cell]]),
          tree: {
            transforms: new Map([
              [cell.transform.ref, { ref: cell.transform.ref, tags: ['mvs-ref:new-parent'] }],
            ]),
          },
          selectQ: () => [],
        },
      },
      managers: { structure: { hierarchy: { current: { structures: [{ cell }] } } } },
    });

    expect(resolveMolViewSpecStructureRef(plugin, 'new-parent')).toBe(structure);
    expect(() => resolveMolViewSpecStructureRef(plugin, 'old-parent')).toThrow('not loaded');
  });
});
