// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchStructureBytes,
  validateAlphaFoldId,
  validateRcsbId,
} from './structure-service-client';

const TEST_SIDECAR_BASE_URL = vi.hoisted(() => 'http://127.0.0.1:8127');

vi.mock('../../../../../services/service-manager', async () => {
  const { configureRendererSidecarApiClient } =
    await import('../../../../../services/sidecar-session');
  return {
    serviceManager: {
      getBaseUrl: () => TEST_SIDECAR_BASE_URL,
      getExternalLookupBaseUrl: () => TEST_SIDECAR_BASE_URL,
      bindExternalLookupClient: () => configureRendererSidecarApiClient(TEST_SIDECAR_BASE_URL),
    },
  };
});

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  (globalThis as { electronAPI?: object }).electronAPI = {};
});

function requestBody(index = 0): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[index][1].body as string) as Record<string, unknown>;
}

function requestHeaders(): Headers {
  return new Headers(fetchMock.mock.calls[0][1].headers);
}

describe('structure-service-client', () => {
  it('fetches structure bytes from the sidecar with structure capability', async () => {
    fetchMock.mockResolvedValue(
      new Response('data_1RBL', {
        status: 200,
        headers: {
          'X-Structure-Format': 'mmcif',
          'X-External-Id': 'RCSB:1RBL:ENTRY',
          'X-Source-Url': 'https://files.rcsb.org/download/1RBL.cif',
        },
      })
    );

    const result = await fetchStructureBytes({
      provider: 'rcsb',
      externalId: '1RBL',
      format: 'mmcif',
    });

    expect(result).toEqual({
      data: 'data_1RBL',
      format: 'mmcif',
      externalId: 'RCSB:1RBL:ENTRY',
      sourceUrl: 'https://files.rcsb.org/download/1RBL.cif',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_SIDECAR_BASE_URL}/external/structure/bytes`,
      expect.objectContaining({ method: 'POST' })
    );
    expect(requestHeaders().has('X-DNAForge-Session')).toBe(false);
    expect(requestBody()).toMatchObject({
      provider: 'rcsb',
      external_id: '1RBL',
      format: 'mmcif',
      granted_capabilities: ['external-fetch:structure'],
    });
  });

  it('fetches AlphaFold structure bytes for 10-character UniProt accessions', async () => {
    fetchMock.mockResolvedValue(
      new Response('data_A0A0H3JZA8', {
        status: 200,
        headers: { 'X-Structure-Format': 'mmcif' },
      })
    );

    const result = await fetchStructureBytes({
      provider: 'alphafold',
      externalId: 'A0A0H3JZA8',
      format: 'mmcif',
    });

    expect(result).toEqual({ data: 'data_A0A0H3JZA8', format: 'mmcif' });
    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_SIDECAR_BASE_URL}/external/structure/bytes`,
      expect.objectContaining({ method: 'POST' })
    );
    expect(requestBody()).toMatchObject({
      provider: 'alphafold',
      external_id: 'A0A0H3JZA8',
      format: 'mmcif',
      granted_capabilities: ['external-fetch:structure'],
    });
  });

  it('throws provider errors for structure byte sidecar outages', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: { error: 'provider_error' } }), { status: 502 })
    );

    await expect(
      fetchStructureBytes({
        provider: 'rcsb',
        externalId: 'RCSB:1RBL:ENTRY',
        format: 'mmcif',
      })
    ).rejects.toMatchObject({
      name: 'SidecarProviderError',
    });
  });

  it('throws provider errors for structure byte network failures', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      fetchStructureBytes({
        provider: 'rcsb',
        externalId: 'RCSB:1RBL:ENTRY',
        format: 'mmcif',
      })
    ).rejects.toMatchObject({
      name: 'SidecarProviderError',
    });
  });

  it('preserves abort errors during structure byte fetches', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('Aborted'), { name: 'AbortError' }));

    await expect(
      fetchStructureBytes({
        provider: 'rcsb',
        externalId: 'RCSB:1RBL:ENTRY',
        format: 'mmcif',
      })
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('sends scoped provider identity fields for chain/entity/model-aware byte fetches', async () => {
    fetchMock.mockResolvedValue(
      new Response('data_1RBL', {
        status: 200,
        headers: { 'X-Structure-Format': 'mmcif' },
      })
    );

    await fetchStructureBytes({
      provider: 'rcsb',
      externalId: 'RCSB:1RBL:ENTRY',
      format: 'mmcif',
      pdbId: '1RBL',
      pdbEntityId: '1',
      labelAsymIds: ['A', 'B'],
      authAsymIds: ['L', 'M'],
      assemblyId: '1',
    });

    expect(requestBody()).toMatchObject({
      provider: 'rcsb',
      external_id: 'RCSB:1RBL:ENTRY',
      format: 'mmcif',
      pdb_id: '1RBL',
      pdb_entity_id: '1',
      label_asym_ids: ['A', 'B'],
      auth_asym_ids: ['L', 'M'],
      assembly_id: '1',
      granted_capabilities: ['external-fetch:structure'],
    });
  });

  it('sends AlphaFold fragment/version/model identity fields', async () => {
    fetchMock.mockResolvedValue(
      new Response('data_P04637', {
        status: 200,
        headers: { 'X-Structure-Format': 'mmcif' },
      })
    );

    await fetchStructureBytes({
      provider: 'alphafold',
      externalId: 'AF:P04637:F1:V4',
      format: 'mmcif',
      accession: 'P04637',
      fragment: 'F1',
      version: 'V4',
      modelId: 'AF-P04637-F1-model_v4',
    });

    expect(requestBody()).toMatchObject({
      provider: 'alphafold',
      external_id: 'AF:P04637:F1:V4',
      format: 'mmcif',
      accession: 'P04637',
      fragment: 'F1',
      version: 'V4',
      model_id: 'AF-P04637-F1-model_v4',
      granted_capabilities: ['external-fetch:structure'],
    });
  });

  it('maps RCSB validation metadata from the sidecar', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        valid: true,
        metadata: {
          title: 'RuBisCO large subunit',
          organism: 'Spinacia oleracea',
          resolution: 2.2,
          experimental_method: 'X-ray diffraction',
        },
      })
    );

    const result = await validateRcsbId('1rbl');

    expect(result).toEqual({
      valid: true,
      metadata: {
        title: 'RuBisCO large subunit',
        organism: 'Spinacia oleracea',
        resolution: 2.2,
        method: 'X-ray diffraction',
      },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${TEST_SIDECAR_BASE_URL}/external/rcsb/validate`);
    expect(requestBody()).toMatchObject({
      pdb_id: '1rbl',
      granted_capabilities: ['external-fetch:annotation'],
    });
  });

  it('keeps session authority out of repeated renderer requests', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        Response.json({
          valid: true,
          metadata: {
            title: 'RuBisCO large subunit',
            organism: 'Spinacia oleracea',
            resolution: 2.2,
            experimental_method: 'X-ray diffraction',
          },
        })
      )
    );

    await validateRcsbId('1rbl');
    await validateRcsbId('1rbl');

    const secondHeaders = new Headers(fetchMock.mock.calls[1][1].headers as HeadersInit);
    expect(secondHeaders.get('X-DNAForge-Session')).toBeNull();
  });

  it('throws provider errors for RCSB validation outages instead of reporting an invalid PDB id', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: { error: 'circuit_open' } }), { status: 503 })
    );

    await expect(validateRcsbId('1rbl')).rejects.toMatchObject({
      name: 'SidecarProviderError',
    });
  });

  it('maps AlphaFold summary metadata from the sidecar', async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          valid: true,
          latest_version: 6,
          cif_url: 'https://alphafold.ebi.ac.uk/files/AF-P04637-F1-model_v6.cif',
          provider_identity_key: 'AF:P04637:F1:V6:MODEL:AF-P04637-F1-model_v6',
          fragment: 'F1',
          model_id: 'AF-P04637-F1-model_v6',
          metadata: {
            mean_plddt: 95.1,
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          valid: true,
          metadata: {
            name: 'Cellular tumor antigen p53',
            organism: 'Homo sapiens',
            function: 'Acts as a tumor suppressor.',
          },
        })
      );

    const result = await validateAlphaFoldId('P04637');

    expect(result).toEqual({
      valid: true,
      providerIdentityKey: 'AF:P04637:F1:V6:MODEL:AF-P04637-F1-model_v6',
      latestVersion: 6,
      cifUrl: 'https://alphafold.ebi.ac.uk/files/AF-P04637-F1-model_v6.cif',
      fragment: 'F1',
      modelId: 'AF-P04637-F1-model_v6',
      metadata: {
        title: 'Cellular tumor antigen p53',
        organism: 'Homo sapiens',
        description: 'Acts as a tumor suppressor.',
      },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${TEST_SIDECAR_BASE_URL}/external/alphafold/summary`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${TEST_SIDECAR_BASE_URL}/external/uniprot/summary`);
    expect(requestBody(0)).toMatchObject({
      accession: 'P04637',
      granted_capabilities: ['external-fetch:annotation'],
    });
    expect(requestBody(1)).toMatchObject({
      accession: 'P04637',
      granted_capabilities: ['external-fetch:annotation'],
    });
  });

  it('throws provider errors for AlphaFold validation outages instead of reporting a missing accession', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: { error: 'provider_error' } }), { status: 502 })
    );

    await expect(validateAlphaFoldId('P04637')).rejects.toMatchObject({
      name: 'SidecarProviderError',
    });
  });

  it('rejects malformed AlphaFold provider identities returned by the sidecar', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        valid: true,
        latest_version: 0,
        cif_url: 'https://alphafold.ebi.ac.uk/files/AF-P04637-F0-model_v0.cif',
        provider_identity_key: 'AF:P04637:F0:V0:MODEL:AF-P04637-F0-model_v0',
        fragment: 'F0',
        model_id: 'AF-P04637-F0-model_v0',
        metadata: {},
      })
    );

    await expect(validateAlphaFoldId('P04637')).rejects.toMatchObject({
      name: 'SidecarProviderError',
    });
  });

  it('treats UniProt summary provider failures as optional AlphaFold enrichment misses', async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          valid: true,
          latest_version: 6,
          cif_url: 'https://alphafold.ebi.ac.uk/files/AF-P04637-F1-model_v6.cif',
          provider_identity_key: 'AF:P04637:F1:V6:MODEL:AF-P04637-F1-model_v6',
          fragment: 'F1',
          model_id: 'AF-P04637-F1-model_v6',
          metadata: {},
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: { error: 'provider_error' } }), { status: 502 })
      );

    await expect(validateAlphaFoldId('P04637')).resolves.toEqual({
      valid: true,
      providerIdentityKey: 'AF:P04637:F1:V6:MODEL:AF-P04637-F1-model_v6',
      latestVersion: 6,
      cifUrl: 'https://alphafold.ebi.ac.uk/files/AF-P04637-F1-model_v6.cif',
      fragment: 'F1',
      modelId: 'AF-P04637-F1-model_v6',
    });
  });
});
