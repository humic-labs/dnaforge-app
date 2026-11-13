// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  ENTITY_ARTIFACT_SCHEMA,
  entityArtifactSourceMetadata,
  isEntityArtifactPath,
  parseEntityArtifact,
  serializeEntityArtifact,
  type EntityArtifactV1,
} from './entity-artifact';
import * as entityArtifact from './entity-artifact';

const artifact: EntityArtifactV1 = {
  schema: ENTITY_ARTIFACT_SCHEMA,
  id: 'entity-1',
  kind: 'strain',
  name: 'DH5alpha',
  fields: { genotypeCanonical: 'recA1' },
  registrationStatus: 'registered',
  domainStatus: null,
  relationships: [],
  source: {
    recordId: 'row-7',
    sourceName: 'strains.csv',
    sourceKind: 'csv',
    sourceRow: 7,
    values: { Source: 'freezer' },
  },
};

describe('generic Registry entity artifact', () => {
  it.each(['file_import', 'manual'])(
    'preserves unknown %s source, relationship, and top-level fields during parsing',
    (type) => {
      const extended = {
        ...artifact,
        reviewNote: { reviewer: 'historical-owner' },
        source:
          type === 'manual'
            ? { type: 'manual', values: {}, extension: { original: true } }
            : { ...artifact.source, extension: { original: true } },
        relationships: [
          {
            type: 'derives_from',
            fromEntityId: artifact.id,
            toEntityId: 'parent',
            payload: {},
            extension: ['preserve', 'verbatim'],
          },
        ],
      };
      expect(
        JSON.parse(serializeEntityArtifact(parseEntityArtifact(JSON.stringify(extended))))
      ).toEqual(extended);
    }
  );
  it('retains a portable frozen schema revision and archive state in v2', () => {
    const portable = {
      ...artifact,
      schema: 'waypoint.entity.v2',
      kind: 'enzyme',
      archived: true,
      schemaRevisionId: 'enzyme-schema-v1',
      schemaSnapshot: {
        schemaId: 'enzyme-schema',
        schemaRevisionId: 'enzyme-schema-v1',
        name: 'enzyme',
        displayName: 'Enzyme',
        baseKind: 'record',
        version: 1,
        fields: [{ key: 'lot', label: 'Lot', type: 'text', required: true }],
      },
    };
    expect(parseEntityArtifact(JSON.stringify(portable))).toEqual(portable);
    expect(() =>
      parseEntityArtifact(JSON.stringify({ ...portable, schemaRevisionId: 'other' }))
    ).toThrow(/revision/i);
  });
  it('round-trips the complete authoritative record', () => {
    expect(parseEntityArtifact(serializeEntityArtifact(artifact))).toEqual(artifact);
  });

  it('keeps the import row identity separate from the Registry entity id', () => {
    expect(entityArtifactSourceMetadata(artifact)).toMatchObject({
      importRecordId: 'row-7',
      row: { index: 7 },
      origin: { type: 'file_import', sourceName: 'strains.csv', sourceKind: 'csv' },
    });
  });

  it('round-trips honest manual provenance without pretending a CSV was imported', () => {
    const manual: EntityArtifactV1 = {
      ...artifact,
      source: { type: 'manual', values: {} },
    };

    expect(parseEntityArtifact(serializeEntityArtifact(manual))).toEqual(manual);
    expect(entityArtifactSourceMetadata(manual)).toEqual({
      schemaVersion: 1,
      origin: { type: 'manual' },
      values: {},
    });
  });

  it('claims only the canonical compound suffix and rejects malformed documents', () => {
    expect(isEntityArtifactPath('/ws/records/strain/DH5alpha.entity.json')).toBe(true);
    expect(isEntityArtifactPath('/ws/strains.csv')).toBe(false);
    expect(() => parseEntityArtifact('{"schema":"unknown"}')).toThrow(/Not a/);
  });

  it('does not export unused entityArtifactLinks', () => {
    expect(entityArtifact).not.toHaveProperty('entityArtifactLinks');
    expect(typeof entityArtifact.parseEntityArtifact).toBe('function');
    expect(typeof entityArtifact.entityArtifactSourceMetadata).toBe('function');
  });
});
