// @vitest-environment node

import { describe, it, expect, vi } from 'vitest';
import { computeTm } from './compute-tm';
import { DEFAULT_TM_MODEL, type TmModel } from './tm-model';

const NEB_Q5: TmModel = { kind: 'neb', polymerase: 'q5', prodcode: 'q5-0' };
const SEQ = 'GACCATGATTACGCCAAGCTT';

describe('computeTm — routes a resolved model to local(sync) or NEB(async)', () => {
  it('local model uses localFn, stamps source "local", never calls nebFetch', async () => {
    const localFn = vi.fn(() => 56.2);
    const nebFetch = vi.fn();
    const res = await computeTm(DEFAULT_TM_MODEL, SEQ, {
      localFn,
      nebFetch,
      online: true,
      conc_nM: 500,
    });
    expect(res.tm).toBe(56.2);
    expect(res.provenance.source).toBe('local');
    expect(res.verified).toBe(false);
    expect(res.pendingNebVerification).toBeFalsy();
    expect(nebFetch).not.toHaveBeenCalled();
  });

  it('NEB model online (fetch ok) returns the NEB value + version/fetchedAt provenance, verified', async () => {
    const localFn = vi.fn(() => 56.2);
    const nebFetch = vi.fn(async () => ({
      tm: 75.2,
      ta: 76,
      nebApiVersion: '0.19.0',
      fetchedAt: '2026-07-13T21:00:00.000Z',
    }));
    const res = await computeTm(NEB_Q5, SEQ, { localFn, nebFetch, online: true, conc_nM: 500 });
    expect(res.tm).toBe(75.2);
    expect(res.ta).toBe(76);
    expect(res.verified).toBe(true);
    expect(res.provenance).toMatchObject({
      source: 'neb-api',
      prodcode: 'q5-0',
      conc_nM: 500,
      nebApiVersion: '0.19.0',
      fetchedAt: '2026-07-13T21:00:00.000Z',
    });
    expect(localFn).not.toHaveBeenCalled();
    expect(nebFetch).toHaveBeenCalledTimes(1);
  });

  it('NEB model but offline: skips nebFetch, falls back to local, marks pending (never throws)', async () => {
    const localFn = vi.fn(() => 56.2);
    const nebFetch = vi.fn();
    const res = await computeTm(NEB_Q5, SEQ, { localFn, nebFetch, online: false, conc_nM: 500 });
    expect(res.tm).toBe(56.2);
    expect(res.verified).toBe(false);
    expect(res.pendingNebVerification).toBe(true);
    expect(res.provenance.source).toBe('neb-q5-offline');
    expect(nebFetch).not.toHaveBeenCalled();
  });

  it('NEB model, fetch rejects: falls back to local + pending, does not throw', async () => {
    const localFn = vi.fn(() => 56.2);
    const nebFetch = vi.fn(async () => {
      throw new Error('circuit_open');
    });
    const res = await computeTm(NEB_Q5, SEQ, { localFn, nebFetch, online: true, conc_nM: 500 });
    expect(res.tm).toBe(56.2);
    expect(res.verified).toBe(false);
    expect(res.pendingNebVerification).toBe(true);
    expect(res.provenance.source).toBe('neb-q5-offline');
  });

  it('passes cancellation to the provider and does not turn an abort into a local fallback', async () => {
    const localFn = vi.fn(() => 56.2);
    const controller = new AbortController();
    const nebFetch = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      expect(signal).toBe(controller.signal);
      const error = new Error('cancelled');
      error.name = 'AbortError';
      throw error;
    });

    await expect(
      computeTm(NEB_Q5, SEQ, {
        localFn,
        nebFetch,
        online: true,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(localFn).not.toHaveBeenCalled();
  });

  it('NEB model, fetch rejects: reports the raw error via onNebError', async () => {
    const localFn = vi.fn(() => 56.2);
    const rejection = new Error('HTTP 429: rate limited');
    const nebFetch = vi.fn(async () => {
      throw rejection;
    });
    const onNebError = vi.fn();
    await computeTm(NEB_Q5, SEQ, { localFn, nebFetch, online: true, conc_nM: 500, onNebError });
    expect(onNebError).toHaveBeenCalledTimes(1);
    expect(onNebError).toHaveBeenCalledWith(rejection);
  });

  it('NEB model but offline (fetch never attempted): does NOT call onNebError', async () => {
    const localFn = vi.fn(() => 56.2);
    const nebFetch = vi.fn();
    const onNebError = vi.fn();
    await computeTm(NEB_Q5, SEQ, { localFn, nebFetch, online: false, conc_nM: 500, onNebError });
    expect(onNebError).not.toHaveBeenCalled();
  });

  it('NEB model, fetch succeeds: does NOT call onNebError', async () => {
    const localFn = vi.fn(() => 56.2);
    const nebFetch = vi.fn(async () => ({
      tm: 75.2,
      nebApiVersion: '0.19.0',
      fetchedAt: '2026-07-13T21:00:00.000Z',
    }));
    const onNebError = vi.fn();
    await computeTm(NEB_Q5, SEQ, { localFn, nebFetch, online: true, conc_nM: 500, onNebError });
    expect(onNebError).not.toHaveBeenCalled();
  });
});
