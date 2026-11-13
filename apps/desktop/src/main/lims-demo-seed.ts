import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative } from 'path';
import { app } from 'electron';
import {
  parseGenBankFull,
  reverseComplement as sharedReverseComplement,
  searchNucleotide,
  serializeGenBank,
} from '@waypoint/sequence-utils';
import {
  limsEntityFromRow,
  limsLinkFromRow,
  type DnaSequenceRef,
  type LimsEntity,
  type LimsEntityRow,
  type LimsLink,
  type LimsLinkEntitiesInput,
  type LimsLinkRow,
  type LimsRegisterEntityInput,
  type LimsSeedDemoDatasetAssetSource,
  type LimsSeedDemoDatasetInput,
  type LimsSeedDemoDatasetResult,
  type LimsSeedMockDemoInput,
  type LimsSeedMockDemoResult,
  type LimsSeedPracticeDemoInput,
  type LimsSeedPracticeDemoResult,
  type LimsSeedStarterRegistryInput,
  type LimsSeedStarterRegistryResult,
} from '../shared/lims';
import { DEV_LIMS_SEED_ID_PREFIXES } from '../shared/lims-dev-seed';
import {
  LOCAL_ACTOR,
  clearDevSeededLimsRegistryInsideTx,
  clearLimsRegistryInsideTx,
  insertAuditEvent,
  linkLimsEntitiesOrExistingInsideTx,
  nextEventSeq,
  replaceTombstonedSeedLimsEntityInsideTx,
  registerLimsEntityInsideTx,
  updateLimsEntityInsideTx,
  seedLimsBuiltinsInDb,
  upsertLimsLinkProjectionInsideTx,
} from './lims-engine-core';
import {
  buildFileSequenceRef,
  deleteRange,
  replaceBase,
  sanitizePathStem,
  sha256,
} from './lims-sequence-io';
import { buildPracticePlasmids } from './lims-practice-plasmids';
import { getLimsStrainGenomeSummaryInsideTx } from './lims-strain-genome';
import { currentLimsScenarioSeedContext } from './lims-scenario-context';
import { isPathInsideBoundary } from '../shared/path-boundary';

export const LIMS_DEMO_BATCH_PREFIX = 'dna509-lims-demo';

export const LIMS_DEMO_IDS = {
  organism: 'demo-dna509-organism-ecoli-mg1655',
  parentGenome: 'demo-dna509-genome-mg1655-region',
  suppliedHypothesisGenome: 'demo-dna509-genome-supplied-hypothesis',
  verifiedWgsGenome: 'demo-dna509-genome-wgs',
  strain: 'demo-dna509-strain-argf',
  pUc19: 'demo-dna509-plasmid-puc19',
} as const;

export type SeededLimsEntityResult = {
  entity: LimsEntity;
  inserted: boolean;
};

export type SeededLimsLinkResult = {
  link: LimsLink;
  inserted: boolean;
};

export function seedLimsDemoDatasetInDb(
  db: Database.Database,
  input: LimsSeedDemoDatasetInput = {}
): LimsSeedDemoDatasetResult {
  seedLimsBuiltinsInDb(db);
  const actor = input.actor ?? LOCAL_ACTOR;
  const batchId = `${LIMS_DEMO_BATCH_PREFIX}-${Date.now()}`;
  const outputDir =
    input.outputDir ?? join(app.getPath('userData'), 'lims', 'demo-datasets', 'dna509');
  mkdirSync(outputDir, { recursive: true });

  const parentFixturePath = findFixturePath(
    'test-fixtures/sequences/linear/ecoli-mg1655-region.gb'
  );
  const pUc19FixturePath = findFixturePath('test-fixtures/sequences/circular/pUC19.gb');

  const assetSources: LimsSeedDemoDatasetAssetSource[] = [
    { role: 'parent genome', path: parentFixturePath, used: true },
    { role: 'plasmid', path: pUc19FixturePath, used: true },
    { role: 'primer table', path: 'designed-from-public-genomes', used: true },
  ];

  const parentContent = readFileSync(parentFixturePath, 'utf8');
  const parentSequence = parseGenBankFull(parentContent);
  const pUc19Content = readFileSync(pUc19FixturePath, 'utf8');
  const pUc19Sequence = parseGenBankFull(pUc19Content);
  const suppliedHypothesisPath = join(outputDir, 'dna509-supplied-genome-hypothesis.gb');
  const verifiedWgsPath = join(outputDir, 'dna509-verified-wgs.gb');
  const suppliedHypothesisSequence = {
    ...parentSequence,
    id: 'dna509-supplied-hypothesis',
    name: 'Demo supplied genome hypothesis',
    sequence: deleteRange(parentSequence.sequence, 5320, 6324),
    annotations: [],
    description: 'Supplied genome hypothesis fixture with argF deleted from the MG1655 region.',
  };
  const suppliedHypothesisContent = serializeGenBank({
    ...suppliedHypothesisSequence,
    length: suppliedHypothesisSequence.sequence.length,
  });
  const verifiedWgsSequence = {
    ...suppliedHypothesisSequence,
    id: 'dna509-verified-wgs',
    name: 'Demo verified WGS',
    sequence: replaceBase(suppliedHypothesisSequence.sequence, 10, 'A'),
    description: 'WGS fixture with one deliberate mismatch against the supplied hypothesis.',
  };
  const verifiedWgsContent = serializeGenBank({
    ...verifiedWgsSequence,
    length: verifiedWgsSequence.sequence.length,
  });
  const primerRows = buildDemoPrimerRows();

  const createdHypothesisFile = !existsSync(suppliedHypothesisPath);
  const createdVerifiedFile = !existsSync(verifiedWgsPath);
  writeFileSync(suppliedHypothesisPath, suppliedHypothesisContent, 'utf8');
  writeFileSync(verifiedWgsPath, verifiedWgsContent, 'utf8');

  const runSeed = db.transaction(() => {
    if (input.reset) clearLimsRegistryInsideTx(db);
    const insertedEntities: SeededLimsEntityResult[] = [];
    const insertedLinks: SeededLimsLinkResult[] = [];
    const ensureEntity = (request: LimsRegisterEntityInput): LimsEntity => {
      const result = ensureSeedLimsEntityInsideTx(db, {
        ...request,
        actor,
        batchId,
      });
      insertedEntities.push(result);
      return result.entity;
    };
    const ensureLink = (request: LimsLinkEntitiesInput): LimsLink => {
      const result = ensureSeedLimsLinkInsideTx(db, {
        ...request,
        actor,
        batchId,
      });
      insertedLinks.push(result);
      return result.link;
    };

    const organism = ensureEntity({
      id: LIMS_DEMO_IDS.organism,
      kind: 'organism',
      name: 'Escherichia coli K-12 MG1655',
      fields: {
        taxid: '511145',
        scientificName: 'Escherichia coli str. K-12 substr. MG1655',
        rank: 'strain',
        commonName: 'E. coli K-12 MG1655',
      },
      registrationStatus: 'registered',
    });
    const parentGenome = ensureEntity({
      id: LIMS_DEMO_IDS.parentGenome,
      kind: 'genome',
      name: 'MG1655 parent region',
      fields: {
        sequence: buildFileSequenceRef(parentFixturePath, parentContent, {
          documentId: LIMS_DEMO_IDS.parentGenome,
          length: parentSequence.length,
          topology: parentSequence.circular ? 'circular' : 'linear',
          sourceFormat: 'gb',
        }),
        source: 'reference',
        assemblyLevel: 'contig',
        accessions: ['U00096.3'],
        notes: 'MG1655 region fixture from test-fixtures/sequences/linear.',
      },
      registrationStatus: 'registered',
    });
    const suppliedHypothesisGenome = ensureEntity({
      id: LIMS_DEMO_IDS.suppliedHypothesisGenome,
      kind: 'genome',
      name: 'Demo supplied genome hypothesis',
      fields: {
        sequence: buildFileSequenceRef(suppliedHypothesisPath, suppliedHypothesisContent, {
          documentId: LIMS_DEMO_IDS.suppliedHypothesisGenome,
          length: suppliedHypothesisSequence.sequence.length,
          topology: 'linear',
          sourceFormat: 'gb',
        }),
        source: 'other',
        assemblyLevel: 'contig',
        notes: 'Supplied hypothesis fixture; not a full reconstructed genome claim.',
      },
      registrationStatus: 'registered',
    });
    const verifiedWgsGenome = ensureEntity({
      id: LIMS_DEMO_IDS.verifiedWgsGenome,
      kind: 'genome',
      name: 'Demo verified WGS',
      fields: {
        sequence: buildFileSequenceRef(verifiedWgsPath, verifiedWgsContent, {
          documentId: LIMS_DEMO_IDS.verifiedWgsGenome,
          length: verifiedWgsSequence.sequence.length,
          topology: 'linear',
          sourceFormat: 'gb',
        }),
        source: 'WGS',
        assemblyLevel: 'contig',
        notes: 'WGS fixture intentionally differs from the supplied hypothesis at one base.',
      },
      registrationStatus: 'registered',
    });
    const strain = ensureEntity({
      id: LIMS_DEMO_IDS.strain,
      kind: 'strain',
      name: 'Demo argF deletion strain',
      fields: {
        genotypeCanonical: 'argFΔ; g.1414A>T',
        markers: ['argF deletion'],
        source: 'Demo demo dataset',
        notes: 'Seed strain for LIMS Phase B evidence flow.',
      },
      registrationStatus: 'registered',
    });
    const pUc19 = ensureEntity({
      id: LIMS_DEMO_IDS.pUc19,
      kind: 'plasmid',
      name: 'pUC19',
      fields: {
        sequence: buildFileSequenceRef(pUc19FixturePath, pUc19Content, {
          documentId: LIMS_DEMO_IDS.pUc19,
          length: pUc19Sequence.length,
          topology: 'circular',
          sourceFormat: 'gb',
        }),
        markers: ['AmpR'],
        ori: 'pMB1',
        type: 'cloning vector',
        notes: 'pUC19 sequence fixture.',
      },
      registrationStatus: 'registered',
    });
    const primers = primerRows.map((primer, index) =>
      ensureEntity({
        id: `demo-dna509-oligo-${sanitizePathStem(primer.name).toLowerCase() || `primer-${index + 1}`}`,
        kind: 'oligo',
        name: primer.name,
        fields: {
          sequence: {
            mode: 'inline',
            bases: primer.sequence,
            topology: 'linear',
            length: primer.sequence.length,
            contentHash: sha256(primer.sequence),
          },
          use: 'primer',
          notes: primer.description,
        },
        registrationStatus: 'registered',
      })
    );

    ensureLink({
      fromEntityId: strain.id,
      toEntityId: organism.id,
      type: 'references',
      payload: { role: 'organism' },
    });
    ensureLink({
      fromEntityId: strain.id,
      toEntityId: parentGenome.id,
      type: 'references',
      payload: {
        role: 'parent_genome',
        confidence: 'genotype_parent_reference',
        genotype: 'argFΔ; g.1414A>T',
      },
    });
    ensureLink({
      fromEntityId: strain.id,
      toEntityId: suppliedHypothesisGenome.id,
      type: 'has_genome',
      payload: {
        confidence: 'hypothesis_supplied',
        method: 'supplied_genome_hypothesis',
      },
    });
    ensureLink({
      fromEntityId: suppliedHypothesisGenome.id,
      toEntityId: parentGenome.id,
      type: 'derives_from',
      payload: {
        method: 'supplied_genome_hypothesis',
        genotype: 'argFΔ; g.1414A>T',
      },
    });
    ensureLink({
      fromEntityId: strain.id,
      toEntityId: verifiedWgsGenome.id,
      type: 'has_genome',
      payload: {
        confidence: 'WGS_verified',
        method: 'WGS',
        coverage: 94,
      },
    });
    ensureLink({
      fromEntityId: suppliedHypothesisGenome.id,
      toEntityId: verifiedWgsGenome.id,
      type: 'verified_by',
      payload: {
        method: 'WGS',
        coverage: 94,
      },
    });
    tombstoneDemoPrimerTargetLinksInsideTx(db, {
      primerIds: primers.slice(0, 2).map((primer) => primer.id),
      targetEntityId: pUc19.id,
      actor,
      batchId,
    });
    for (const primer of primers.slice(0, 2)) {
      ensureLink({
        fromEntityId: primer.id,
        toEntityId: pUc19.id,
        type: 'associated_with',
        payload: {
          role: 'intended_target',
          orientation: primer.name.toLowerCase().includes('reverse') ? 'reverse' : 'forward',
          sourceColumn: 'Target',
        },
      });
    }

    insertAuditEvent(db, {
      eventType: 'demo_dataset_seeded',
      subjectTable: 'lims_entity',
      subjectId: strain.id,
      batchId,
      actor,
      payload: {
        dataset: 'Demo LIMS Phase B evidence demo',
        insertedEntities: insertedEntities.filter((result) => result.inserted).length,
        existingEntities: insertedEntities.filter((result) => !result.inserted).length,
        insertedLinks: insertedLinks.filter((result) => result.inserted).length,
        existingLinks: insertedLinks.filter((result) => !result.inserted).length,
        assetSources,
      },
    });

    return {
      batchId,
      insertedEntities: insertedEntities.filter((result) => result.inserted).length,
      existingEntities: insertedEntities.filter((result) => !result.inserted).length,
      insertedLinks: insertedLinks.filter((result) => result.inserted).length,
      existingLinks: insertedLinks.filter((result) => !result.inserted).length,
      entities: [
        organism,
        parentGenome,
        suppliedHypothesisGenome,
        verifiedWgsGenome,
        strain,
        pUc19,
        ...primers,
      ],
      strainSummary: getLimsStrainGenomeSummaryInsideTx(db, { strainEntityId: strain.id }),
      assetSources,
    };
  });
  try {
    return runSeed();
  } catch (err) {
    if (createdHypothesisFile) safeRemoveFile(suppliedHypothesisPath);
    if (createdVerifiedFile) safeRemoveFile(verifiedWgsPath);
    throw err;
  }
}

export const LIMS_MOCK_DEMO_BATCH_PREFIX = 'mock-dna509-demo';
export const LIMS_MOCK_DEMO_PLASMID_ID = 'mock-dna509-plasmid-puc19';
export const LIMS_MOCK_DEMO_GENOME_ID = 'mock-dna509-genome-scerevisiae-chr4';
const LIMS_MOCK_BULK_CSV = 'test-fixtures/lims-mock/mock-primers-derivative.csv';
const LIMS_MOCK_HERO_MANIFEST = 'test-fixtures/lims-mock/mock-demo-hero-manifest.json';

type MockHero = { name: string; sequence: string; target: string; expectedOrientation: string };

const LIMS_MOCK_TARGETS = {
  puc19: {
    id: LIMS_MOCK_DEMO_PLASMID_ID,
    kind: 'plasmid' as const,
    name: 'pUC19 (mock demo)',
    fixture: 'test-fixtures/sequences/circular/pUC19.gb',
    topology: 'circular' as const,
    fields: { markers: ['AmpR'], type: 'cloning vector' } as Record<string, unknown>,
  },
  'yeast-chrIV': {
    id: LIMS_MOCK_DEMO_GENOME_ID,
    kind: 'chromosome' as const,
    name: 'S. cerevisiae chromosome IV (mock demo)',
    fixture: 'test-fixtures/genomes/yeast-chrIV/chrIV.gbff',
    topology: 'linear' as const,

    fields: {
      moleculeType: 'chromosome',
      species: 'Saccharomyces cerevisiae',
      accessions: ['NC_001136.10'],
    } as Record<string, unknown>,
  },
} as const;

type MockTargetKey = keyof typeof LIMS_MOCK_TARGETS;

function ensureDevSequenceCatalogBindingInsideTx(
  db: Database.Database,
  input: { preferredDocumentId: string; name: string; path: string; contentHash: string }
): string {
  const scenario = currentLimsScenarioSeedContext(db);
  const workspaceId = scenario?.workspaceId ?? null;
  const relativePath = scenario
    ? relative(scenario.repoPath, input.path).replaceAll('\\', '/')
    : null;
  const locator = `file://${input.path}`;
  const now = Date.now();
  const byPath = db
    .prepare(
      'SELECT id, entity_id, object_uuid, created_at FROM catalog_entity_files WHERE path = ?'
    )
    .get(input.path) as
    | { id: string; entity_id: string; object_uuid: string | null; created_at: number }
    | undefined;
  const byLocator = db.prepare('SELECT id FROM catalog_entities WHERE locator = ?').get(locator) as
    | { id: string }
    | undefined;
  const documentId = byPath?.entity_id ?? byLocator?.id ?? input.preferredDocumentId;

  db.prepare(
    `INSERT INTO catalog_entities
       (id, type, name, locator, storage_type, status, workspace_id, metadata, created_at, updated_at)
     VALUES (?, 'sequence', ?, ?, 'file', 'active', ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type = 'sequence',
       name = excluded.name,
       locator = excluded.locator,
       storage_type = 'file',
       status = 'active',
       workspace_id = excluded.workspace_id,
       metadata = excluded.metadata,
       updated_at = excluded.updated_at`
  ).run(
    documentId,
    input.name,
    locator,
    workspaceId,
    JSON.stringify({ devScenario: true, path: input.path }),
    now,
    now
  );

  const existingBinding =
    byPath ??
    (db
      .prepare(
        `SELECT id, entity_id, object_uuid, created_at
         FROM catalog_entity_files
         WHERE entity_id = ?
         ORDER BY status = 'current' DESC, updated_at DESC
         LIMIT 1`
      )
      .get(documentId) as
      | { id: string; entity_id: string; object_uuid: string | null; created_at: number }
      | undefined);
  db.prepare(
    `UPDATE catalog_entity_files
     SET status = 'historical', updated_at = ?
     WHERE entity_id = ? AND status = 'current' AND id <> ?`
  ).run(now, documentId, existingBinding?.id ?? '');

  const stat = statSync(input.path);
  if (existingBinding) {
    db.prepare(
      `UPDATE catalog_entity_files
       SET entity_id = ?, workspace_id = ?, path = ?, relative_path = ?,
           file_kind = 'sequence', content_hash = ?, size_bytes = ?, modified_at = ?,
           status = 'current', last_seen_at = ?, missing_since = NULL,
           object_uuid = COALESCE(object_uuid, ?), updated_at = ?
       WHERE id = ?`
    ).run(
      documentId,
      workspaceId,
      input.path,
      relativePath,
      input.contentHash,
      stat.size,
      stat.mtimeMs,
      now,
      randomUUID(),
      now,
      existingBinding.id
    );
  } else {
    db.prepare(
      `INSERT INTO catalog_entity_files
         (id, entity_id, workspace_id, path, relative_path, file_kind, content_hash,
          size_bytes, modified_at, status, last_seen_at, missing_since, object_uuid,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'sequence', ?, ?, ?, 'current', ?, NULL, ?, ?, ?)`
    ).run(
      randomUUID(),
      documentId,
      workspaceId,
      input.path,
      relativePath,
      input.contentHash,
      stat.size,
      stat.mtimeMs,
      now,
      randomUUID(),
      now,
      now
    );
  }

  return documentId;
}

function extractGenBankSequenceForMock(content: string): string {
  const afterOrigin = content.split(/^ORIGIN/m)[1];
  if (!afterOrigin) throw new Error('GenBank fixture has no ORIGIN block');
  return afterOrigin.replace(/[^acgtACGT]/g, '').toUpperCase();
}

const revcompForSeed = sharedReverseComplement;

function parseStarterCdsGenes(
  content: string,
  seqLen: number,
  max: number
): Array<{ gene: string; start: number; end: number }> {
  const lines = content.split('\n');
  const out: Array<{ gene: string; start: number; end: number }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const loc = lines[i].match(/^ {5}(?:CDS|misc_feature) +(?:complement\()?(\d+)\.\.(\d+)\)?\s*$/);
    if (!loc) continue;
    const start = Number(loc[1]);
    const end = Number(loc[2]);
    if (end - start < 200 || start < 30 || end > seqLen - 30) continue;
    let geneQualifier: string | null = null;
    let locusTag: string | null = null;
    let labelGene: string | null = null;

    for (let j = i + 1; j < lines.length; j++) {
      if (/^ {5}\S/.test(lines[j]) || /^\S/.test(lines[j])) break;
      const g = lines[j].match(/^ +\/gene="([A-Za-z][A-Za-z0-9_'.-]{0,15})"/);
      if (g && !geneQualifier) geneQualifier = g[1];
      const lt = lines[j].match(/^ +\/locus_tag="([A-Za-z0-9][A-Za-z0-9_'.-]{0,15})"/);
      if (lt && !locusTag) locusTag = lt[1];
      const lab = lines[j].match(/\/label="([A-Za-z][A-Za-z0-9_-]{1,12}) CDS\b/);
      if (lab && !labelGene) labelGene = lab[1];
    }
    const gene = geneQualifier ?? locusTag ?? labelGene;
    if (!gene || seen.has(gene)) continue;
    seen.add(gene);
    out.push({ gene, start, end });
  }
  return out;
}

export function seedLimsMockDemoInDb(
  db: Database.Database,
  input: LimsSeedMockDemoInput = {}
): LimsSeedMockDemoResult {
  seedLimsBuiltinsInDb(db);
  const actor = input.actor ?? LOCAL_ACTOR;
  const batchId = `${LIMS_MOCK_DEMO_BATCH_PREFIX}-${Date.now()}`;

  const bulkCsvPath = findFixturePath(LIMS_MOCK_BULK_CSV);
  const heroManifestPath = findFixturePath(LIMS_MOCK_HERO_MANIFEST);

  const bulkRows = parseSimpleCsv(readFileSync(bulkCsvPath, 'utf8'))
    .map((row) => ({
      name: readCsvColumn(row, ['Name', 'name']) ?? '',
      sequence: (readCsvColumn(row, ['Sequence', 'sequence']) ?? '')
        .replace(/\s/g, '')
        .toUpperCase(),
    }))
    .filter((row) => row.name && /^[ACGTURYSWKMBDHVN]+$/.test(row.sequence));
  const heroes = (JSON.parse(readFileSync(heroManifestPath, 'utf8')) as { heroes: MockHero[] })
    .heroes;

  const targetData = Object.fromEntries(
    (Object.keys(LIMS_MOCK_TARGETS) as MockTargetKey[]).map((key) => {
      const target = LIMS_MOCK_TARGETS[key];
      const path = findFixturePath(target.fixture);
      const content = readFileSync(path, 'utf8');
      return [key, { target, path, content, sequence: extractGenBankSequenceForMock(content) }];
    })
  ) as Record<
    MockTargetKey,
    {
      target: (typeof LIMS_MOCK_TARGETS)[MockTargetKey];
      path: string;
      content: string;
      sequence: string;
    }
  >;

  const runSeed = db.transaction((): LimsSeedMockDemoResult => {
    if (input.reset) {
      if (input.resetScope === 'dev-seed') {
        clearDevSeededLimsRegistryInsideTx(db, DEV_LIMS_SEED_ID_PREFIXES);
      } else {
        clearLimsRegistryInsideTx(db);
      }
    }
    let insertedOligos = 0;
    let existingOligos = 0;
    let insertedLinks = 0;

    const inlineSequenceField = (bases: string) => ({
      mode: 'inline' as const,
      bases,
      topology: 'linear' as const,
      length: bases.length,
      contentHash: sha256(bases),
    });

    bulkRows.forEach((row, index) => {
      const result = ensureSeedLimsEntityInsideTx(db, {
        id: `mock-dna509-oligo-${String(index).padStart(4, '0')}`,
        kind: 'oligo',
        name: row.name,
        fields: { sequence: inlineSequenceField(row.sequence), use: 'primer' },
        registrationStatus: 'registered',
        actor,
        batchId,
      });
      if (result.inserted) insertedOligos++;
      else existingOligos++;
    });

    const targetEntityIds = {} as Record<MockTargetKey, string>;
    for (const key of Object.keys(targetData) as MockTargetKey[]) {
      const { target, path, content, sequence } = targetData[key];
      const documentId = ensureDevSequenceCatalogBindingInsideTx(db, {
        preferredDocumentId: target.id,
        name: target.name,
        path,
        contentHash: sha256(content),
      });
      const entity = ensureSeedLimsEntityInsideTx(db, {
        id: target.id,
        kind: target.kind,
        name: target.name,
        fields: {
          ...target.fields,
          sequence: buildFileSequenceRef(path, content, {
            documentId,
            length: sequence.length,
            topology: target.topology,
            sourceFormat: 'gb',
          }),
          notes: `${target.name} target for the Demo mock primer demo.`,
        },
        registrationStatus: 'registered',
        actor,
        batchId,
      }).entity;
      targetEntityIds[key] = entity.id;
    }

    const heroOligoIds: string[] = [];
    for (const hero of heroes) {
      const targetKey = (hero.target in LIMS_MOCK_TARGETS ? hero.target : 'puc19') as MockTargetKey;
      const { target, sequence } = targetData[targetKey];
      const heroResult = ensureSeedLimsEntityInsideTx(db, {
        id: `mock-dna509-hero-${sanitizePathStem(hero.name).toLowerCase()}`,
        kind: 'oligo',
        name: hero.name,
        fields: {
          sequence: inlineSequenceField(hero.sequence),
          use: 'primer',
          notes: `Hero oligo — binds ${target.name} (public sub-sequence) for the open-at-binding demo.`,
        },
        registrationStatus: 'registered',
        actor,
        batchId,
      });
      if (heroResult.inserted) insertedOligos++;
      else existingOligos++;
      heroOligoIds.push(heroResult.entity.id);

      const match = searchNucleotide(sequence, hero.sequence, {
        circular: target.topology === 'circular',
        reverseComplement: true,
      })[0];
      const payload = match
        ? {
            role: 'binds_target',
            orientation: match.strand,
            bindingStart: match.start + 1,
            bindingEnd: match.end + 1,
            coordsOrigin: 'searchNucleotide',
          }
        : {
            role: 'binds_target',
            orientation: hero.expectedOrientation,
            coordsOrigin: 'unresolved',
          };
      const linkResult = ensureSeedLimsLinkInsideTx(db, {
        fromEntityId: heroResult.entity.id,
        toEntityId: target.id,
        type: 'amplifies',
        payload,
        actor,
        batchId,
      });
      if (linkResult.inserted) insertedLinks++;
    }

    insertAuditEvent(db, {
      eventType: 'mock_demo_seeded',
      subjectTable: 'lims_entity',
      subjectId: targetEntityIds.puc19,
      batchId,
      actor,
      payload: { insertedOligos, existingOligos, insertedLinks, heroOligoIds },
    });

    return {
      batchId,
      insertedOligos,
      existingOligos,
      plasmidId: targetEntityIds.puc19,
      genomeId: targetEntityIds['yeast-chrIV'],
      heroOligoIds,
      insertedLinks,
    };
  });

  return runSeed();
}

export const LIMS_STARTER_BATCH_PREFIX = 'starter-dna509';

const SC_CHROMOSOMES: ReadonlyArray<{ roman: string; accession: string }> = [
  { roman: 'I', accession: 'NC_001133' },
  { roman: 'II', accession: 'NC_001134' },
  { roman: 'III', accession: 'NC_001135' },
  { roman: 'IV', accession: 'NC_001136.10' },
  { roman: 'V', accession: 'NC_001137' },
  { roman: 'VI', accession: 'NC_001138' },
  { roman: 'VII', accession: 'NC_001139' },
  { roman: 'VIII', accession: 'NC_001140' },
  { roman: 'IX', accession: 'NC_001141' },
  { roman: 'X', accession: 'NC_001142' },
  { roman: 'XI', accession: 'NC_001143' },
  { roman: 'XII', accession: 'NC_001144' },
  { roman: 'XIII', accession: 'NC_001145' },
  { roman: 'XIV', accession: 'NC_001146' },
  { roman: 'XV', accession: 'NC_001147' },
  { roman: 'XVI', accession: 'NC_001148' },
];

const LIMS_PRACTICE_BATCH_PREFIX = 'dna509-lims-practice';
const LIMS_PRACTICE_FEATURED_BACKBONE = 'pGEX-4T-1';

const PRACTICE_TIMELINE_SPAN_MS = 18 * 30 * 24 * 60 * 60 * 1000;
const PRACTICE_DAY_MS = 24 * 60 * 60 * 1000;

export function weaveProportional<A, B>(a: readonly A[], b: readonly B[]): Array<A | B> {
  const out: Array<A | B> = [];
  let ai = 0;
  let bi = 0;
  const total = a.length + b.length;
  for (let i = 0; i < total; i++) {
    const aShare = a.length === 0 ? Infinity : (ai + 0.5) / a.length;
    const bShare = b.length === 0 ? Infinity : (bi + 0.5) / b.length;
    if (ai < a.length && (bi >= b.length || aShare <= bShare)) {
      out.push(a[ai++]);
    } else {
      out.push(b[bi++]);
    }
  }
  return out;
}

export function seedLimsPracticeDemoInDb(
  db: Database.Database,
  input: LimsSeedPracticeDemoInput = {}
): LimsSeedPracticeDemoResult {
  seedLimsBuiltinsInDb(db);
  const actor = input.actor ?? LOCAL_ACTOR;
  const batchId = `${LIMS_PRACTICE_BATCH_PREFIX}-${Date.now()}`;

  const plasmids = buildPracticePlasmids((relativePath) =>
    readFileSync(findFixturePath(relativePath), 'utf8')
  );

  const primerCsvPath = findFixturePath(LIMS_MOCK_BULK_CSV);
  const primers = parseSimpleCsv(readFileSync(primerCsvPath, 'utf8'))
    .map((row) => ({
      name: readCsvColumn(row, ['Name', 'name']) ?? '',
      sequence: (readCsvColumn(row, ['Sequence', 'sequence']) ?? '')
        .replace(/\s/g, '')
        .toUpperCase(),
    }))
    .filter((row) => row.name && /^[ACGTURYSWKMBDHVN]+$/.test(row.sequence));

  const outputDir = join(app.getPath('userData'), 'lims', 'practice-demo', 'plasmids');
  mkdirSync(outputDir, { recursive: true });
  const writtenFiles: Array<{ path: string; created: boolean }> = [];
  const plasmidFiles = plasmids.map((plasmid) => {
    const bases = plasmid.bases;
    const gbContent = serializeGenBank({
      id: plasmid.id,
      name: plasmid.name,
      sequence: bases,
      length: bases.length,
      annotations: [],
      circular: true,
      description: `Synthetic practice plasmid ${plasmid.name}: a random ${plasmid.insertLength} bp insert in ${plasmid.backbone} (NCBI ${plasmid.accession}).`,
    });
    const filePath = join(outputDir, `${plasmid.id}.gb`);
    const created = !existsSync(filePath);
    writeFileSync(filePath, gbContent, 'utf8');
    writtenFiles.push({ path: filePath, created });
    return { plasmid, bases, gbContent, filePath };
  });

  const merged = weaveProportional(
    plasmidFiles.map((p) => ({ type: 'plasmid' as const, p })),
    primers.map((pr) => ({ type: 'oligo' as const, pr }))
  );
  const total = merged.length;
  const windowEnd = Date.now() - PRACTICE_DAY_MS;
  const windowStart = windowEnd - PRACTICE_TIMELINE_SPAN_MS;
  const createdAtFor = (index: number): number =>
    total <= 1
      ? windowEnd
      : windowStart + Math.floor(((windowEnd - windowStart) * index) / (total - 1));

  const inlineSequenceField = (bases: string) => ({
    mode: 'inline' as const,
    bases,
    topology: 'linear' as const,
    length: bases.length,
    contentHash: sha256(bases),
  });

  type PracticeChromosome = {
    id: string;
    name: string;
    accession: string;
    fixture: string;
    length: number;
    topology: 'circular';
    notes?: string;
  };
  type PracticeGenomeSpec = {
    speciesName: string;
    speciesTaxid: string;
    strainId: string;
    strainName: string;
    genotype: string;
    source: string;
    assemblyId: string;
    assemblyName: string;
    assemblyAccession: string;
    chromosomes: PracticeChromosome[];
  };
  const GENOME_SPECS: PracticeGenomeSpec[] = [
    {
      speciesName: 'Vibrio cholerae',
      speciesTaxid: '666',
      strainId: 'practice-dna509-strain-vcholerae-n16961',
      strainName: 'Vibrio cholerae O1 El Tor N16961',
      genotype:
        'O1 serogroup, El Tor biotype; wild-type cholera reference (Heidelberg et al. 2000).',
      source: 'NCBI RefSeq reference genome GCF_000006745.1',
      assemblyId: 'practice-dna509-genome-vcholerae-n16961',
      assemblyName: 'V. cholerae N16961 reference assembly',
      assemblyAccession: 'GCF_000006745.1',
      chromosomes: [
        {
          id: 'practice-dna509-chr-vcholerae-chr1',
          name: 'V. cholerae N16961 chromosome I',
          accession: 'NC_002505.1',
          fixture: 'test-fixtures/genomes/vibrio-cholerae-N16961/NC_002505.1.gb',
          length: 2961149,
          topology: 'circular',
        },
        {
          id: 'practice-dna509-chr-vcholerae-chr2',
          name: 'V. cholerae N16961 chromosome II',
          accession: 'NC_002506.1',
          fixture: 'test-fixtures/genomes/vibrio-cholerae-N16961/NC_002506.1.gb',
          length: 1072315,
          topology: 'circular',
          notes:
            'Chromosome II derives from an ancestral domesticated megaplasmid and retains a ' +
            'plasmid-type replication origin, but is annotated and replicates as a chromosome ' +
            '(it is NOT a separate plasmid molecule).',
        },
      ],
    },
    {
      speciesName: 'Escherichia coli',
      speciesTaxid: '562',
      strainId: 'practice-dna509-strain-ecoli-mg1655',
      strainName: 'E. coli K-12 MG1655',
      genotype: 'F– λ– rph-1; wild-type K-12 reference.',
      source: 'NCBI RefSeq reference genome NC_000913.3',
      assemblyId: 'practice-dna509-genome-ecoli-mg1655',
      assemblyName: 'E. coli K-12 MG1655 reference assembly',
      assemblyAccession: 'NC_000913.3',
      chromosomes: [
        {
          id: 'practice-dna509-chr-ecoli-mg1655',
          name: 'E. coli K-12 MG1655 chromosome',
          accession: 'NC_000913.3',
          fixture: 'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb',
          length: 4641652,
          topology: 'circular',
        },
      ],
    },
    {
      speciesName: 'Escherichia coli',
      speciesTaxid: '562',
      strainId: 'practice-dna509-strain-ecoli-w3110',
      strainName: 'E. coli K-12 W3110',
      genotype: 'F– λ– IN(rrnD-rrnE)1 rph-1; wild-type K-12 reference (sibling of MG1655).',
      source: 'NCBI RefSeq reference genome NC_007779.1',
      assemblyId: 'practice-dna509-genome-ecoli-w3110',
      assemblyName: 'E. coli K-12 W3110 reference assembly',
      assemblyAccession: 'NC_007779.1',
      chromosomes: [
        {
          id: 'practice-dna509-chr-ecoli-w3110',
          name: 'E. coli K-12 W3110 chromosome',
          accession: 'NC_007779.1',
          fixture: 'test-fixtures/genomes/ecoli-W3110/NC_007779.1.gb',
          length: 4646332,
          topology: 'circular',
        },
      ],
    },
  ];

  const chromosomeContent = new Map<string, { path: string; content: string }>();
  for (const spec of GENOME_SPECS) {
    for (const chr of spec.chromosomes) {
      const path = findFixturePath(chr.fixture);
      chromosomeContent.set(chr.id, { path, content: readFileSync(path, 'utf8') });
    }
  }

  try {
    const runSeed = db.transaction((): LimsSeedPracticeDemoResult => {
      if (input.reset) {
        if (input.resetScope === 'dev-seed') {
          clearDevSeededLimsRegistryInsideTx(db, DEV_LIMS_SEED_ID_PREFIXES);
        } else {
          clearLimsRegistryInsideTx(db);
        }
      }
      let insertedPlasmids = 0;
      let insertedOligos = 0;
      let existingEntities = 0;
      let sampleEntityId: string | null = null;

      merged.forEach((item, index) => {
        const createdAt = createdAtFor(index);
        if (item.type === 'plasmid') {
          const { plasmid, bases, gbContent, filePath } = item.p;
          const result = ensureSeedLimsEntityInsideTx(db, {
            id: `practice-dna509-plasmid-${plasmid.id}`,
            kind: 'plasmid',
            name: plasmid.name,
            fields: {
              sequence: buildFileSequenceRef(filePath, gbContent, {
                documentId: `practice-dna509-plasmid-${plasmid.id}`,
                length: bases.length,
                topology: 'circular',
                sourceFormat: 'gb',
              }),
              type: plasmid.backbone,
              markers: [...plasmid.markers],
              notes: `Synthetic practice plasmid: a random ${plasmid.insertLength} bp insert after base ${plasmid.insertAfter} of ${plasmid.backbone} (NCBI ${plasmid.accession}).`,
            },
            registrationStatus: 'registered',
            actor,
            batchId,
            createdAt,
          });
          if (result.inserted) {
            insertedPlasmids++;
            if (!sampleEntityId) sampleEntityId = result.entity.id;
          } else existingEntities++;
        } else {
          const { pr } = item;
          const result = ensureSeedLimsEntityInsideTx(db, {
            id: `practice-dna509-oligo-${sanitizePathStem(pr.name).toLowerCase()}-${index}`,
            kind: 'oligo',
            name: pr.name,
            fields: { sequence: inlineSequenceField(pr.sequence), use: 'primer' },
            registrationStatus: 'registered',
            actor,
            batchId,
            createdAt,
          });
          if (result.inserted) insertedOligos++;
          else existingEntities++;
        }
      });

      let insertedGenomeEntities = 0;
      const genomeCreatedAt = windowEnd;
      for (const spec of GENOME_SPECS) {
        const strain = ensureSeedLimsEntityInsideTx(db, {
          id: spec.strainId,
          kind: 'strain',
          name: spec.strainName,
          fields: {
            genotypeCanonical: spec.genotype,
            species: spec.speciesName,
            speciesTaxid: spec.speciesTaxid,
            source: spec.source,
          },
          registrationStatus: 'registered',
          actor,
          batchId,
          createdAt: genomeCreatedAt,
        });
        if (strain.inserted) {
          insertedGenomeEntities++;
          if (!sampleEntityId) sampleEntityId = strain.entity.id;
        } else existingEntities++;

        const genome = ensureSeedLimsEntityInsideTx(db, {
          id: spec.assemblyId,
          kind: 'genome',
          name: spec.assemblyName,
          fields: {
            sequence: { mode: 'unresolved' },
            assemblyLevel: 'complete_genome',
            source: 'reference',
            accessions: [spec.assemblyAccession],
            species: spec.speciesName,
            speciesTaxid: spec.speciesTaxid,
            notes: `Reference assembly ${spec.assemblyAccession} (NCBI RefSeq, public domain).`,
          },
          registrationStatus: 'registered',
          actor,
          batchId,
          createdAt: genomeCreatedAt,
        });
        if (genome.inserted) insertedGenomeEntities++;
        else existingEntities++;
        ensureSeedLimsLinkInsideTx(db, {
          fromEntityId: strain.entity.id,
          toEntityId: genome.entity.id,
          type: 'has_genome',
          actor,
          batchId,
        });

        for (const chr of spec.chromosomes) {
          const cached = chromosomeContent.get(chr.id);
          if (!cached) continue;
          const chrEntity = ensureSeedLimsEntityInsideTx(db, {
            id: chr.id,
            kind: 'chromosome',
            name: chr.name,
            fields: {
              sequence: buildFileSequenceRef(cached.path, cached.content, {
                documentId: chr.id,
                length: chr.length,
                topology: chr.topology,
                sourceFormat: 'gb',
              }),
              moleculeType: 'chromosome',
              accessions: [chr.accession],
              species: spec.speciesName,
              speciesTaxid: spec.speciesTaxid,
              notes: chr.notes,
            },
            registrationStatus: 'registered',
            actor,
            batchId,
            createdAt: genomeCreatedAt,
          });
          if (chrEntity.inserted) insertedGenomeEntities++;
          else existingEntities++;
          ensureSeedLimsLinkInsideTx(db, {
            fromEntityId: genome.entity.id,
            toEntityId: chrEntity.entity.id,
            type: 'has_part',
            actor,
            batchId,
          });
        }
      }

      const featured = plasmids.find(
        (plasmid) => plasmid.backbone === LIMS_PRACTICE_FEATURED_BACKBONE
      );
      if (featured) {
        ensureSeedLimsLinkInsideTx(db, {
          fromEntityId: 'practice-dna509-strain-ecoli-mg1655',
          toEntityId: `practice-dna509-plasmid-${featured.id}`,
          type: 'has_part',
          actor,
          batchId,
        });
      }

      return {
        batchId,
        insertedPlasmids,
        insertedOligos,
        insertedGenomeEntities,
        existingEntities,
        sampleEntityId,
      };
    });
    return runSeed();
  } catch (error) {
    for (const f of writtenFiles) {
      if (f.created) safeRemoveFile(f.path);
    }
    throw error;
  }
}

export function seedLimsStarterRegistryInDb(
  db: Database.Database,
  input: LimsSeedStarterRegistryInput = {}
): LimsSeedStarterRegistryResult {
  seedLimsBuiltinsInDb(db);
  const actor = input.actor ?? LOCAL_ACTOR;
  const batchId = `${LIMS_STARTER_BATCH_PREFIX}-${Date.now()}`;

  const ecoliPath = findFixturePath('test-fixtures/sequences/circular/ecoli-mg1655-complete.gb');
  const ecoliContent = readFileSync(ecoliPath, 'utf8');
  const ecoliSeq = extractGenBankSequenceForMock(ecoliContent);
  const chrIVPath = findFixturePath('test-fixtures/genomes/yeast-chrIV/chrIV.gbff');
  const chrIVContent = readFileSync(chrIVPath, 'utf8');
  const chrIVSeq = extractGenBankSequenceForMock(chrIVContent);

  const chrIContent = readFileSync(
    findFixturePath('test-fixtures/genomes/yeast-S288C/S288C_chromosome_I.gb'),
    'utf8'
  );
  const chrIIContent = readFileSync(
    findFixturePath('test-fixtures/genomes/yeast-S288C/S288C_chromosome_II.gb'),
    'utf8'
  );
  const chrIIIContent = readFileSync(
    findFixturePath('test-fixtures/genomes/yeast-S288C/S288C_chromosome_III.gb'),
    'utf8'
  );

  const puc19Seq = extractGenBankSequenceForMock(
    readFileSync(findFixturePath('test-fixtures/sequences/circular/pUC19.gb'), 'utf8')
  );

  const runSeed = db.transaction((): LimsSeedStarterRegistryResult => {
    if (input.reset) clearLimsRegistryInsideTx(db);
    let insertedEntities = 0;
    let existingEntities = 0;
    let insertedLinks = 0;
    const strainIds: string[] = [];
    const genomeIds: string[] = [];
    const ECOLI = { name: 'Escherichia coli', taxid: '562' };
    const YEAST = { name: 'Saccharomyces cerevisiae', taxid: '4932' };

    const ensureEntity = (request: LimsRegisterEntityInput): LimsEntity => {
      const result = ensureSeedLimsEntityInsideTx(db, { ...request, actor, batchId });
      if (result.inserted) insertedEntities++;
      else existingEntities++;
      return result.entity;
    };
    const ensureLink = (request: LimsLinkEntitiesInput): void => {
      const result = ensureSeedLimsLinkInsideTx(db, { ...request, actor, batchId });
      if (result.inserted) insertedLinks++;
    };
    const unresolvedSequence = { mode: 'unresolved' as const };

    const ensureStrain = (
      species: { name: string; taxid: string },
      spec: { id: string; name: string; genotype: string; source: string; notes: string },
      lineage?: { parentStrainId: string; reference: string; genotypeDelta?: string }
    ): LimsEntity => {
      const strain = ensureEntity({
        id: spec.id,
        kind: 'strain',
        name: spec.name,
        fields: {
          genotypeCanonical: spec.genotype,
          species: species.name,
          speciesTaxid: species.taxid,
          source: spec.source,
          notes: spec.notes,
        },
        registrationStatus: 'registered',
      });
      strainIds.push(strain.id);
      if (lineage) {
        ensureLink({
          fromEntityId: strain.id,
          toEntityId: lineage.parentStrainId,
          type: 'derives_from',
          payload: {
            provenance: 'literature',
            reference: lineage.reference,
            ...(lineage.genotypeDelta ? { genotypeDelta: lineage.genotypeDelta } : {}),
            sequenceDiff: 'not_computed',
          },
        });
      }
      return strain;
    };

    const ensureChromosome = (
      genomeId: string,
      spec: {
        id: string;
        name: string;
        accession: string;
        chromosomeLabel: string;
        sequence: DnaSequenceRef;
        notes: string;
      }
    ): LimsEntity => {
      const isFile = spec.sequence.mode === 'file';
      const chromosome = ensureEntity({
        id: spec.id,
        kind: 'chromosome',
        name: spec.name,
        fields: {
          sequence: spec.sequence,
          moleculeType: 'chromosome',
          accessions: [spec.accession],
          notes: spec.notes,
        },
        registrationStatus: isFile ? 'registered' : 'unresolved',
      });
      ensureLink({
        fromEntityId: genomeId,
        toEntityId: chromosome.id,
        type: 'has_part',
        payload: { role: 'chromosome', chromosome: spec.chromosomeLabel },
      });
      return chromosome;
    };

    const w1485 = ensureStrain(ECOLI, {
      id: 'starter-strain-ecoli-w1485',
      name: 'E. coli K-12 W1485',
      genotype: 'F+ λ+',
      source: 'K-12 ancestor',
      notes: 'Prototrophic K-12 ancestor of MG1655 and W3110.',
    });
    const mg1655 = ensureStrain(
      ECOLI,
      {
        id: 'starter-strain-ecoli-mg1655',
        name: 'E. coli K-12 MG1655',
        genotype: 'F– λ– rph-1',
        source: 'reference K-12 strain',
        notes: 'E. coli K-12 reference strain (RefSeq NC_000913.3).',
      },
      { parentStrainId: w1485.id, reference: 'Hayashi et al. 2006, Mol Syst Biol 2:2006.0007' }
    );

    const mg1655Genome = ensureEntity({
      id: 'starter-genome-ecoli-mg1655',
      kind: 'genome',
      name: 'E. coli MG1655 genome',
      fields: {
        sequence: unresolvedSequence,
        assemblyLevel: 'complete_genome',
        source: 'reference',
        accessions: ['GCF_000005845.2'],
        notes: 'MG1655 reference assembly — one circular chromosome.',
      },
      registrationStatus: 'registered',
    });
    genomeIds.push(mg1655Genome.id);
    ensureLink({
      fromEntityId: mg1655.id,
      toEntityId: mg1655Genome.id,
      type: 'has_genome',
      payload: { confidence: 'reference' },
    });
    ensureChromosome(mg1655Genome.id, {
      id: 'starter-chr-ecoli-mg1655',
      name: 'E. coli MG1655 chromosome',
      accession: 'NC_000913.3',
      chromosomeLabel: 'main',
      sequence: buildFileSequenceRef(ecoliPath, ecoliContent, {
        documentId: 'starter-chr-ecoli-mg1655',
        length: ecoliSeq.length,
        topology: 'circular',
        sourceFormat: 'gb',
      }),
      notes: 'E. coli MG1655 single circular chromosome — committed fixture (openable).',
    });

    ensureStrain(
      ECOLI,
      {
        id: 'starter-strain-ecoli-w3110',
        name: 'E. coli K-12 W3110',
        genotype: 'F– λ– rph-1 IN(rrnD-rrnE)1',
        source: 'common lab stock',
        notes: 'K-12 lab strain; sibling of MG1655 (shared W1485 ancestor).',
      },
      { parentStrainId: w1485.id, reference: 'Hayashi et al. 2006, Mol Syst Biol 2:2006.0007' }
    );

    ensureStrain(ECOLI, {
      id: 'starter-strain-ecoli-dh5a',
      name: 'E. coli DH5α',
      genotype:
        'F– endA1 glnV44 thi-1 recA1 relA1 gyrA96 deoR nupG Φ80dlacZΔM15 Δ(lacZYA-argF)U169 hsdR17 λ–',
      source: 'common cloning strain',
      notes:
        'High-efficiency cloning strain (K-12 derivative; precise parent lineage not asserted).',
    });
    ensureStrain(ECOLI, {
      id: 'starter-strain-ecoli-bl21',
      name: 'E. coli BL21(DE3)',
      genotype: 'F– ompT hsdSB(rB– mB–) gal dcm (DE3)',
      source: 'common expression strain',
      notes: 'T7 RNA-polymerase expression strain (B lineage, distinct from K-12).',
    });

    const s288c = ensureStrain(YEAST, {
      id: 'starter-strain-scerevisiae-s288c',
      name: 'S. cerevisiae S288C',
      genotype: 'MATα SUC2 gal2 mal2 mel flo1 flo8-1 hap1 ho bio1 bio6',
      source: 'reference strain',
      notes: 'S. cerevisiae reference strain (assembly GCF_000146045.2, taxid 559292).',
    });

    const s288cGenome = ensureEntity({
      id: 'starter-genome-scerevisiae-s288c',
      kind: 'genome',
      name: 'S. cerevisiae S288C genome',
      fields: {
        sequence: unresolvedSequence,
        assemblyLevel: 'complete_genome',
        source: 'reference',
        accessions: ['GCF_000146045.2'],
        notes: 'S288C reference assembly — 16 nuclear chromosomes, all file-backed/openable.',
      },
      registrationStatus: 'registered',
    });
    genomeIds.push(s288cGenome.id);
    ensureLink({
      fromEntityId: s288c.id,
      toEntityId: s288cGenome.id,
      type: 'has_genome',
      payload: { confidence: 'reference' },
    });
    for (const chr of SC_CHROMOSOMES) {
      const isChrIV = chr.roman === 'IV';
      const chrPath = isChrIV
        ? chrIVPath
        : findFixturePath(`test-fixtures/genomes/yeast-S288C/S288C_chromosome_${chr.roman}.gb`);
      const chrContent = isChrIV ? chrIVContent : readFileSync(chrPath, 'utf8');
      const chrLength = isChrIV
        ? chrIVSeq.length
        : extractGenBankSequenceForMock(chrContent).length;
      ensureChromosome(s288cGenome.id, {
        id: `starter-chr-scerevisiae-${chr.roman.toLowerCase()}`,
        name: `S. cerevisiae S288C chromosome ${chr.roman}`,
        accession: chr.accession,
        chromosomeLabel: chr.roman,
        sequence: buildFileSequenceRef(chrPath, chrContent, {
          documentId: `starter-chr-scerevisiae-${chr.roman.toLowerCase()}`,
          length: chrLength,
          topology: 'linear',
          sourceFormat: 'gb',
        }),
        notes: `Chromosome ${chr.roman} — committed fixture (openable).`,
      });
    }

    ensureStrain(
      YEAST,
      {
        id: 'starter-strain-scerevisiae-by4741',
        name: 'S. cerevisiae BY4741',
        genotype: 'MATa his3Δ1 leu2Δ0 met15Δ0 ura3Δ0',
        source: 'common lab strain',
        notes: 'S288C-derived MATa auxotroph (deletion-collection background).',
      },
      {
        parentStrainId: s288c.id,
        reference: 'Brachmann et al. 1998, Yeast 14:115-132',
        genotypeDelta: 'his3Δ1 leu2Δ0 met15Δ0 ura3Δ0 (markers deleted vs S288C)',
      }
    );
    ensureStrain(
      YEAST,
      {
        id: 'starter-strain-scerevisiae-by4742',
        name: 'S. cerevisiae BY4742',
        genotype: 'MATα his3Δ1 leu2Δ0 lys2Δ0 ura3Δ0',
        source: 'common lab strain',
        notes: 'S288C-derived MATα auxotroph (deletion-collection background).',
      },
      {
        parentStrainId: s288c.id,
        reference: 'Brachmann et al. 1998, Yeast 14:115-132',
        genotypeDelta: 'his3Δ1 leu2Δ0 lys2Δ0 ura3Δ0 (markers deleted vs S288C)',
      }
    );

    const oligoIds: string[] = [];
    const inlinePrimerSeq = (bases: string) => ({
      mode: 'inline' as const,
      bases,
      topology: 'linear' as const,
      length: bases.length,
      contentHash: sha256(bases),
    });
    const registerPrimer = (
      primer: {
        name: string;
        sequence: string;
        use?: string;
        note?: string;
        gene?: string;
        orientation?: 'forward' | 'reverse';
        bindingStart?: number;
        bindingEnd?: number;
        linkType?: string;
      },
      targetEntityId?: string
    ): void => {
      const oligo = ensureEntity({
        id: `starter-oligo-${primer.name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`,
        kind: 'oligo',
        name: primer.name,
        fields: {
          sequence: inlinePrimerSeq(primer.sequence),
          use: primer.use ?? 'primer',
          ...(primer.note ? { notes: primer.note } : {}),
        },
        registrationStatus: 'registered',
      });
      oligoIds.push(oligo.id);
      if (targetEntityId && primer.orientation && primer.bindingStart && primer.bindingEnd) {
        ensureLink({
          fromEntityId: oligo.id,
          toEntityId: targetEntityId,
          type: primer.linkType ?? 'amplifies',
          payload: {
            role: 'binds_target',
            orientation: primer.orientation,
            bindingStart: primer.bindingStart,
            bindingEnd: primer.bindingEnd,
            ...(primer.gene ? { gene: primer.gene } : {}),
            coordsOrigin: 'reference_genome',
          },
        });
      }
    };

    const primerSources: Array<{
      entityId: string;
      content: string;
      prefix: string;
      maxGenes: number;
    }> = [
      { entityId: 'starter-chr-ecoli-mg1655', content: ecoliContent, prefix: 'Eco', maxGenes: 28 },
      { entityId: 'starter-chr-scerevisiae-i', content: chrIContent, prefix: 'Sc1', maxGenes: 10 },
      {
        entityId: 'starter-chr-scerevisiae-ii',
        content: chrIIContent,
        prefix: 'Sc2',
        maxGenes: 10,
      },
      {
        entityId: 'starter-chr-scerevisiae-iii',
        content: chrIIIContent,
        prefix: 'Sc3',
        maxGenes: 10,
      },
    ];

    const gibLeftArm = puc19Seq.slice(360, 390);
    const gibRightArm = puc19Seq.slice(390, 420);
    const lenIn = (seed: number, lo: number, span: number): number => lo + (Math.abs(seed) % span);
    const transversion: Record<string, string> = { A: 'C', C: 'A', G: 'T', T: 'G' };
    const isDna = (s: string, n: number): boolean => s.length === n && /^[ACGT]+$/.test(s);

    for (const src of primerSources) {
      const seq = extractGenBankSequenceForMock(src.content);
      const genes = parseStarterCdsGenes(src.content, seq.length, src.maxGenes);
      genes.forEach((g, idx) => {
        const project = idx % 4;
        const annealF = (len: number) => seq.slice(g.start - 1, g.start - 1 + len);
        const annealR = (len: number) => revcompForSeed(seq.slice(g.end - len, g.end));

        if (project === 0) {
          const aF = annealF(lenIn(g.start, 20, 6));
          const aR = annealR(lenIn(g.end, 20, 6));
          const gibF = gibLeftArm + aF;
          const gibR = revcompForSeed(gibRightArm) + aR;
          if (!isDna(aF, aF.length) || !isDna(aR, aR.length)) return;
          registerPrimer(
            {
              name: `${src.prefix}-${g.gene}-Gib-F`,
              sequence: gibF,
              use: 'primer',
              note: `Gibson: ${g.gene} into pUC19 (fwd, ${gibF.length} nt)`,
              gene: g.gene,
              orientation: 'forward',
              bindingStart: g.start,
              bindingEnd: g.start + aF.length - 1,
            },
            src.entityId
          );
          registerPrimer(
            {
              name: `${src.prefix}-${g.gene}-Gib-R`,
              sequence: gibR,
              use: 'primer',
              note: `Gibson: ${g.gene} into pUC19 (rev, ${gibR.length} nt)`,
              gene: g.gene,
              orientation: 'reverse',
              bindingStart: g.end - aR.length + 1,
              bindingEnd: g.end,
            },
            src.entityId
          );
          const sq = annealF(lenIn(g.start + 7, 18, 4));
          registerPrimer(
            {
              name: `${src.prefix}-${g.gene}-seqF`,
              sequence: sq,
              use: 'sequencing',
              note: `Sequencing primer for ${g.gene}`,
              gene: g.gene,
              orientation: 'forward',
              bindingStart: g.start,
              bindingEnd: g.start + sq.length - 1,
              linkType: 'associated_with',
            },
            src.entityId
          );
        } else if (project === 1) {
          const f = annealF(lenIn(g.start, 19, 7));
          const r = annealR(lenIn(g.end, 19, 7));
          if (!isDna(f, f.length) || !isDna(r, r.length)) return;
          registerPrimer(
            {
              name: `${src.prefix}-${g.gene}-F`,
              sequence: f,
              use: 'primer',
              note: `PCR fwd for ${g.gene}`,
              gene: g.gene,
              orientation: 'forward',
              bindingStart: g.start,
              bindingEnd: g.start + f.length - 1,
            },
            src.entityId
          );
          registerPrimer(
            {
              name: `${src.prefix}-${g.gene}-R`,
              sequence: r,
              use: 'primer',
              note: `PCR rev for ${g.gene}`,
              gene: g.gene,
              orientation: 'reverse',
              bindingStart: g.end - r.length + 1,
              bindingEnd: g.end,
            },
            src.entityId
          );
          const mid = Math.floor((g.start + g.end) / 2);
          const qf = seq.slice(mid - 1, mid - 1 + 20);
          const qr = revcompForSeed(seq.slice(mid + 80, mid + 100));
          if (isDna(qf, 20) && isDna(qr, 20)) {
            registerPrimer(
              {
                name: `${src.prefix}-${g.gene}-qPCR-F`,
                sequence: qf,
                use: 'primer',
                note: `qPCR fwd for ${g.gene}`,
                gene: g.gene,
                orientation: 'forward',
                bindingStart: mid,
                bindingEnd: mid + 19,
              },
              src.entityId
            );
            registerPrimer(
              {
                name: `${src.prefix}-${g.gene}-qPCR-R`,
                sequence: qr,
                use: 'primer',
                note: `qPCR rev for ${g.gene}`,
                gene: g.gene,
                orientation: 'reverse',
                bindingStart: mid + 81,
                bindingEnd: mid + 100,
              },
              src.entityId
            );
          }
        } else if (project === 2) {
          const mid = Math.floor((g.start + g.end) / 2);
          const flank = 18;
          const window = seq.slice(mid - 1 - flank, mid + flank);
          if (!isDna(window, 2 * flank + 1)) return;
          const orig = window[flank];
          const mut = transversion[orig];
          const mutated = window.slice(0, flank) + mut + window.slice(flank + 1);
          registerPrimer(
            {
              name: `${src.prefix}-${g.gene}-${orig}${mid}${mut}-QC-F`,
              sequence: mutated,
              use: 'mutagenesis',
              note: `QuikChange ${orig}${mid}${mut} in ${g.gene}`,
              gene: g.gene,
              orientation: 'forward',
              bindingStart: mid - flank,
              bindingEnd: mid + flank,
              linkType: 'associated_with',
            },
            src.entityId
          );
          registerPrimer(
            {
              name: `${src.prefix}-${g.gene}-${orig}${mid}${mut}-QC-R`,
              sequence: revcompForSeed(mutated),
              use: 'mutagenesis',
              note: `QuikChange ${orig}${mid}${mut} in ${g.gene} (rev)`,
              gene: g.gene,
              orientation: 'reverse',
              bindingStart: mid - flank,
              bindingEnd: mid + flank,
              linkType: 'associated_with',
            },
            src.entityId
          );
        } else {
          const ultraLen = lenIn(g.start, 86, 10);
          const ultra = annealF(ultraLen);
          if (isDna(ultra, ultraLen)) {
            registerPrimer(
              {
                name: `${src.prefix}-${g.gene}-gBlock`,
                sequence: ultra,
                use: 'gBlock',
                note: `Synthesis fragment for ${g.gene} (${ultra.length} nt)`,
                gene: g.gene,
                orientation: 'forward',
                bindingStart: g.start,
                bindingEnd: g.start + ultra.length - 1,
                linkType: 'associated_with',
              },
              src.entityId
            );
          }
          const f = annealF(lenIn(g.start + 3, 20, 5));
          if (isDna(f, f.length)) {
            registerPrimer(
              {
                name: `${src.prefix}-${g.gene}-F`,
                sequence: f,
                use: 'primer',
                note: `PCR fwd for ${g.gene}`,
                gene: g.gene,
                orientation: 'forward',
                bindingStart: g.start,
                bindingEnd: g.start + f.length - 1,
              },
              src.entityId
            );
          }
        }
      });
    }

    insertAuditEvent(db, {
      eventType: 'starter_registry_seeded',
      subjectTable: 'lims_entity',
      subjectId: strainIds[0] ?? genomeIds[0],
      batchId,
      actor,
      payload: {
        insertedEntities,
        existingEntities,
        insertedLinks,
        strainIds,
        oligoCount: oligoIds.length,
      },
    });

    return {
      batchId,
      insertedEntities,
      existingEntities,
      insertedLinks,
      strainIds,
      genomeIds,
      oligoIds,
    };
  });

  return runSeed();
}

export function safeRemoveFile(filePath: string): void {
  try {
    rmSync(filePath, { force: true });
  } catch {}
}

export function ensureSeedLimsEntityInsideTx(
  db: Database.Database,
  input: LimsRegisterEntityInput
): SeededLimsEntityResult {
  if (input.id) {
    const existing = db.prepare(`SELECT * FROM lims_entity WHERE id = ?`).get(input.id) as
      | LimsEntityRow
      | undefined;
    if (existing && !existing.tombstone) {
      const entity = limsEntityFromRow(existing);
      const scenario = currentLimsScenarioSeedContext(db);
      if (scenario) {
        const owned = ownScenarioSeedInput(db, { ...input, fields: entity.fields });
        if (
          JSON.stringify(owned.fields) !== JSON.stringify(entity.fields) ||
          entity.workspaceId !== scenario.workspaceId
        ) {
          return {
            entity: updateLimsEntityInsideTx(db, {
              id: entity.id,
              fields: owned.fields,
              workspaceId: scenario.workspaceId,
              actor: input.actor,
              batchId: input.batchId,
            }),
            inserted: false,
          };
        }
      }
      return { entity, inserted: false };
    }
    if (existing?.tombstone) {
      return {
        entity: replaceTombstonedSeedLimsEntityInsideTx(db, ownScenarioSeedInput(db, input)),
        inserted: true,
      };
    }
  }
  return {
    entity: registerLimsEntityInsideTx(db, ownScenarioSeedInput(db, input)),
    inserted: true,
  };
}

function ownScenarioSeedInput(
  db: Database.Database,
  input: LimsRegisterEntityInput
): LimsRegisterEntityInput {
  const scenario = currentLimsScenarioSeedContext(db);
  if (!scenario) return input;
  const value = input.fields.sequence;
  if (!value || typeof value !== 'object' || !('mode' in value) || value.mode !== 'file') {
    return { ...input, workspaceId: scenario.workspaceId };
  }
  const sequence = value as Extract<DnaSequenceRef, { mode: 'file' }>;
  const content = readFileSync(sequence.relPath, 'utf8');
  const contentHash = sha256(content);
  if ((sequence.fileContentHash ?? sequence.contentHash) !== contentHash) {
    throw new Error('Scenario sequence bytes changed before their owned copy was made.');
  }
  const path = isPathInsideBoundary(sequence.relPath, scenario.repoPath)
    ? sequence.relPath
    : join(scenario.repoPath, 'sequences', contentHash, basename(sequence.relPath));
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' });
    scenario.createdFiles.add(path);
  } else if (sha256(readFileSync(path, 'utf8')) !== contentHash) {
    throw new Error('An immutable scenario sequence copy contains different bytes.');
  }
  const documentId = ensureDevSequenceCatalogBindingInsideTx(db, {
    preferredDocumentId: sequence.documentId,
    name: input.name,
    path,
    contentHash,
  });
  const stat = statSync(path);
  return {
    ...input,
    workspaceId: scenario.workspaceId,
    fields: {
      ...input.fields,
      sequence: {
        ...sequence,
        documentId,
        relPath: path,
        workspaceId: scenario.workspaceId,
        sizeBytes: stat.size,
        modifiedAt: stat.mtimeMs,
      },
    },
  };
}

export function ensureSeedLimsLinkInsideTx(
  db: Database.Database,
  input: LimsLinkEntitiesInput
): SeededLimsLinkResult {
  const existing = db
    .prepare(
      `SELECT * FROM lims_link
       WHERE from_entity_id = ? AND to_entity_id = ? AND type = ? AND tombstone = 0
       LIMIT 1`
    )
    .get(input.fromEntityId, input.toEntityId, input.type) as LimsLinkRow | undefined;
  if (existing) return { link: limsLinkFromRow(existing), inserted: false };
  return { link: linkLimsEntitiesOrExistingInsideTx(db, input), inserted: true };
}

export function tombstoneDemoPrimerTargetLinksInsideTx(
  db: Database.Database,
  input: {
    primerIds: readonly string[];
    targetEntityId: string;
    actor: string;
    batchId: string;
  }
): number {
  if (input.primerIds.length === 0) return 0;
  const placeholders = input.primerIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT *
       FROM lims_link
       WHERE from_entity_id IN (${placeholders})
         AND to_entity_id = ?
         AND type = 'amplifies'
         AND tombstone = 0`
    )
    .all(...input.primerIds, input.targetEntityId) as LimsLinkRow[];

  for (const row of rows) {
    const before = limsLinkFromRow(row);
    const eventSeq = nextEventSeq(db);
    const now = Date.now();
    const after: LimsLink = {
      ...before,
      actor: input.actor,
      eventSeq,
      tombstone: true,
      updatedAt: now,
      archivedAt: now,
    };
    insertAuditEvent(db, {
      eventSeq,
      eventType: 'link_tombstoned',
      subjectTable: 'lims_link',
      subjectId: row.id,
      batchId: input.batchId,
      actor: input.actor,
      before,
      after,
      payload: {
        reason: 'demo_primer_association_type_normalized',
        replacementType: 'associated_with',
      },
    });
    upsertLimsLinkProjectionInsideTx(db, after);
  }

  return rows.length;
}

export function findFixturePath(relativePath: string): string {
  const found = findOptionalFixturePath(relativePath);
  if (!found) throw new Error(`LIMS demo fixture not found: ${relativePath}`);
  return found;
}

export function findOptionalFixturePath(
  relativePath: string,
  extraCandidates: readonly string[] = []
): string | null {
  const candidates = [
    join(findRepoAnchorPath(), relativePath),
    join(process.cwd(), relativePath),
    join(process.cwd(), '..', '..', relativePath),
    join(__dirname, '../../../..', relativePath),
    join(__dirname, '../../../../..', relativePath),
    ...extraCandidates,
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function findRepoAnchorPath(): string {
  const candidates = [
    process.cwd(),
    join(process.cwd(), '..', '..'),
    join(__dirname, '../../../..'),
    join(__dirname, '../../../../..'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json')) && existsSync(join(candidate, 'apps'))) {
      return candidate;
    }
  }
  const appPath = safeElectronAppPath();
  if (appPath && existsSync(join(appPath, 'package.json'))) return appPath;
  return process.cwd();
}

export function safeElectronAppPath(): string | null {
  const getAppPath = (app as typeof app & { getAppPath?: () => string }).getAppPath;
  if (typeof getAppPath !== 'function') return null;
  try {
    return getAppPath();
  } catch {
    return null;
  }
}

export type DemoPrimerRow = {
  name: string;
  sequence: string;
  description: string;
};

export function buildDemoPrimerRows(): DemoPrimerRow[] {
  return [
    {
      name: 'M13-Forward',
      sequence: 'GTAAAACGACGGCCAGT',
      description: 'Universal M13 (-20) forward sequencing primer.',
    },
    {
      name: 'M13-Reverse',
      sequence: 'CAGGAAACAGCTATGAC',
      description: 'Universal M13 reverse sequencing primer.',
    },
    {
      name: 'SP6-Promoter',
      sequence: 'ATTTAGGTGACACTATAGAA',
      description: 'Universal SP6 promoter primer.',
    },
    {
      name: 'T7-Promoter',
      sequence: 'TAATACGACTCACTATAGGG',
      description: 'Universal T7 promoter primer.',
    },
  ];
}

export function readDemoPrimerRows(primerFixturePath: string | null): DemoPrimerRow[] {
  if (primerFixturePath && existsSync(primerFixturePath)) {
    const parsed = parseSimpleCsv(readFileSync(primerFixturePath, 'utf8'));
    const rows = parsed
      .map((row) => ({
        name: readCsvColumn(row, ['Name', 'name']) ?? '',
        sequence: (readCsvColumn(row, ['Sequence', 'sequence']) ?? '')
          .replace(/\s/g, '')
          .toUpperCase(),
        description: readCsvColumn(row, ['Description', 'description', 'Purpose', 'purpose']) ?? '',
      }))
      .filter((row) => row.name && /^[ACGTURYSWKMBDHVN]+$/.test(row.sequence))
      .slice(0, 4);
    if (rows.length >= 4) return rows;
  }
  return [
    {
      name: 'M13-Forward',
      sequence: 'GTAAAACGACGGCCAGT',
      description: 'Standard M13 forward primer.',
    },
    {
      name: 'M13-Reverse',
      sequence: 'CAGGAAACAGCTATGAC',
      description: 'Standard M13 reverse primer.',
    },
    {
      name: 'T7-Promoter',
      sequence: 'TAATACGACTCACTATAGGG',
      description: 'T7 promoter primer.',
    },
    {
      name: 'SP6-Promoter',
      sequence: 'ATTTAGGTGACACTATAG',
      description: 'SP6 promoter primer.',
    },
  ];
}

export function parseSimpleCsv(content: string): Array<Record<string, string>> {
  const rows = content
    .split(/\r?\n/)
    .map((line) => splitCsvLine(line).map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean));
  const headers = rows.shift() ?? [];
  return rows.map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = row[index] ?? '';
    });
    return record;
  });
}

export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        cell += '"';
        index++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

export function readCsvColumn(
  row: Record<string, string>,
  aliases: readonly string[]
): string | null {
  for (const alias of aliases) {
    const value = row[alias];
    if (value?.trim()) return value.trim();
  }
  return null;
}
