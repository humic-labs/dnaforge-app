const MISSING_RELATIONSHIP_TOKENS = new Set(['none', '-']);

function isMissingRelationshipToken(value: string): boolean {
  const token = value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
  return token.length === 0 || MISSING_RELATIONSHIP_TOKENS.has(token);
}

export function benchlingRelationshipDisplayNames(value: string): readonly string[] {
  const trimmed = value.trim();
  if (!/[;,]/.test(trimmed)) return isMissingRelationshipToken(trimmed) ? [] : [trimmed];
  return trimmed
    .split(/[;,]/u)
    .map((part) => part.trim())
    .filter((part) => !isMissingRelationshipToken(part));
}
