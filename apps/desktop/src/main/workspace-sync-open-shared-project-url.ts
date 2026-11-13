const ALLOWED_SCHEMES = new Set(['dnaforge', 'dnaforge-beta', 'dnaforge-dev']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ParsedOpenSharedProjectUrl {
  remoteWorkspaceId: string;
}

export function isOpenSharedProjectUrl(url: string): boolean {
  return parseOpenSharedProjectUrl(url) !== null;
}

export function parseOpenSharedProjectUrl(url: string): ParsedOpenSharedProjectUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (!ALLOWED_SCHEMES.has(scheme)) return null;
  if (parsed.hostname.toLowerCase() !== 'open-shared-project') return null;
  const remoteWorkspaceId = parsed.searchParams.get('workspaceId')?.trim().toLowerCase() ?? '';
  if (!UUID_PATTERN.test(remoteWorkspaceId)) return null;
  return { remoteWorkspaceId };
}

export class PendingOpenSharedProjectUrl {
  private value: string | null = null;

  replace(url: string): boolean {
    if (!parseOpenSharedProjectUrl(url)) return false;
    this.value = url;
    return true;
  }

  take(): string | null {
    const value = this.value;
    this.value = null;
    return value;
  }

  peek(): string | null {
    return this.value;
  }
}
