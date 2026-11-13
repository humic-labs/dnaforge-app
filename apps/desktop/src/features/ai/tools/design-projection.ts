import { deriveAssemblyIssues } from '../../assembly/public/issues/assembly-issues';
import {
  orphanedSpacers,
  projectAssemblyGaps,
  projectAssemblySlots,
} from '../../design/public/slot-projection';
import { getComposedSequenceForDesign } from '../../design/public/restriction-digest';
import { resolveTmModelWithSource } from '../../design/public/algorithms/tm-service';
import { savedPrimerLinkFor } from '../../design/public/saved-primer-links';
import type { TmModel } from '../../design/public/algorithms/tm-model';
import { useSettingsStore } from '../../junction-workbench/public/settings';
import { computeJunctionCount } from '../../junction-workbench/public/AssemblyWorkbenchIdentity';
import type {
  DesignPrimer,
  DesignRegion,
  RestrictionDigestEnd,
  SequenceDesign,
} from '../../design/public/types';

export type DesignProjectionLevel = 'header' | 'detail';
const MAX_INLINE_DESIGN_SEQUENCE_BP = 50_000;
const DESIGN_SEQUENCE_PREVIEW_BP = 1_000;

export function projectDesignHeader(design: SequenceDesign) {
  const issueErrors = deriveAssemblyIssues({ design }).filter(
    (issue) => issue.severity === 'error' && issue.gates.run
  );
  return {
    id: design.id,
    name: design.name,
    topology: design.topology,
    assemblyMethod: design.assemblyMethod,
    assemblyState: design.assemblyState,
    status: design.status,
    version: design.version,
    regionCount: design.regions.length,
    homologyRegionCount: design.homologyRegions.length,
    goldenGateJunctionCount: design.goldenGateJunctions?.length ?? 0,
    primerPairCount: design.designPrimers.length,
    validationErrorCount: Math.max(issueErrors.length, design.validationErrors.filter((item) => item.severity === 'error').length),
  };
}

export function projectDesignDetail(design: SequenceDesign) {
  const header = projectDesignHeader(design);
  const issues = deriveAssemblyIssues({ design });
  const committedErrors = issues.filter(
    (issue) => issue.lifecycle === 'committed' && issue.severity === 'error'
  );
  const slots = projectAssemblySlots(design);
  const gaps = projectAssemblyGaps(design);
  const orphaned = orphanedSpacers(design);
  const composedSequence = getComposedSequenceForDesign(design);
  const composedSequenceIncluded = composedSequence.length <= MAX_INLINE_DESIGN_SEQUENCE_BP;

  return {
    ...header,
    goldenGateEnzyme: design.goldenGateConfig?.enzyme ?? null,
    goldenGateSchema: design.goldenGateSchema
      ? {
          id: design.goldenGateSchema.id,
          name: design.goldenGateSchema.name,
          revision: design.goldenGateSchema.revision,
          origin: design.goldenGateSchema.origin,
          enzyme: design.goldenGateSchema.enzyme,
          slots: design.goldenGateSchema.slots.map((slot) => ({
            id: slot.id,
            label: slot.label,
            outgoingOverhang: slot.outgoingOverhang,
            preferredRoles: slot.preferredRoles.map((role) => ({
              ...(role.id ? { id: role.id } : {}),
              label: role.label,
            })),
          })),
        }
      : null,
    mocloFactory: design.mocloFactory
      ? {
          runId: design.mocloFactory.runId,
          kitId: design.mocloFactory.kitId,
          kitRevision: design.mocloFactory.kitRevision,
          recipeId: design.mocloFactory.recipeId,
          stageId: design.mocloFactory.stageId,
          stageInputs: design.mocloFactory.stageInputs.map((input) => ({ ...input })),
        }
      : null,
    pcrPolymerase: design.pcrPolymerase ?? null,
    tmResolution: projectDesignTmResolution(design),
    validationErrors: design.validationErrors.map((error) => ({
      code: error.code,
      severity: error.severity,
      message: error.message,
      field: error.field ?? null,
      fragmentIndex: error.fragmentIndex ?? null,
    })),
    assemblyIssues: issues.map((issue) => ({
      kind: issue.kind,
      severity: issue.severity,
      lifecycle: issue.lifecycle,
      gates: { ...issue.gates },
      title: issue.title,
      detail: issue.detail,
      scope: issue.scope,
      internalSites: issue.internalSites ?? null,
    })),
    assemblyIssueErrorCount: committedErrors.length,
    blocksRun: committedErrors.some((issue) => issue.gates.run),
    blocksFinalize: committedErrors.some((issue) => issue.gates.finalize),
    blocksExport: committedErrors.some((issue) => issue.gates.export),
    slots,
    slotCount: slots.length,
    emptySlotCount: slots.filter((slot) => slot.isEmpty).length,
    gaps,
    junctionCount: computeJunctionCount(design),
    spacers: design.spacers.map((spacer) => ({
      id: spacer.id,
      junctionIndex: spacer.junctionIndex,
      anchor: spacer.anchor
        ? {
            leftRegionId: spacer.anchor.leftRegionId,
            rightRegionId: spacer.anchor.rightRegionId,
          }
        : null,
      sequence: spacer.sequence,
      name: spacer.name ?? null,
      length: spacer.sequence.length,
    })),
    orphanedSpacers: orphaned.map((spacer) => ({
      id: spacer.id,
      junctionIndex: spacer.junctionIndex,
      sequence: spacer.sequence,
    })),
    spacerIntegrityWarnings: [
      ...gaps
        .filter((gap) => gap.duplicateSpacerIds.length > 0)
        .map((gap) => ({
          code: 'DUPLICATE_SPACERS_AT_JUNCTION' as const,
          junctionIndex: gap.junctionIndex,
          spacerIds: [gap.spacer?.id, ...gap.duplicateSpacerIds].filter(
            (id): id is string => typeof id === 'string'
          ),
        })),
      ...orphaned.map((spacer) => ({
        code: 'ORPHANED_SPACER' as const,
        spacerId: spacer.id,
        junctionIndex: spacer.junctionIndex,
      })),
    ],
    composedSequenceLength: composedSequence.length,
    composedSequenceIncluded,
    composedSequence: composedSequenceIncluded ? composedSequence : null,
    composedSequencePreview: composedSequenceIncluded
      ? null
      : composedSequence.slice(0, DESIGN_SEQUENCE_PREVIEW_BP),
    regions: design.regions.map(projectRegion),
    primers: design.designPrimers.map((pair) => ({
      fragmentIndex: pair.fragmentIndex,
      forward: projectPrimer(design, pair.forward),
      reverse: projectPrimer(design, pair.reverse),
    })),
    goldenGateJunctions: (design.goldenGateJunctions ?? []).map((junction) => ({
      junctionIndex: junction.junctionIndex,
      junctionPosition: junction.junctionPosition,
      offset: junction.offset,
      overhangStart: junction.overhangStart,
      overhangEnd: junction.overhangEnd,
      overhang: junction.overhang,
      source: junction.source,
      isValid: junction.isValid,
      validationError: junction.validationError ?? null,
    })),
  };
}

export function projectDesignTmResolution(design: SequenceDesign) {
  const settings = useSettingsStore.getState();
  const resolution = resolveTmModelWithSource({
    reaction: { polymerase: design.pcrPolymerase ?? null },
    userSetting: settings.tmModel,
    userSettingIsExplicit: settings.tmModelExplicit,
  });
  const primers = design.designPrimers.flatMap((pair) => [pair.forward, pair.reverse]);
  const verifiedPrimerCount = primers.filter((primer) => {
    const provenance = primer.tmProvenance;
    return (
      provenance?.verified === true &&
      provenance.concNm === settings.primerConcNm &&
      provenance.model !== undefined &&
      sameTmModel(provenance.model, resolution.model)
    );
  }).length;

  return {
    ...resolution,
    pendingNebVerification:
      resolution.model.kind === 'neb' &&
      primers.length > 0 &&
      verifiedPrimerCount < primers.length,
    primerCount: primers.length,
    verifiedPrimerCount,
  };
}

function sameTmModel(left: TmModel, right: TmModel): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'local' && right.kind === 'local'
    ? left.algorithm === right.algorithm
    : left.kind === 'neb' &&
        right.kind === 'neb' &&
        left.prodcode === right.prodcode &&
        left.polymerase === right.polymerase;
}

function projectRegion(region: DesignRegion) {
  return {
    id: region.id,
    sourceSequenceId: region.sourceSequenceId,
    sourceSequenceName: region.sourceSequenceName,
    sourceStart: region.sourceStart,
    sourceEnd: region.sourceEnd,
    length: region.sequence.length,
    annotationCount: region.annotations.length,
    isPlaceholder: region.isPlaceholder === true,
    mocloStageOutput: region.mocloStageOutput ?? null,
    sourceType: region.sourceType ?? null,
    ggType: region.ggType ?? null,
    rdOverhangs: region.rdOverhangs
      ? {
          upstream: region.rdOverhangs.upstream,
          downstream: region.rdOverhangs.downstream,
        }
      : null,
    rdSourceEnzyme: region.rdSourceEnzyme ?? null,
    rdSourceEnzymeName: region.rdSourceEnzymeName ?? null,
    rdEnds: region.rdEnds
      ? {
          upstream: projectRdEnd(region.rdEnds.upstream),
          downstream: projectRdEnd(region.rdEnds.downstream),
        }
      : null,
  };
}

function projectRdEnd(end: RestrictionDigestEnd | undefined) {
  if (!end) return null;
  return {
    overhang: end.overhang ?? null,
    overhangType: end.overhangType ?? null,
    recognitionSequence: end.recognitionSequence ?? null,
    recognitionStart: end.recognitionStart ?? null,
    recognitionEnd: end.recognitionEnd ?? null,
    cutPositionTop: end.cutPositionTop ?? null,
    cutPositionBottom: end.cutPositionBottom ?? null,
    strand: end.strand ?? null,
    retainedScarSequence: end.retainedScarSequence ?? null,
    retainedScarLength: end.retainedScarLength ?? null,
    nebuilderResectionBases: end.nebuilderResectionBases ?? null,
  };
}

function projectSavedOligo(design: SequenceDesign, primerId: string) {
  const link = savedPrimerLinkFor(design, primerId);
  if (!link) return null;
  return {
    oligoId: link.oligoId,
    artifactRevision: link.artifactRevision,
    sequenceContentHash: link.sequenceContentHash,
    linkedAtDesignVersion: link.linkedAtDesignVersion,
    linkedAt: link.linkedAt,
    via: link.via,
  };
}

function projectPrimer(design: SequenceDesign, primer: DesignPrimer) {
  return {
    id: primer.id,
    name: primer.name,
    savedOligo: projectSavedOligo(design, primer.id),
    direction: primer.direction,
    fragmentIndex: primer.fragmentIndex,
    junctionIndex: primer.junctionIndex,
    sequence: primer.sequence,
    oligo: primer.oligo ?? null,
    manuallyEdited: primer.manuallyEdited ?? false,
    manuallyNamed: primer.manuallyNamed ?? false,
    pbs: {
      start: primer.pbs.start,
      end: primer.pbs.end,
      sequence: primer.pbs.sequence,
      length: primer.pbs.sequence.length,
    },
    overhang: {
      length: primer.overhang.length,
      tailLength: primer.overhang.tailLength ?? primer.overhang.sequence.length,
      sequence: primer.overhang.sequence,
      spacerSequence: primer.overhang.spacerSequence ?? null,
    },
    goldenGateOverhang: primer.goldenGateOverhang
      ? {
          padding5prime: primer.goldenGateOverhang.padding5prime,
          enzymeSite: primer.goldenGateOverhang.enzymeSite,
          spacer: primer.goldenGateOverhang.spacer,
          overhang: primer.goldenGateOverhang.overhang,
          literalExtra: primer.goldenGateOverhang.literalExtra,
          literalSpacerLength: primer.goldenGateOverhang.literalSpacerLength ?? null,
          fullSequence: primer.goldenGateOverhang.fullSequence,
        }
      : null,
    tm: primer.tm ?? null,
    tmProvenance: primer.tmProvenance ?? null,
    cognate4bpLength: primer.cognate4bpLength ?? null,
    synthetic4bpSpacerLength: primer.synthetic4bpSpacerLength ?? null,
  };
}
