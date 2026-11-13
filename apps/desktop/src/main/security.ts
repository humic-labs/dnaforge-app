export const SAFE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export function isLocalUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    const h = parsed.hostname;
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

export function isTrustedRendererUrl(raw: string, trustedRendererUrl: string): boolean {
  try {
    const candidate = new URL(raw);
    const trusted = new URL(trustedRendererUrl);
    if (trusted.protocol === 'file:') {
      return (
        candidate.protocol === 'file:' &&
        candidate.host === trusted.host &&
        candidate.pathname === trusted.pathname
      );
    }
    return (
      candidate.origin === trusted.origin && candidate.username === '' && candidate.password === ''
    );
  } catch {
    return false;
  }
}

export function isSafeExternalProtocol(url: string): boolean {
  try {
    const parsed = new URL(url);
    return SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}
