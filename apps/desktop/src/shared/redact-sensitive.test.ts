// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { redactSensitive } from './redact-sensitive';

describe('redactSensitive ', () => {
  it('redacts emails', () => {
    expect(redactSensitive('login failed for alice@example.com')).toBe(
      'login failed for [redacted-email]'
    );
  });

  it('redacts provider API keys and JWT-shaped tokens', () => {
    expect(redactSensitive('key sk-000000000000 used')).toContain('[redacted-key]');
    expect(redactSensitive('gho_0000000000000000')).toContain('[redacted-key]');
    expect(redactSensitive('t=eyJ00000000.aaaa0000.bbbb0000')).toContain('[redacted-jwt]');
  });

  it('redacts key=value / bearer secrets', () => {
    expect(redactSensitive('api_key=xxxxxxxxxxxx')).toBe('api_key=[redacted]');
    expect(redactSensitive('token: xxxxxxxxxxxx')).toBe('token: [redacted]');
  });

  it('redacts the username from home-directory paths (POSIX + Windows)', () => {
    expect(redactSensitive('failed to read /Users/alice/research/secret.gb')).toBe(
      'failed to read /Users/[redacted-user]/research/secret.gb'
    );
    expect(redactSensitive('/home/bob/data.txt missing')).toBe(
      '/home/[redacted-user]/data.txt missing'
    );
    expect(redactSensitive('C:\\Users\\user\\file.gb')).toBe(
      'C:\\Users\\[redacted-user]\\file.gb'
    );
  });

  it('redacts high-value secret shapes (AWS, Stripe, github_pat, PEM, connection strings)', () => {
    const aws = 'AKIA' + 'A'.repeat(16);
    const stripe = 'sk_live_' + '0'.repeat(20);
    const ghPat = 'github_pat_' + '0'.repeat(30);
    expect(redactSensitive(`id ${aws}`)).toContain('[redacted-key]');
    expect(redactSensitive(stripe)).toContain('[redacted-key]');
    expect(redactSensitive(ghPat)).toContain('[redacted-key]');
    expect(redactSensitive('-----BEGIN RSA PRIVATE KEY-----')).toBe('[redacted-private-key]');
    expect(redactSensitive('postgresql://admin:xxxxxxxx@db.host/app')).toBe(
      'postgresql://admin:[redacted]@db.host/app'
    );
  });

  it('leaves non-sensitive content (and DNA sequences) intact', () => {
    expect(redactSensitive('rendered 1200 bases of ACGTACGTACGT')).toBe(
      'rendered 1200 bases of ACGTACGTACGT'
    );
    expect(redactSensitive('opened data/plasmid.gb')).toBe('opened data/plasmid.gb');
    expect(redactSensitive('')).toBe('');
  });
});
