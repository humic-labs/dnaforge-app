import { HOSTED_REFERENCE_CATALOG_V1 } from './hosted-reference-catalog';
import { parseNcbiAssemblyLink } from './ncbi-assembly-link';

const UCSC_DATABASE_ALIASES: Readonly<Record<string, string>> = {
  hg38: 'grch38',
  grch38: 'grch38',
};

export function ucscDatabaseToken(raw: string): string | null {
  const text = raw.trim();
  if (/^GC[AF]_[0-9]+\.[0-9]+$/u.test(text)) return null;
  if (/^[A-Za-z][A-Za-z0-9.]{0,40}$/u.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'ucsc.edu' && !host.endsWith('.ucsc.edu')) return null;
  const database = url.searchParams.get('db');
  if (database && /^[A-Za-z][A-Za-z0-9.]{0,40}$/u.test(database)) return database;
  const goldenPath = url.pathname.match(/\/goldenPath\/([^/]+)/u);
  return goldenPath?.[1] ?? null;
}

export function hostedCatalogIdForAssemblyPaste(raw: string): string | null {
  let accession: string | null = null;
  try {
    accession = parseNcbiAssemblyLink(raw).accession;
  } catch {
    accession = null;
  }
  if (accession) {
    return (
      HOSTED_REFERENCE_CATALOG_V1.find(
        (definition) => definition.provenance.datasetId === accession
      )?.id ?? null
    );
  }
  const token = ucscDatabaseToken(raw);
  if (!token) return null;
  const needle = token.toLowerCase();
  const alias = UCSC_DATABASE_ALIASES[needle];
  if (alias && HOSTED_REFERENCE_CATALOG_V1.some((definition) => definition.id === alias)) {
    return alias;
  }
  const byId = HOSTED_REFERENCE_CATALOG_V1.find(
    (definition) => definition.id.toLowerCase() === needle
  );
  if (byId) return byId.id;
  return (
    HOSTED_REFERENCE_CATALOG_V1.find((definition) =>
      definition.provenance.sourceUrl?.toLowerCase().includes(`/goldenpath/${needle}/`)
    )?.id ?? null
  );
}
