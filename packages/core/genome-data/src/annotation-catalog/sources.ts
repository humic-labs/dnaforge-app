import type { AssemblyAccession, SourceId } from './ids';
import type { CatalogRecord, FeatureKind, Strand } from './records';

export type AnnotationEvidenceClass = 'curated' | 'measured' | 'computed';

export const ANNOTATION_EVIDENCE_LABELS: Readonly<Record<AnnotationEvidenceClass, string>> = {
  curated: 'Curated',
  measured: 'Measured',
  computed: 'Computed',
};

export interface SourceLicense {
  readonly spdx: string | null;
  readonly attribution: string;
  readonly evidenceUrl: string | null;
}

export interface SourceProvenance {
  readonly citation: string | null;
  readonly url: string | null;
  readonly doi: string | null;
  readonly datasetVersion: string | null;
  readonly liftedFrom: string | null;
  readonly license: SourceLicense;
}

export interface AssemblyIdentity {
  readonly accession: AssemblyAccession;
  readonly lengthBp: number;
}

export interface GeneModel {
  readonly name: string;
  readonly locusTag: string | null;
  readonly start: number;
  readonly end: number;
  readonly strand: Strand;
}

export interface SequenceReader {
  readonly lengthBp: number;
  slice(start: number, end: number): string;
}

export interface SourceLoadContext {
  readonly assembly: AssemblyIdentity;
  readonly genes: readonly GeneModel[];
  readonly sequence: SequenceReader;
  readonly loadRecords: (id: SourceId) => Promise<readonly CatalogRecord[]>;
}

export type SourceAvailability =
  | { readonly status: 'available' }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface AnnotationSourceDefinition {
  readonly id: SourceId;
  readonly label: string;
  readonly kinds: readonly [FeatureKind, ...FeatureKind[]];
  readonly assembly: AssemblyAccession;
  readonly evidence: AnnotationEvidenceClass;
  readonly provenance: SourceProvenance;
  readonly availability: SourceAvailability;
  readonly derivedFrom: readonly SourceId[];
  load(context: SourceLoadContext): Promise<readonly CatalogRecord[]>;
}

export interface AnnotationSourceCatalog {
  get(id: SourceId): AnnotationSourceDefinition | undefined;
  list(): readonly AnnotationSourceDefinition[];
  forKind(query: {
    kind: FeatureKind;
    assembly: AssemblyAccession;
  }): readonly AnnotationSourceDefinition[];
}

export function createAnnotationSourceCatalog(
  definitions: readonly AnnotationSourceDefinition[]
): AnnotationSourceCatalog {
  const byId = new Map<SourceId, AnnotationSourceDefinition>();
  for (const definition of definitions) {
    if (byId.has(definition.id)) {
      throw new Error(`Duplicate annotation source id "${definition.id}"`);
    }
    byId.set(definition.id, definition);
  }
  for (const definition of definitions) {
    for (const upstream of definition.derivedFrom) {
      if (!byId.has(upstream)) {
        throw new Error(`Source "${definition.id}" is derived from unknown source "${upstream}"`);
      }
    }
  }
  const ordered = Object.freeze([...definitions]);
  return {
    get: (id) => byId.get(id),
    list: () => ordered,
    forKind: ({ kind, assembly }) =>
      ordered
        .filter((d) => d.assembly === assembly && d.kinds.includes(kind))
        .sort((a, b) => availabilityRank(a) - availabilityRank(b)),
  };
}

function availabilityRank(definition: AnnotationSourceDefinition): number {
  return definition.availability.status === 'available' ? 0 : 1;
}

export interface SourceRecordCache {
  load(id: SourceId): Promise<readonly CatalogRecord[]>;
}

export function createSourceRecordCache(input: {
  catalog: AnnotationSourceCatalog;
  assembly: AssemblyIdentity;
  genes: readonly GeneModel[];
  sequence: SequenceReader;
}): SourceRecordCache {
  const inFlight = new Map<SourceId, Promise<readonly CatalogRecord[]>>();

  const loadWithStack = (
    id: SourceId,
    stack: readonly SourceId[]
  ): Promise<readonly CatalogRecord[]> => {
    if (stack.includes(id)) {
      return Promise.reject(new Error(`Annotation source cycle: ${[...stack, id].join(' -> ')}`));
    }
    const existing = inFlight.get(id);
    if (existing) return existing;
    const definition = input.catalog.get(id);
    if (!definition) return Promise.reject(new Error(`Unknown annotation source "${id}"`));
    if (definition.availability.status === 'unavailable') {
      return Promise.reject(
        new Error(`${definition.label} is unavailable: ${definition.availability.reason}`)
      );
    }
    if (definition.assembly !== input.assembly.accession) {
      return Promise.reject(
        new Error(
          `${definition.label} is for ${definition.assembly}, not ${input.assembly.accession}`
        )
      );
    }
    const nextStack = [...stack, id];
    const promise = definition
      .load({
        assembly: input.assembly,
        genes: input.genes,
        sequence: input.sequence,
        loadRecords: (upstream) => loadWithStack(upstream, nextStack),
      })
      .then((records) => {
        assertRecordsFit(definition, records, input.assembly.lengthBp);
        return records;
      });
    inFlight.set(id, promise);
    promise.catch(() => inFlight.delete(id));
    return promise;
  };

  return { load: (id) => loadWithStack(id, []) };
}

function assertRecordsFit(
  definition: AnnotationSourceDefinition,
  records: readonly CatalogRecord[],
  lengthBp: number
): void {
  for (const record of records) {
    if (!definition.kinds.includes(record.kind)) {
      throw new Error(
        `${definition.label} returned a ${record.kind} record but declares ${definition.kinds.join(', ')}`
      );
    }
    const end = record.location.shape === 'point' ? record.location.bp + 1 : record.location.end;
    if (end > lengthBp) {
      throw new Error(
        `${definition.label} record ${record.id} ends at ${end}, past ${lengthBp} bp`
      );
    }
  }
}
