import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from '../junction-workbench/public/AssemblyWorkbenchReducer';
import rad51 from '../../../../../test-fixtures/assembly/rad51-gibson.json';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SequenceDesign } from '../design/types';
import { assemblyCommands } from './commands';
import { applyGoldenGateSchemaCommand } from '../design/golden-gate-schema-command';
import {
  createAssemblyDispatcher,
  type AssemblySidecarResult,
  type AssemblyStoreAdapter,
} from './dispatcher';

const observations = vi.hoisted(() => ({ observe: vi.fn(() => true) }));
vi.mock('../../lib/workflow-telemetry', () => ({ observeWorkflowAction: observations.observe }));
const operationMocks = vi.hoisted(() => ({
  beginToolOperation: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('../../lib/analytics-operation', () => ({
  beginToolOperation: operationMocks.beginToolOperation,
}));

describe('assembly dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    operationMocks.beginToolOperation.mockReturnValue({
      operationId: '550e8400-e29b-41d4-a716-446655440010',
      consumed: false,
      complete: operationMocks.complete,
      fail: operationMocks.fail,
      cancel: operationMocks.cancel,
    });
  });

  it(' preserves all explicitly edited binding sites and tails through real draft dispatch', async () => {
    const harness = createHarness(
      createDesign({ regions: rad51.regions as SequenceDesign['regions'] })
    );
    const dispatcher = createAssemblyDispatcher(harness.adapter);
    expect((await dispatcher.dispatch(assemblyCommands.validate('design-1')).result).ok).toBe(true);
    for (let junctionIndex = 0; junctionIndex < 2; junctionIndex++) {
      const design = harness.state.designs['design-1'];
      const prepared = applyAssemblyWorkbenchCommand({
        design,
        viewState: createAssemblyWorkbenchViewState(design),
        command: {
          type: 'setHomologyEncoding',
          junctionIndex,
          encoding: { onLeft: 15, onRight: 15 },
          expectedDesignVersion: design.version,
        },
      });
      expect(prepared.status, JSON.stringify(prepared.errors)).toBe('applied');
      harness.state.designs['design-1'] = prepared.nextDesign;
    }
    const lengths = [32, 30, 46, 33];
    for (let index = 0; index < lengths.length; index++) {
      for (const field of ['tailLength', 'pbsLength'] as const) {
        const design = harness.state.designs['design-1'];
        const pair = design.designPrimers[Math.floor(index / 2)];
        const primer = index % 2 ? pair.reverse : pair.forward;
        const result = applyAssemblyWorkbenchCommand({
          design,
          viewState: createAssemblyWorkbenchViewState(design),
          command: {
            type: field === 'pbsLength' ? 'setPrimerPbsLength' : 'setPrimerOverhangLength',
            primerId: primer.id,
            expectedDesignVersion: design.version,
            length: field === 'pbsLength' ? lengths[index] : 30,
          },
        });
        expect(result.status, JSON.stringify(result.errors)).toBe('applied');
        harness.state.designs['design-1'] = result.nextDesign;
      }
    }
    expect(
      harness.state.designs['design-1'].designPrimers.flatMap((pair) => [
        pair.forward.pbs.sequence.length,
        pair.reverse.pbs.sequence.length,
      ])
    ).toEqual(lengths);
    const version = harness.state.designs['design-1'].version;
    expect((await dispatcher.dispatch(assemblyCommands.validate('design-1')).result).ok).toBe(true);
    const next = harness.state.designs['design-1'];
    expect(next.version).toBe(version + 1);
    expect(
      next.designPrimers.flatMap((pair) => [
        pair.forward.pbs.sequence.length,
        pair.reverse.pbs.sequence.length,
      ])
    ).toEqual(lengths);
    expect(
      next.designPrimers.flatMap((pair) => [
        pair.forward.overhang.tailLength,
        pair.reverse.overhang.tailLength,
      ])
    ).toEqual([30, 30, 30, 30]);
  });

  it(' preserves explicit homology arms without shifting the PCR binding anchors', async () => {
    const harness = createHarness(
      createDesign({ regions: rad51.regions as SequenceDesign['regions'] })
    );
    const dispatcher = createAssemblyDispatcher(harness.adapter);
    expect((await dispatcher.dispatch(assemblyCommands.validate('design-1')).result).ok).toBe(true);
    for (let junctionIndex = 0; junctionIndex < 2; junctionIndex++) {
      const design = harness.state.designs['design-1'];
      const result = applyAssemblyWorkbenchCommand({
        design,
        viewState: createAssemblyWorkbenchViewState(design),
        command: {
          type: 'setHomologyEncoding',
          junctionIndex,
          encoding: { onLeft: 30, onRight: 30 },
          recomputePrimers: true,
          expectedDesignVersion: design.version,
        },
      });
      expect(result.status, JSON.stringify(result.errors)).toBe('applied');
      harness.state.designs['design-1'] = result.nextDesign;
    }
    const lengths = [32, 30, 46, 33];
    for (let index = 0; index < lengths.length; index++) {
      const design = harness.state.designs['design-1'];
      const primer =
        index % 2
          ? design.designPrimers[Math.floor(index / 2)].reverse
          : design.designPrimers[Math.floor(index / 2)].forward;
      const result = applyAssemblyWorkbenchCommand({
        design,
        viewState: createAssemblyWorkbenchViewState(design),
        command: {
          type: 'setPrimerPbsLength',
          primerId: primer.id,
          length: lengths[index],
          expectedDesignVersion: design.version,
        },
      });
      expect(result.status).toBe('applied');
      harness.state.designs['design-1'] = result.nextDesign;
    }
    expect((await dispatcher.dispatch(assemblyCommands.validate('design-1')).result).ok).toBe(true);
    const next = harness.state.designs['design-1'];
    expect(next.homologyRegions.map((homology) => homology.encoding)).toEqual([
      { onLeft: 30, onRight: 30 },
      { onLeft: 30, onRight: 30 },
    ]);
    expect(next.designPrimers.map((pair) => pair.forward.pbs.start)).toEqual([0, 5618]);
    expect(next.designPrimers.map((pair) => pair.reverse.pbs.end)).toEqual([5618, 7969]);
    expect(
      next.designPrimers.flatMap((pair) => [
        pair.forward.pbs.sequence.length,
        pair.reverse.pbs.sequence.length,
      ])
    ).toEqual(lengths);
  });

  it.each([
    ['pcr', ['pcr', 'pcr'], 2],
    ['digest', ['rd', 'rd'], 0],
    ['mixed', ['pcr', 'rd'], 1],
  ] as const)(
    'describes the accepted %s material route without exporting inputs',
    async (route, types, count) => {
      const design = createDesign({ assemblyState: 'ready' });
      design.regions = types.map((kind, index) =>
        fragment(`Private template ${index}`, 'ACGT'.repeat(30), kind)
      );
      const dispatcher = createAssemblyDispatcher(createHarness(design).adapter, {
        run: () => ({ validationErrors: [] }),
      });
      expect((await dispatcher.dispatch(assemblyCommands.run(design.id)).result).ok).toBe(true);
      expect(operationMocks.beginToolOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowMetadata: expect.objectContaining({
            assemblyComputeStage: 'construct_preview',
            assemblyMaterialRoute: route,
            pcrTemplateCount: count,
          }),
        })
      );
      expect(JSON.stringify(operationMocks.beginToolOperation.mock.calls)).not.toMatch(
        /Private template|ACGT/
      );
    }
  );

  it('marks the actual Draft command as primer planning and carries context on refusal', async () => {
    const design = createDesign({ assemblyState: 'drafting' });
    const dispatcher = createAssemblyDispatcher(createHarness(design).adapter, {
      validate: () => ({ validationErrors: [] }),
    });
    await dispatcher.dispatch(assemblyCommands.validate(design.id)).result;
    expect(operationMocks.beginToolOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowMetadata: expect.objectContaining({
          assemblyComputeStage: 'draft_primers',
          assemblyMaterialRoute: 'pcr',
          pcrTemplateCount: 2,
        }),
      })
    );
    vi.clearAllMocks();
    const refused = createAssemblyDispatcher(
      createHarness(createDesign({ assemblyState: 'preflight' })).adapter
    );
    await refused.dispatch(assemblyCommands.run(design.id)).result;
    expect(operationMocks.beginToolOperation).not.toHaveBeenCalled();
    expect(observations.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        assemblyComputeStage: 'construct_preview',
        assemblyMaterialRoute: 'pcr',
        pcrTemplateCount: 2,
        status: 'blocked',
        outcomeKind: 'validation_refused',
      })
    );
  });

  it('starts draft-compute telemetry only after acceptance and consumes one success terminal', async () => {
    const harness = createHarness(createDesign({ assemblyState: 'ready' }));
    const dispatcher = createAssemblyDispatcher(harness.adapter, {
      run: () => ({
        validationErrors: [],
        updates: {
          assemblyResult: {
            junctions: [],
            primerPairs: [],
            pcrProducts: [],
            assembled: {
              id: 'product',
              name: 'Fixture product',
              sequence: 'ATCG',
              topology: 'circular',
              length: 4,
            },
            validation: { valid: true, errors: [] },
          },
        },
      }),
    });

    const accepted = await dispatcher.dispatch(assemblyCommands.run('design-1')).result;
    const rejected = await createAssemblyDispatcher(
      createHarness(createDesign({ assemblyState: 'preflight' })).adapter
    ).dispatch(assemblyCommands.run('design-1')).result;

    expect(accepted.ok).toBe(true);
    expect(rejected.ok).toBe(false);
    expect(operationMocks.beginToolOperation).toHaveBeenCalledOnce();
    expect(operationMocks.beginToolOperation).toHaveBeenCalledWith({
      toolId: 'assembly',
      surface: 'tab',
      action: 'computed',
      workflowMetadata: expect.objectContaining({
        operationId: expect.any(String),
        artifactCorrelationId: 'design-1',
      }),
    });
    expect(observations.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'assembly',
        action: 'compute',
        status: 'blocked',
        outcomeKind: 'validation_refused',
        valueDelivered: false,
        usableResult: false,
      })
    );
    expect(operationMocks.complete).toHaveBeenCalledExactlyOnceWith(
      undefined,
      expect.objectContaining({ resultCount: 1, valueDelivered: false, usableResult: false })
    );
    expect(operationMocks.fail).not.toHaveBeenCalled();
    expect(operationMocks.cancel).not.toHaveBeenCalled();
  });

  it('records a refused run once, keeps its exact dispatch ID, and excludes dry-run previews', async () => {
    const id = '550e8400-e29b-41d4-a716-446655440103';
    const dispatcher = createAssemblyDispatcher(
      createHarness(createDesign({ assemblyState: 'preflight' })).adapter,
      { createId: () => id }
    );
    await dispatcher.dispatch(assemblyCommands.run('design-1'), { commit: false }).result;
    expect(observations.observe).not.toHaveBeenCalled();
    await dispatcher.dispatch(assemblyCommands.run('design-1')).result;
    expect(observations.observe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ actionId: id, operationId: id, status: 'blocked' })
    );
    expect(operationMocks.beginToolOperation).not.toHaveBeenCalled();
  });

  it('observes the actual UI Draft validate path as a computed ready draft', async () => {
    const dispatcher = createAssemblyDispatcher(createHarness(createDesign()).adapter, {
      validate: () => ({
        validationErrors: [],
        updates: { homologyRegions: [], designPrimers: [] },
      }),
    });
    expect((await dispatcher.dispatch(assemblyCommands.validate('design-1')).result).ok).toBe(true);
    expect(operationMocks.beginToolOperation).toHaveBeenCalledOnce();
    expect(operationMocks.complete).toHaveBeenCalledExactlyOnceWith(
      undefined,
      expect.objectContaining({
        status: 'ready',
        outcomeKind: 'inspection_ready',
        valueDelivered: false,
        usableResult: false,
      })
    );
  });

  it('classifies accepted draft-compute failure and cancellation as exactly one terminal', async () => {
    const failing = createAssemblyDispatcher(
      createHarness(createDesign({ assemblyState: 'ready' })).adapter,
      {
        run: () => {
          throw new Error('sidecar unavailable');
        },
      }
    );
    await failing.dispatch(assemblyCommands.run('design-1')).result;
    expect(operationMocks.fail).toHaveBeenCalledOnce();
    expect(operationMocks.fail).toHaveBeenCalledWith('sidecar');

    vi.clearAllMocks();
    operationMocks.beginToolOperation.mockReturnValue({
      operationId: '550e8400-e29b-41d4-a716-446655440011',
      consumed: false,
      complete: operationMocks.complete,
      fail: operationMocks.fail,
      cancel: operationMocks.cancel,
    });
    const cancellable = createAssemblyDispatcher(
      createHarness(createDesign({ assemblyState: 'ready' })).adapter,
      {
        run: (_design, signal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({ validationErrors: [] }), {
              once: true,
            });
          }),
      }
    );
    const pending = cancellable.dispatch(assemblyCommands.run('design-1'));
    pending.abort();
    await pending.result;

    expect(operationMocks.cancel).toHaveBeenCalledOnce();
    expect(operationMocks.complete).not.toHaveBeenCalled();
    expect(operationMocks.fail).not.toHaveBeenCalled();
  });

  it('terminates an accepted compute with validation when the sidecar commits blocking issues', async () => {
    const dispatcher = createAssemblyDispatcher(
      createHarness(createDesign({ assemblyState: 'ready' })).adapter,
      {
        run: () => ({
          validationErrors: [
            { code: 'invalid_fragment', severity: 'error', message: 'Invalid fragment' },
          ],
        }),
      }
    );

    const result = await dispatcher.dispatch(assemblyCommands.run('design-1')).result;

    expect(result.ok).toBe(true);
    expect(operationMocks.fail).toHaveBeenCalledOnce();
    expect(operationMocks.fail).toHaveBeenCalledWith(
      'validation',
      undefined,
      undefined,
      'validation_invalid_fragment'
    );
    expect(operationMocks.complete).not.toHaveBeenCalled();
  });

  it('serializes dispatches per design and aborts in-flight validation before edits', async () => {
    const harness = createHarness(createDesign({ assemblyState: 'drafting' }));
    let release!: () => void;

    const dispatcher = createAssemblyDispatcher(harness.adapter, {
      validate: (_design, signal) =>
        new Promise<AssemblySidecarResult>((resolve) => {
          release = () => resolve({ validationErrors: [] });
          signal.addEventListener('abort', () => {
            resolve({ validationErrors: [] });
          });
        }),
    });

    const first = dispatcher.dispatch(assemblyCommands.validate('design-1'));
    const second = dispatcher.dispatch(
      assemblyCommands.addFragment('design-1', 'seq-3', {
        region: fragment('fragment-3', 'GGGG'.repeat(30)),
      })
    );

    expect(harness.state.designs['design-1'].regions).toHaveLength(2);
    release();

    const firstResult = await first.result;
    const secondResult = await second.result;

    expect(firstResult.ok).toBe(false);
    if (!firstResult.ok) {
      expect(firstResult.error.kind).toBe('state_conflict');
    }
    expect(secondResult.ok).toBe(true);
    expect(harness.state.designs['design-1'].regions).toHaveLength(3);
    expect(harness.state.designs['design-1'].assemblyState).toBe('drafting');
  });

  it('allows immediate revalidation after an edit aborts in-flight validation', async () => {
    const harness = createHarness(createDesign({ assemblyState: 'drafting' }));
    let validateCallCount = 0;

    const dispatcher = createAssemblyDispatcher(harness.adapter, {
      validate: (_design, signal) => {
        validateCallCount += 1;
        if (validateCallCount === 1) {
          return new Promise<AssemblySidecarResult>((resolve) => {
            signal.addEventListener('abort', () => resolve({ validationErrors: [] }), {
              once: true,
            });
          });
        }
        return Promise.resolve({ validationErrors: [] });
      },
    });

    const first = dispatcher.dispatch(assemblyCommands.validate('design-1'));
    const second = dispatcher.dispatch(
      assemblyCommands.addFragment('design-1', 'seq-3', {
        region: fragment('fragment-3', 'GGGG'.repeat(30)),
      })
    );
    const third = dispatcher.dispatch(assemblyCommands.validate('design-1'));

    const thirdResult = await third.result;

    expect(thirdResult.ok).toBe(true);
    if (!thirdResult.ok) {
      expect(thirdResult.error.kind).not.toBe('state_conflict');
    }
    expect((await first.result).ok).toBe(false);
    expect((await second.result).ok).toBe(true);
  });

  it('does not clear a newer lifecycle pending id from an aborted lifecycle finally', async () => {
    const harness = createHarness(createDesign({ assemblyState: 'drafting' }));
    const pendingLog: Array<string | null> = [];
    const ids = ['validate-initial', 'edit-after-abort', 'validate-next'];
    let validateCallCount = 0;
    harness.onPending = (dispatchId) => pendingLog.push(dispatchId);

    const dispatcher = createAssemblyDispatcher(harness.adapter, {
      createId: () => ids.shift() ?? 'extra-dispatch',
      validate: (_design, signal) => {
        validateCallCount += 1;
        if (validateCallCount === 1) {
          return new Promise<AssemblySidecarResult>((resolve) => {
            signal.addEventListener('abort', () => resolve({ validationErrors: [] }), {
              once: true,
            });
          });
        }
        return Promise.resolve({ validationErrors: [] });
      },
    });

    const first = dispatcher.dispatch(assemblyCommands.validate('design-1'));
    const second = dispatcher.dispatch(
      assemblyCommands.addFragment('design-1', 'seq-3', {
        region: fragment('fragment-3', 'GGGG'.repeat(30)),
      })
    );
    const third = dispatcher.dispatch(assemblyCommands.validate('design-1'));

    await Promise.all([first.result, second.result, third.result]);

    expect(pendingLog).toEqual(['validate-initial', 'validate-next', null]);
  });

  it('wires AbortController through lifecycle commands', async () => {
    const harness = createHarness(createDesign({ assemblyState: 'drafting' }));
    let capturedSignal: AbortSignal | null = null;

    const dispatcher = createAssemblyDispatcher(harness.adapter, {
      validate: (_design, signal) => {
        capturedSignal = signal;
        return new Promise<AssemblySidecarResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      },
    });

    const dispatch = dispatcher.dispatch(assemblyCommands.validate('design-1'));
    dispatch.abort();
    const result = await dispatch.result;

    expect(capturedSignal?.aborted).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('state_conflict');
    }
  });

  it('sets and clears pendingDispatchId around async lifecycle commands', async () => {
    const harness = createHarness(createDesign({ assemblyState: 'drafting' }));
    const pendingLog: Array<string | null> = [];
    harness.onPending = (dispatchId) => pendingLog.push(dispatchId);

    const dispatcher = createAssemblyDispatcher(harness.adapter, {
      validate: () => Promise.resolve({ validationErrors: [] }),
    });

    const result = await dispatcher.dispatch(assemblyCommands.validate('design-1')).result;

    expect(result.ok).toBe(true);
    expect(pendingLog[0]).toEqual(expect.any(String));
    expect(pendingLog[pendingLog.length - 1]).toBeNull();
    expect(harness.state.pendingDispatchId).toBeNull();
  });

  it('returns a successful design-change summary for validate', async () => {
    const harness = createHarness(createDesign({ assemblyState: 'drafting' }));
    const dispatcher = createAssemblyDispatcher(harness.adapter);

    const result = await dispatcher.dispatch(assemblyCommands.validate('design-1')).result;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.designId).toBe('design-1');
      expect(result.value.version).toBe(1);
      expect(result.value.changedFields).toContain('assemblyState');
    }
    expect(harness.state.designs['design-1'].assemblyState).toBe('ready');
    expect(harness.state.designs['design-1'].designPrimers.length).toBeGreaterThan(0);
  });

  it('rejects adjacent restriction digest fragments in Gibson designs', async () => {
    const harness = createHarness(
      createDesign({
        assemblyState: 'ready',
        regions: [
          fragment('rd-1', 'ATCG'.repeat(30), 'rd'),
          fragment('rd-2', 'GCTA'.repeat(30), 'rd'),
        ],
      })
    );
    const dispatcher = createAssemblyDispatcher(harness.adapter);

    const result = await dispatcher.dispatch(assemblyCommands.validate('design-1')).result;

    expect(result.ok).toBe(true);
    expect(harness.state.designs['design-1'].assemblyState).toBe('drafting');
    expect(harness.state.designs['design-1'].validationErrors).toContainEqual(
      expect.objectContaining({
        code: 'gibson_rd_rd_junction',
        severity: 'error',
        field: 'regions[0]',
        fragmentIndex: 0,
      })
    );
    expect(harness.state.designs['design-1'].designPrimers).toEqual([]);
  });

  it('rejects adjacent restriction digest fragments in NEBuilder designs', async () => {
    const harness = createHarness(
      createDesign({
        assemblyMethod: 'nebuilder',
        assemblyState: 'drafting',
        regions: [
          fragment('rd-1', 'ATCG'.repeat(30), 'rd'),
          fragment('rd-2', 'GCTA'.repeat(30), 'rd'),
        ],
      })
    );
    const dispatcher = createAssemblyDispatcher(harness.adapter);

    const result = await dispatcher.dispatch(assemblyCommands.validate('design-1')).result;

    expect(result.ok).toBe(true);
    expect(harness.state.designs['design-1'].assemblyState).toBe('drafting');
    expect(harness.state.designs['design-1'].validationErrors).toContainEqual(
      expect.objectContaining({
        code: 'gibson_rd_rd_junction',
        severity: 'error',
      })
    );
  });

  it('rejects Golden Gate drafts when an RD fragment was produced by a different Type IIS enzyme', async () => {
    const bsmBIRd = {
      ...fragment('bsmBI-rd', 'ATCG'.repeat(30), 'rd'),
      rdSourceEnzyme: 'BsmBI' as const,
      rdSourceEnzymeName: 'BsmBI',
    };
    const harness = createHarness(
      createDesign({
        assemblyMethod: 'goldengate',
        goldenGateConfig: { enzyme: 'BsaI' },
        goldenGateJunctions: [],
        assemblyState: 'drafting',
        regions: [bsmBIRd, fragment('pcr', 'GCTA'.repeat(30), 'pcr')],
      })
    );
    const dispatcher = createAssemblyDispatcher(harness.adapter);

    const result = await dispatcher.dispatch(assemblyCommands.validate('design-1')).result;
    const design = harness.state.designs['design-1'];

    expect(result.ok).toBe(true);
    expect(design.assemblyState).toBe('drafting');
    expect(design.validationErrors).toContainEqual(
      expect.objectContaining({
        code: 'goldengate_rd_enzyme_mismatch',
        severity: 'error',
        field: 'regions[0]',
        fragmentIndex: 0,
      })
    );
    expect(design.designPrimers).toEqual([]);
  });

  it('allows the invalid Golden Gate method state but blocks assembly output for incompatible RD fragments', async () => {
    const bsmBIRd = {
      ...fragment('bsmBI-rd', 'ATCG'.repeat(30), 'rd'),
      rdSourceEnzyme: 'BsmBI' as const,
      rdSourceEnzymeName: 'BsmBI',
    };
    const harness = createHarness(
      createDesign({
        assemblyMethod: 'goldengate',
        goldenGateConfig: { enzyme: 'BsaI' },
        goldenGateJunctions: [],
        assemblyState: 'ready',
        regions: [bsmBIRd, fragment('pcr', 'GCTA'.repeat(30), 'pcr')],
      })
    );
    const dispatcher = createAssemblyDispatcher(harness.adapter);

    const result = await dispatcher.dispatch(assemblyCommands.run('design-1')).result;
    const design = harness.state.designs['design-1'];

    expect(result.ok).toBe(true);
    expect(design.assemblyMethod).toBe('goldengate');
    expect(design.assemblyState).toBe('drafting');
    expect(design.assemblyResult).toBeUndefined();
    expect(design.validationErrors).toContainEqual(
      expect.objectContaining({
        code: 'goldengate_rd_enzyme_mismatch',
        severity: 'error',
        field: 'regions[0]',
        fragmentIndex: 0,
      })
    );
  });

  it('rejects Golden Gate drafts when RD cut-site provenance does not match selected enzyme geometry', async () => {
    const badGeometryRd = {
      ...fragment('bad-geometry-rd', 'ATCG'.repeat(30), 'rd'),
      rdSourceEnzyme: 'BsaI' as const,
      rdSourceEnzymeName: 'BsaI',
      sourceSequence: 'A'.repeat(160),
      rdEnds: {
        upstream: {
          overhang: 'AATG',
          recognitionSequence: 'GGTCTC',
          recognitionStart: 20,
          recognitionEnd: 26,
          cutPositionTop: 28,
          cutPositionBottom: 32,
          strand: 'forward' as const,
        },
      },
    };
    const harness = createHarness(
      createDesign({
        assemblyMethod: 'goldengate',
        goldenGateConfig: { enzyme: 'BsaI' },
        goldenGateJunctions: [],
        assemblyState: 'drafting',
        regions: [badGeometryRd, fragment('pcr', 'GCTA'.repeat(30), 'pcr')],
      })
    );
    const dispatcher = createAssemblyDispatcher(harness.adapter);

    const result = await dispatcher.dispatch(assemblyCommands.validate('design-1')).result;
    const design = harness.state.designs['design-1'];

    expect(result.ok).toBe(true);
    expect(design.assemblyState).toBe('drafting');
    expect(design.validationErrors).toContainEqual(
      expect.objectContaining({
        code: 'goldengate_rd_cut_site_mismatch',
        severity: 'error',
        field: 'regions[0]',
        fragmentIndex: 0,
      })
    );
    expect(design.designPrimers).toEqual([]);
  });

  it.each(['gibson', 'nebuilder'] as const)(
    'rejects circular %s RD/PCR/RD hybrid designs because the closing junction is RD/RD',
    async (assemblyMethod) => {
      const harness = createHarness(
        createDesign({
          assemblyMethod,
          assemblyState: 'drafting',
          regions: [
            fragment('rd-left', 'ATCG'.repeat(30), 'rd'),
            fragment('pcr-middle', 'GCTA'.repeat(30), 'pcr'),
            fragment('rd-right', 'CGTA'.repeat(30), 'rd'),
          ],
        })
      );
      const dispatcher = createAssemblyDispatcher(harness.adapter);

      const result = await dispatcher.dispatch(assemblyCommands.validate('design-1')).result;
      const design = harness.state.designs['design-1'];

      expect(result.ok).toBe(true);
      expect(design.assemblyState).toBe('drafting');
      expect(design.validationErrors).toContainEqual(
        expect.objectContaining({
          code: 'gibson_rd_rd_junction',
          severity: 'error',
          field: 'regions[2]',
          fragmentIndex: 2,
        })
      );
      expect(design.homologyRegions).toEqual([]);
      expect(design.designPrimers).toEqual([]);
    }
  );

  it('rejects linear topology at the assembly dispatcher boundary', async () => {
    const harness = createHarness(
      createDesign({
        topology: 'linear',
        assemblyState: 'drafting',
      })
    );
    const dispatcher = createAssemblyDispatcher(harness.adapter);

    const result = await dispatcher.dispatch(assemblyCommands.validate('design-1')).result;
    const design = harness.state.designs['design-1'];

    expect(result.ok).toBe(true);
    expect(design.assemblyState).toBe('drafting');
    expect(design.validationErrors).toContainEqual(
      expect.objectContaining({
        code: 'unsupported_linear_topology',
        severity: 'error',
        field: 'topology',
      })
    );
    expect(design.designPrimers).toEqual([]);
  });

  it('accepts NEBuilder as an enzyme strategy', async () => {
    const harness = createHarness(createDesign({ assemblyState: 'drafting' }));
    const dispatcher = createAssemblyDispatcher(harness.adapter);

    const result = await dispatcher.dispatch(
      assemblyCommands.setEnzymeStrategy('design-1', { method: 'nebuilder' })
    ).result;

    expect(result.ok).toBe(true);
    expect(harness.state.designs['design-1'].assemblyMethod).toBe('nebuilder');
    expect(harness.state.designs['design-1'].goldenGateConfig).toBeUndefined();
    expect(harness.state.designs['design-1'].homologyRegions).toEqual([]);
  });

  it('supports dry-run homology edits without mutating design state', async () => {
    const harness = createHarness(createDesign({ assemblyState: 'drafting' }));
    const dispatcher = createAssemblyDispatcher(harness.adapter);
    await dispatcher.dispatch(assemblyCommands.validate('design-1')).result;
    const before = structuredClone(harness.state.designs['design-1']);
    const homology = before.homologyRegions[0];

    const dryRun = await dispatcher.dispatch(
      assemblyCommands.updateHomologyEncoding(
        'design-1',
        homology.junctionIndex,
        { onLeft: homology.encoding.onLeft + 1, onRight: homology.encoding.onRight },
        { expectedVersion: before.version, recomputePrimers: false }
      ),
      { commit: false }
    ).result;

    expect(dryRun.ok).toBe(true);
    expect(harness.state.designs['design-1']).toEqual(before);

    const commit = await dispatcher.dispatch(
      assemblyCommands.updateHomologyEncoding(
        'design-1',
        homology.junctionIndex,
        { onLeft: homology.encoding.onLeft + 1, onRight: homology.encoding.onRight },
        { expectedVersion: before.version, recomputePrimers: true }
      )
    ).result;

    expect(commit.ok).toBe(true);
    expect(harness.state.designs['design-1'].version).toBe(before.version + 1);
    expect(harness.state.designs['design-1'].homologyRegions[0].encoding.onLeft).toBe(
      homology.encoding.onLeft + 1
    );
  });

  it('refuses an incompatible fixed-overhang reorder from non-UI command callers', async () => {
    const aToB = {
      ...fragment('A-B', 'ATCG'.repeat(30), 'rd'),
      rdOverhangs: { upstream: 'AATG', downstream: 'GCTT' },
    };
    const bToC = {
      ...fragment('B-C', 'GCTA'.repeat(30), 'rd'),
      rdOverhangs: { upstream: 'GCTT', downstream: 'CGCT' },
    };
    const cToA = {
      ...fragment('C-A', 'CGAT'.repeat(30), 'rd'),
      rdOverhangs: { upstream: 'CGCT', downstream: 'AATG' },
    };
    const harness = createHarness(
      createDesign({
        assemblyMethod: 'goldengate',
        goldenGateConfig: { enzyme: 'BsaI' },
        regions: [aToB, bToC, cToA],
      })
    );
    const dispatcher = createAssemblyDispatcher(harness.adapter);

    const result = await dispatcher.dispatch(
      assemblyCommands.reorderFragments('design-1', [aToB.id, cToA.id, bToC.id])
    ).result;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('bad_input');
      expect(result.error.message).toContain('fixed Golden Gate overhangs');
    }
    expect(harness.state.designs['design-1'].regions.map((region) => region.id)).toEqual([
      aToB.id,
      bToC.id,
      cToA.id,
    ]);
  });

  it('shares stable position links and route-free empty inputs for agent structural edits', async () => {
    const applied = applyGoldenGateSchemaCommand({
      design: createDesign({ regions: [], assemblyMethod: 'goldengate' }),
      expectedVersion: 0,
      schema: {
        id: 'custom',
        name: 'Custom',
        revision: 1,
        origin: { type: 'custom' },
        enzyme: 'BsaI',
        slots: ['first', 'second'].map((id) => ({
          id,
          label: id,
          outgoingOverhang: null,
          preferredRoles: [],
        })),
      },
    });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') return;
    const harness = createHarness(applied.nextDesign);
    const dispatcher = createAssemblyDispatcher(harness.adapter);
    const read = () => harness.state.designs['design-1'];
    expect(
      (await dispatcher.dispatch(assemblyCommands.addFragment('design-1', 'pending-source')).result)
        .ok
    ).toBe(true);
    const added = read().regions[2];
    expect(added.sourceType).toBeUndefined();
    expect(added.schemaSlotId).toBe(read().goldenGateSchema!.slots[2].id);
    expect(
      (
        await dispatcher.dispatch(
          assemblyCommands.reorderFragments(
            'design-1',
            read()
              .regions.map((r) => r.id)
              .reverse()
          )
        ).result
      ).ok
    ).toBe(true);
    expect(read().regions.map((r) => r.schemaSlotId)).toEqual(
      read().goldenGateSchema!.slots.map((s) => s.id)
    );
    expect(
      (await dispatcher.dispatch(assemblyCommands.removeFragment('design-1', added.id)).result).ok
    ).toBe(true);
    expect(read().regions.map((r) => r.schemaSlotId)).toEqual(['second', 'first']);
    expect(read().goldenGateSchema!.slots.map((s) => s.id)).toEqual(['second', 'first']);
  });

  it('refuses structural edits to an assembly using a reusable Golden Gate schema', async () => {
    const design = createDesign({
      assemblyMethod: 'goldengate',
      goldenGateConfig: { enzyme: 'BsaI' },
      goldenGateSchema: {
        id: 'kit-schema',
        name: 'Kit schema',
        revision: 1,
        origin: { type: 'kit', kitId: 'kit', kitName: 'Kit' },
        enzyme: 'BsaI',
        slots: [
          { id: 'first', label: 'First', outgoingOverhang: 'AATG', preferredRoles: [] },
          { id: 'second', label: 'Second', outgoingOverhang: 'GGAG', preferredRoles: [] },
        ],
      },
    });
    const harness = createHarness(design);
    const dispatcher = createAssemblyDispatcher(harness.adapter);

    const commands = [
      assemblyCommands.addFragment('design-1', 'seq-3', {
        region: fragment('fragment-3', 'AAAA'),
      }),
      assemblyCommands.removeFragment('design-1', 'fragment-1'),
      assemblyCommands.reorderFragments('design-1', ['fragment-2', 'fragment-1']),
    ];

    for (const command of commands) {
      const result = await dispatcher.dispatch(command).result;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('schema');
    }
    expect(harness.state.designs['design-1'].regions.map((region) => region.id)).toEqual([
      'fragment-1',
      'fragment-2',
    ]);
  });

  it('returns structured refusal shapes for bad input, state conflict, stale state, and sidecar failure', async () => {
    const harness = createHarness(createDesign({ assemblyState: 'preflight' }));
    const dispatcher = createAssemblyDispatcher(harness.adapter);

    const badInput = await dispatcher.dispatch({ type: 'wat', designId: 'design-1' } as any).result;
    expect(badInput.ok).toBe(false);
    if (!badInput.ok) expect(badInput.error.kind).toBe('bad_input');

    const conflict = await dispatcher.dispatch(assemblyCommands.run('design-1')).result;
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.kind).toBe('state_conflict');

    harness.state.designs['design-1'].assemblyState = 'drafting';
    const stale = await dispatcher.dispatch(
      assemblyCommands.validate('design-1', { expectedVersion: 100 })
    ).result;
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.kind).toBe('stale_state');

    const failingDispatcher = createAssemblyDispatcher(harness.adapter, {
      validate: () => {
        throw new Error('sidecar unavailable');
      },
    });
    const sidecarFailure = await failingDispatcher.dispatch(assemblyCommands.validate('design-1'))
      .result;
    expect(sidecarFailure.ok).toBe(false);
    if (!sidecarFailure.ok) expect(sidecarFailure.error.kind).toBe('sidecar_failure');
  });
});

function createHarness(initialDesign: SequenceDesign) {
  const state = {
    designs: { [initialDesign.id]: initialDesign },
    pendingDispatchId: null as string | null,
  };
  const harness = {
    state,
    onPending: null as null | ((dispatchId: string | null) => void),
    adapter: {
      getDesign: (designId) => state.designs[designId],
      updateDesign: (designId, updater) => {
        state.designs[designId] = updater(state.designs[designId]);
      },
      setPendingDispatchId: (dispatchId) => {
        state.pendingDispatchId = dispatchId;
        harness.onPending?.(dispatchId);
      },
    } satisfies AssemblyStoreAdapter,
  };
  return harness;
}

function createDesign(overrides: Partial<SequenceDesign> = {}): SequenceDesign {
  const now = new Date('2026-04-26T00:00:00.000Z');
  return {
    id: 'design-1',
    name: 'Design 1',
    topology: 'circular',
    regions: [fragment('fragment-1', 'ATCG'.repeat(30)), fragment('fragment-2', 'GCTA'.repeat(30))],
    spacers: [],
    version: 0,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fragment(name: string, sequence: string, sourceType: 'pcr' | 'rd' = 'pcr') {
  return {
    id: name,
    sourceSequenceId: `source-${name}`,
    sourceSequenceName: name,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType,
    ...(sourceType === 'rd'
      ? {
          ggType: 'insert' as const,
          rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
          rdSourceEnzyme: 'BsaI' as const,
        }
      : {}),
  };
}
