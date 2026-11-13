import type Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { app } from 'electron';
import { serializeGenBank, type AnnotatedSequence } from '@waypoint/sequence-utils';
import {
  limsEntityFromRow,
  limsLinkFromRow,
  type LimsAttachGenomeHypothesisInput,
  type LimsAttachGenomeHypothesisResult,
  type LimsAttachVerifiedGenomeInput,
  type LimsAttachVerifiedGenomeResult,
  type LimsEntity,
  type LimsGenomeConfidence,
  type LimsGenomeGapSummary,
  type LimsLink,
  type LimsLinkRow,
  type LimsProjectGenomeFromGenotypeInput,
  type LimsProjectGenomeFromGenotypeResult,
  type LimsRecordStrainParentGenomeInput,
  type LimsRecordStrainParentGenomeResult,
  type LimsSequenceDifference,
  type LimsStrainGenomeSummariesInput,
  type LimsStrainGenomeSummariesResult,
  type LimsStrainGenomeSummary,
  type LimsStrainGenomeSummaryInput,
} from '../shared/lims';
import {
  applyLimsGenotypeEdits,
  parseLimsGenotype,
} from '../shared/registry-artifacts/genotype-reconstruction';
import {
  LOCAL_ACTOR,
  errorMessage,
  getEntityRowById,
  insertAuditEvent,
  linkLimsEntitiesInsideTx,
  linkLimsEntitiesOrExistingInsideTx,
  registerLimsEntityInsideTx,
  seedLimsBuiltinsInDb,
} from './lims-engine-core';
import {
  buildFileSequenceRef,
  loadEntitySequence,
  resolveMarkerSequences,
  sanitizePathStem,
} from './lims-sequence-io';

export function getLimsStrainGenomeSummariesInDb(
  db: Database.Database,
  input: LimsStrainGenomeSummariesInput
): LimsStrainGenomeSummariesResult {
  seedLimsBuiltinsInDb(db);
  return getLimsStrainGenomeSummariesInsideTx(db, input);
}

export function projectLimsGenomeFromGenotypeInDb(
  db: Database.Database,
  input: LimsProjectGenomeFromGenotypeInput
): LimsProjectGenomeFromGenotypeResult {
  seedLimsBuiltinsInDb(db);
  const strain = limsEntityFromRow(getEntityRowById(db, input.strainEntityId));
  if (strain.kind !== 'strain') throw new Error(`LIMS entity is not a strain: ${strain.id}`);
  const parentGenome = limsEntityFromRow(getEntityRowById(db, input.parentGenomeEntityId));
  if (parentGenome.kind !== 'genome') {
    throw new Error(`LIMS entity is not a genome: ${parentGenome.id}`);
  }
  const genotype =
    typeof strain.fields.genotypeCanonical === 'string' ? strain.fields.genotypeCanonical : '';
  const parsed = parseLimsGenotype(genotype);
  if (parsed.errors.length > 0) {
    throw new Error(`Invalid genotype: ${parsed.errors.join('; ')}`);
  }
  if (parsed.edits.length === 0) throw new Error('Strain genotype contains no projectable edits');

  const parentSequence = loadEntitySequence(parentGenome, 'parent genome', db);
  const markerSequences = resolveMarkerSequences(db, input.markerGenomeEntityIds ?? {});
  const projected = applyLimsGenotypeEdits(parentSequence.sequence, parsed.edits, markerSequences);
  const outputPath = input.outputPath ?? defaultGenomeHypothesisPath(strain, parentGenome);
  mkdirSync(dirname(outputPath), { recursive: true });
  const hypothesisName = input.hypothesisGenomeName ?? `${strain.name} genome hypothesis`;
  const hypothesisGenomeId = input.hypothesisGenomeId ?? `hypothesis-${strain.id}`;
  const hypothesisContent = serializeGenBank({
    id: hypothesisGenomeId,
    name: hypothesisName,
    sequence: projected.sequence,
    length: projected.sequence.length,
    circular: parentSequence.sequence.circular,
    annotations: [],
    description: `Computational projection from ${strain.name} genotype relative to ${parentGenome.name}.`,
  });
  writeFileSync(outputPath, hypothesisContent, 'utf8');
  const hypothesisRef = buildFileSequenceRef(outputPath, hypothesisContent, {
    documentId: hypothesisGenomeId,
    length: projected.sequence.length,
    topology: parentSequence.sequence.circular ? 'circular' : 'linear',
    sourceFormat: 'gb',
  });

  return db.transaction(() => {
    const hypothesisGenome = registerLimsEntityInsideTx(db, {
      id: hypothesisGenomeId,
      kind: 'genome',
      name: hypothesisName,
      fields: {
        sequence: hypothesisRef,
        source: 'computational_projection',
        assemblyLevel: parentGenome.fields.assemblyLevel ?? 'unknown',
        genotypeCanonical: genotype,
        parentGenomeEntityId: parentGenome.id,
        notes: `Computational genotype projection. Not WGS verified: ${genotype}`,
      },
      registrationStatus: 'registered',
      actor: input.actor ?? LOCAL_ACTOR,
      workspaceId: strain.workspaceId ?? parentGenome.workspaceId,
      batchId: input.batchId ?? null,
    });
    const derivesFromLink = linkLimsEntitiesInsideTx(db, {
      fromEntityId: hypothesisGenome.id,
      toEntityId: parentGenome.id,
      type: 'derives_from',
      payload: {
        method: 'experimental_genotype_projection',
        genotype,
        edits: parsed.edits,
        appliedEdits: projected.applied,
      },
      actor: input.actor ?? LOCAL_ACTOR,
      workspaceId: strain.workspaceId ?? parentGenome.workspaceId,
      batchId: input.batchId ?? null,
    });
    const hasGenomeLink = linkLimsEntitiesInsideTx(db, {
      fromEntityId: strain.id,
      toEntityId: hypothesisGenome.id,
      type: 'has_genome',
      payload: {
        confidence: 'hypothesis_from_genotype_projection',
        method: 'experimental_genotype_projection',
        parentGenomeEntityId: parentGenome.id,
        genotype,
        editCount: parsed.edits.length,
      },
      actor: input.actor ?? LOCAL_ACTOR,
      workspaceId: strain.workspaceId ?? parentGenome.workspaceId,
      batchId: input.batchId ?? null,
    });
    insertAuditEvent(db, {
      eventType: 'genome_hypothesis_projected',
      subjectTable: 'lims_entity',
      subjectId: hypothesisGenome.id,
      batchId: input.batchId ?? null,
      actor: input.actor ?? LOCAL_ACTOR,
      workspaceId: strain.workspaceId ?? parentGenome.workspaceId,
      payload: {
        strainEntityId: strain.id,
        parentGenomeEntityId: parentGenome.id,
        outputPath,
        parentLength: parentSequence.sequence.length,
        hypothesisLength: projected.sequence.length,
        editCount: parsed.edits.length,
      },
    });
    return {
      strain,
      parentGenome,
      hypothesisGenome,
      hasGenomeLink,
      derivesFromLink,
      parsed,
      outputPath,
      parentLength: parentSequence.sequence.length,
      hypothesisLength: projected.sequence.length,
      appliedEditCount: projected.applied.length,
    };
  })();
}

export function recordLimsStrainParentGenomeInDb(
  db: Database.Database,
  input: LimsRecordStrainParentGenomeInput
): LimsRecordStrainParentGenomeResult {
  seedLimsBuiltinsInDb(db);
  return db.transaction(() => {
    const strain = limsEntityFromRow(getEntityRowById(db, input.strainEntityId));
    if (strain.kind !== 'strain') throw new Error(`LIMS entity is not a strain: ${strain.id}`);
    const parentGenome = limsEntityFromRow(getEntityRowById(db, input.parentGenomeEntityId));
    if (parentGenome.kind !== 'genome') {
      throw new Error(`LIMS entity is not a genome: ${parentGenome.id}`);
    }
    const genotype =
      typeof strain.fields.genotypeCanonical === 'string' ? strain.fields.genotypeCanonical : '';
    const link = linkLimsEntitiesOrExistingInsideTx(db, {
      fromEntityId: strain.id,
      toEntityId: parentGenome.id,
      type: 'references',
      payload: {
        role: 'parent_genome',
        confidence: 'genotype_parent_reference',
        genotype,
      },
      actor: input.actor ?? LOCAL_ACTOR,
      workspaceId: strain.workspaceId ?? parentGenome.workspaceId,
      batchId: input.batchId ?? null,
    });
    insertAuditEvent(db, {
      eventType: 'strain_parent_genome_recorded',
      subjectTable: 'lims_link',
      subjectId: link.id,
      batchId: input.batchId ?? null,
      actor: input.actor ?? LOCAL_ACTOR,
      workspaceId: link.workspaceId,
      payload: input,
    });
    return {
      link,
      gap: summarizeStrainGenomeGap(db, strain.id),
    };
  })();
}

export function attachGenomeHypothesisInDb(
  db: Database.Database,
  input: LimsAttachGenomeHypothesisInput
): LimsAttachGenomeHypothesisResult {
  seedLimsBuiltinsInDb(db);
  return db.transaction(() => {
    const strain = limsEntityFromRow(getEntityRowById(db, input.strainEntityId));
    if (strain.kind !== 'strain') throw new Error(`LIMS entity is not a strain: ${strain.id}`);
    const hypothesisGenome = limsEntityFromRow(
      getEntityRowById(db, input.hypothesisGenomeEntityId)
    );
    if (hypothesisGenome.kind !== 'genome') {
      throw new Error(`LIMS entity is not a genome: ${hypothesisGenome.id}`);
    }
    const hasGenomeLink = linkLimsEntitiesOrExistingInsideTx(db, {
      fromEntityId: strain.id,
      toEntityId: hypothesisGenome.id,
      type: 'has_genome',
      payload: {
        confidence: 'hypothesis_supplied',
        method: input.method ?? 'supplied_genome_hypothesis',
      },
      actor: input.actor ?? LOCAL_ACTOR,
      workspaceId: strain.workspaceId ?? hypothesisGenome.workspaceId,
      batchId: input.batchId ?? null,
    });
    let parentReferenceLink: LimsLink | undefined;
    let derivesFromLink: LimsLink | undefined;
    if (input.parentGenomeEntityId) {
      const parentGenome = limsEntityFromRow(getEntityRowById(db, input.parentGenomeEntityId));
      if (parentGenome.kind !== 'genome') {
        throw new Error(`LIMS entity is not a genome: ${parentGenome.id}`);
      }
      parentReferenceLink = linkLimsEntitiesOrExistingInsideTx(db, {
        fromEntityId: strain.id,
        toEntityId: parentGenome.id,
        type: 'references',
        payload: {
          role: 'parent_genome',
          confidence: 'genotype_parent_reference',
          genotype:
            typeof strain.fields.genotypeCanonical === 'string'
              ? strain.fields.genotypeCanonical
              : '',
        },
        actor: input.actor ?? LOCAL_ACTOR,
        workspaceId: strain.workspaceId ?? parentGenome.workspaceId,
        batchId: input.batchId ?? null,
      });
      derivesFromLink = linkLimsEntitiesOrExistingInsideTx(db, {
        fromEntityId: hypothesisGenome.id,
        toEntityId: parentGenome.id,
        type: 'derives_from',
        payload: {
          method: input.method ?? 'supplied_genome_hypothesis',
        },
        actor: input.actor ?? LOCAL_ACTOR,
        workspaceId: hypothesisGenome.workspaceId ?? parentGenome.workspaceId,
        batchId: input.batchId ?? null,
      });
    }
    insertAuditEvent(db, {
      eventType: 'genome_hypothesis_attached',
      subjectTable: 'lims_link',
      subjectId: hasGenomeLink.id,
      batchId: input.batchId ?? null,
      actor: input.actor ?? LOCAL_ACTOR,
      workspaceId: hasGenomeLink.workspaceId,
      payload: input,
    });
    return {
      hasGenomeLink,
      derivesFromLink,
      parentReferenceLink,
      gap: summarizeStrainGenomeGap(db, strain.id),
    };
  })();
}

export function attachVerifiedLimsGenomeInDb(
  db: Database.Database,
  input: LimsAttachVerifiedGenomeInput
): LimsAttachVerifiedGenomeResult {
  seedLimsBuiltinsInDb(db);
  return db.transaction(() => {
    const strain = limsEntityFromRow(getEntityRowById(db, input.strainEntityId));
    if (strain.kind !== 'strain') throw new Error(`LIMS entity is not a strain: ${strain.id}`);
    const verifiedGenome = limsEntityFromRow(getEntityRowById(db, input.verifiedGenomeEntityId));
    if (verifiedGenome.kind !== 'genome') {
      throw new Error(`LIMS entity is not a genome: ${verifiedGenome.id}`);
    }
    const hasGenomeLink = linkLimsEntitiesOrExistingInsideTx(db, {
      fromEntityId: strain.id,
      toEntityId: verifiedGenome.id,
      type: 'has_genome',
      payload: {
        confidence: 'WGS_verified',
        method: input.method ?? 'WGS',
        coverage: input.coverage ?? null,
      },
      actor: input.actor ?? LOCAL_ACTOR,
      workspaceId: strain.workspaceId ?? verifiedGenome.workspaceId,
      batchId: input.batchId ?? null,
    });
    let verifiedByLink: LimsLink | undefined;
    if (input.hypothesisGenomeEntityId) {
      const hypothesisGenome = limsEntityFromRow(
        getEntityRowById(db, input.hypothesisGenomeEntityId)
      );
      if (hypothesisGenome.kind !== 'genome') {
        throw new Error(`LIMS entity is not a genome: ${hypothesisGenome.id}`);
      }
      verifiedByLink = linkLimsEntitiesOrExistingInsideTx(db, {
        fromEntityId: input.hypothesisGenomeEntityId,
        toEntityId: verifiedGenome.id,
        type: 'verified_by',
        payload: {
          method: input.method ?? 'WGS',
          coverage: input.coverage ?? null,
        },
        actor: input.actor ?? LOCAL_ACTOR,
        workspaceId: strain.workspaceId ?? verifiedGenome.workspaceId,
        batchId: input.batchId ?? null,
      });
    }
    insertAuditEvent(db, {
      eventType: 'verified_genome_attached',
      subjectTable: 'lims_link',
      subjectId: hasGenomeLink.id,
      batchId: input.batchId ?? null,
      actor: input.actor ?? LOCAL_ACTOR,
      workspaceId: hasGenomeLink.workspaceId,
      payload: input,
    });
    return {
      hasGenomeLink,
      verifiedByLink,
      gap: summarizeStrainGenomeGap(db, strain.id),
    };
  })();
}

export function getLimsStrainGenomeSummaryInDb(
  db: Database.Database,
  input: LimsStrainGenomeSummaryInput
): LimsStrainGenomeSummary {
  seedLimsBuiltinsInDb(db);
  return getLimsStrainGenomeSummaryInsideTx(db, input);
}

export function getLimsStrainGenomeSummaryInsideTx(
  db: Database.Database,
  input: LimsStrainGenomeSummaryInput
): LimsStrainGenomeSummary {
  const strain = limsEntityFromRow(getEntityRowById(db, input.strainEntityId));
  if (strain.kind !== 'strain') throw new Error(`LIMS entity is not a strain: ${strain.id}`);
  const links = getActiveLinksFrom(db, strain.id, 'has_genome');
  const parentLink =
    getActiveLinksFrom(db, strain.id, 'references').find(
      (link) => link.payload.role === 'parent_genome'
    ) ?? null;
  const hypothesisLink = newestGenomeHypothesisLink(links);
  const verifiedLink = newestLinkByConfidence(links, 'WGS_verified');
  return {
    strain,
    parentGenome: parentLink
      ? limsEntityFromRow(getEntityRowById(db, parentLink.toEntityId))
      : null,
    hypothesisGenome: hypothesisLink
      ? limsEntityFromRow(getEntityRowById(db, hypothesisLink.toEntityId))
      : null,
    verifiedGenome: verifiedLink
      ? limsEntityFromRow(getEntityRowById(db, verifiedLink.toEntityId))
      : null,
    parentLink,
    hypothesisLink,
    verifiedLink,
    gap: summarizeStrainGenomeGap(db, strain.id),
  };
}

export function getLimsStrainGenomeSummariesInsideTx(
  db: Database.Database,
  input: LimsStrainGenomeSummariesInput
): LimsStrainGenomeSummariesResult {
  const summaries: Record<string, LimsStrainGenomeSummary> = {};
  for (const strainEntityId of input.strainEntityIds) {
    summaries[strainEntityId] = getLimsStrainGenomeSummaryInsideTx(db, { strainEntityId });
  }
  return { summaries };
}

export function defaultGenomeHypothesisPath(strain: LimsEntity, parentGenome: LimsEntity): string {
  const stem = sanitizePathStem(`${strain.name}-hypothesis-from-${parentGenome.name}`);
  return join(app.getPath('userData'), 'lims', 'genome-hypotheses', `${stem}-${strain.id}.gb`);
}

export function summarizeStrainGenomeGap(
  db: Database.Database,
  strainEntityId: string
): LimsGenomeGapSummary {
  const links = getActiveLinksFrom(db, strainEntityId, 'has_genome');
  const hypothesisLink = newestGenomeHypothesisLink(links);
  if (!hypothesisLink) {
    return {
      status: 'no_hypothesis',
      message: 'No genome hypothesis is linked for this strain yet.',
    };
  }
  const verifiedLink = newestLinkByConfidence(links, 'WGS_verified');
  if (!verifiedLink) {
    return {
      status: 'no_verified',
      hypothesisGenomeId: hypothesisLink.toEntityId,
      message: 'Genome hypothesis exists; no WGS-verified genome is linked yet.',
    };
  }

  const hypothesisGenome = limsEntityFromRow(getEntityRowById(db, hypothesisLink.toEntityId));
  const verifiedGenome = limsEntityFromRow(getEntityRowById(db, verifiedLink.toEntityId));
  try {
    const hypothesis = loadEntitySequence(hypothesisGenome, 'genome hypothesis', db).sequence;
    const verified = loadEntitySequence(verifiedGenome, 'verified genome', db).sequence;
    return compareGenomeSequences(hypothesisGenome.id, hypothesis, verifiedGenome.id, verified);
  } catch (err) {
    return {
      status: 'unresolved',
      hypothesisGenomeId: hypothesisGenome.id,
      verifiedGenomeId: verifiedGenome.id,
      message: `Genome hypothesis and verified genome are linked, but the sequence gap is unresolved: ${errorMessage(err)}`,
    };
  }
}

export function compareGenomeSequences(
  hypothesisGenomeId: string,
  hypothesis: AnnotatedSequence,
  verifiedGenomeId: string,
  verified: AnnotatedSequence
): LimsGenomeGapSummary {
  const hypothesisSequence = hypothesis.sequence.toUpperCase();
  const verifiedSequence = verified.sequence.toUpperCase();
  const minLength = Math.min(hypothesisSequence.length, verifiedSequence.length);
  const firstDifferences: LimsSequenceDifference[] = [];
  let mismatchCount = 0;

  for (let i = 0; i < minLength; i++) {
    if (hypothesisSequence[i] !== verifiedSequence[i]) {
      mismatchCount++;
      if (firstDifferences.length < 10) {
        firstDifferences.push({
          position: i + 1,
          hypothesisBase: hypothesisSequence[i],
          verifiedBase: verifiedSequence[i],
        });
      }
    }
  }

  const lengthDelta = verifiedSequence.length - hypothesisSequence.length;
  if (lengthDelta !== 0) {
    mismatchCount += Math.abs(lengthDelta);
    for (
      let i = minLength;
      i < Math.max(hypothesisSequence.length, verifiedSequence.length) &&
      firstDifferences.length < 10;
      i++
    ) {
      firstDifferences.push({
        position: i + 1,
        hypothesisBase: hypothesisSequence[i] ?? '',
        verifiedBase: verifiedSequence[i] ?? '',
      });
    }
  }

  if (mismatchCount === 0) {
    return {
      status: 'match',
      hypothesisGenomeId,
      verifiedGenomeId,
      hypothesisLength: hypothesisSequence.length,
      verifiedLength: verifiedSequence.length,
      lengthDelta: 0,
      mismatchCount: 0,
      firstDifferences: [],
      message: 'Genome hypothesis matches the WGS-verified genome exactly.',
    };
  }

  return {
    status: 'mismatch',
    hypothesisGenomeId,
    verifiedGenomeId,
    hypothesisLength: hypothesisSequence.length,
    verifiedLength: verifiedSequence.length,
    lengthDelta,
    mismatchCount,
    firstDifferences,
    message: `Genome hypothesis disagrees with WGS: ${mismatchCount} base differences, length delta ${lengthDelta}.`,
  };
}

export function getActiveLinksFrom(
  db: Database.Database,
  fromEntityId: string,
  type: string
): LimsLink[] {
  const rows = db
    .prepare(
      `SELECT * FROM lims_link
       WHERE from_entity_id = ? AND type = ? AND tombstone = 0
       ORDER BY updated_at DESC, created_at DESC`
    )
    .all(fromEntityId, type) as LimsLinkRow[];
  return rows.map(limsLinkFromRow);
}

export function newestLinkByConfidence(
  links: readonly LimsLink[],
  confidence: LimsGenomeConfidence
): LimsLink | null {
  return (
    links.find((link) => {
      const linkConfidence = link.payload.confidence;
      return typeof linkConfidence === 'string' && linkConfidence === confidence;
    }) ?? null
  );
}

export function newestGenomeHypothesisLink(links: readonly LimsLink[]): LimsLink | null {
  return (
    newestLinkByConfidence(links, 'hypothesis_supplied') ??
    newestLinkByConfidence(links, 'hypothesis_from_genotype_projection')
  );
}
