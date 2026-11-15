import { healthCheck, isApiError, type ApiClient } from '@waypoint/api-client';
import { createRendererSidecarApiClient, hostedExternalLookupBaseUrl } from './sidecar-session';

export interface HealthCheckResult {
  healthy: boolean;
  error?: string;
  latencyMs?: number;
}

function normalizeBaseUrl(baseUrl: string | undefined): string | null {
  const trimmed = baseUrl?.trim();
  return trimmed ? trimmed : null;
}

export class ServiceManager {
  private baseUrl: string | null;
  private ready = false;

  constructor(baseUrl?: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  isReady(): boolean {
    return this.ready;
  }

  getBaseUrl(): string {
    if (!this.baseUrl) {
      throw new Error(
        'ServiceManager base URL is not initialized. Call initPlatform() before making sidecar requests.'
      );
    }
    return this.baseUrl;
  }

  setBaseUrl(url: string): void {
    const normalized = normalizeBaseUrl(url);
    if (!normalized) {
      throw new Error('ServiceManager base URL cannot be empty.');
    }
    this.baseUrl = normalized;
  }

  client(): ApiClient {
    return createRendererSidecarApiClient(this.getBaseUrl());
  }

  getExternalLookupBaseUrl(): string {
    return hostedExternalLookupBaseUrl() ?? this.getBaseUrl();
  }

  externalLookupClient(): ApiClient {
    return createRendererSidecarApiClient(this.getExternalLookupBaseUrl());
  }

  async checkHealth(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      await healthCheck(
        this.client().options({
          signal: AbortSignal.timeout(5000),
        })
      );

      const latencyMs = Date.now() - startTime;
      this.ready = true;
      return {
        healthy: true,
        latencyMs,
      };
    } catch (error) {
      this.ready = false;
      return {
        healthy: false,
        error: isApiError(error)
          ? `Health check failed: HTTP ${error.status}${error.statusText ? ` ${error.statusText}` : ''}`
          : error instanceof Error
            ? error.message
            : String(error),
        latencyMs: Date.now() - startTime,
      };
    }
  }
}

export const serviceManager = new ServiceManager();
