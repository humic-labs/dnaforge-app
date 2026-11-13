// @vitest-environment node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { AcceptedAssemblySidecarPayload } from '../features/assembly/accepted-types';
import { BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT } from '../shared/sequence-entity-schema';
import {
  SEQUENCE_PACKAGE_FORMAT_VERSION,
  DEFAULT_SEQUENCE_ENTITY_METADATA,
  SEQUENCE_PACKAGE_META_NAME,
  SEQUENCE_PACKAGE_SCHEMA,
  SequencePackageFormatError,
  buildSequencePackageDocument,
  isSequencePackageMemberRelativePath,
  isSequencePackageMetaPath,
  parseSequencePackageDocument,
  sequenceManagedMemberPath,
  sequencePackagePaths,
  sequenceProductExtensionForPath,
  resolveSequenceProductFile,
  serializeSequencePackageDocument,
  stripSequenceProductExtension,
  toPackageRelative,
  fromPackageRelative,
} from './sequence-package';

const DIR = dirname(fileURLToPath(import.meta.url));

const acceptedPayload = {
  type: 'accepted_assembly',
  schemaVersion: 1,
  acceptedAssemblyVersionId: 'accepted-v1',
  acceptedAt: '2026-07-24T00:00:00.000Z',
  designId: 'design-1',
  designName: 'pMyConstruct',
  construction: {
    method: 'gibson',
    topology: 'circular',
    canonicalDraftChecksum: 'sha256:draft-abc',
    regionCount: 2,
    spacerCount: 0,
  },
  projectionInput: { canonicalDraftChecksum: 'sha256:draft-abc', regions: [], spacers: [] },
  validationSnapshot: { projectionInputChecksum: 'sha256:draft-abc' },
  artifacts: { canonicalDraftChecksum: 'sha256:draft-abc' },
} as unknown as AcceptedAssemblySidecarPayload;

describe('plasmid-package', () => {
  it('keeps one product-extension contract for path parsing', () => {
    expect(sequenceProductExtensionForPath('/lab/chrIV.GBFF')).toBe('.gbff');
    expect(stripSequenceProductExtension('/lab/chrIV.GBFF')).toBe('/lab/chrIV');
    expect(sequenceProductExtensionForPath('/lab/notes.txt')).toBeNull();
    expect(stripSequenceProductExtension('/lab/notes.txt')).toBe('/lab/notes.txt');
  });

  describe('sequencePackagePaths', () => {
    it('derives every member location from the package root', () => {
      expect(sequencePackagePaths('/lab/pMyConstruct')).toEqual({
        root: '/lab/pMyConstruct',
        stem: 'pMyConstruct',
        metaDir: '/lab/pMyConstruct/.forge',
        metaPath: '/lab/pMyConstruct/.forge/plasmid.json',
        revisionJournalPath: '/lab/pMyConstruct/.forge/sequence-revision-publication.json',
        contentsDir: '/lab/pMyConstruct/contents',
        primersDir: '/lab/pMyConstruct/primers',
        assetsDir: '/lab/pMyConstruct/assets',
        productPath: '/lab/pMyConstruct/pMyConstruct.gb',
      });
    });

    it('honors a recorded product filename that differs from the folder stem', () => {
      expect(
        sequencePackagePaths('/lab/Renamed', { productFile: 'pMyConstruct.gb' }).productPath
      ).toBe('/lab/Renamed/pMyConstruct.gb');
    });

    it('preserves a non-default GenBank extension', () => {
      expect(sequencePackagePaths('/lab/p1', { productFile: 'p1.genbank' }).productPath).toBe(
        '/lab/p1/p1.genbank'
      );
    });

    it('refuses a recorded product path that escapes the package', () => {
      expect(() => sequencePackagePaths('/lab/p1', { productFile: '/etc/passwd' })).toThrow(
        /package-relative/i
      );
      expect(() => sequencePackagePaths('/lab/p1', { productFile: '../sibling.gb' })).toThrow(
        /package-relative/i
      );
    });

    it('refuses a nested or non-GenBank product filename', () => {
      expect(() => sequencePackagePaths('/lab/p1', { productFile: 'nested/p1.gb' })).toThrow(
        /single file name/i
      );
      expect(() => sequencePackagePaths('/lab/p1', { productFile: './p1.gb' })).toThrow(
        /single file name/i
      );
      expect(() => sequencePackagePaths('/lab/p1', { productFile: 'p1.txt' })).toThrow(/genbank/i);
    });

    it('exposes the meta filename as the single source of truth', () => {
      expect(SEQUENCE_PACKAGE_META_NAME).toBe('plasmid.json');
      expect(SEQUENCE_PACKAGE_SCHEMA).toBe('waypoint.sequence.v1');
    });
  });

  describe('resolveSequenceProductFile', () => {
    it('uses the recorded filename when it is present on disk', () => {
      expect(resolveSequenceProductFile('pMyConstruct.gb', ['pMyConstruct.gb', 'notes.txt'])).toBe(
        'pMyConstruct.gb'
      );
    });

    it('prefers the recorded filename even when other GenBank files sit alongside', () => {
      expect(resolveSequenceProductFile('pMyConstruct.gb', ['other.gb', 'pMyConstruct.gb'])).toBe(
        'pMyConstruct.gb'
      );
    });

    it('heals to the sole GenBank file when the recorded name is gone', () => {
      expect(resolveSequenceProductFile('pMyConstruct.gb', ['pRenamed.gb', 'notes.txt'])).toBe(
        'pRenamed.gb'
      );
    });

    it('heals when no filename was recorded at all', () => {
      expect(resolveSequenceProductFile(undefined, ['pUC19.gbk'])).toBe('pUC19.gbk');
    });

    it('FAILS CLOSED on two candidates — never guesses which plasmid is the product', () => {
      expect(() => resolveSequenceProductFile('gone.gb', ['a.gb', 'b.gb'])).toThrow(/ambiguous/i);
    });

    it('fails closed when there is no candidate at all', () => {
      expect(() => resolveSequenceProductFile('gone.gb', ['notes.txt'])).toThrow(/no product/i);
    });

    it('refuses a recorded name that is not a GenBank file, even when it exists', () => {
      expect(() => resolveSequenceProductFile('notes.txt', ['notes.txt', 'pUC19.gb'])).toThrow(
        /genbank/i
      );
    });

    it('ignores a directory that merely looks like a GenBank file', () => {
      expect(
        resolveSequenceProductFile(undefined, [
          { name: 'archive.gb', isFile: false },
          { name: 'pUC19.gb', isFile: true },
        ])
      ).toBe('pUC19.gb');
    });
  });

  describe('buildSequencePackageDocument', () => {
    it('builds a valid document with NO assembly block (an imported plasmid)', () => {
      const doc = buildSequencePackageDocument({
        id: 'plasmid-1',
        name: 'pUC19',
        product: { file: 'pUC19.gb', topology: 'circular' },
        updatedAt: '2026-07-24T00:00:00.000Z',
      });
      expect(doc.schema).toBe(SEQUENCE_PACKAGE_SCHEMA);
      expect(doc.kind).toBe('sequence');
      expect(doc.formatVersion).toBe(SEQUENCE_PACKAGE_FORMAT_VERSION);
      expect(doc.members).toEqual([]);
      expect(doc.assembly).toBeUndefined();
      expect('assembly' in doc).toBe(false);
      expect(doc.entity).toBeDefined();
      expect(doc.entity).toEqual(DEFAULT_SEQUENCE_ENTITY_METADATA);
    });

    it('embeds the accepted-assembly payload verbatim', () => {
      const doc = buildSequencePackageDocument({
        id: 'plasmid-2',
        name: 'pMyConstruct',
        product: { file: 'pMyConstruct.gb', topology: 'circular' },
        assembly: {
          primers: { csv: 'contents/pMyConstruct.primers.csv' },
          accepted: acceptedPayload,
        },
        updatedAt: '2026-07-24T00:00:00.000Z',
      });
      expect(doc.assembly?.accepted).toEqual(acceptedPayload);
    });

    it('preserves unknown top-level fields written by a future version', () => {
      const doc = buildSequencePackageDocument({
        id: 'p',
        name: 'p',
        product: { file: 'p.gb', topology: 'linear' },
        existing: { futureField: 'keep me' },
      });
      expect(doc.futureField).toBe('keep me');
    });

    it('round-trips an immutable custom schema snapshot and unknown field values', () => {
      const doc = buildSequencePackageDocument({
        id: 'custom-sequence-1',
        name: 'Custom sequence',
        product: { file: 'custom.gb', topology: 'linear' },
        entity: {
          schema: {
            schemaId: 'schema-custom-plasmid',
            schemaRevisionId: 'schema-custom-plasmid-v7',
            name: 'custom_plasmid',
            displayName: 'Custom plasmid',
            baseKind: 'sequence',
            version: 7,
            fields: [
              { key: 'host', label: 'Host', type: 'text', required: true },
              { key: 'futureField', label: 'Future field', type: 'future_type' },
            ],
          },
          fields: { host: 'E. coli', futureField: { nested: ['keep', 7] } },
          registrationStatus: 'registered',
          domainStatus: 'verified',
          registryId: 'dna000007',
          relationships: [
            {
              type: 'derived_from',
              fromEntityId: 'custom-sequence-1',
              toEntityId: 'template-1',
              payload: { source: 'Benchling' },
            },
          ],
          source: { connector: 'benchling', sourceId: 'bfi_123' },
        },
      });

      const parsed = parseSequencePackageDocument(serializeSequencePackageDocument(doc));
      expect(parsed.entity?.schema.schemaRevisionId).toBe('schema-custom-plasmid-v7');
      expect(parsed.entity).toEqual(doc.entity);
    });

    it.each([false, true])(
      'preserves a legacy v1 sequence schema with locus field present: %s',
      (hasLocus) => {
        const legacy = structuredClone(DEFAULT_SEQUENCE_ENTITY_METADATA);
        legacy.schema.schemaRevisionId = 'schema-entity-sequence-v1';
        legacy.schema.version = 1;
        if (hasLocus)
          legacy.schema.fields.unshift({
            key: 'locus',
            label: 'Locus',
            type: 'text',
            suggested: true,
          });
        const frozen = structuredClone(legacy.schema);
        legacy.fields = { locus: 'pBR322' };

        const doc = buildSequencePackageDocument({
          id: 'legacy-sequence',
          name: 'Legacy sequence',
          product: { file: 'legacy.gb', topology: 'circular' },
          entity: legacy,
        });

        expect(doc.entity.schema).toEqual(frozen);
        expect(doc.entity.fields.locus).toBe('pBR322');
      }
    );
  });

  describe('parseSequencePackageDocument', () => {
    it.each([7, 8])(
      'preserves canonical accepted records through format %i migration',
      (formatVersion) => {
        const accepted = {
          schemaVersion: 2,
          operationChecksum: 'sha256:original-operation',
          molecularStateChecksum: 'sha256:original-state',
          operation: {
            id: 'immutable-accepted-id',
            document: {
              id: 'original-document',
              recipes: [
                {
                  operation: {
                    id: 'future.mechanism',
                    version: 12,
                    parameters: { future: [null, { keep: true }] },
                  },
                },
              ],
            },
          },
          outputBinding: { constructId: 'package', eventId: 'event', outputId: 'product' },
        };
        const current = buildSequencePackageDocument({
          id: 'package',
          name: 'Historical canonical operation',
          product: { file: 'product.gb' },
          assembly: { accepted, history: [accepted] },
        });
        const historical: Record<string, unknown> = { ...current, formatVersion };
        if (formatVersion === 7) delete historical.versionHistory;
        const parsed = parseSequencePackageDocument(JSON.stringify(historical));
        expect(parsed.assembly).toEqual(historical.assembly);
        expect(parsed.versionHistory).toEqual(current.versionHistory);
        expect(parsed.userAttachments).toEqual(current.userAttachments);
        expect(parseSequencePackageDocument(serializeSequencePackageDocument(parsed))).toEqual(
          parsed
        );
      }
    );

    it.each([
      ['schema-entity-sequence-v2', 2, false],
      ['schema-entity-sequence-v2', 2, true],
      ['schema-entity-sequence-builtin-locus-v2', 2, true],
      ['schema-entity-sequence-v3', 3, false],
      ['schema-entity-sequence-builtin-description-v3', 3, false],
    ] as const)(
      'preserves historical revision %s version %s (Locus: %s) exactly',
      (id, version, hasLocus) => {
        const entity = structuredClone(DEFAULT_SEQUENCE_ENTITY_METADATA);
        entity.schema.schemaRevisionId = id;
        entity.schema.version = version;
        if (hasLocus)
          entity.schema.fields.unshift({
            key: 'locus',
            label: 'Locus',
            type: 'text',
            suggested: true,
          });
        entity.fields = { locus: 'pBR322', description: 'Retained source value' };
        const packageDocument = buildSequencePackageDocument({
          id: 'historical-schema',
          name: 'Historical schema',
          product: { file: 'source.gb' },
          entity,
        });
        expect(
          parseSequencePackageDocument(serializeSequencePackageDocument(packageDocument)).entity
        ).toEqual(entity);
      }
    );

    it('preserves each historical schema snapshot without inventing fields', () => {
      const legacy = buildSequencePackageDocument({
        id: 'legacy-sequence',
        name: 'Legacy sequence',
        product: { file: 'legacy.gb', topology: 'linear' },
      });
      legacy.entity.schema.schemaRevisionId = 'schema-entity-sequence-v1';
      legacy.entity.schema.version = 1;

      const parsedLegacy = parseSequencePackageDocument(JSON.stringify(legacy));
      expect(parsedLegacy.entity.schema.fields.map((field) => field.key)).toEqual(['description']);

      const legacyWithLocus = structuredClone(legacy);
      legacyWithLocus.entity.schema.fields.unshift({
        key: 'locus',
        label: 'Locus',
        type: 'text',
        suggested: true,
      });
      expect(
        parseSequencePackageDocument(JSON.stringify(legacyWithLocus)).entity.schema.fields.map(
          (field) => field.key
        )
      ).toEqual(['locus', 'description']);

      const current = buildSequencePackageDocument({
        id: 'current-sequence',
        name: 'Current sequence',
        product: { file: 'current.gb', topology: 'linear' },
      });
      expect(current.entity.schema.schemaRevisionId).toBe(
        BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT.schemaRevisionId
      );
      expect(
        parseSequencePackageDocument(JSON.stringify(current)).entity.schema.fields.map(
          (field) => field.key
        )
      ).toEqual(['description']);
    });

    it('round-trips a package with a build record, byte-identically', () => {
      const doc = buildSequencePackageDocument({
        id: 'plasmid-2',
        name: 'pMyConstruct',
        product: {
          file: 'pMyConstruct.gb',
          topology: 'circular',
          sequenceChecksum: 'sha256:seq',
        },
        assembly: { accepted: acceptedPayload },
        updatedAt: '2026-07-24T00:00:00.000Z',
      });
      const parsed = parseSequencePackageDocument(serializeSequencePackageDocument(doc));
      expect(parsed).toEqual(doc);

      expect(parsed.assembly?.accepted).toEqual(acceptedPayload);
    });

    it('round-trips a package with no build record', () => {
      const doc = buildSequencePackageDocument({
        id: 'plasmid-1',
        name: 'pUC19',
        product: { file: 'pUC19.gb', topology: 'circular' },
        updatedAt: '2026-07-24T00:00:00.000Z',
      });
      const parsed = parseSequencePackageDocument(serializeSequencePackageDocument(doc));
      expect(parsed.assembly).toBeUndefined();
    });

    it('rejects a foreign schema, so a notebook.json can never be read as a plasmid', () => {
      expect(() =>
        parseSequencePackageDocument(
          JSON.stringify({ schema: 'waypoint.notebook.v1', kind: 'notebook', id: 'x' })
        )
      ).toThrow(/waypoint\.sequence\.v1/);
    });

    it('rejects malformed JSON, a non-object, a missing id, and a missing product', () => {
      expect(() => parseSequencePackageDocument('{ not json')).toThrow(/invalid/i);
      expect(() => parseSequencePackageDocument('[]')).toThrow(/object/i);
      expect(() =>
        parseSequencePackageDocument(
          JSON.stringify({
            schema: SEQUENCE_PACKAGE_SCHEMA,
            kind: 'plasmid',
            product: { file: 'a.gb' },
          })
        )
      ).toThrow(/id/i);
      expect(() =>
        parseSequencePackageDocument(
          JSON.stringify({ schema: SEQUENCE_PACKAGE_SCHEMA, kind: 'plasmid', id: 'x' })
        )
      ).toThrow(/product/i);
    });

    it.each(['id', 'path'] as const)(
      'rejects duplicate normalized member %s on read, build, and serialize',
      (duplicate) => {
        const document = buildSequencePackageDocument({
          id: 'sequence-stable-id',
          name: 'Sequence',
          product: { file: 'sequence.gb' },
          members: [
            {
              id: 'attachment-1',
              role: 'data',
              path: 'contents/first.csv',
              replaceable: false,
              createdAt: '2026-10-05T00:00:00.000Z',
            },
          ],
        });
        const members = [
          document.members[0]!,
          {
            ...document.members[0]!,
            id: duplicate === 'id' ? ' attachment-1 ' : 'attachment-2',
            path: duplicate === 'path' ? 'contents\\first.csv' : 'contents/second.csv',
          },
        ];
        const invalid = { ...document, members };
        expect(() => parseSequencePackageDocument(JSON.stringify(invalid))).toThrow(/duplicate/i);
        expect(() => serializeSequencePackageDocument(invalid)).toThrow(/duplicate/i);
        expect(() =>
          buildSequencePackageDocument({
            id: document.id,
            name: document.name,
            product: document.product,
            members,
          })
        ).toThrow(/duplicate/i);
      }
    );

    it('rejects an absolute product path stored in the record', () => {
      expect(() =>
        parseSequencePackageDocument(
          JSON.stringify({
            schema: SEQUENCE_PACKAGE_SCHEMA,
            kind: 'plasmid',
            id: 'x',
            name: 'x',
            product: { file: '/abs/x.gb', topology: 'circular' },
          })
        )
      ).toThrow(/package-relative/i);
    });

    it('migrates a checked-in v1 fixture to the current format', () => {
      const raw = readFileSync(
        join(DIR, '__fixtures__/sequence-packages/v1-imported/.forge/plasmid.json'),
        'utf8'
      );
      expect(JSON.parse(raw).formatVersion).toBeUndefined();
      const doc = parseSequencePackageDocument(raw);
      expect(doc.formatVersion).toBe(SEQUENCE_PACKAGE_FORMAT_VERSION);
      expect(doc.members).toEqual([]);
      expect(doc.product.file).toBe('pUC19.gb');
    });

    it('migrates a checked-in v2 finalized package: primers join contents/', () => {
      const raw = readFileSync(
        join(DIR, '__fixtures__/sequence-packages/v2-finalized/.forge/plasmid.json'),
        'utf8'
      );
      expect(JSON.parse(raw).formatVersion).toBe(2);
      expect(JSON.parse(raw).assembly.primers.csv).toBe('primers/pMyConstruct.primers.csv');
      const doc = parseSequencePackageDocument(raw);
      expect(doc.formatVersion).toBe(SEQUENCE_PACKAGE_FORMAT_VERSION);
      expect(doc.assembly?.primers).toBeUndefined();
      expect(doc.members.filter((member) => member.role === 'primer-export')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'contents/pMyConstruct.primers.csv',
            replaceable: true,
          }),
          expect.objectContaining({
            path: 'contents/pMyConstruct.primers.fasta',
            replaceable: true,
          }),
        ])
      );
    });

    it('migrates a checked-in v4 package to the builtin DNA sequence schema', () => {
      const raw = readFileSync(
        join(DIR, '__fixtures__/sequence-packages/v4-basic/.forge/plasmid.json'),
        'utf8'
      );
      expect(JSON.parse(raw).formatVersion).toBe(4);
      const doc = parseSequencePackageDocument(raw);
      expect(doc.formatVersion).toBe(SEQUENCE_PACKAGE_FORMAT_VERSION);
      expect(doc.entity).toBeDefined();
      expect(doc.entity).toEqual(DEFAULT_SEQUENCE_ENTITY_METADATA);
    });

    it('rejects malformed schema-bound entity metadata', () => {
      const doc = buildSequencePackageDocument({
        id: 'x',
        name: 'x',
        product: { file: 'x.gb' },
      });
      expect(doc.entity).toBeDefined();
      expect(() =>
        parseSequencePackageDocument(
          JSON.stringify({
            ...doc,
            entity: {
              ...doc.entity,
              schema: { ...doc.entity.schema, schemaRevisionId: '' },
            },
          })
        )
      ).toThrow(/schemaRevisionId/i);
    });

    it('refuses a newer formatVersion instead of guessing', () => {
      expect(() =>
        parseSequencePackageDocument(
          JSON.stringify({
            schema: SEQUENCE_PACKAGE_SCHEMA,
            kind: 'plasmid',
            formatVersion: 99,
            id: 'x',
            name: 'x',
            product: { file: 'x.gb' },
          })
        )
      ).toThrow(SequencePackageFormatError);
      try {
        parseSequencePackageDocument(
          JSON.stringify({
            schema: SEQUENCE_PACKAGE_SCHEMA,
            kind: 'plasmid',
            formatVersion: 99,
            id: 'x',
            name: 'x',
            product: { file: 'x.gb' },
          })
        );
      } catch (err) {
        expect(err).toBeInstanceOf(SequencePackageFormatError);
        expect((err as SequencePackageFormatError).code).toBe('SEQUENCE_PACKAGE_NEWER_FORMAT');
      }
    });

    it('preserves an unknown member role through parse and serialize', () => {
      const parsed = parseSequencePackageDocument(
        JSON.stringify({
          schema: SEQUENCE_PACKAGE_SCHEMA,
          kind: 'plasmid',
          formatVersion: 2,
          id: 'x',
          name: 'x',
          product: { file: 'x.gb' },
          members: [
            {
              id: 'm1',
              role: 'future-kind',
              path: 'contents/odd.bin',
              replaceable: false,
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        })
      );
      expect(parsed.members[0]?.role).toBe('future-kind');
      const again = parseSequencePackageDocument(serializeSequencePackageDocument(parsed));
      expect(again.members[0]?.role).toBe('future-kind');
    });

    it.each([
      {
        label: 'valid',
        mediaType: 'application/octet-stream',
        expectedMediaType: { mediaType: 'application/octet-stream' },
      },
      { label: 'invalid', mediaType: 42, expectedMediaType: {} },
    ])(
      'retains optional member metadata through parse and serialize with $label mediaType',
      ({ mediaType, expectedMediaType }) => {
        const extensions = {
          'org.example.trace-annotation': {
            version: 2,
            data: { sample: { name: 'clone-7' }, labels: ['reviewed', null], accepted: true },
          },
        };
        const stored = {
          ...buildSequencePackageDocument({
            id: 'member-metadata-package',
            name: 'Member metadata',
            product: { file: 'metadata.gb' },
          }),
          members: [
            {
              id: ' trace-7 ',
              role: ' future-kind ',
              path: 'files/trace.bin',
              replaceable: 'true',
              createdAt: '2026-01-01T00:00:00.000Z',
              mediaType,
              extensions,
            },
          ],
        };
        const expected = {
          id: 'trace-7',
          role: 'future-kind',
          path: 'contents/trace.bin',
          replaceable: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          ...expectedMediaType,
          extensions,
        };

        const parsed = parseSequencePackageDocument(JSON.stringify(stored));
        expect(parsed.members).toEqual([expected]);
        const reopened = parseSequencePackageDocument(serializeSequencePackageDocument(parsed));
        expect(reopened.members).toEqual([expected]);
      }
    );

    it('refuses to serialize a stale formatVersion — parse/build are the only writers', () => {
      const doc = buildSequencePackageDocument({
        id: 'x',
        name: 'x',
        product: { file: 'x.gb' },
      });
      expect(() =>
        serializeSequencePackageDocument({ ...doc, formatVersion: 1 } as typeof doc)
      ).toThrow(/current-format/i);
    });

    it('rewrites an unreleased files/ member path to contents/', () => {
      const parsed = parseSequencePackageDocument(
        JSON.stringify({
          schema: SEQUENCE_PACKAGE_SCHEMA,
          kind: 'sequence',
          formatVersion: 2,
          id: 'x',
          name: 'x',
          product: { file: 'x.gb' },
          members: [
            {
              id: 'm1',
              role: 'sequencing-read',
              path: 'files/clone-1.fasta',
              replaceable: false,
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        })
      );
      expect(parsed.members[0]?.path).toBe('contents/clone-1.fasta');
    });

    it('derives managed member paths from the contract, not a caller folder', () => {
      expect(sequenceManagedMemberPath('clone-1.fasta')).toBe('contents/clone-1.fasta');
      expect(sequenceManagedMemberPath('/tmp/nested/clone-1.fasta')).toBe('contents/clone-1.fasta');
      expect(() => sequenceManagedMemberPath('..')).toThrow(/single file name/i);
    });

    it('rejects marker-recorded primer paths that are not exact generated files', () => {
      const base = {
        schema: SEQUENCE_PACKAGE_SCHEMA,
        kind: 'plasmid',
        id: 'x',
        name: 'x',
        product: { file: 'x.gb' },
        assembly: { accepted: {}, primers: {} },
      };
      expect(() =>
        parseSequencePackageDocument(
          JSON.stringify({
            ...base,
            assembly: { accepted: {}, primers: { csv: 'assets' } },
          })
        )
      ).toThrow(/exact generated primer file/i);
      expect(() =>
        parseSequencePackageDocument(
          JSON.stringify({
            ...base,
            assembly: { accepted: {}, primers: { fasta: 'primers/x.primers.csv' } },
          })
        )
      ).toThrow(/exact generated primer file/i);
    });
  });

  describe('path predicates', () => {
    it('detects the meta path and never aliases the notebook kind', () => {
      expect(isSequencePackageMetaPath('/lab/pUC19/.forge/plasmid.json')).toBe(true);
      expect(isSequencePackageMetaPath('/lab/Lab notes/.forge/notebook.json')).toBe(false);
    });

    it('detects members for sync/share allowlisting', () => {
      expect(isSequencePackageMemberRelativePath('pUC19/.forge/plasmid.json')).toBe(true);
      expect(isSequencePackageMemberRelativePath('pUC19/pUC19.gb')).toBe(true);
      expect(isSequencePackageMemberRelativePath('pUC19/primers/pUC19.primers.csv')).toBe(true);
      expect(isSequencePackageMemberRelativePath('pUC19/primers/pUC19.primers.fasta')).toBe(true);
      expect(isSequencePackageMemberRelativePath('pUC19/contents/clone-1.fasta')).toBe(true);
      expect(isSequencePackageMemberRelativePath('loose.gb')).toBe(false);
      expect(isSequencePackageMemberRelativePath('some-dir/unrelated.gb')).toBe(false);
    });
  });
});

describe('package-relative path conversion', () => {
  const root = '/lab/pMyConstruct';

  it('relativizes a member path against the package root', () => {
    expect(toPackageRelative(`${root}/pMyConstruct.gb`, root)).toBe('pMyConstruct.gb');
    expect(toPackageRelative(`${root}/primers/p.primers.csv`, root)).toBe('primers/p.primers.csv');
    expect(toPackageRelative(`${root}/.forge/plasmid.json`, root)).toBe('.forge/plasmid.json');
  });

  it('round-trips back to the same absolute path', () => {
    const absolute = `${root}/primers/p.primers.fasta`;
    expect(fromPackageRelative(toPackageRelative(absolute, root), root)).toBe(absolute);
  });

  it('resolves against a MOVED root — this is what survives the move', () => {
    const relative = toPackageRelative(`${root}/pMyConstruct.gb`, root);
    expect(fromPackageRelative(relative, '/somewhere/else/Renamed')).toBe(
      '/somewhere/else/Renamed/pMyConstruct.gb'
    );
  });

  it('tolerates a trailing slash on the root and windows separators', () => {
    expect(toPackageRelative(`${root}/a.gb`, `${root}/`)).toBe('a.gb');
    expect(toPackageRelative('C:\\lab\\pkg\\a.gb', 'C:\\lab\\pkg')).toBe('a.gb');
  });

  it('refuses a path that is not inside the package', () => {
    expect(() => toPackageRelative('/elsewhere/a.gb', root)).toThrow(/inside the package/i);

    expect(() => toPackageRelative('/lab/pMyConstruct-old/a.gb', root)).toThrow(
      /inside the package/i
    );
  });

  it('refuses to resolve a relative path that escapes the package', () => {
    expect(() => fromPackageRelative('../outside.gb', root)).toThrow(/package-relative/i);
    expect(() => fromPackageRelative('/abs.gb', root)).toThrow(/package-relative/i);
  });
});
