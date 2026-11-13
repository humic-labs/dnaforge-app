// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { ServiceManager } from './service-manager';

describe('API URL single source of truth', () => {
  it('serviceManager fails closed before platform initialization supplies the URL', () => {
    const mgr = new ServiceManager();
    expect(() => mgr.getBaseUrl()).toThrow(
      'ServiceManager base URL is not initialized. Call initPlatform() before making sidecar requests.'
    );
  });

  it('setBaseUrl changes the URL for all subsequent getBaseUrl calls', () => {
    const mgr = new ServiceManager();
    mgr.setBaseUrl('http://runtime-sidecar.test.invalid');
    expect(mgr.getBaseUrl()).toBe('http://runtime-sidecar.test.invalid');
    const fetchUrl = `${mgr.getBaseUrl()}/toolbox/status`;
    expect(fetchUrl).toBe('http://runtime-sidecar.test.invalid/toolbox/status');
  });

  it('no import.meta.env.VITE_API_URL in service-manager.ts', () => {
    const fs = require('fs');
    const path = require('path');
    const content = fs.readFileSync(path.resolve(__dirname, 'service-manager.ts'), 'utf8');
    expect(content).not.toContain('import.meta.env.VITE_API_URL');
    expect(content).not.toContain('127.0.0.1:8000');
  });

  it('no import.meta.env.VITE_API_URL in alignment-api.ts', () => {
    const fs = require('fs');
    const path = require('path');
    const content = fs.readFileSync(
      path.resolve(__dirname, '../features/alignment-manager/utils/alignment-api.ts'),
      'utf8'
    );
    expect(content).not.toContain('import.meta.env.VITE_API_URL');
  });
});
