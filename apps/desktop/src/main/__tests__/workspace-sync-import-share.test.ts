import { describe, expect, it } from 'vitest';

import {
  isImportShareUrl,
  parseImportShareUrl,
  PendingImportShareUrl,
} from '../workspace-sync-import-share-url';

const TOKEN = 'capability_token_1234567890';

describe('workspace sync import-share deep link (Phase C)', () => {
  it('parses dnaforge://import-share URLs', () => {
    expect(parseImportShareUrl(`dnaforge://import-share?shortId=abc12345&token=${TOKEN}`)).toEqual({
      shortId: 'abc12345',
      token: TOKEN,
    });
    expect(isImportShareUrl(`dnaforge-dev://import-share?shortId=dev_12345&token=${TOKEN}`)).toBe(
      true
    );
  });

  it('rejects incomplete or wrong-host deep links', () => {
    expect(parseImportShareUrl('dnaforge://import-share?shortId=abc')).toBeNull();
    expect(parseImportShareUrl(`dnaforge://import-share?shortId=short&token=${TOKEN}`)).toBeNull();
    expect(
      parseImportShareUrl('dnaforge://import-share?shortId=abc12345&token=too-short')
    ).toBeNull();
    expect(parseImportShareUrl('dnaforge://auth-callback?code=c&flow_nonce=n')).toBeNull();
    expect(isImportShareUrl('https://dnaforge.com/d/abc')).toBe(false);
  });

  it('buffers only the latest valid request and consumes it once', () => {
    const pending = new PendingImportShareUrl();
    const first = `dnaforge://import-share?shortId=first123&token=${TOKEN}`;
    const second = `dnaforge://import-share?shortId=second12&token=${TOKEN}`;

    expect(pending.replace(first)).toBe(true);
    expect(pending.replace('https://example.com')).toBe(false);
    expect(pending.replace(second)).toBe(true);
    expect(pending.hasValue()).toBe(true);
    expect(pending.take()).toBe(second);
    expect(pending.take()).toBeNull();
    expect(pending.hasValue()).toBe(false);
  });
});
