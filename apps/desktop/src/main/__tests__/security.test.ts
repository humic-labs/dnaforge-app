import { describe, it, expect } from 'vitest';
import {
  isLocalUrl,
  isSafeExternalProtocol,
  isTrustedRendererUrl,
  SAFE_EXTERNAL_PROTOCOLS,
} from '../security';

describe('isTrustedRendererUrl', () => {
  it('allows paths on the exact configured dev origin', () => {
    expect(
      isTrustedRendererUrl(
        'http://127.0.0.1:3108/workspace?tab=1',
        'http://127.0.0.1:3108/?e2e=true'
      )
    ).toBe(true);
  });

  it.each([
    'http://127.0.0.1:3109/',
    'http://localhost:3108/',
    'https://127.0.0.1:3108/',
    'http://127.0.0.1:8000/health',
  ])('rejects a different loopback origin: %s', (candidate) => {
    expect(isTrustedRendererUrl(candidate, 'http://127.0.0.1:3108/')).toBe(false);
  });

  it('allows only the exact packaged renderer file', () => {
    const trusted = 'file:///Applications/DNAForge.app/Contents/Resources/app/renderer/index.html';
    expect(isTrustedRendererUrl(`${trusted}?e2e=true#home`, trusted)).toBe(true);
    expect(
      isTrustedRendererUrl(
        'file:///Applications/DNAForge.app/Contents/Resources/app/renderer/attacker.html',
        trusted
      )
    ).toBe(false);
  });
});

describe('isLocalUrl', () => {
  describe('allows local dev-server URLs', () => {
    it('allows http://localhost:1420/', () => {
      expect(isLocalUrl('http://localhost:1420/')).toBe(true);
    });

    it('allows http://localhost:3000/path', () => {
      expect(isLocalUrl('http://localhost:3000/path')).toBe(true);
    });

    it('allows https://localhost:443/', () => {
      expect(isLocalUrl('https://localhost:443/')).toBe(true);
    });

    it('allows http://127.0.0.1:8080/', () => {
      expect(isLocalUrl('http://127.0.0.1:8080/')).toBe(true);
    });

    it('allows http://[::1]:3000/', () => {
      expect(isLocalUrl('http://[::1]:3000/')).toBe(true);
    });

    it('allows http://localhost/ (no port)', () => {
      expect(isLocalUrl('http://localhost/')).toBe(true);
    });

    it('allows http://localhost:1420/deep/path?query=1#hash', () => {
      expect(isLocalUrl('http://localhost:1420/deep/path?query=1#hash')).toBe(true);
    });
  });

  describe('blocks remote / dangerous URLs', () => {
    it('blocks http://evil.com/', () => {
      expect(isLocalUrl('http://evil.com/')).toBe(false);
    });

    it('blocks http://localhost@evil.com/ (userinfo bypass)', () => {
      expect(isLocalUrl('http://localhost@evil.com/')).toBe(false);
    });

    it('blocks http://localhost:3000@evil.com/ (userinfo with port)', () => {
      expect(isLocalUrl('http://localhost:3000@evil.com/')).toBe(false);
    });

    it('blocks http://user:pass@localhost/ (username+password)', () => {
      expect(isLocalUrl('http://user:pass@localhost/')).toBe(false);
    });
  });

  describe('blocks non-http(s) schemes', () => {
    it('blocks javascript:alert(1)', () => {
      expect(isLocalUrl('javascript:alert(1)')).toBe(false);
    });

    it('blocks data:text/html,<h1>hi</h1>', () => {
      expect(isLocalUrl('data:text/html,<h1>hi</h1>')).toBe(false);
    });

    it('blocks file:///etc/passwd', () => {
      expect(isLocalUrl('file:///etc/passwd')).toBe(false);
    });

    it('blocks blob:http://evil.com/uuid', () => {
      expect(isLocalUrl('blob:http://evil.com/uuid')).toBe(false);
    });
  });

  describe('blocks edge cases', () => {
    it('blocks empty string', () => {
      expect(isLocalUrl('')).toBe(false);
    });

    it('blocks malformed URL', () => {
      expect(isLocalUrl('not-a-url')).toBe(false);
    });

    it('blocks http://localhost. (trailing dot — DNS resolves differently)', () => {
      expect(isLocalUrl('http://localhost./')).toBe(false);
    });
  });
});

describe('isSafeExternalProtocol', () => {
  describe('allows safe protocols', () => {
    it('allows http: URLs', () => {
      expect(isSafeExternalProtocol('http://example.com')).toBe(true);
    });

    it('allows https: URLs', () => {
      expect(isSafeExternalProtocol('https://example.com')).toBe(true);
    });

    it('allows mailto: URLs', () => {
      expect(isSafeExternalProtocol('mailto:user@example.com')).toBe(true);
    });
  });

  describe('blocks unsafe protocols', () => {
    it('blocks javascript: URLs', () => {
      expect(isSafeExternalProtocol('javascript:alert(1)')).toBe(false);
    });

    it('blocks file: URLs', () => {
      expect(isSafeExternalProtocol('file:///etc/passwd')).toBe(false);
    });

    it('blocks data: URLs', () => {
      expect(isSafeExternalProtocol('data:text/html,<h1>hi</h1>')).toBe(false);
    });

    it('blocks blob: URLs', () => {
      expect(isSafeExternalProtocol('blob:http://evil.com/uuid')).toBe(false);
    });
  });

  describe('handles invalid input', () => {
    it('returns false for malformed URLs', () => {
      expect(isSafeExternalProtocol('not-a-url')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isSafeExternalProtocol('')).toBe(false);
    });
  });
});

describe('SAFE_EXTERNAL_PROTOCOLS', () => {
  it('contains exactly http:, https:, and mailto:', () => {
    expect(SAFE_EXTERNAL_PROTOCOLS).toEqual(new Set(['http:', 'https:', 'mailto:']));
  });

  it('does not contain ftp:', () => {
    expect(SAFE_EXTERNAL_PROTOCOLS.has('ftp:')).toBe(false);
  });
});
