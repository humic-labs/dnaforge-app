import {
  parseWorkTaskDocument,
  sequenceFileCodecs,
  type ScientificFileCodec,
} from '@waypoint/scientific-objects';
import type { CanonicalMap, CanonicalValue } from '@waypoint/workspace-revisions';
import { parsePrimerArtifact } from './shared/primers/primer-artifact';
import { parseEntityArtifact } from './shared/entity-artifact';
import {
  validateNativePrimerReferences,
  validateNativeStrainReferences,
  parseNativeStrainRelationships,
} from './native-references';
import {
  nativeRecord as record,
  parseNativeJson as nativeJson,
  withoutNativeKeys as except,
} from './native-json';
function embeddedIdentity(text: string): string {
  const id = nativeJson(text).id;
  if (typeof id !== 'string') throw new TypeError('Native scientific identity is missing.');
  return id;
}

export const scientificNativeCodecs: readonly ScientificFileCodec[] = Object.freeze([
  ...sequenceFileCodecs,
  Object.freeze({
    format: 'work-task-v1',
    mediaType: 'application/vnd.dnaforge.work-task+json',
    resourceIdentity: embeddedIdentity,
    decode: (text: string) => parseWorkTaskDocument(except(nativeJson(text), ['id'])),
  } satisfies ScientificFileCodec),
  Object.freeze({
    format: 'primer-v2',
    mediaType: 'application/vnd.dnaforge.primer+json',
    resourceIdentity: embeddedIdentity,
    validateReferences: validateNativePrimerReferences,
    decode: (text: string) => {
      const raw = nativeJson(text);
      const primer = parsePrimerArtifact(text);
      const oligo = raw.oligo === undefined ? {} : record(raw.oligo);
      const computed = record(raw.computed);
      const metadata = record(raw.metadata);
      return {
        formatVersion: 1,
        kind: 'primer',
        name: primer.name,
        molecule: primer.oligo?.orderType === 'rna' ? 'RNA' : 'DNA',
        bases: primer.sequence.bases,
        modifications: (primer.oligo?.modifications ?? []).map((modification) => ({
          code: modification.chemistryId,
          anchor: modification.anchor,
          details: except(record(modification), ['chemistryId', 'anchor']),
        })),
        fields: {
          catalogNumber: primer.catalogNumber,
          registry: { kind: primer.registry.kind, use: primer.registry.use },
          computed,
          metadata: except(metadata, ['createdAt', 'updatedAt', 'actor']),
          ...(raw.entity === undefined ? {} : { entity: raw.entity }),
          ...(raw.designProvenance === undefined ? {} : { designProvenance: raw.designProvenance }),
          oligoOrder: {
            vendor: primer.oligo?.vendor ?? null,
            orderType: primer.oligo?.orderType ?? 'dna',
            notation: primer.oligo?.notation ?? null,
          },
          nativeExtras: {
            record: except(raw, [
              'schema',
              'schemaVersion',
              'artifactRevision',
              'id',
              'name',
              'catalogNumber',
              'sequence',
              'oligo',
              'computed',
              'metadata',
              'registry',
              'entity',
              'file',
              'bindings',
              'designProvenance',
            ]),
            sequence: except(record(raw.sequence), ['bases', 'topology', 'length', 'contentHash']),
            oligo: except(oligo, ['vendor', 'orderType', 'notation', 'modifications']),
            computed: except(computed, ['tmC', 'gcPercent', 'tmCalculation']),
            metadata: except(metadata, [
              'createdAt',
              'updatedAt',
              'actor',
              'source',
              'application',
              'notes',
            ]),
            registry: except(record(raw.registry), ['required', 'entityId', 'kind', 'use']),
            file: except(record(raw.file), ['workspaceRelativePath']),
          },
        },
      };
    },
    bindingFields: (document): CanonicalMap => {
      if (document.kind !== 'primer') throw new TypeError('Expected a native primer.');

      return except(document.fields, [
        'catalogNumber',
        'registry',
        'computed',
        'metadata',
        'oligoOrder',
        'designProvenance',
      ]);
    },
  } satisfies ScientificFileCodec),
  Object.freeze({
    format: 'strain-entity-v1',
    mediaType: 'application/vnd.waypoint.entity+json',
    resourceIdentity: embeddedIdentity,
    validateReferences: validateNativeStrainReferences,
    decode: (text: string) => {
      const raw = nativeJson(text);
      const strain = parseEntityArtifact(text);
      if (strain.kind !== 'strain')
        throw new TypeError('Native scientific strain requires a strain record.');
      parseNativeStrainRelationships(text);
      const species = strain.fields.species;
      return {
        formatVersion: 1,
        kind: 'strain',
        name: strain.name,
        taxon: typeof species === 'string' && species.trim() ? species : null,
        fields: {
          values: raw.fields,
          source: raw.source,
          registrationStatus: strain.registrationStatus,
          domainStatus: strain.domainStatus,
          nativeExtras: except(raw, [
            'schema',
            'id',
            'kind',
            'name',
            'fields',
            'source',
            'registrationStatus',
            'domainStatus',
            'relationships',
          ]),
        } satisfies Record<string, CanonicalValue>,
      };
    },
  } satisfies ScientificFileCodec),
]);
