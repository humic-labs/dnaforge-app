import { describe, expect, it } from 'vitest';

import { parseSignInUrl } from './sign-in-url';

describe('parseSignInUrl', () => {
  it('accepts an HTTPS provider authorize URL', () => {
    expect(parseSignInUrl('https://provider.example/authorize?x=1')).toBe(
      'https://provider.example/authorize?x=1'
    );
  });

  it('accepts loopback HTTP used by local Supabase live proof', () => {
    expect(parseSignInUrl('http://127.0.0.1:54321/auth/v1/authorize?x=1')).toBe(
      'http://127.0.0.1:54321/auth/v1/authorize?x=1'
    );
    expect(parseSignInUrl('http://localhost:3108/auth/callback')).toBe(
      'http://localhost:3108/auth/callback'
    );
  });

  it('rejects file URLs, unknown schemes, and embedded credentials', () => {
    expect(parseSignInUrl('file:///etc/passwd')).toBeNull();
    expect(parseSignInUrl('smb://files.example/share')).toBeNull();
    expect(parseSignInUrl('https://user:pass@accounts.google.com/o/oauth2')).toBeNull();
    expect(parseSignInUrl('http://provider.example/authorize')).toBeNull();
  });
});
