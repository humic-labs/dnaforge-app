import { IUPAC_REGEX_CLASS } from './iupac';

const VALID_CLIPBOARD_DNA_CODES = new Set(Object.keys(IUPAC_REGEX_CLASS));

export function normalizePlainDnaClipboardText(text: string): string | null {
  const compact = text.replace(/\s+/g, '').toUpperCase().replace(/U/g, 'T');
  if (!compact) return null;
  return [...compact].every((base) => VALID_CLIPBOARD_DNA_CODES.has(base)) ? compact : null;
}
