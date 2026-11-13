import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_APEX_ORIGIN,
  PRODUCTION_WWW_ORIGIN,
  canonicalizeWebApiOrigin,
} from './web-api-origin';

describe('canonicalizeWebApiOrigin', () => {
  it('rewrites production apex to www so Bearer headers survive', () => {
    expect(canonicalizeWebApiOrigin(PRODUCTION_APEX_ORIGIN)).toBe(PRODUCTION_WWW_ORIGIN);
    expect(canonicalizeWebApiOrigin(`${PRODUCTION_APEX_ORIGIN}/`)).toBe(PRODUCTION_WWW_ORIGIN);
  });

  it('leaves www, staging, loopback, and sealed Release B origins unchanged', () => {
    expect(canonicalizeWebApiOrigin(PRODUCTION_WWW_ORIGIN)).toBe(PRODUCTION_WWW_ORIGIN);
    expect(canonicalizeWebApiOrigin('https://staging.dnaforge.com')).toBe(
      'https://staging.dnaforge.com'
    );
    expect(canonicalizeWebApiOrigin('http://127.0.0.1:4321')).toBe('http://127.0.0.1:4321');
    expect(canonicalizeWebApiOrigin('http://localhost:3108')).toBe('http://localhost:3108');
    expect(canonicalizeWebApiOrigin('https://hosted-ai-gateway-staging.up.railway.app')).toBe(
      'https://hosted-ai-gateway-staging.up.railway.app'
    );
  });
});
