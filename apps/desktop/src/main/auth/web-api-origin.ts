export const PRODUCTION_APEX_ORIGIN = 'https://dnaforge.com';
export const PRODUCTION_WWW_ORIGIN = 'https://www.dnaforge.com';

export function canonicalizeWebApiOrigin(origin: string): string {
  const trimmed = origin.replace(/\/+$/, '');
  return trimmed === PRODUCTION_APEX_ORIGIN ? PRODUCTION_WWW_ORIGIN : trimmed;
}
