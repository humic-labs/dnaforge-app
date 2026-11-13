import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateTmNN } from '../design/algorithms/tm-calculator';
import {
  DEFAULT_TM_CONDITIONS,
  DEFAULT_TM_MODEL,
  OWCZARZY_TM_MODEL,
} from '../design/algorithms/tm-model';
import { useSettingsStore } from '../junction-workbench/settings';
import { primerTmCalculationService } from './primer-tm-service';
import { estimateLegacyPrimerTm } from '../../shared/primers/primer-tm';

const { nebFetchMock } = vi.hoisted(() => ({ nebFetchMock: vi.fn() }));

vi.mock('../design/algorithms/neb-tm-client', () => ({
  makeNebFetch: () => nebFetchMock,
}));

const SEQUENCE = 'ATGCGATCGATCGATCGATC';

describe('primerTmCalculationService', () => {
  beforeEach(() => {
    nebFetchMock.mockReset();
    useSettingsStore.setState({
      tmModel: DEFAULT_TM_MODEL,
      tmModelExplicit: false,
      primerConcNm: 500,
      primerConcExplicit: false,
      tmConditions: DEFAULT_TM_CONDITIONS,
    });
  });

  afterEach(() => {
    useSettingsStore.setState({
      tmModel: DEFAULT_TM_MODEL,
      tmModelExplicit: false,
      primerConcNm: 500,
      primerConcExplicit: false,
      tmConditions: DEFAULT_TM_CONDITIONS,
    });
  });

  it('calculates a standalone primer with the saved local preference and concentration', async () => {
    useSettingsStore.setState({ tmModelExplicit: true, primerConcNm: 750 });

    const result = await primerTmCalculationService.calculate(SEQUENCE);

    expect(result.valueC).toBeCloseTo(calculateTmNN(SEQUENCE, { primerConc: 750 }), 8);
    expect(result.source).toBe('user-setting');
    expect(result.status).toBe('local');
  });

  it('uses a typed per-call override without changing the saved preference', async () => {
    const result = await primerTmCalculationService.calculate(SEQUENCE, {
      override: OWCZARZY_TM_MODEL,
    });

    const expected = calculateTmNN(SEQUENCE, {
      primerConc: 500,
      naConc: DEFAULT_TM_CONDITIONS.monovalentMm,
      mgConc: DEFAULT_TM_CONDITIONS.divalentMm,
      dntpConc: DEFAULT_TM_CONDITIONS.dntpMm,
      saltMethod: 'owczarzy',
    });
    expect(result.model).toEqual(OWCZARZY_TM_MODEL);
    expect(result.valueC).toBeCloseTo(expected, 8);
    expect(result.valueC).not.toBeCloseTo(calculateTmNN(SEQUENCE, { primerConc: 500 }), 4);
    expect(result.source).toBe('call-override');
    expect(useSettingsStore.getState().tmModel).toEqual(DEFAULT_TM_MODEL);
  });

  it('uses the selected NEB provider and records verified provenance', async () => {
    nebFetchMock.mockResolvedValueOnce({
      tm: 71.2,
      nebApiVersion: 'test',
      fetchedAt: '2026-08-10T00:00:00.000Z',
    });

    const result = await primerTmCalculationService.calculate(SEQUENCE, {
      override: { kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' },
      online: true,
    });

    expect(result.valueC).toBe(71.2);
    expect(result.status).toBe('verified');
    expect(result.provider.source).toBe('neb-api');
  });

  it('keeps legacy artifact parsing deterministic and independent of saved settings', () => {
    useSettingsStore.setState({
      tmModel: { kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' },
      tmModelExplicit: true,
      primerConcNm: 900,
    });

    for (const sequence of [SEQUENCE, SEQUENCE.toLowerCase(), 'ACGTACGTACGTACGN', 'ATGC']) {
      expect(estimateLegacyPrimerTm(sequence)).toBe(calculateTmNN(sequence));
      expect(primerTmCalculationService.estimateLegacyLocal(sequence)).toBe(
        calculateTmNN(sequence)
      );
    }
    expect(nebFetchMock).not.toHaveBeenCalled();
  });
});
