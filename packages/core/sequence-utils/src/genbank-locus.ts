export const GENBANK_LOCUS_ENCODING_COMMENT =
  'COMMENT     DNAForge locus-name encoding: percent-v1';

export function decodeGenBankLocusName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export function formatGenBankLocusPrefix(name: string, length: number): string {
  const identifier = encodeURIComponent(name || 'Unknown');
  const size = String(length);
  const gap = ' '.repeat(Math.max(1, 28 - identifier.length - size.length));
  return `LOCUS       ${identifier}${gap}${size}`;
}
