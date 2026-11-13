import { parseSourceRecords } from './dataset-records';
import { assemblyAccession, isAssemblyAccession, isCatalogId, sourceId } from './ids';
import { isFeatureKind, type FeatureKind } from './records';
import type { AnnotationSourceDefinition, AnnotationEvidenceClass } from './sources';

export function defineDatasetSource(input: {
  readonly manifest: unknown;
  readonly loadRecordsFile: () => Promise<unknown>;
}): AnnotationSourceDefinition {
  const manifest = parseDatasetManifest(input.manifest);
  return {
    ...manifest,
    derivedFrom: [],
    availability: { status: 'available' },
    load: async (context) => {
      const raw = await input.loadRecordsFile();
      const { records, rejected } = parseSourceRecords({
        raw,
        expectedSourceId: manifest.id,
        assembly: context.assembly,
      });
      if (rejected.count > 0) {
        throw new Error(
          `${manifest.label}: ${rejected.count} invalid records, e.g. ${rejected.examples.slice(0, 3).join('; ')}`
        );
      }
      return records;
    },
  };
}

type ParsedManifest = Pick<
  AnnotationSourceDefinition,
  'id' | 'label' | 'kinds' | 'assembly' | 'evidence' | 'provenance'
>;

export function parseDatasetManifest(raw: unknown): ParsedManifest {
  if (!isObject(raw)) throw new Error('source.json must be an object');
  const id = requireString(raw, 'sourceId');
  if (!isCatalogId(id)) throw new Error(`source.json sourceId "${id}" is not a catalog id`);
  const where = `source.json for ${id}`;

  const kindsRaw = raw.kinds;
  if (!Array.isArray(kindsRaw)) throw new Error(`${where}: kinds must be an array`);
  const kinds: FeatureKind[] = [];
  for (const kind of kindsRaw) {
    if (typeof kind !== 'string' || !isFeatureKind(kind)) {
      throw new Error(`${where}: unknown kind "${String(kind)}"`);
    }
    kinds.push(kind);
  }
  const [firstKind, ...otherKinds] = kinds;
  if (!firstKind) throw new Error(`${where}: kinds is empty`);

  const assembly = requireString(raw, 'assembly');
  if (!isAssemblyAccession(assembly))
    throw new Error(`${where}: assembly must be a versioned accession`);

  const evidence = requireString(raw, 'evidence');
  if (!isEvidenceClass(evidence))
    throw new Error(`${where}: evidence must be curated, measured, or computed`);

  const licenseEvidence = isObject(raw.licenseEvidence) ? raw.licenseEvidence : {};
  const liftedFrom = raw.liftedFrom;
  if (liftedFrom !== null && liftedFrom !== undefined && typeof liftedFrom !== 'string') {
    throw new Error(`${where}: liftedFrom must be a string or null`);
  }
  const doi = raw.doi;
  if (doi !== null && doi !== undefined && typeof doi !== 'string') {
    throw new Error(`${where}: doi must be a string or null`);
  }

  return {
    id: sourceId(id),
    label: requireString(raw, 'label'),
    kinds: [firstKind, ...otherKinds],
    assembly: assemblyAccession(assembly),
    evidence,
    provenance: {
      citation: requireString(raw, 'citation'),
      url: requireString(raw, 'url'),
      doi: typeof doi === 'string' && doi.length > 0 ? doi : null,
      datasetVersion: requireString(raw, 'datasetVersion'),
      liftedFrom: typeof liftedFrom === 'string' && liftedFrom.length > 0 ? liftedFrom : null,
      license: {
        spdx: requireString(raw, 'license'),
        attribution: requireString(raw, 'attribution'),
        evidenceUrl: typeof licenseEvidence.url === 'string' ? licenseEvidence.url : null,
      },
    },
  };
}

function isEvidenceClass(value: string): value is AnnotationEvidenceClass {
  return value === 'curated' || value === 'measured' || value === 'computed';
}

function requireString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`source.json field "${key}" must be a non-empty string`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
