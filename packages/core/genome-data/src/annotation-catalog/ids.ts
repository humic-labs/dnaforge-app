export type SourceId = string & { readonly __brand: 'AnnotationSourceId' };
export type VisualizationId = string & { readonly __brand: 'AnnotationVisualizationId' };
export type TrackBindingId = string & { readonly __brand: 'AnnotationTrackBindingId' };
export type AssemblyAccession = string & { readonly __brand: 'AssemblyAccession' };

const CATALOG_ID = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
const ACCESSION = /^[A-Za-z]{1,6}_?[A-Za-z]{0,4}[0-9]+\.[0-9]+$/;

export function isCatalogId(value: string): boolean {
  return CATALOG_ID.test(value);
}

export function isAssemblyAccession(value: string): boolean {
  return ACCESSION.test(value);
}

function catalogId(value: string, what: string): string {
  if (!isCatalogId(value)) {
    throw new Error(`Invalid ${what} id "${value}": use lowercase letters, digits, and : . _ -`);
  }
  return value;
}

export function sourceId(value: string): SourceId {
  return catalogId(value, 'source') as SourceId;
}

export function visualizationId(value: string): VisualizationId {
  return catalogId(value, 'visualization') as VisualizationId;
}

export function trackBindingId(value: string): TrackBindingId {
  return catalogId(value, 'track') as TrackBindingId;
}

export function assemblyAccession(value: string): AssemblyAccession {
  if (!isAssemblyAccession(value)) {
    throw new Error(`Invalid versioned assembly accession "${value}", e.g. NC_000913.3`);
  }
  return value as AssemblyAccession;
}
