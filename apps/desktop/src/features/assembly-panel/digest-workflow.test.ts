// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeVirtualDigest, VirtualDigestLimitError } from './hooks/useVirtualDigest';
import {
  bindDigestDrag,
  bindDigestTransfer,
  createDigestDrag,
  digestReceiptFor,
  inheritDigestTransfer,
  placeDigestTransfer,
  refuseDigestTransfer,
} from './digest-workflow';
import { digestEnzyme, digestTelemetryHarness } from '../../test/fixtures/digest-workflow';
import { sanitizeClosedBetaProperties } from '../../shared/analytics-allowlist';
import { useDesignStore } from '../design/public/store';
import type { DesignRegion } from '../design/public/assembly-design';

const owners: Array<{ retire(): void }> = [];
afterEach(() => {
  owners.splice(0).forEach((owner) => owner.retire());
  vi.restoreAllMocks();
});

function activate(sequence = 'AAAAGAATTCTTTT', circular = true) {
  const harness = digestTelemetryHarness();
  owners.push(harness.owner);
  const result = computeVirtualDigest(sequence, digestEnzyme(), [], { circular });
  harness.owner.request('private-enzyme-key');
  harness.owner.commit('private-enzyme-key', result, undefined, {});
  const receipt = digestReceiptFor(result.fragments)!;
  const fragment = result.fragments[0];
  const material: Omit<DesignRegion, 'id'> = {
    sourceSequenceId: 'private-source',
    sourceSequenceName: 'Private source',
    sourceStart: fragment.startPosition,
    sourceEnd: fragment.wrapsOrigin
      ? fragment.startPosition + fragment.length
      : fragment.endPosition,
    sequence: fragment.wrapsOrigin
      ? sequence.slice(fragment.startPosition) + sequence.slice(0, fragment.endPosition)
      : sequence.slice(fragment.startPosition, fragment.endPosition),
    sourceSequence: sequence,
    sourceIsCircular: circular,
    sourceType: 'rd',
    annotations: [],
    ggType: fragment.ggType,
    rdOverhangs: { upstream: fragment.upstream.sequence, downstream: fragment.downstream.sequence },
    rdEnds: { upstream: fragment.upstream.rdEnd, downstream: fragment.downstream.rdEnd },
  };
  bindDigestTransfer(material, receipt, fragment);
  return { ...harness, result, receipt, fragment, material };
}

describe('digest receipts at current-result and real placement boundaries', () => {
  it('publishes one operation/result join and emitted clocks without exporting material', () => {
    const h = activate();
    expect(h.results('compute')).toHaveLength(1);
    const event = h.results('compute')[0].properties;
    expect(event).toMatchObject({
      digest_trigger: 'activation',
      digest_topology: 'circular',
      digest_cut_count: 1,
      digest_enzyme_count: 1,
      result_count: 1,
      digest_readiness: 'not_applicable',
      outcome_kind: 'digest_fragments',
    });
    const start = h.events.find(
      ({ properties }) => properties.action_phase === 'start'
    )!.properties;
    expect(event.action_id).toBe(start.action_id);
    expect(event.operation_id).toBe(start.operation_id);
    expect(event.artifact_correlation_id).toBe(start.artifact_correlation_id);
    expect(event.occurred_at_ms).toEqual(expect.any(Number));
    expect(JSON.stringify(h.events)).not.toContain('GAATTC');
    expect(JSON.stringify(h.events)).not.toContain('EcoRI');
    expect(JSON.stringify(h.events)).not.toContain('private-source');
    expect(h.events.every(({ event }) => event === 'workflow_action_observed')).toBe(true);
    expect(sanitizeClosedBetaProperties(event)).toMatchObject({
      workflow: 'digest',
      digest_cut_count: 1,
    });
  });

  it('deactivates the same key without inventing a second compute or task', () => {
    const h = activate();
    h.owner.request('');
    h.owner.commit('', null);
    expect(h.results('compute')).toHaveLength(1);
    expect(h.results('deactivate')).toHaveLength(1);
    expect(h.receipt.isCurrent()).toBe(false);
    expect(h.receipt.beginUse(h.fragment, 'copy')).toBeNull();
  });

  it('keeps zero physical cuts distinct from Golden Gate not-ready', () => {
    const h = digestTelemetryHarness();
    owners.push(h.owner);
    const noCuts = computeVirtualDigest('AAAAAAAAAAAA', digestEnzyme());
    h.owner.request('private-enzyme-key');
    h.owner.commit('private-enzyme-key', noCuts, undefined, {});
    expect(h.results('compute')[0].properties).toMatchObject({
      workflow_status: 'no_match',
      success: true,
      outcome_kind: 'digest_no_cuts',
      digest_cut_count: 0,
    });
    const gg = computeVirtualDigest('AAAAGGTCTCAAAAAAAA', digestEnzyme('BsaI', 'GGTCTC'));
    h.owner.request('private-gg');
    h.owner.commit('private-gg', gg, undefined, {});
    expect(h.results('compute').at(-1)!.properties).toMatchObject({
      success: true,
      outcome_kind: 'digest_fragments',
      digest_readiness: 'not-ready',
    });
  });

  it('retires old results on recompute and excludes stale, foreign and retired use callbacks', () => {
    const h = activate();
    const pending = h.receipt.beginUse(h.fragment, 'copy')!;
    const linear = computeVirtualDigest('AAAAGAATTCTTTT', digestEnzyme(), [], { circular: false });
    h.owner.commit('private-enzyme-key', linear, undefined, {});
    expect(h.results('compute').at(-1)!.properties).toMatchObject({
      digest_trigger: 'recompute',
      digest_topology: 'linear',
      result_count: 2,
    });
    expect(pending.complete()).toBe(false);
    expect(digestReceiptFor(linear.fragments)!.beginUse(h.fragment, 'select')).toBeNull();
    h.owner.retire();
    expect(digestReceiptFor(linear.fragments)!.beginUse(linear.fragments[0], 'select')).toBeNull();
  });

  it.each([null, 'different-identity', 'different-episode'])(
    'drops pending use across capture context %s',
    (context) => {
      const h = activate();
      const pending = h.receipt.beginUse(h.fragment, 'copy')!;
      h.changeContext(context);
      expect(pending.complete()).toBe(false);
      expect(h.results('copy')).toHaveLength(0);
      h.changeContext('capture-generation-after-opt-in');
      h.owner.commit('private-enzyme-key', h.result, undefined, {});
      expect(h.results('compute')).toHaveLength(1);
    }
  );

  it('does not backfill a restored view or an activation made with capture disabled', () => {
    const h = digestTelemetryHarness();
    owners.push(h.owner);
    const result = computeVirtualDigest('AAAAGAATTCTTTT', digestEnzyme());
    h.owner.commit('restored-key', result, undefined, {});
    h.changeContext(null);
    h.owner.request('private-key');
    h.changeContext('new-generation');
    h.owner.commit('private-key', result, undefined, {});
    expect(h.events).toEqual([]);
  });

  it('attests only the intended material accepted by the real design store', () => {
    const h = activate();
    const store = useDesignStore.getState();
    const id = store.createDesign('Local digest placement');
    const read = () => useDesignStore.getState().designs[id]?.regions;
    const command = vi.fn(() => store.addRegion(id, h.material));
    placeDigestTransfer(h.material, read, command);
    expect(command).toHaveBeenCalledTimes(1);
    expect(read()).toHaveLength(1);
    expect(read()![0]).toMatchObject(h.material);
    expect(h.results('place').at(-1)!.properties).toMatchObject({
      outcome_kind: 'digest_use_accepted',
      affected_count: 1,
    });
  });

  it('does not attest a no-op when the optional before-read failed, and still runs the command once', () => {
    const h = activate();
    const store = useDesignStore.getState();
    const id = store.createDesign('Before-read failure');
    store.addRegion(id, h.material);
    const existing = useDesignStore.getState().designs[id].regions;
    const read = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('optional lookup');
      })
      .mockImplementation(() => useDesignStore.getState().designs[id].regions);
    const command = vi.fn(() => store.updateRegion(id, 'missing-region', h.material));
    expect(placeDigestTransfer(h.material, read, command)).toBeUndefined();
    expect(command).toHaveBeenCalledTimes(1);
    expect(useDesignStore.getState().designs[id].regions).toBe(existing);
    expect(h.results('place')).toHaveLength(0);
    expect(
      h.events.filter(({ properties }) => properties.workflow_action === 'place')
    ).toHaveLength(0);
  });

  it.each(['wrong-material', 'unrelated-addition', 'unrelated-replacement', 'no-op'] as const)(
    'refuses %s as intended placement proof',
    (kind) => {
      const h = activate();
      const store = useDesignStore.getState();
      const id = store.createDesign(`Placement refusal ${kind}`);
      store.addRegion(id, h.material);
      const prior = useDesignStore.getState().designs[id].regions[0];
      placeDigestTransfer(
        h.material,
        () => useDesignStore.getState().designs[id].regions,
        () => {
          if (kind === 'wrong-material') store.addRegion(id, { ...h.material, sequence: 'TTTT' });
          if (kind === 'unrelated-addition')
            store.addRegion(id, { ...h.material, sourceSequenceId: 'other-source' });
          if (kind === 'unrelated-replacement')
            store.updateRegion(id, prior.id, { sourceSequenceName: 'Only a label changed' });
          if (kind === 'no-op') store.updateRegion(id, 'missing-region', h.material);
        }
      );
      expect(h.results('place').at(-1)!.properties).toMatchObject({
        outcome_kind: 'digest_use_refused',
        affected_count: 0,
      });
    }
  );

  it('preserves a real store refusal and the exact thrown product error', () => {
    const h = activate();
    const missing = 'missing-design';
    placeDigestTransfer(
      h.material,
      () => [],
      () => useDesignStore.getState().addRegion(missing, h.material)
    );
    expect(h.results('place').at(-1)!.properties.outcome_kind).toBe('digest_use_refused');
    const error = new Error('private product failure');
    expect(() =>
      placeDigestTransfer(
        h.material,
        () => [],
        () => {
          throw error;
        }
      )
    ).toThrow(error);
    expect(h.results('place').at(-1)!.properties).toMatchObject({
      success: false,
      error_class: 'unknown',
    });
    expect(JSON.stringify(h.events)).not.toContain(error.message);
  });

  it('refuses altered drag payloads, wrong fragments and stale source-result joins', () => {
    const h = activate();
    const key = createDigestDrag(h.material, h.receipt, h.fragment)!;
    const altered = { ...h.material, sequence: 'TTTT' };
    bindDigestDrag(altered, key);
    placeDigestTransfer(
      altered,
      () => [],
      () => undefined
    );
    const wrongFragment = { ...h.material };
    bindDigestTransfer(wrongFragment, h.receipt, {});
    placeDigestTransfer(
      wrongFragment,
      () => [],
      () => undefined
    );
    const inheritedWrong = { ...h.material, sourceStart: 999 };
    inheritDigestTransfer(inheritedWrong, h.material);
    placeDigestTransfer(
      inheritedWrong,
      () => [],
      () => undefined
    );
    h.owner.retire();
    const stale = { ...h.material };
    bindDigestDrag(stale, key);
    refuseDigestTransfer(stale);
    expect(h.results('place')).toHaveLength(0);
  });

  it('keeps the engine supported fragment-limit refusal separate from no cuts and never invents cancellation', () => {
    const h = digestTelemetryHarness();
    owners.push(h.owner);
    let error: unknown;
    try {
      computeVirtualDigest('AAAAGAATTCTTTT', digestEnzyme(), [], { maxFragments: 0 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(VirtualDigestLimitError);
    h.owner.request('private-key');
    h.owner.commit('private-key', null, 'limit', {});
    expect(h.results('compute')[0].properties).toMatchObject({
      success: false,
      outcome_kind: 'digest_limit',
    });
    expect(h.events.some(({ properties }) => properties.action_phase === 'cancel')).toBe(false);
  });

  it('does not count unknown post-read evidence or a stale placement completion as accepted use', () => {
    const h = activate();
    const read = vi
      .fn()
      .mockReturnValueOnce([])
      .mockImplementationOnce(() => {
        throw new Error('optional post-read');
      });
    const command = vi.fn();
    placeDigestTransfer(h.material, read, command);
    expect(command).toHaveBeenCalledTimes(1);
    expect(h.results('place').at(-1)!.properties).toMatchObject({
      success: false,
      outcome_kind: 'digest_use_unattested',
    });
    const store = useDesignStore.getState();
    const id = store.createDesign('Retired placement');
    placeDigestTransfer(
      h.material,
      () => useDesignStore.getState().designs[id].regions,
      () => {
        store.addRegion(id, h.material);
        h.owner.retire();
      }
    );
    expect(useDesignStore.getState().designs[id].regions[0]).toMatchObject(h.material);
    expect(
      h
        .results('place')
        .filter(({ properties }) => properties.outcome_kind === 'digest_use_accepted')
    ).toHaveLength(0);
  });

  it('does not backfill unsupported collection after the destination begins accepting again', () => {
    const h = digestTelemetryHarness();
    owners.push(h.owner);
    const result = computeVirtualDigest('AAAAGAATTCTTTT', digestEnzyme());
    h.setCollectionAccepted(false);
    h.owner.request('private-key');
    h.owner.commit('private-key', result, undefined, {});
    h.setCollectionAccepted(true);
    h.owner.commit('private-key', result, undefined, {});
    expect(h.events).toEqual([]);
  });

  it('does not reuse retired owner or identity result joins for a later deactivation', () => {
    const h = activate();
    h.owner.retire();
    h.owner.request('');
    h.owner.commit('', null);
    expect(h.results('deactivate').at(-1)!.properties).not.toHaveProperty(
      'artifact_correlation_id'
    );
    expect(h.results('deactivate').at(-1)!.properties).not.toHaveProperty('operation_id');
  });

  it('rejects an invalid fragment rebind instead of retaining the old transfer authority', () => {
    const h = activate();
    expect(createDigestDrag(h.material, h.receipt, {})).toBeUndefined();
    placeDigestTransfer(
      h.material,
      () => [],
      () => undefined
    );
    expect(h.results('place')).toHaveLength(0);
  });
});
