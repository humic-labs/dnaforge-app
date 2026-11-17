// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { configureApiClient } from '@waypoint/api-client';

import { ServiceManager } from './service-manager';

const TEST_BASE_URL = 'http://service-manager.test.invalid';
const CUSTOM_BASE_URL = 'http://custom-sidecar.test.invalid';
const UPDATED_BASE_URL = 'http://updated-sidecar.test.invalid';

function jsonResponse(data: unknown, status = 200, statusText = ''): Response {
  return new Response(JSON.stringify(data), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ServiceManager', () => {
  let manager: ServiceManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new ServiceManager(TEST_BASE_URL);
  });

  describe('initialization', () => {
    it('creates a ServiceManager instance', () => {
      expect(manager).toBeInstanceOf(ServiceManager);
    });

    it('starts in not-ready state', () => {
      expect(manager.isReady()).toBe(false);
    });

    it('requires a base URL before requests can be made', () => {
      const uninitialized = new ServiceManager();
      expect(() => uninitialized.getBaseUrl()).toThrow(
        'ServiceManager base URL is not initialized. Call initPlatform() before making sidecar requests.'
      );
    });

    it('accepts custom base URL via constructor', () => {
      const custom = new ServiceManager(CUSTOM_BASE_URL);
      expect(custom.getBaseUrl()).toBe(CUSTOM_BASE_URL);
    });

    it('updates base URL via setBaseUrl()', () => {
      expect(manager.getBaseUrl()).toBe(TEST_BASE_URL);
      manager.setBaseUrl(UPDATED_BASE_URL);
      expect(manager.getBaseUrl()).toBe(UPDATED_BASE_URL);
    });

    it('rejects empty base URLs', () => {
      expect(() => manager.setBaseUrl('   ')).toThrow('ServiceManager base URL cannot be empty.');
    });
  });

  describe('endpoint ownership', () => {
    beforeEach(() => {
      global.fetch = vi.fn();
    });

    it('uses its own base URL when the compatibility default points elsewhere', async () => {
      configureApiClient({ baseUrl: 'http://another-feature.test.invalid' });
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse({ status: 'healthy' })
      );

      await manager.checkHealth();

      expect(global.fetch).toHaveBeenCalledWith(`${TEST_BASE_URL}/health`, expect.any(Object));
    });
  });

  describe('health checks', () => {
    beforeEach(() => {
      global.fetch = vi.fn();
    });

    it('reports healthy when API responds', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse({ status: 'healthy' })
      );

      const health = await manager.checkHealth();

      expect(health.healthy).toBe(true);
    });

    it('reports unhealthy when API fails', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Connection refused')
      );

      const health = await manager.checkHealth();

      expect(health.healthy).toBe(false);
      expect(health.error).toContain('Connection refused');
    });

    it('preserves the HTTP status when the health endpoint rejects the request', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse({ detail: 'sidecar unavailable' }, 503, 'Service Unavailable')
      );

      const health = await manager.checkHealth();

      expect(health).toMatchObject({
        healthy: false,
        error: 'Health check failed: HTTP 503 Service Unavailable',
      });
    });

    it('reports unhealthy on timeout', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 100))
      );

      const health = await manager.checkHealth();

      expect(health.healthy).toBe(false);
    });
  });
});
