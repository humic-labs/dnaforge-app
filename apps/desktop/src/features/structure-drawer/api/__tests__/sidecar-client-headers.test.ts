// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getExternalResourceByExternalId,
  sidecarFetchRcsbMetadata,
  sidecarFetchUniProtEntry,
  sidecarRcsbSequenceSearch,
  sidecarUniProtBySequence,
  sidecarUniProtSearch,
  sidecarUniProtSearchMany,
  sidecarValidateAfdb,
} from '../sidecar-client';
import './sidecar-mocks';

const realFetch = globalThis.fetch;

beforeEach(() => {
  (globalThis as { electronAPI?: object }).electronAPI = {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function captureHeaders(spy: ReturnType<typeof vi.fn>): Headers {
  const init = spy.mock.calls[0][1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

function captureBody(spy: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = spy.mock.calls[0][1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

describe('structure-drawer sidecar-client — renderer authority boundary', () => {
  it('sidecarUniProtSearch leaves session injection to Electron main', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ hits: [{ accession: 'P00875', reviewed: true }] }), {
        status: 200,
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sidecarUniProtSearch('gene:rbcL', new AbortController().signal);

    expect(fetchMock).toHaveBeenCalled();
    const headers = captureHeaders(fetchMock);
    expect(headers.get('X-DNAForge-Session')).toBeNull();
    expect(captureBody(fetchMock)).toMatchObject({
      granted_capabilities: ['external-fetch:annotation'],
    });
  });

  it('repeated sidecarUniProtSearch calls never expose renderer session authority', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ hits: [] }), {
          status: 200,
        })
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sidecarUniProtSearch('gene:rbcL', new AbortController().signal);
    await sidecarUniProtSearch('gene:rbcL', new AbortController().signal);

    const secondHeaders = new Headers(
      (fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined)?.headers
    );
    expect(secondHeaders.get('X-DNAForge-Session')).toBeNull();
  });

  it('surfaces a successful body without a hits list as a provider failure, not an empty miss', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ unexpected: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as unknown as typeof fetch;

    await expect(
      sidecarUniProtSearchMany('gene:rbcL', new AbortController().signal)
    ).rejects.toMatchObject({
      name: 'SidecarProviderError',
      message:
        'Structure sidecar provider failure /external/uniprot/search: response has no hits list',
    });
  });

  it('reports a null hit element as a provider failure instead of dropping or crashing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ hits: [null, { accession: 'P00875', reviewed: true }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as unknown as typeof fetch;

    await expect(
      sidecarUniProtSearchMany('gene:rbcL', new AbortController().signal)
    ).rejects.toMatchObject({
      name: 'SidecarProviderError',
      message: 'Structure sidecar provider failure: response UniProt hit is not an object',
    });
  });

  it('reports a hit without a string accession as a provider failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ hits: [{ accession: 123, reviewed: true }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as unknown as typeof fetch;

    await expect(
      sidecarUniProtBySequence('MADITLISGSTLGGAEYVAE', new AbortController().signal)
    ).rejects.toMatchObject({
      name: 'SidecarProviderError',
      message: 'Structure sidecar provider failure: response UniProt sequence hit has no accession',
    });
  });

  it('surfaces a 422 on a typed structure request instead of reading it as a miss', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: [{ loc: ['body', 'fragment'], type: 'string_pattern_mismatch' }],
        }),
        {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    ) as unknown as typeof fetch;

    await expect(sidecarValidateAfdb('P00875', new AbortController().signal)).rejects.toMatchObject(
      {
        name: 'SidecarProviderError',
        message:
          'Structure sidecar provider failure /external/alphafold/validate: request rejected by the sidecar contract (HTTP 422)',
      }
    );
  });

  it('reports an unknown match-evidence kind as a provider failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          md5: '4BFC2ED15C60BB6BF4D68FC54F668B53',
          query_identity: {
            kind: 'protein_sequence',
            normalized_length: 20,
            checksum_md5: '4BFC2ED15C60BB6BF4D68FC54F668B53',
            checksum_sha256: '0688d2c546ef5e3b818ce9b3f45d3eb942740e09849eef2047b2864ea734050d',
            canonical_form: 'waypoint-protein-v2',
            canonical_lookup_sequence: 'MADITLISGSTLGGAEYVAE',
          },
          hits: [
            {
              accession: 'P00880',
              reviewed: true,
              match_evidence: { kind: 'bogus', rank: 0, rank_reasons: [] },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ) as unknown as typeof fetch;

    await expect(
      sidecarUniProtBySequence('MADITLISGSTLGGAEYVAE', new AbortController().signal)
    ).rejects.toMatchObject({
      name: 'SidecarProviderError',
      message: 'Structure sidecar provider failure: response match evidence has an unknown kind',
    });
  });

  it('getExternalResourceByExternalId keeps a provider outage or transport error as a cache miss', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: { error: 'circuit_open' } }), { status: 503 })
      )
      .mockRejectedValueOnce(new TypeError('Failed to fetch')) as unknown as typeof fetch;

    await expect(
      getExternalResourceByExternalId('uniprot', 'P00875', new AbortController().signal)
    ).resolves.toBeNull();
    await expect(
      getExternalResourceByExternalId('uniprot', 'P00875', new AbortController().signal)
    ).resolves.toBeNull();
  });

  it('getExternalResourceByExternalId still propagates an authorization refusal', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ detail: { code: 'BAD_SESSION' } }), { status: 401 })
      ) as unknown as typeof fetch;

    await expect(
      getExternalResourceByExternalId('uniprot', 'P00875', new AbortController().signal)
    ).rejects.toMatchObject({ name: 'SidecarAuthError' });
  });

  it('sends exactly the generated UniProt search request model', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ hits: [] }), { status: 200 }))
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sidecarUniProtSearch('gene:rbcL', new AbortController().signal, {
      size: 3,
      workspaceId: 'ws-1',
    });

    expect(String(fetchMock.mock.calls[0][0])).toContain('/external/uniprot/search');
    expect(captureBody(fetchMock)).toEqual({
      query: 'gene:rbcL AND reviewed:true',
      size: 3,
      workspace_id: 'ws-1',
      include_sequence: false,
      granted_capabilities: ['external-fetch:annotation'],
    });
  });

  it('surfaces malformed successful JSON as a recoverable provider failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{not-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as unknown as typeof fetch;

    await expect(
      sidecarUniProtSearch('gene:rbcL', new AbortController().signal)
    ).rejects.toMatchObject({ name: 'SidecarProviderError' });
  });

  it('sidecarUniProtSearchMany requests sequence payloads for overlap validation', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          hits: [
            {
              accession: 'P75718',
              reviewed: true,
              sequence: 'MARAGILVVDGKVWRTVYYRFATREEWEGKVSTNLIFKECRQSAAMKRVLRVYKRTSMGTQ',
              taxon_id: 83333,
              organism: 'Escherichia coli (strain K12)',
            },
          ],
        }),
        { status: 200 }
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const hits = await sidecarUniProtSearchMany('gene:renD', new AbortController().signal, {
      size: 10,
      includeSequence: true,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(captureBody(fetchMock)).toMatchObject({
      query: 'gene:renD AND reviewed:true',
      size: 10,
      include_sequence: true,
      granted_capabilities: ['external-fetch:annotation'],
    });
    expect(hits).toEqual([
      {
        accession: 'P75718',
        reviewed: true,
        sequence: 'MARAGILVVDGKVWRTVYYRFATREEWEGKVSTNLIFKECRQSAAMKRVLRVYKRTSMGTQ',
        taxonId: 83333,
        organism: 'Escherichia coli (strain K12)',
      },
    ]);
  });

  it('sidecarValidateAfdb leaves session injection to Electron main', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accession: 'P00875',
          mean_plddt: 92.3,
          latest_version: 6,
          cif_url: 'https://alphafold.ebi.ac.uk/files/AF-P00875-F1-model_v6.cif',
          provider_identity_key: 'AF:P00875:F1:V6:MODEL:AF-P00875-F1-model_v6',
          fragment: 'F1',
          model_id: 'AF-P00875-F1-model_v6',
          exists: true,
        }),
        {
          status: 200,
        }
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const hit = await sidecarValidateAfdb('P00875', new AbortController().signal);

    expect(fetchMock).toHaveBeenCalled();
    const headers = captureHeaders(fetchMock);
    expect(headers.get('X-DNAForge-Session')).toBeNull();
    expect(captureBody(fetchMock)).toMatchObject({
      accession: 'P00875',
      granted_capabilities: ['external-fetch:annotation'],
    });
    expect(hit).toEqual({
      accession: 'P00875',
      meanPlddt: 92.3,
      latestVersion: 6,
      cifUrl: 'https://alphafold.ebi.ac.uk/files/AF-P00875-F1-model_v6.cif',
      providerIdentityKey: 'AF:P00875:F1:V6:MODEL:AF-P00875-F1-model_v6',
      fragment: 'F1',
      modelId: 'AF-P00875-F1-model_v6',
    });
  });

  it('sidecarRcsbSequenceSearch sends RNA sequence search through the sidecar', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          hits: [
            {
              identifier: '4GXY_1',
              pdb_id: '4GXY',
              entity_id: '1',
              score: 91,
              sequence_identity: 0.98,
            },
          ],
        }),
        { status: 200 }
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const hits = await sidecarRcsbSequenceSearch(
      'A'.repeat(30),
      'rna',
      new AbortController().signal
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/external/rcsb/sequence-search');
    const headers = captureHeaders(fetchMock);
    expect(headers.get('X-DNAForge-Session')).toBeNull();
    expect(captureBody(fetchMock)).toMatchObject({
      sequence: 'A'.repeat(30),
      sequence_type: 'rna',
      granted_capabilities: ['external-fetch:homology-search'],
    });
    expect(hits).toEqual([
      {
        identifier: '4GXY_1',
        pdbId: '4GXY',
        entityId: '1',
        score: 91,
        sequenceIdentity: 0.98,
        evalue: undefined,
        bitScore: undefined,
      },
    ]);
  });

  it('sidecarRcsbSequenceSearch treats RCSB 204 no-content as an empty hit list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const hits = await sidecarRcsbSequenceSearch(
      'AUGCUAGCUAGCUAGCUAGCUAGCUAGCUA',
      'rna',
      new AbortController().signal
    );

    expect(hits).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/external/rcsb/sequence-search');
    expect(captureBody(fetchMock)).toMatchObject({
      sequence_type: 'rna',
      granted_capabilities: ['external-fetch:homology-search'],
    });
  });

  it('getExternalResourceByExternalId leaves session injection to Electron main', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'res-1',
          provider: 'uniprot',
          external_id: 'P00875',
          external_url: null,
          data_file_id: null,
          version_identifier: null,
          etag: null,
          license: null,
          attribution: null,
          metadata: {},
          fetched_at: '2026-05-04T00:00:00Z',
          last_checked: '2026-05-04T00:00:00Z',
        }),
        { status: 200 }
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await getExternalResourceByExternalId('uniprot', 'P00875', new AbortController().signal);

    expect(fetchMock).toHaveBeenCalled();
    const headers = captureHeaders(fetchMock);
    expect(headers.get('X-DNAForge-Session')).toBeNull();
  });

  it('does not require a preload-exposed session token', async () => {
    delete (globalThis as { electronAPI?: unknown }).electronAPI;
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ hits: [] }), {
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      sidecarUniProtSearch('gene:rbcL', new AbortController().signal)
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('throws SidecarAuthError on 401 instead of collapsing auth failure into a resolver miss', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: {
            code: 'BAD_SESSION',
            message: 'MCP session token is missing or invalid.',
            retriable: true,
          },
        }),
        { status: 401 }
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      sidecarUniProtBySequence('MADITLISGSTLGGAEYVAE', new AbortController().signal)
    ).rejects.toMatchObject({ name: 'SidecarAuthError' });
  });

  it('throws SidecarProviderError on provider 503s so callers can decide whether to fall through', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ detail: { error: 'circuit_open' } }), { status: 503 })
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(sidecarValidateAfdb('P00875', new AbortController().signal)).rejects.toMatchObject(
      {
        name: 'SidecarProviderError',
        message: 'Structure sidecar provider failure /external/alphafold/validate: HTTP 503',
      }
    );
  });

  it('sidecarUniProtBySequence maps structured PDB xrefs alongside legacy pdbIds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          md5: '4BFC2ED15C60BB6BF4D68FC54F668B53',
          query_identity: {
            kind: 'protein_sequence',
            normalized_length: 20,
            checksum_md5: '4BFC2ED15C60BB6BF4D68FC54F668B53',
            checksum_sha256: '0688d2c546ef5e3b818ce9b3f45d3eb942740e09849eef2047b2864ea734050d',
            canonical_form: 'waypoint-protein-v2',
            canonical_lookup_sequence: 'MADITLISGSTLGGAEYVAE',
            canonical_form_applied: true,
            ineligible: false,
            ineligible_reason: null,
            evidence: [],
          },
          hits: [
            {
              accession: 'P00880',
              reviewed: true,
              match_evidence: {
                kind: 'exact_sequence_checksum',
                checksum_md5: '4BFC2ED15C60BB6BF4D68FC54F668B53',
                sequence_identity: 1,
                rank: 0,
                rank_reasons: ['checksum_match', 'reviewed'],
              },
              pdb_ids: ['1RBL', '1RLC'],
              pdb_xrefs: [
                {
                  pdb_id: '1RBL',
                  method: 'X-ray',
                  resolution: 2.2,
                  chains: ['a', 'A'],
                  raw_properties: {
                    Method: 'X-ray',
                    Resolution: '2.20 A',
                    Chains: 'a=1-150, A=1-150',
                  },
                },
                {
                  pdb_id: '1RLC',
                  method: 'NMR',
                  resolution: null,
                  chains: ['A'],
                  raw_properties: {
                    Method: 'NMR',
                    Chains: 'A=1-95',
                  },
                },
              ],
            },
          ],
        }),
        { status: 200 }
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await sidecarUniProtBySequence(
      'MADITLISGSTLGGAEYVAE',
      new AbortController().signal
    );

    expect(result?.hits).toHaveLength(1);
    expect(result?.topHit?.accession).toBe('P00880');
    expect(result?.pdbIds).toEqual(['1RBL', '1RLC']);
    expect(captureBody(fetchMock)).toMatchObject({
      sequence: 'MADITLISGSTLGGAEYVAE',
      canonical_form_hint: 'waypoint-protein-v2',
      granted_capabilities: ['external-fetch:annotation', 'external-fetch:xref-resolution'],
    });
    expect(result?.queryIdentity).toEqual({
      kind: 'protein_sequence',
      normalizedLength: 20,
      checksumMd5: '4BFC2ED15C60BB6BF4D68FC54F668B53',
      checksumSha256: '0688d2c546ef5e3b818ce9b3f45d3eb942740e09849eef2047b2864ea734050d',
      canonicalForm: 'waypoint-protein-v2',
      canonicalLookupSequence: 'MADITLISGSTLGGAEYVAE',
      canonicalFormApplied: true,
      ineligible: false,
      ineligibleReason: undefined,
      evidence: [],
    });
    expect(result?.matchEvidence).toEqual({
      kind: 'exact_sequence_checksum',
      checksumMd5: '4BFC2ED15C60BB6BF4D68FC54F668B53',
      sequenceIdentity: 1,
      rank: 0,
      rankReasons: ['checksum_match', 'reviewed'],
    });
    expect(result?.pdbXrefs).toEqual([
      {
        pdbId: '1RBL',
        method: 'X-ray',
        resolution: 2.2,
        chains: ['a', 'A'],
        rawProperties: {
          Method: 'X-ray',
          Resolution: '2.20 A',
          Chains: 'a=1-150, A=1-150',
        },
      },
      {
        pdbId: '1RLC',
        method: 'NMR',
        resolution: undefined,
        chains: ['A'],
        rawProperties: {
          Method: 'NMR',
          Chains: 'A=1-95',
        },
      },
    ]);
  });

  it('sidecarFetchRcsbMetadata posts through /external/fetch and maps candidate metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          provider: 'rcsb',
          external_id: '1rbl',
          external_resource_id: 'resource-1',
          cache_hit: false,
          license: 'CC0-1.0',
          attribution: 'RCSB Protein Data Bank; PDB ID 1RBL',
          metadata: {
            pdb_id: '1RBL',
            title: 'Ribulose bisphosphate carboxylase',
            experimental_method: 'X-ray',
            resolution: 2.2,
            chain_count: 2,
            chain_ids: ['A', 'B'],
            chains: [
              {
                description: 'Ribulose bisphosphate carboxylase large chain',
                polymer_type: 'Protein',
              },
              {
                description: 'Ribulose bisphosphate carboxylase small chain',
                polymer_type: 'Protein',
              },
            ],
            organism: 'Synechococcus elongatus',
            provider_url: 'https://www.rcsb.org/structure/1RBL',
            deposition_date: '1991-01-15',
            initial_release_date: '1991-04-15',
            revision_date: '2024-06-12',
            revision_version: '1.3',
          },
          xref_count: 0,
        }),
        { status: 200 }
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await sidecarFetchRcsbMetadata('1rbl', new AbortController().signal);

    expect(result).toEqual({
      externalResourceId: 'resource-1',
      cacheHit: false,
      pdbId: '1RBL',
      title: 'Ribulose bisphosphate carboxylase',
      method: 'X-ray',
      resolution: 2.2,
      chainCount: 2,
      chainIds: ['A', 'B'],
      polymerTypes: ['Protein'],
      entityDescriptions: [
        'Ribulose bisphosphate carboxylase large chain',
        'Ribulose bisphosphate carboxylase small chain',
      ],
      organism: 'Synechococcus elongatus',
      sourceUrl: 'https://www.rcsb.org/structure/1RBL',
      license: 'CC0-1.0',
      attribution: 'RCSB Protein Data Bank; PDB ID 1RBL',
      depositionDate: '1991-01-15',
      initialReleaseDate: '1991-04-15',
      revisionDate: '2024-06-12',
      revisionVersion: '1.3',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/external/fetch'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"provider":"rcsb"'),
      })
    );
    expect(captureBody(fetchMock)).toMatchObject({
      provider: 'rcsb',
      external_id: '1rbl',
      granted_capabilities: ['external-fetch:annotation'],
    });
  });

  it('sidecarFetchUniProtEntry fetches annotation metadata without xref capability', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            provider: 'uniprot',
            external_id: 'P00880',
            external_resource_id: 'resource-uniprot-1',
            cache_hit: false,
            license: 'CC-BY-4.0',
            attribution: 'UniProt Consortium',
            metadata: {},
            xref_count: 0,
            binding_id: null,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'resource-uniprot-1',
            provider: 'uniprot',
            external_id: 'P00880',
            external_url: null,
            data_file_id: null,
            version_identifier: '2026_02',
            etag: 'etag-1',
            license: null,
            attribution: null,
            metadata: {},
            fetched_at: '2026-05-04T00:00:00Z',
            last_checked: '2026-05-04T00:00:00Z',
          }),
          { status: 200 }
        )
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await sidecarFetchUniProtEntry('P00880', new AbortController().signal);

    expect(result?.externalResourceId).toBe('resource-uniprot-1');
    expect(fetchMock.mock.calls[0][0]).toContain('/external/fetch');
    expect(captureBody(fetchMock)).toMatchObject({
      provider: 'uniprot',
      external_id: 'P00880',
      granted_capabilities: ['external-fetch:annotation'],
    });
  });

  it('does not require a preload bridge token for getExternalResourceByExternalId', async () => {
    delete (globalThis as { electronAPI?: unknown }).electronAPI;
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      getExternalResourceByExternalId('uniprot', 'P00875', new AbortController().signal)
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('sidecarUniProtBySequence preserves query identity evidence when there are no hits', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          md5: '',
          query_identity: {
            kind: 'protein_sequence',
            normalized_length: 12,
            checksum_md5: '',
            checksum_sha256: '',
            canonical_form: 'waypoint-protein-v2',
            canonical_lookup_sequence: 'MFAKE-PRTEIN',
            canonical_form_applied: true,
            ineligible: true,
            ineligible_reason: 'protein_invalid_residue',
            evidence: [{ kind: 'protein_invalid_residue', residue: '-' }],
          },
          hits: [],
        }),
        { status: 200 }
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await sidecarUniProtBySequence('MFAKE-PRTEIN', new AbortController().signal);

    expect(result).toMatchObject({
      md5: '',
      hits: [],
      topHit: undefined,
      queryIdentity: {
        ineligible: true,
        ineligibleReason: 'protein_invalid_residue',
        evidence: [{ kind: 'protein_invalid_residue', residue: '-' }],
      },
    });
  });

  it('sidecarUniProtBySequence rejects malformed identity and evidence fields instead of fabricating proof', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          md5: '4BFC2ED15C60BB6BF4D68FC54F668B53',
          query_identity: {
            kind: 'protein_sequence',
            normalized_length: '20',
            checksum_md5: '4BFC2ED15C60BB6BF4D68FC54F668B53',
            checksum_sha256: '0688d2c546ef5e3b818ce9b3f45d3eb942740e09849eef2047b2864ea734050d',
            canonical_form: 'waypoint-protein-v1',
            canonical_lookup_sequence: 'MADITLISGSTLGGAEYVAE',
          },
          hits: [
            {
              accession: 'P00880',
              reviewed: true,
              match_evidence: {
                kind: 'exact_sequence_checksum',
                rank: '0',
                rank_reasons: ['checksum_match'],
              },
            },
          ],
        }),
        { status: 200 }
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await sidecarUniProtBySequence(
      'MADITLISGSTLGGAEYVAE',
      new AbortController().signal
    );

    expect(result?.queryIdentity).toBeUndefined();
    expect(result?.topHit?.matchEvidence).toBeUndefined();
    expect(result?.matchEvidence).toBeUndefined();
  });
});
