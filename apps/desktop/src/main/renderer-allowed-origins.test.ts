import { describe, it, expect } from 'vitest';
import {
  FILE_DOCUMENT_ORIGIN,
  SIDECAR_ALLOWED_ORIGINS_ENV,
  rendererAllowedOriginsEnv,
  resolveRendererAllowedOrigin,
} from './renderer-allowed-origins';

describe('renderer allowed origins', () => {
  it('grants the file:// opaque origin when there is no dev server', () => {
    expect(resolveRendererAllowedOrigin(undefined)).toBe(FILE_DOCUMENT_ORIGIN);
    expect(resolveRendererAllowedOrigin('')).toBe(FILE_DOCUMENT_ORIGIN);
  });

  it('grants exactly the dev server origin, and NOT "null"', () => {
    expect(resolveRendererAllowedOrigin('http://localhost:1451')).toBe('http://localhost:1451');
    expect(resolveRendererAllowedOrigin('http://localhost:1451')).not.toBe(FILE_DOCUMENT_ORIGIN);
  });

  it('never returns more than one origin', () => {
    for (const url of [undefined, 'http://localhost:1451', 'http://127.0.0.1:3130', 'nonsense']) {
      expect(resolveRendererAllowedOrigin(url)).not.toContain(',');
    }
  });

  it('drops the path, keeping only the origin', () => {
    expect(resolveRendererAllowedOrigin('http://localhost:1451/index.html?x=1')).toBe(
      'http://localhost:1451'
    );
  });

  it('falls back to the file:// origin on an unparseable dev URL', () => {
    expect(resolveRendererAllowedOrigin('not a url')).toBe(FILE_DOCUMENT_ORIGIN);
  });

  it('never INTRODUCES a wildcard of its own', () => {
    for (const url of [undefined, '', 'http://localhost:1451', '*', 'not a url']) {
      expect(resolveRendererAllowedOrigin(url)).not.toContain('*');
    }
  });

  it('emits the variable name the sidecar actually reads', () => {
    const env = rendererAllowedOriginsEnv('http://localhost:1451');
    expect(Object.keys(env)).toEqual([SIDECAR_ALLOWED_ORIGINS_ENV]);
    expect(env[SIDECAR_ALLOWED_ORIGINS_ENV]).toBe('http://localhost:1451');
  });
});
