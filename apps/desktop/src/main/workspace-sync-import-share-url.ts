const ALLOWED_SCHEMES = new Set(['dnaforge', 'dnaforge-beta', 'dnaforge-dev']);
const SHORT_ID_PATTERN = /^[A-Za-z0-9_-]{8,32}$/;
const CAPABILITY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;

export interface ParsedImportShareUrl {
  shortId: string;
  token: string;
}

export function isImportShareUrl(url: string): boolean {
  return parseImportShareUrl(url) !== null;
}

export function parseImportShareUrl(url: string): ParsedImportShareUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (!ALLOWED_SCHEMES.has(scheme)) return null;
  if (parsed.hostname.toLowerCase() !== 'import-share') return null;
  const shortId = parsed.searchParams.get('shortId')?.trim() ?? '';
  const token = parsed.searchParams.get('token')?.trim() ?? '';
  if (!SHORT_ID_PATTERN.test(shortId) || !CAPABILITY_TOKEN_PATTERN.test(token)) return null;
  return { shortId, token };
}

export class PendingImportShareUrl {
  private value: string | null = null;

  replace(url: string): boolean {
    if (!parseImportShareUrl(url)) return false;
    this.value = url;
    return true;
  }

  take(): string | null {
    const value = this.value;
    this.value = null;
    return value;
  }

  hasValue(): boolean {
    return this.value !== null;
  }
}
