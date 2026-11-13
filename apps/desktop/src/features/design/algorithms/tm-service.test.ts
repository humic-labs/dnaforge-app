// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import {
  createTmCalculator,
  resolveTmModelWithSource,
  tmModelFromReaction,
  LOCAL_TM_CALCULATOR,
} from './tm-service';
import { resolveTmModel } from './tm-model';
import { DEFAULT_TM_MODEL, OWCZARZY_TM_MODEL, type TmModel } from './tm-model';
import { estimateTm } from './tm-calculator';

const Q5: TmModel = { kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' };

describe('resolveTmModelWithSource — the precedence trap ', () => {
  it("lets a design's polymerase beat the app-global DEFAULT", () => {
    const inputs = {
      reaction: { polymerase: 'q5' },
      userSetting: DEFAULT_TM_MODEL,
      userSettingIsExplicit: false,
    };

    const old = resolveTmModel({ userChoice: inputs.userSetting, reaction: inputs.reaction });
    expect(old).toEqual(DEFAULT_TM_MODEL);

    const resolved = resolveTmModelWithSource(inputs);
    expect(resolved.model).toEqual(Q5);
    expect(resolved.source).toBe('reaction');
  });

  it('respects an EXPLICIT app-wide choice over no reaction at all', () => {
    const resolved = resolveTmModelWithSource({
      userSetting: OWCZARZY_TM_MODEL,
      userSettingIsExplicit: true,
    });
    expect(resolved.model).toEqual(OWCZARZY_TM_MODEL);
    expect(resolved.source).toBe('user-setting');
  });

  it("still prefers the design's enzyme over an explicit global preference", () => {
    const resolved = resolveTmModelWithSource({
      reaction: { polymerase: 'phusion' },
      userSetting: OWCZARZY_TM_MODEL,
      userSettingIsExplicit: true,
    });
    expect(resolved.source).toBe('reaction');
    expect(resolved.model).toMatchObject({ kind: 'neb', polymerase: 'phusion' });
  });

  it('a per-call override beats everything', () => {
    const resolved = resolveTmModelWithSource({
      override: OWCZARZY_TM_MODEL,
      reaction: { polymerase: 'q5' },
      userSetting: DEFAULT_TM_MODEL,
      userSettingIsExplicit: true,
    });
    expect(resolved.source).toBe('call-override');
    expect(resolved.model).toEqual(OWCZARZY_TM_MODEL);
  });

  it('falls back to the default and says so', () => {
    const resolved = resolveTmModelWithSource({});
    expect(resolved.model).toEqual(DEFAULT_TM_MODEL);
    expect(resolved.source).toBe('default');
    expect(resolved.reason).toMatch(/default/i);
  });

  it('always explains itself — every resolution carries a non-empty reason', () => {
    const cases = [
      { override: OWCZARZY_TM_MODEL },
      { reaction: { polymerase: 'q5' } },
      { userSetting: OWCZARZY_TM_MODEL, userSettingIsExplicit: true },
      {},
    ];
    for (const input of cases) {
      expect(resolveTmModelWithSource(input).reason.length).toBeGreaterThan(10);
    }
  });
});

describe('tmModelFromReaction', () => {
  it('maps a family name, a product code, and a human label', () => {
    expect(tmModelFromReaction({ polymerase: 'q5' })).toEqual(Q5);
    expect(tmModelFromReaction({ polymerase: 'q5-0' })).toEqual(Q5);
    expect(tmModelFromReaction({ polymerase: 'Phusion HF' })).toMatchObject({
      polymerase: 'phusion',
    });
  });

  it('returns null for an unknown or absent enzyme rather than guessing', () => {
    expect(tmModelFromReaction({ polymerase: 'SomeOtherPol' })).toBeNull();
    expect(tmModelFromReaction({ polymerase: '' })).toBeNull();
    expect(tmModelFromReaction(null)).toBeNull();
    expect(tmModelFromReaction(undefined)).toBeNull();
  });
});

describe('createTmCalculator — the insertable surface', () => {
  const SEQ = 'ATGCGTACGTTAGCATCGATCGATCGTAGCTA';

  it('is a drop-in for the bare estimateTm when unconfigured', () => {
    expect(createTmCalculator().estimate(SEQ)).toBeCloseTo(estimateTm(SEQ), 6);
    expect(LOCAL_TM_CALCULATOR.estimate(SEQ)).toBeCloseTo(estimateTm(SEQ), 6);
  });

  it('never claims a NEB number from the synchronous path', () => {
    const calc = createTmCalculator({ reaction: { polymerase: 'q5' } });
    const estimate = calc.estimateWithProvenance(SEQ);
    expect(estimate.model).toEqual(Q5);
    expect(estimate.source).toBe('reaction');
    expect(estimate.pendingNebVerification).toBe(true);
    expect(estimate.tm).toBeCloseTo(estimateTm(SEQ), 6);
  });

  it('does not flag pending verification for a local model', () => {
    const calc = createTmCalculator({});
    expect(calc.estimateWithProvenance(SEQ).pendingNebVerification).toBe(false);
  });

  it('routes the async path to NEB when the reaction resolves to one', async () => {
    const nebFetch = vi.fn(async () => ({
      tm: 68.4,
      ta: 70,
      nebApiVersion: 'test',
      fetchedAt: '2026-07-25T00:00:00Z',
    }));
    const calc = createTmCalculator({ reaction: { polymerase: 'q5' }, nebFetch });

    const result = await calc.compute(SEQ);
    expect(nebFetch).toHaveBeenCalledTimes(1);
    expect(nebFetch.mock.calls[0][0]).toMatchObject({ prodcode: 'q5-0' });
    expect(result.tm).toBe(68.4);
    expect(result.verified).toBe(true);
    expect(result.provenance.polymerase).toBe('q5');
  });

  it('falls back to the local value when the NEB call fails, and flags it', async () => {
    const onNebError = vi.fn();
    const calc = createTmCalculator({
      reaction: { polymerase: 'q5' },
      nebFetch: vi.fn(async () => {
        throw new Error('sidecar down');
      }),
      onNebError,
    });

    const result = await calc.compute(SEQ);
    expect(result.verified).toBe(false);
    expect(result.provenance.pendingNebVerification).toBe(true);
    expect(onNebError).toHaveBeenCalled();
  });

  it('never calls NEB for a local model', async () => {
    const nebFetch = vi.fn();
    const calc = createTmCalculator({ nebFetch });
    const result = await calc.compute(SEQ);
    expect(nebFetch).not.toHaveBeenCalled();
    expect(result.provenance.source).toBe('local');
  });

  it('applies Owczarzy salt conditions when that model is resolved', () => {
    const plain = createTmCalculator({}).estimate(SEQ);
    const owczarzy = createTmCalculator({
      override: OWCZARZY_TM_MODEL,
      conditions: { monovalentMm: 50, divalentMm: 2, dntpMm: 0.2 },
    }).estimate(SEQ);
    expect(owczarzy).not.toBeCloseTo(plain, 3);
  });
});

describe("a design's polymerase reaches assembly primer design ", () => {
  function twoPartDesign(pcrPolymerase?: string | null) {
    const left = 'ATGCGTACGTTAGCATCGATCGATCGTAGCTAGCTAGCTAGCATCGATCGATCGATCGTA';
    const right = 'GGCCTTAAGGCCTTAAGGCCTTAAGGCCTTAAGGCCTTAAGGCCTTAAGGCCTTAAGGCC';
    return {
      id: 'd1',
      name: 'draft',
      topology: 'circular' as const,
      assemblyMethod: 'gibson' as const,
      defaultHomologyLength: 30,
      version: 0,
      status: 'draft' as const,
      assemblyState: 'drafting' as const,
      validationErrors: [],
      spacers: [],
      homologyRegions: [],
      designPrimers: [],
      pcrPolymerase,
      regions: [left, right].map((sequence, index) => ({
        id: `r${index}`,
        sourceSequenceId: `s${index}`,
        sourceSequenceName: `s${index}`,
        sourceStart: 0,
        sourceEnd: sequence.length,
        sequence,
        annotations: [],
        sourceType: 'pcr' as const,
      })),
    };
  }

  it('reports the DEFAULT model when no polymerase is recorded', async () => {
    const { computeDraftAssembly } = await import('./draft-assembly');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = computeDraftAssembly(twoPartDesign(null) as any);
    expect(result.tmResolution.source).toBe('default');
    expect(result.tmResolution.pendingNebVerification).toBe(false);
  });

  it("resolves to the design's polymerase once one is recorded", async () => {
    const { computeDraftAssembly } = await import('./draft-assembly');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = computeDraftAssembly(twoPartDesign('q5') as any);
    expect(result.tmResolution.source).toBe('reaction');
    expect(result.tmResolution.model).toEqual(Q5);
    expect(result.tmResolution.pendingNebVerification).toBe(true);
  });

  it('does not silently change the primer Tm numbers it already produced', async () => {
    const { computeDraftAssembly } = await import('./draft-assembly');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const before = computeDraftAssembly(twoPartDesign(null) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const after = computeDraftAssembly(twoPartDesign('q5') as any);
    expect(after.designPrimers.map((p) => p.tm)).toEqual(before.designPrimers.map((p) => p.tm));
  });
});
