import { afterEach, beforeEach, vi, type MockInstance } from 'vitest';
import { serviceManager } from '../../../../services/service-manager';

export const TEST_SIDECAR_BASE_URL = 'http://127.0.0.1:8126';

const _STUB_KEY = 'electronAPI' as const;

beforeEach(() => {
  (globalThis as { electronAPI?: object })[_STUB_KEY] = {};
  serviceManager.setBaseUrl(TEST_SIDECAR_BASE_URL);
});

afterEach(() => {
  delete (globalThis as { electronAPI?: object })[_STUB_KEY];
});

export function sidecarSearchHit(accession: string, reviewed = true): Response {
  return new Response(JSON.stringify({ hits: [{ accession, reviewed }] }));
}

export function sidecarSearchMiss(): Response {
  return new Response(JSON.stringify({ hits: [] }));
}

export function sidecarAfdbHit(
  accession: string,
  plddt?: number,
  opts: { latestVersion?: number; cifUrl?: string; fragment?: string; modelId?: string } = {}
): Response {
  const normalizedAccession = accession.toUpperCase();
  const fragment = opts.fragment ?? 'F1';
  const version = opts.latestVersion !== undefined ? `V${opts.latestVersion}` : 'LATEST';
  const modelId =
    opts.modelId ??
    (opts.latestVersion !== undefined
      ? `AF-${normalizedAccession}-${fragment}-model_v${opts.latestVersion}`
      : undefined);
  const providerIdentityKey = `AF:${normalizedAccession}:${fragment}:${version}${
    modelId ? `:MODEL:${modelId}` : ''
  }`;
  return new Response(
    JSON.stringify({
      accession: normalizedAccession,
      mean_plddt: plddt ?? null,
      latest_version: opts.latestVersion ?? null,
      cif_url: opts.cifUrl ?? null,
      provider_identity_key: providerIdentityKey,
      fragment,
      model_id: modelId ?? null,
      exists: true,
    })
  );
}

export function sidecarAfdbMiss(): Response {
  return new Response(
    JSON.stringify({
      accession: null,
      mean_plddt: null,
      latest_version: null,
      cif_url: null,
      provider_identity_key: null,
      fragment: null,
      model_id: null,
      exists: false,
    })
  );
}

export function callBody<T = Record<string, unknown>>(
  spy: MockInstance<typeof globalThis.fetch>,
  callIndex: number
): T {
  const init = spy.mock.calls[callIndex][1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? '{}')) as T;
}

export { vi };
