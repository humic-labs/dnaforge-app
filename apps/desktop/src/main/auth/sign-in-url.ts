import { isLocalUrl, isSafeExternalProtocol } from '../security';

export type SignInUrl = string & { readonly __brand: 'SignInUrl' };

export function parseSignInUrl(raw: string): SignInUrl | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.username !== '' || parsed.password !== '') return null;
    if (parsed.hostname.length === 0) return null;
    if (!isSafeExternalProtocol(raw)) return null;
    if (parsed.protocol === 'https:') return raw as SignInUrl;
    if (isLocalUrl(raw)) return raw as SignInUrl;
    return null;
  } catch {
    return null;
  }
}
