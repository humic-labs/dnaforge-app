import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TmModel } from '../design/algorithms/tm-model';
import { primerTmCalculationService } from './primer-tm-service';

type StoredCalculatorContext = Parameters<
  typeof import('../junction-workbench/settings').createStoredPrimerTmCalculator
>[0];

const { nebFetchMock, recordedOnline } = vi.hoisted(() => ({
  nebFetchMock: vi.fn(),
  recordedOnline: [] as (boolean | undefined)[],
}));

vi.mock('../design/algorithms/neb-tm-client', () => ({
  makeNebFetch: () => nebFetchMock,
}));

vi.mock('../junction-workbench/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../junction-workbench/settings')>();
  return {
    ...actual,
    createStoredPrimerTmCalculator: (context: StoredCalculatorContext) => {
      recordedOnline.push(context?.online);
      return actual.createStoredPrimerTmCalculator(context);
    },
  };
});

const SEQUENCE = 'ATGCGATCGATCGATCGATC';
const NEB_MODEL: TmModel = { kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' };

const NODE_22_NAVIGATOR = { platform: 'MacIntel', userAgent: 'Node.js/22' };

beforeEach(() => {
  nebFetchMock.mockReset();
  recordedOnline.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the jsdom baseline these renderer tests actually run in', () => {
  it('supplies a browser navigator with a boolean onLine, not Node 22 s', () => {
    expect(typeof navigator.onLine).toBe('boolean');
    expect(navigator.platform).toBe('');
  });
});

describe('the connectivity default handed to the calculator', () => {
  it('no navigator at all (Node 20 anywhere, Electron main) → online', () => {
    vi.stubGlobal('navigator', undefined);
    primerTmCalculationService.estimate(SEQUENCE);
    expect(recordedOnline).toEqual([true]);
  });

  it('🟥 a Node 22 navigator has no onLine → online, as a real boolean', () => {
    vi.stubGlobal('navigator', NODE_22_NAVIGATOR);
    primerTmCalculationService.estimate(SEQUENCE);
    expect(recordedOnline).toEqual([true]);
  });

  it('a browser reporting online → online', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', onLine: true });
    primerTmCalculationService.estimate(SEQUENCE);
    expect(recordedOnline).toEqual([true]);
  });

  it('a browser reporting OFFLINE is still respected', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', onLine: false });
    primerTmCalculationService.estimate(SEQUENCE);
    expect(recordedOnline).toEqual([false]);
  });

  it('an unusable onLine reading is not mistaken for offline', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', onLine: 'yes' });
    primerTmCalculationService.estimate(SEQUENCE);
    expect(recordedOnline).toEqual([true]);
  });

  it('an explicit context.online always wins over the default', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', onLine: true });
    primerTmCalculationService.estimate(SEQUENCE, { online: false });
    expect(recordedOnline).toEqual([false]);
  });
});

describe('what that default gates end to end', () => {
  it('a Node 22 navigator still reaches the NEB provider, with verified provenance', async () => {
    vi.stubGlobal('navigator', NODE_22_NAVIGATOR);
    nebFetchMock.mockResolvedValueOnce({
      tm: 71.2,
      nebApiVersion: 'test',
      fetchedAt: '2026-08-17T00:00:00.000Z',
    });

    const result = await primerTmCalculationService.calculate(SEQUENCE, { override: NEB_MODEL });

    expect(nebFetchMock).toHaveBeenCalledTimes(1);
    expect(result.valueC).toBe(71.2);
    expect(result.status).toBe('verified');
    expect(result.provider.source).toBe('neb-api');
  });

  it('a genuinely offline browser falls back locally without calling NEB', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', onLine: false });

    const result = await primerTmCalculationService.calculate(SEQUENCE, { override: NEB_MODEL });

    expect(nebFetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe('fallback');
    expect(result.provider.source).toBe('neb-q5-offline');
  });
});
