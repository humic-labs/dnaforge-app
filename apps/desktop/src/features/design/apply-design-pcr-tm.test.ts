import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beginToolOperation } from '../../lib/analytics-operation';
vi.mock('../../lib/analytics-operation', () => ({ beginToolOperation: vi.fn() }));
import { applyDesignPcrTmModel, resetDesignPcrTmSettingsToDefaults } from './apply-design-pcr-tm';
import { useDesignStore } from './store';
import { useSettingsStore } from '../junction-workbench/settings';
import {
  DEFAULT_PRIMER_CONC_NM,
  DEFAULT_TM_CONDITIONS,
  DEFAULT_TM_MODEL,
} from './algorithms/tm-model';
import { GOLDENGATE_DEFAULT_PCR_TM } from './validation-constants';
import { recomputeDesignPrimerTms } from './algorithms/recompute-design-primer-tms';
import { createAppTmCalculator } from '../junction-workbench/settings';
import { getTmProviderRegistry, setTmProviderRegistry } from './algorithms/design-tm-refinement';
import { TmProviderRegistry, createLocalTmProvider } from './algorithms/tm-provider';
import type { DesignPrimerPair } from './types';

function primerPair(pbs: string): DesignPrimerPair {
  const primer = (id: string) => ({
    id,
    name: id,
    sequence: pbs,
    pbs: { start: 0, end: pbs.length, sequence: pbs },
    overhang: { length: 0, sequence: '' },
    direction: 'forward' as const,
    fragmentIndex: 0,
    junctionIndex: 0,
    tm: 50,
  });
  return {
    forward: primer('f'),
    reverse: primer('r'),
    fragmentIndex: 0,
  } as unknown as DesignPrimerPair;
}

describe('applyDesignPcrTmModel', () => {
  const originalRegistry = getTmProviderRegistry();

  beforeEach(() => {
    setTmProviderRegistry(new TmProviderRegistry().register(createLocalTmProvider(() => 50)));
    useSettingsStore.setState({ tmModel: DEFAULT_TM_MODEL, tmModelExplicit: false });
    useDesignStore.setState({
      designs: {
        d1: {
          id: 'd1',
          name: 'd',
          regions: [],
          topology: 'circular',
          assemblyMethod: 'goldengate',
          defaultHomologyLength: 30,
          homologyRegions: [],
          designPrimers: [primerPair('GGTCTCAAAAACCCC')],
          spacers: [],
          status: 'draft',
          assemblyState: 'drafting',
          validationErrors: [],
          version: 1,
          pcrPolymerase: null,
        } as never,
      },
      activeDesignId: 'd1',
      lastCopied: null,
      pendingDispatchId: null,
    });
  });

  afterEach(() => {
    setTmProviderRegistry(originalRegistry);
  });

  it('sets the shared Tm model, records the design polymerase, and refreshes stored Tms', () => {
    const before = useDesignStore.getState().designs.d1.designPrimers[0].forward.tm;
    expect(applyDesignPcrTmModel('d1', { kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' })).toBe(
      true
    );
    const design = useDesignStore.getState().designs.d1;
    expect(useSettingsStore.getState().tmModel).toEqual({
      kind: 'neb',
      prodcode: 'q5-0',
      polymerase: 'q5',
    });
    expect(design.pcrPolymerase).toBe('q5-0');
    expect(design.designPrimers[0].forward.tm).not.toBe(before);
    expect(design.designPrimers[0].forward.tmProvenance).toBeUndefined();
    expect(beginToolOperation).not.toHaveBeenCalled();
  });

  it('recomputeDesignPrimerTms uses the calculator the caller already resolved', () => {
    const pair = primerPair('GGTCTCAAAAACCCC');
    const next = recomputeDesignPrimerTms([pair], createAppTmCalculator(null));
    expect(next[0].forward.tm).toBe(createAppTmCalculator(null).estimate('GGTCTCAAAAACCCC'));
    expect(next[0].forward.tm).not.toBe(50);
  });

  it('resets global settings and clears the current design polymerase override', () => {
    expect(applyDesignPcrTmModel('d1', { kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' })).toBe(
      true
    );
    useSettingsStore.setState({
      defaultPcrTm: 64,
      primerConcNm: 125,
      primerConcExplicit: true,
      tmConditions: { monovalentMm: 75, divalentMm: 2, dntpMm: 0.8 },
    });

    expect(resetDesignPcrTmSettingsToDefaults('d1')).toBe(true);

    expect(useSettingsStore.getState()).toMatchObject({
      defaultPcrTm: GOLDENGATE_DEFAULT_PCR_TM,
      tmModel: DEFAULT_TM_MODEL,
      tmModelExplicit: false,
      primerConcNm: DEFAULT_PRIMER_CONC_NM,
      primerConcExplicit: false,
      tmConditions: DEFAULT_TM_CONDITIONS,
    });
    expect(useDesignStore.getState().designs.d1.pcrPolymerase).toBeNull();
  });
});
