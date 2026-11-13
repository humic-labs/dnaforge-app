const MAXIMUM_EXTERNAL_URL_LENGTH = 8 * 1024;
const MAXIMUM_RCSB_ASYMMETRIC_UNIT_LENGTH = 64;
const MAXIMUM_NCBI_SEQUENCE_ACCESSION_LENGTH = 64;
const MAXIMUM_PMC_TEXT_FRAGMENT_LENGTH = 4 * 1024;
const MAXIMUM_PMC_DECODED_TEXT_LENGTH = 2 * 1024;

const RCSB_SEQUENCE_PATH = /^\/3d-sequence\/[A-Za-z0-9]{4}\/?$/u;
const BOUNDED_LOCATOR_VALUE = /^[A-Za-z0-9._-]+$/u;
const PMC_ARTICLE_PATH = /^\/pmc\/articles\/PMC[0-9]{1,16}\/?$/iu;
const PMC_TEXT_FRAGMENT_PREFIX = '#:~:text=';

export function sanitizeBenchlingMigrationExternalHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > MAXIMUM_EXTERNAL_URL_LENGTH ||
    containsControlCharacter(trimmed)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    return null;
  }

  const preservedSearch = allowlistedScientificSearch(parsed);
  const preservedHash = allowlistedScientificFragment(parsed);
  parsed.search = preservedSearch;
  parsed.hash = preservedHash;
  return parsed.toString();
}

function allowlistedScientificSearch(parsed: URL): string {
  if (
    parsed.protocol === 'https:' &&
    parsed.hostname === 'www.rcsb.org' &&
    parsed.port === '' &&
    RCSB_SEQUENCE_PATH.test(parsed.pathname)
  ) {
    const asymId = exactlyOneSearchParameter(parsed.searchParams, 'asymId');
    if (
      asymId &&
      asymId.length <= MAXIMUM_RCSB_ASYMMETRIC_UNIT_LENGTH &&
      BOUNDED_LOCATOR_VALUE.test(asymId)
    ) {
      return `?${new URLSearchParams({ asymId }).toString()}`;
    }
  }

  if (
    parsed.protocol === 'https:' &&
    parsed.hostname === 'www.ncbi.nlm.nih.gov' &&
    parsed.port === '' &&
    parsed.pathname.toLowerCase() === '/structure/cdd/wrpsb.cgi'
  ) {
    const inputType = exactlyOneSearchParameter(parsed.searchParams, 'INPUT_TYPE');
    const sequence = exactlyOneSearchParameter(parsed.searchParams, 'SEQUENCE');
    if (
      inputType === 'live' &&
      sequence &&
      sequence.length <= MAXIMUM_NCBI_SEQUENCE_ACCESSION_LENGTH &&
      BOUNDED_LOCATOR_VALUE.test(sequence)
    ) {
      return `?${new URLSearchParams({ INPUT_TYPE: inputType, SEQUENCE: sequence }).toString()}`;
    }
  }

  return '';
}

function allowlistedScientificFragment(parsed: URL): string {
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'www.ncbi.nlm.nih.gov' ||
    parsed.port !== '' ||
    !PMC_ARTICLE_PATH.test(parsed.pathname) ||
    !parsed.hash.startsWith(PMC_TEXT_FRAGMENT_PREFIX) ||
    parsed.hash.length > MAXIMUM_PMC_TEXT_FRAGMENT_LENGTH
  ) {
    return '';
  }

  const encodedText = parsed.hash.slice(PMC_TEXT_FRAGMENT_PREFIX.length);
  if (!encodedText || encodedText.includes('&') || encodedText.includes('#')) return '';

  let decodedText: string;
  try {
    decodedText = decodeURIComponent(encodedText);
  } catch {
    return '';
  }
  if (
    !decodedText.trim() ||
    decodedText.length > MAXIMUM_PMC_DECODED_TEXT_LENGTH ||
    containsControlCharacter(decodedText)
  ) {
    return '';
  }

  return parsed.hash;
}

function exactlyOneSearchParameter(parameters: URLSearchParams, name: string): string | null {
  const values = parameters.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}
