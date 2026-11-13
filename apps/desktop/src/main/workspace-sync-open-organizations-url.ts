const ALLOWED_SCHEMES = new Set(['dnaforge', 'dnaforge-beta', 'dnaforge-dev']);

export function isOpenOrganizationsUrl(url: string): boolean {
  return parseOpenOrganizationsUrl(url);
}

export function parseOpenOrganizationsUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (!ALLOWED_SCHEMES.has(scheme)) return false;
  return parsed.hostname.toLowerCase() === 'open-organizations';
}

export class PendingOpenOrganizationsUrl {
  private value: string | null = null;

  replace(url: string): boolean {
    if (!parseOpenOrganizationsUrl(url)) return false;
    this.value = url;
    return true;
  }

  take(): string | null {
    const value = this.value;
    this.value = null;
    return value;
  }
}
