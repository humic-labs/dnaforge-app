// @vitest-environment node

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { customFetch, resetApiClientConfigurationForTests } from '@waypoint/api-client';
import { ServiceManager } from './service-manager';
import { useAgentJobsStore } from '../features/jobs/agent-jobs-store';
import { sidecarFetchSequenceBytes } from '../features/ai/tools/sidecar-client';

type RequestRecord = { path: string; headers: IncomingHttpHeaders; body: string };
const endpoints: Array<{ url: string; server: Server; requests: RequestRecord[] }> = [];

beforeEach(async () => {
  resetApiClientConfigurationForTests();
  useAgentJobsStore.getState().resetForTests();
  for (const identity of ['first', 'second']) {
    const requests: RequestRecord[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      requests.push({ path: request.url!, headers: request.headers, body });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.url?.startsWith('/operations/agent-jobs') ? {
        jobs: [], job_count: 0, active_count: 0, terminal_count: 0, history_complete: true,
      } : request.url === '/external/sequence/bytes' ? {
        provider: 'ncbi-nuccore', external_id: identity, format: 'genbank',
        content: `LOCUS ${identity}`, content_sha256: 'a'.repeat(64),
      } : { status: 'healthy', identity }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing owned HTTP port');
    endpoints.push({ url: `http://127.0.0.1:${address.port}`, server, requests });
  }
});

afterEach(async () => {
  vi.unstubAllGlobals();
  resetApiClientConfigurationForTests();
  useAgentJobsStore.getState().resetForTests();
  for (const { server } of endpoints.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it('keeps each concurrent Jobs refresh on the endpoint returned for that request', async () => {
  let calls = 0;
  vi.stubGlobal('electronAPI', { config: { getApiUrl: async () => endpoints[calls++].url } });
  await Promise.all([useAgentJobsStore.getState().refresh(), useAgentJobsStore.getState().refresh()]);
  expect(calls).toBe(2);
  expect(useAgentJobsStore.getState().error).toBeNull();
  for (const endpoint of endpoints) {
    expect(endpoint.requests.map(({ path }) => path)).toEqual(['/operations/agent-jobs?limit=200&offset=0']);
    expect(endpoint.requests[0].headers['x-dnaforge-session']).toBeUndefined();
  }
});

it('interleaves health checks and external sequence lookup without changing their destinations', async () => {
  const first = new ServiceManager(endpoints[0].url);
  const second = new ServiceManager(endpoints[1].url);
  vi.stubGlobal('electronAPI', { config: { getApiUrl: async () => endpoints[0].url } });
  const [firstHealth, secondHealth, sequence] = await Promise.all([
    first.checkHealth(), second.checkHealth(), sidecarFetchSequenceBytes({ externalId: 'first' }),
  ]);
  expect(firstHealth.healthy).toBe(true);
  expect(secondHealth.healthy).toBe(true);
  expect(sequence.content).toBe('LOCUS first');
  expect(endpoints[0].requests.map(({ path }) => path).sort()).toEqual(['/external/sequence/bytes', '/health']);
  expect(endpoints[1].requests.map(({ path }) => path)).toEqual(['/health']);
  expect(JSON.parse(endpoints[0].requests.find(({ path }) => path === '/external/sequence/bytes')!.body))
    .toMatchObject({ external_id: 'first', granted_capabilities: ['external-fetch:annotation'] });
});

it('strips local credentials before a remote transport receives an external request', async () => {
  const forwarded: string[] = [];
  await customFetch('/health', { headers: {
    'X-DNAForge-Session': 'synthetic-session',
    'X-DNAForge-Agent-Identity': 'synthetic-agent',
    'X-DNAForge-Agent-Capabilities': 'synthetic-capability',
  } }, {
    baseUrl: 'https://external.example.invalid',
    fetch: (url, options) => {
      forwarded.push(String(url));
      return fetch(`${endpoints[1].url}/health`, options);
    },
  });
  expect(forwarded).toEqual(['https://external.example.invalid/health']);
  expect(endpoints[1].requests).toHaveLength(1);
  const { headers } = endpoints[1].requests[0];
  expect(headers['x-dnaforge-session']).toBeUndefined();
  expect(headers['x-dnaforge-agent-identity']).toBeUndefined();
  expect(headers['x-dnaforge-agent-capabilities']).toBeUndefined();
});
