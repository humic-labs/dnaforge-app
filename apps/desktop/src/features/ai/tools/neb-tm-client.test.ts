
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sidecarNebTm, sidecarNebTmBatch, makeNebFetch } from './neb-tm-client';

const ROUTE_RESPONSE = {
  prodcode: 'q5-0',
  conc_nm: 500,
  p1: { tm: 75.219, gc_fraction: 0.48, length: 21, seq: 'GACCATGATTACGCCAAGCTT' },
  p2: { tm: 72.883, gc_fraction: 0.48, length: 21, seq: 'CAGGAAACAGCTATGACCATG' },
  ta: 72,
  api_version: '0.19.0',
  notes: [],
};

function stubElectron() {
  (globalThis as unknown as { electronAPI?: unknown }).electronAPI = {
    config: { getApiUrl: async () => 'http://localhost:8033' },
  };
}

describe('sidecarNebTm — renderer → sidecar /external/neb/tm', () => {
  beforeEach(stubElectron);
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('POSTs to /external/neb/tm without renderer session authority and parses the result', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(ROUTE_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await sidecarNebTm(
      {
        seq1: 'GACCATGATTACGCCAAGCTT',
        seq2: 'CAGGAAACAGCTATGACCATG',
        prodcode: 'q5-0',
        concNm: 500,
      },
      { grantedCapabilities: ['external-compute:tm', 'read-workspace'] }
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8033/external/neb/tm');
    expect(new Headers(init.headers).get('X-DNAForge-Session')).toBeNull();
    const body = JSON.parse(init.body as string);
    expect(body.seq1).toBe('GACCATGATTACGCCAAGCTT');
    expect(body.seq2).toBe('CAGGAAACAGCTATGACCATG');
    expect(body.prodcode).toBe('q5-0');
    expect(body.conc_nm).toBe(500);
    expect(body.granted_capabilities).toEqual(['external-compute:tm', 'read-workspace']);

    expect(res.p1.tm).toBeCloseTo(75.219, 3);
    expect(res.p2?.tm).toBeCloseTo(72.883, 3);
    expect(res.ta).toBe(72);
    expect(res.nebApiVersion).toBe('0.19.0');
    expect(typeof res.fetchedAt).toBe('string');
    expect(res.fetchedAt.length).toBeGreaterThan(0);
  });

  it('throws on a non-OK sidecar response so the seam falls back to local', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ detail: { error: 'provider_error' } }), { status: 502 }))
    );
    await expect(sidecarNebTm({ seq1: 'GACCATGATTACGCCAAGCTT' })).rejects.toThrow();
  });

  it('POSTs every primer in one /external/neb/tm/batch call', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                prodcode: 'q5-0',
                conc_nm: 500,
                p1: { tm: 75.2, gc_fraction: 0.48, length: 21, seq: 'GACCATGATTACGCCAAGCTT' },
                api_version: '0.19.0',
                notes: [],
              },
              {
                prodcode: 'q5-0',
                conc_nm: 500,
                p1: { tm: 72.9, gc_fraction: 0.48, length: 21, seq: 'CAGGAAACAGCTATGACCATG' },
                api_version: '0.19.0',
                notes: [],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    const results = await sidecarNebTmBatch({
      sequences: ['GACCATGATTACGCCAAGCTT', 'CAGGAAACAGCTATGACCATG'],
      prodcode: 'q5-0',
      concNm: 500,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8033/external/neb/tm/batch');
    expect(JSON.parse(init.body as string).sequences).toEqual([
      'GACCATGATTACGCCAAGCTT',
      'CAGGAAACAGCTATGACCATG',
    ]);
    expect(results.map((row) => row.p1.tm)).toEqual([75.2, 72.9]);
  });

  it('makeNebFetch adapts sidecarNebTm to the computeTm seam shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(ROUTE_RESPONSE), { status: 200 }))
    );
    const nebFetch = makeNebFetch();
    const out = await nebFetch({ seq: 'GACCATGATTACGCCAAGCTT', prodcode: 'q5-0', conc_nM: 500 });
    expect(out.tm).toBeCloseTo(75.219, 3);
    expect(out.ta).toBe(72);
    expect(out.nebApiVersion).toBe('0.19.0');
    expect(typeof out.fetchedAt).toBe('string');
  });
});
