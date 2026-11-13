import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ApiResponseParseError,
  configureApiClient,
  customFetch,
  isApiError,
  resetApiClientConfigurationForTests,
  type ApiError,
} from './fetcher';
import { getJobJobsJobIdGet } from './generated/react-query';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('customFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('VITE_API_URL', '');
    vi.stubEnv('API_URL', '');
    configureApiClient({ baseUrl: 'http://localhost:8000' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetApiClientConfigurationForTests();
  });

  describe('plain fetch signature', () => {
    it('isolates an explicit request transport from the configured default client', async () => {
      const defaultFetch = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
        Response.json({ owner: 'default' })
      );
      const requestFetch = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
        Response.json({ owner: 'request' })
      );
      configureApiClient({ baseUrl: 'http://127.0.0.1:8100', fetch: defaultFetch });

      const scoped = await customFetch<{ data: { owner: string } }>(
        '/agent-grants',
        { headers: { 'X-DNAForge-Session': 'caller-forged-session' } },
        {
          baseUrl: 'http://127.0.0.1:8123/',
          headers: () => ({ 'X-Feature-Authority': 'request-authority' }),
          fetch: requestFetch,
        }
      );
      expect(scoped.data.owner).toBe('request');
      expect(requestFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:8123/agent-grants',
        expect.objectContaining({ headers: expect.any(Headers) })
      );
      const headers = new Headers(requestFetch.mock.calls[0][1]?.headers);
      expect(headers.get('X-DNAForge-Session')).toBeNull();
      expect(headers.get('X-Feature-Authority')).toBe('request-authority');
      expect(defaultFetch).not.toHaveBeenCalled();

      const defaultResult = await customFetch<{ data: { owner: string } }>('/health');
      expect(defaultResult.data.owner).toBe('default');
      expect(defaultFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:8100/health',
        expect.objectContaining({ headers: expect.any(Headers) })
      );
      expect(new Headers(defaultFetch.mock.calls[0][1]?.headers).has('X-Feature-Authority')).toBe(
        false
      );
    });

    it('refuses an empty explicit request base before dispatch', async () => {
      await expect(customFetch('/health', {}, { baseUrl: ' ' })).rejects.toThrow(
        'API client baseUrl cannot be empty.'
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('uses the runtime sidecar URL without exposing renderer session authority', async () => {
      configureApiClient({
        baseUrl: 'http://127.0.0.1:8123/',
        headers: () => ({ 'X-DNAForge-Session': 'runtime-session' }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ ok: true }),
      });

      await customFetch('/health');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:8123/health',
        expect.objectContaining({ headers: expect.any(Headers) })
      );
      const headers = mockFetch.mock.calls[0][1].headers as Headers;
      expect(headers.get('X-DNAForge-Session')).toBeNull();
    });

    it('does not inherit another destination authority provider on base-only reconfiguration', async () => {
      const featureFetch = vi.fn();
      configureApiClient({
        baseUrl: 'http://127.0.0.1:8123',
        headers: () => ({ 'X-Feature-Authority': 'feature-a-secret' }),
        fetch: featureFetch,
      });
      configureApiClient({ baseUrl: 'https://api.example.test' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ ok: true }),
      });

      await customFetch('/health');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.test/health',
        expect.objectContaining({ headers: expect.any(Headers) })
      );
      const headers = mockFetch.mock.calls[0][1].headers as Headers;
      expect(headers.get('X-Feature-Authority')).toBeNull();
      expect(featureFetch).not.toHaveBeenCalled();
    });

    it('uses an explicitly configured runtime transport', async () => {
      const runtimeFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ ok: true }),
      });
      configureApiClient({
        baseUrl: 'http://127.0.0.1:8123',
        fetch: runtimeFetch,
      });

      await customFetch('/health');

      expect(runtimeFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:8123/health',
        expect.objectContaining({ headers: expect.any(Headers) })
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects an unconfigured Electron request before consulting environment URLs', async () => {
      resetApiClientConfigurationForTests();
      vi.stubEnv('VITE_API_URL', 'https://stale-build-time.example.test');
      vi.stubEnv('API_URL', 'https://stale-process.example.test');
      vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Electron/31.0.0' });

      await expect(customFetch('/health')).rejects.toThrow(
        'API client is not configured for Electron'
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('strips local sidecar authority headers from a non-loopback destination', async () => {
      configureApiClient({
        baseUrl: 'http://127.0.0.1:8123',
        headers: () => ({
          'X-DNAForge-Session': 'runtime-session',
          'X-DNAForge-Agent-Identity': 'local-agent',
          'X-DNAForge-Agent-Capabilities': '["read-workspace"]',
        }),
      });
      configureApiClient({
        baseUrl: 'https://api.example.test',
        headers: () => ({
          'X-DNAForge-Session': 'runtime-session',
          'X-DNAForge-Agent-Identity': 'local-agent',
          'X-DNAForge-Agent-Capabilities': '["read-workspace"]',
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ ok: true }),
      });

      await customFetch('/health');

      const headers = mockFetch.mock.calls[0][1].headers as Headers;
      expect(headers.get('X-DNAForge-Session')).toBeNull();
      expect(headers.get('X-DNAForge-Agent-Identity')).toBeNull();
      expect(headers.get('X-DNAForge-Agent-Capabilities')).toBeNull();
    });

    it('makes GET request with url string', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ data: 'test' }),
      });

      const result = await customFetch('/api/test');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8000/api/test',
        expect.objectContaining({
          headers: expect.any(Headers),
        })
      );
      expect(result).toEqual({
        data: { data: 'test' },
        status: 200,
        headers: expect.any(Headers),
      });
    });

    it('makes POST request with options', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ id: 1 }),
      });

      const result = await customFetch('/api/items', {
        method: 'POST',
        body: JSON.stringify({ name: 'test' }),
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8000/api/items',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'test' }),
        })
      );
      expect(result).toEqual({
        data: { id: 1 },
        status: 201,
        headers: expect.any(Headers),
      });
    });
  });

  describe('React Query signature', () => {
    it('strips caller session headers from generated request options', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ status: 'running' }),
      });

      await getJobJobsJobIdGet('job-1', {
        headers: { 'X-DNAForge-Session': 'session-token' },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8000/jobs/job-1',
        expect.objectContaining({ method: 'GET' })
      );
      const calledHeaders = mockFetch.mock.calls[0][1].headers as Headers;
      expect(calledHeaders.get('X-DNAForge-Session')).toBeNull();
    });

    it('makes request with config object', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ items: [] }),
      });

      const result = await customFetch({
        url: '/api/items',
        method: 'GET',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8000/api/items',
        expect.objectContaining({
          method: 'GET',
        })
      );
      expect(result).toEqual({
        data: { items: [] },
        status: 200,
        headers: expect.any(Headers),
      });
    });

    it('serializes data to JSON body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ success: true }),
      });

      await customFetch({
        url: '/api/items',
        method: 'POST',
        data: { name: 'test', count: 5 },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8000/api/items',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'test', count: 5 }),
        })
      );
    });

    it('serializes query params from config object', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ items: [] }),
      });

      await customFetch({
        url: '/api/items?existing=true',
        method: 'GET',
        params: {
          query: 'alpha beta',
          missing: undefined,
          empty: null,
          tags: ['one', 'two'],
        },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8000/api/items?existing=true&query=alpha+beta&empty=null&tags=one&tags=two',
        expect.objectContaining({
          method: 'GET',
        })
      );
    });

    it('passes signal for cancellation', async () => {
      const controller = new AbortController();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({}),
      });

      await customFetch({
        url: '/api/items',
        method: 'GET',
        signal: controller.signal,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8000/api/items',
        expect.objectContaining({
          signal: controller.signal,
        })
      );
    });

    it('passes custom headers', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({}),
      });

      await customFetch({
        url: '/api/items',
        method: 'GET',
        headers: { Authorization: 'Bearer token123' },
      });

      const calledHeaders = mockFetch.mock.calls[0][1].headers as Headers;
      expect(calledHeaders.get('Authorization')).toBe('Bearer token123');
    });
  });

  describe('error handling', () => {
    it('throws ApiError on 4xx response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({ detail: 'Item not found' }),
      });

      await expect(customFetch('/api/items/999')).rejects.toMatchObject({
        status: 404,
        statusText: 'Not Found',
        detail: 'Item not found',
      });
    });

    it('throws ApiError on 5xx response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({ detail: 'Database error' }),
      });

      await expect(customFetch('/api/items')).rejects.toMatchObject({
        status: 500,
        statusText: 'Internal Server Error',
        detail: 'Database error',
      });
    });

    it('handles non-JSON error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: () => Promise.reject(new Error('Not JSON')),
      });

      await expect(customFetch('/api/items')).rejects.toMatchObject({
        status: 502,
        statusText: 'Bad Gateway',
        detail: undefined,
      });
    });

    it('extracts FastAPI detail from error body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: () =>
          Promise.resolve({
            detail: [{ loc: ['body', 'name'], msg: 'field required', type: 'value_error.missing' }],
          }),
      });

      try {
        await customFetch('/api/items');
      } catch (error) {
        expect(isApiError(error)).toBe(true);
        const apiError = error as ApiError;
        expect(apiError.status).toBe(422);
        expect(apiError.body).toEqual({
          detail: [{ loc: ['body', 'name'], msg: 'field required', type: 'value_error.missing' }],
        });
      }
    });
  });

  describe('response handling', () => {
    it('handles 204 No Content', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        headers: new Headers(),
        json: () => Promise.reject(new Error('No content')),
      });

      const result = await customFetch('/api/items/1', { method: 'DELETE' });

      expect(result).toEqual({
        data: null,
        status: 204,
        headers: expect.any(Headers),
      });
    });

    it('rejects a malformed JSON success response with transport context', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/plain' }),
        json: () => Promise.reject(new Error('Not JSON')),
      });

      const request = customFetch('/api/health');
      await expect(request).rejects.toBeInstanceOf(ApiResponseParseError);
      await expect(request).rejects.toMatchObject({
        name: 'ApiResponseParseError',
        responseStatus: 200,
        responseStatusText: 'OK',
        contentType: 'text/plain',
      });
      await expect(request).rejects.toThrow('API response was not valid JSON (HTTP 200 OK).');
    });

    it('sets Content-Type header when body is present', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({}),
      });

      await customFetch('/api/items', {
        method: 'POST',
        body: JSON.stringify({ name: 'test' }),
      });

      const calledHeaders = mockFetch.mock.calls[0][1].headers as Headers;
      expect(calledHeaders.get('Content-Type')).toBe('application/json');
    });

    it('preserves existing Content-Type header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({}),
      });

      await customFetch('/api/upload', {
        method: 'POST',
        body: 'raw data',
        headers: { 'Content-Type': 'text/plain' },
      });

      const calledHeaders = mockFetch.mock.calls[0][1].headers as Headers;
      expect(calledHeaders.get('Content-Type')).toBe('text/plain');
    });
  });
});

describe('isApiError', () => {
  it('returns true for ApiError objects', () => {
    const error: ApiError = {
      status: 404,
      statusText: 'Not Found',
    };
    expect(isApiError(error)).toBe(true);
  });

  it('returns false for regular Error', () => {
    expect(isApiError(new Error('test'))).toBe(false);
  });

  it('returns false for non-objects', () => {
    expect(isApiError('error')).toBe(false);
    expect(isApiError(null)).toBe(false);
    expect(isApiError(undefined)).toBe(false);
    expect(isApiError(123)).toBe(false);
  });

  it('returns false for objects without status', () => {
    expect(isApiError({ message: 'error' })).toBe(false);
  });

  it('returns false for objects with non-numeric status', () => {
    expect(isApiError({ status: 'error' })).toBe(false);
  });
});
